import { Hono } from 'hono';
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiSatisfactionSurveys, pmsBuiCoupons, pmsBuiCouponRecords } from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { getPlatformProductOrder } from '../../services/platform-client.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

/** 东八区（北京）今天 YYYY-MM-DD（券过期判断统一用北京时间） */
function beijingToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 系统发差评补偿券（复用 commission-scheduler 离店回归券模式）：
 * 查该门店 active 的满减券模板（type='full_reduce'）→ 插入持券记录（expireAt = validDays 后）。
 * I-2 原子性：发券 INSERT 与回写回访台账 coupon_record_id 同事务完成，且先对台账行加行锁、
 *   仅在 coupon_record_id 仍为空时发放（并发/自愈重入安全，杜绝崩溃/并发重复发券）。
 * @param surveyId 回访台账行 id（锁与回写的载体）
 * @returns { couponRecordId, name } 发券成功；无可用模板返回 null（不阻断回访提交）
 */
async function issueCompensationCoupon(
  surveyId: string,
  storeId: string,
  miniUserId: string,
): Promise<{ couponRecordId: string; name: string } | null> {
  return db.transaction(async (tx) => {
    // 条件原子占位：锁定台账行，仅当尚未补偿（coupon_record_id IS NULL）才进入发券流程。
    // READ COMMITTED 下 FOR UPDATE 等待锁时若已被并发事务回写，WHERE 重估不命中 → 返回空 → 不发券。
    const [row] = await tx.select({ id: pmsBuiSatisfactionSurveys.id })
      .from(pmsBuiSatisfactionSurveys)
      .where(and(eq(pmsBuiSatisfactionSurveys.id, surveyId), isNull(pmsBuiSatisfactionSurveys.couponRecordId)))
      .limit(1)
      .for('update');
    if (!row) return null;

    const [coupon] = await tx.select().from(pmsBuiCoupons)
      .where(and(
        eq(pmsBuiCoupons.storeId, storeId),
        eq(pmsBuiCoupons.status, 'active'),
        eq(pmsBuiCoupons.type, 'full_reduce'),
      ))
      .limit(1);
    if (!coupon) return null;

    const expireAt = new Date(Date.now() + 8 * 3600 * 1000 + coupon.validDays * 86400000).toISOString().slice(0, 10);
    const couponRecordId = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // 发券 INSERT + 台账回写 coupon_record_id 同一事务：要么都成功（有券且台账可追溯），要么都回滚（不产生孤儿券/重复券）
    await tx.insert(pmsBuiCouponRecords).values({
      id: couponRecordId, couponId: coupon.id, miniUserId, storeId, expireAt,
    });
    await tx.update(pmsBuiSatisfactionSurveys)
      .set({ couponRecordId })
      .where(eq(pmsBuiSatisfactionSurveys.id, surveyId));
    return { couponRecordId, name: coupon.name };
  });
}

/** 读取某订单的回访台账（无则 undefined） */
async function findSurveyByOrder(orderId: string) {
  const [row] = await db.select().from(pmsBuiSatisfactionSurveys)
    .where(eq(pmsBuiSatisfactionSurveys.orderId, orderId)).limit(1);
  return row;
}

/** 按持券记录 id 解析补偿信息 { couponRecordId, name }（用于幂等重放路径回显，券模板被删则无 name） */
async function compensationInfo(couponRecordId: string): Promise<{ couponRecordId: string; name?: string }> {
  const [row] = await db.select({ name: pmsBuiCoupons.name })
    .from(pmsBuiCouponRecords)
    .innerJoin(pmsBuiCoupons, eq(pmsBuiCouponRecords.couponId, pmsBuiCoupons.id))
    .where(eq(pmsBuiCouponRecords.id, couponRecordId))
    .limit(1);
  return { couponRecordId, name: row?.name };
}

/** 幂等重放响应：已回填时复用（差评补偿缺失时自愈补发） */
async function idempotentResponse(existing: { score: number | null; couponRecordId: string | null }): Promise<{
  score: number | null;
  compensation?: { couponRecordId: string; name?: string };
}> {
  if (existing.score == null) return { score: null };
  const resp: { score: number | null; compensation?: { couponRecordId: string; name?: string } } = { score: existing.score };
  if (existing.couponRecordId) {
    resp.compensation = await compensationInfo(existing.couponRecordId);
  }
  return resp;
}

/**
 * POST /api/mini/survey/:orderId/submit — 回访提交（需登录，C2 差评预检）
 *   body: { score: 1-5, complaints?: string[]（不满点：床品/卫生/隔音/服务/其他）, comment?: string（≤500 字，可选） }
 *   提交时回填 store_id（口碑按店聚合）+ comment；台账/已有台账行均在 score IS NULL 条件内写入。
 *   校验：
 *     - 订单归属该 miniUserId（跨模块经平台 GET /api/product-orders/:id?miniUserId=xxx 做 C-C 校验，防 IDOR）
 *     - 订单已核销（status='used'）才可回访（I-3，防未入住刷差评骗补偿券）
 *   幂等：pms_bui_satisfaction_surveys.order_id 唯一 —— 重复提交返回既有结果，不重复发补偿券。
 *   差评（score < 3）：找该门店 active 补偿券模板（type='full_reduce'）→ 系统发券 → 回写 coupon_record_id；
 *   发券 INSERT 与回写同事务 + 台账行锁（coupon_record_id IS NULL 条件占位）保证原子与每单至多一张（I-2）。
 *   返回 { success, data: { score, compensation?: { couponRecordId, name } } }
 */
