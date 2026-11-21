/**
 * 离店满意度回访调度器（C2 差评预检，Task3）
 *
 * 触发条件：平台套餐订单（pms_platform_product_orders）已核销（status='used'）且
 *   usedAt 距今 ≥45min（冷却期，无上限——靠台账去重支持漏单/重启/失败重试的回补）。
 * 投递通道：内部通知接口 POST /api/internal/notify（type='survey'，与 C1 通知共用双通道：
 *   微信订阅消息 best-effort + 站内消息兜底，幂等由站内消息唯一索引 (mini_user_id, order_id, type) 保证）。
 *
 * 数据访问边界：平台订单在平台库（跨 schema 禁止直查），按项目规范经 pms-platform-server
 *   内部接口（X-Internal-Token）分页拉取 status='used' 订单，再在本地按 usedAt 门槛筛选。
 *   当前平台列表接口不支持按 usedAt 服务端过滤，故用分页全量拉取 + 本地筛选（MVP 量级足够）。
 *
 * 幂等：以满意度回访表为台账 —— 每个 orderId 只投递一次问卷。
 *   先 INSERT 一行 score=NULL 的台账（onConflictDoNothing + returning），返回空 = 已有台账（已投递/已回填）→ 跳过，
 *   避免每 60s 一轮 tick 对同一订单重复推送；台账同时充当答卷行，客人回填时 UPDATE 该行。
 *   通知失败（网络/非 2xx）时回滚台账（仅删 score IS NULL 的行），下个 tick 对该订单重试。
 */
import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiSatisfactionSurveys } from '../db/schema/index.js';
import { listUsedProductOrders } from './platform-client.js';
import { INTERNAL_SERVICE_TOKEN } from '../constants.js';

/** 本服务自调用地址（内部通知接口挂在 pms-server 自身） */
const PMS_SELF_URL = process.env.PMS_SERVER_URL || `http://localhost:${process.env.PORT || 20002}`;

/**
 * 离店 1h 回访门槛：usedAt 距今 ≥45min（离店冷却期）。
 * 窗口不设上限（回补语义）——漏单/部署重启/通知失败重试都由「台账是否存在」去重：
 * 只要该订单还没有回访台账（未投递过问卷），超过冷却期即投递，天然支持补投。
 */
const MIN_ELAPSED_MS = 45 * 60 * 1000;

/** 截断到微信字段上限：thing 类 ≤20 字符 */
function clip(s: string, n: number): string {
  return String(s ?? '').slice(0, n);
}

/**
 * 投递回访问卷通知。
 * 走内部通知接口：微信订阅消息优先、站内消息兜底；站内幂等由接口侧 (mini_user_id, order_id, type) 唯一索引保证。
 * @returns true = 通知接口调用成功（至少站内消息已落库）；false = 网络/HTTP 失败（未送达，调用方须回滚台账以重试）
 */
async function notifySurvey(order: any): Promise<boolean> {
  try {
    const res = await fetch(`${PMS_SELF_URL}/api/internal/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify({
        miniUserId: order.miniUserId,
        orderId: order.id,
        type: 'survey',
        title: '离店回访',
        content: '您对本次入住满意吗？欢迎点击反馈入住体验，如有不满我们将尽快为您处理。',
        wechatData: {
          thing1: { value: clip(order.orderNo || order.id, 20) }, // 订单号
          thing3: { value: clip('离店回访：您对本次入住满意吗？', 20) }, // 回访文案（≤20）
        },
        page: `pages/mine/survey?id=${order.id}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[satisfaction-scheduler] 回访问卷通知接口非 2xx order=${order.id} status=${res.status}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(`[satisfaction-scheduler] 回访问卷通知发送失败 order=${order.id}（站内消息可能未送达，下个 tick 重试）:`, e?.message || e);
    return false;
  }
}

/** 扫描一次：已核销且 usedAt 距今 ≥45min 的订单 → 投递回访问卷。返回投递/重试/跳过计数 */
export async function runSatisfactionScan(): Promise<{ candidates: number; notified: number; failed: number; skipped: number }> {
  const now = Date.now();
  const orders = await listUsedProductOrders();
  // 本地门槛筛选：usedAt 存在且 ≥ 冷却期（无上限，靠台账去重支持漏单/重启回补；usedAt 可能为 ISO 字符串或 Date，统一转时间戳）
  const candidates = (orders || []).filter((o) => {
    if (!o || !o.miniUserId || o.status !== 'used' || !o.usedAt) return false;
    const usedAt = new Date(o.usedAt).getTime();
    if (!Number.isFinite(usedAt)) return false;
    return now - usedAt >= MIN_ELAPSED_MS;
  });

  let notified = 0;
  let failed = 0;
  let skipped = 0;
  for (const o of candidates) {
    // 幂等闸门：先插回访台账（score=NULL，onConflictDoNothing + returning）——
    // 唯一键 order_id 保证同一订单问卷只被抢到一次；returning 为空 = 台账已存在（已投递/已回填）→ 跳过。
    const [claimed] = await db.insert(pmsBuiSatisfactionSurveys).values({
      id: `svy_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      miniUserId: o.miniUserId,
      orderId: o.id,
    }).onConflictDoNothing().returning({ id: pmsBuiSatisfactionSurveys.id });
    if (!claimed) {
      skipped++;
      continue;
    }
    const delivered = await notifySurvey(o);
    if (!delivered) {
      // 通知失败（I-1）：回滚台账，让窗口内（无上限）下个 tick 重试；防并发已回填时误删（仅删 score IS NULL 的台账行）
      await db.delete(pmsBuiSatisfactionSurveys)
        .where(and(eq(pmsBuiSatisfactionSurveys.id, claimed.id), isNull(pmsBuiSatisfactionSurveys.score)));
      failed++;
      continue;
    }
    notified++;
  }
  if (candidates.length > 0) {
    console.log(`[satisfaction-scheduler] 离店≥45min used 订单 ${candidates.length} 笔（used 总量 ${orders?.length ?? 0}），投递回访 ${notified}，失败待重试 ${failed}，已通知跳过 ${skipped}`);
  }
  return { candidates: candidates.length, notified, failed, skipped };
}

/** 启动离店回访调度器（server.ts 调用一次）；启动即扫描一次，之后每 intervalMs 扫描 */
export function startSatisfactionScheduler(intervalMs = 60_000): void {
  setInterval(async () => {
    try {
      await runSatisfactionScan();
    } catch (err) {
      console.error('[satisfaction-scheduler] 扫描失败:', err);
    }
  }, intervalMs);
  // 启动即扫一次，部署后无需等待首个 interval 即可补投
  runSatisfactionScan().catch((err) => console.error('[satisfaction-scheduler] 首次扫描失败:', err));
  console.log(`[satisfaction-scheduler] 已启动（每 ${intervalMs / 1000}s 检查离店 1h 回访）`);
}