route.post('/:orderId/submit', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const orderId = c.req.param('orderId');
    const body = await c.req.json().catch(() => ({}));

    // 校验 score：1-5 整数
    const score = Number(body.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return c.json({ success: false, error: 'score 必须为 1-5 的整数' }, 400);
    }
    // 校验 complaints：可选 string 数组（不满点标签，单条 ≤20 字，防脏数据）
    const complaintsRaw = body.complaints ?? [];
    if (!Array.isArray(complaintsRaw) || complaintsRaw.some((x) => typeof x !== 'string' || x.length > 20)) {
      return c.json({ success: false, error: 'complaints 必须为字符串数组' }, 400);
    }
    const complaints = complaintsRaw.slice(0, 20);
    // 校验 comment：可选文字评价，≤500 字（超长截断，不报错）
    const comment = typeof body.comment === 'string' ? body.comment.slice(0, 500) : '';

    // 订单归属校验（跨模块经平台查）：平台侧对 miniUserId 做 C-C 校验，越权返回 403、不存在返回 404
    const res = await getPlatformProductOrder(orderId, miniUser.miniUserId);
    if (!res.ok) {
      const status = res.status === 404 ? 404 : 403;
      return c.json({ success: false, error: res.data?.error || '订单校验失败' }, status);
    }
    const order = res.data?.data as { storeId?: string; status?: string } | undefined;
    if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
    // I-3 状态门槛：仅已核销（status='used'）订单可回访，杜绝对未入住订单刷差评骗补偿券
    if (order.status !== 'used') {
      return c.json({ success: false, error: '仅已核销（离店）订单可提交回访' }, 400);
    }
    const storeId = order.storeId || '';

    // ============ 幂等 + 并发安全地记录回访 ============
    // 已回填（score 非空）→ 返回既有结果；差评补偿缺失时补发一次（自愈，发券原子性由事务内 coupon_record_id 行锁保证）
    const existing = await findSurveyByOrder(orderId);
    if (existing?.score != null) {
      // 自愈：已打分不满意但补偿券缺失（历史/流程中断）→ 补发一次
      if (existing.score < 3 && !existing.couponRecordId) {
        await issueCompensationCoupon(existing.id, storeId, existing.miniUserId);
      }
      const fresh = await findSurveyByOrder(orderId);
      return c.json({ success: true, data: await idempotentResponse(fresh ?? existing) });
    }

    let surveyId: string | null = existing?.id ?? null;
    let claimedByInsert = false;
    if (!surveyId) {
      // 无台账（调度器未投递/通知丢失，客人直达提交）→ 原子占位，order_id 唯一 + onConflictDoNothing 防并发双写
      const [inserted] = await db.insert(pmsBuiSatisfactionSurveys).values({
        id: `svy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        miniUserId: miniUser.miniUserId,
        orderId,
        score,
        complaints,
        // 台账行也一并写入 storeId（便于后续直接按 storeId 聚合，不依赖 join）
        storeId,
        comment,
      }).onConflictDoNothing().returning({ id: pmsBuiSatisfactionSurveys.id });
      if (inserted) {
        surveyId = inserted.id;
        claimedByInsert = true;
      } else {
        // 并发下被另一请求抢先写入 → 读回既有结果按幂等处理
        const cur = await findSurveyByOrder(orderId);
        if (cur?.score != null) {
          return c.json({ success: true, data: await idempotentResponse(cur) });
        }
        surveyId = cur?.id ?? null;
      }
    }

    if (!surveyId) {
      return c.json({ success: false, error: '回访记录写入失败，请重试' }, 500);
    }

    // 已有台账（score=NULL，调度器已投递问卷）→ 条件更新 score，WHERE score IS NULL 封死并发重复提交
    if (!claimedByInsert) {
      const [updated] = await db.update(pmsBuiSatisfactionSurveys)
        .set({ score, complaints, storeId, comment })
        .where(and(eq(pmsBuiSatisfactionSurveys.id, surveyId), isNull(pmsBuiSatisfactionSurveys.score)))
        .returning({ id: pmsBuiSatisfactionSurveys.id });
      if (!updated) {
        // 被并发请求抢先回填 → 读回既有结果按幂等处理
        const cur = await findSurveyByOrder(orderId);
        if (cur?.score != null) {
          return c.json({ success: true, data: await idempotentResponse(cur) });
        }
        return c.json({ success: false, error: '回访记录写入冲突，请重试' }, 500);
      }
    }

    // ============ 差评补偿券（仅胜出方走到这里，且发券在事务内以 coupon_record_id 行锁保证每单至多一张） ============
    let compensation: { couponRecordId: string; name: string } | null = null;
    if (score < 3) {
      compensation = await issueCompensationCoupon(surveyId, storeId, miniUser.miniUserId);
    }

    return c.json({
      success: true,
      data: {
        score,
        ...(compensation ? { compensation: { couponRecordId: compensation.couponRecordId, name: compensation.name } } : {}),
      },
    });
  } catch (e: any) {
    return serverError(c, e, '提交失败');
  }
});

export default route;
