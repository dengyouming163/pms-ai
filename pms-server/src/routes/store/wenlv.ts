// 商户现场端文旅到店核销路由：LY 集章领奖码（本库直写）+ W 门票券（代理 pms-platform，T7 追加）。
// 鉴权：store 员工 JWT（全局 authMiddleware）。
// 门店边界（S4 松绑定+审计）：标准员工 JWT 不含门店成员信息，X-Store-Id 为客户端自选门店，
// 仅作审计记录（redeemedStoreId），不作归属强校验；领奖码本身即 bearer 凭据。
// 安全：操作人不信 body —— redeemedBy 取 authUser.userId、redeemedStoreId 取 resolveStoreId。
// W 段：代理 pms-platform（券码在平台库），storeId 由本端解析注入；上游超时/不可达回 504/502 稳定中文。
import { Hono } from 'hono';
import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvRewardTiers, pmsBuiWenlvRewards, pmsBuiWenlvClaims, pmsBuiWenlvMerchRedeems } from '../../db/schema/index.js';
import { getTenantScope } from '../../utils/tenant.js';
import { isAllStoresScope } from '../../utils/scope.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();
const PLATFORM_URL = 'http://pms-platform-server:9092';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';
/** 哨兵门店：未分配门店的普通员工 → 到店核销一律 403 */
const NO_STORE = '__none__';

/** 复刻 product-orders 语义：返回当前门店 storeId；普通员工无门店 → NO_STORE；跨店超管(scope=tenant) → '' */
function resolveStoreId(c: Context): string {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser') as { scope?: string } | undefined;
  const sid = scope.storeId && scope.storeId !== '*' ? scope.storeId : '';
  if (!sid) return isAllStoresScope(authUser?.scope) ? '' : NO_STORE;
  return sid;
}

/** 当前操作人 id（审计字段；操作人不信 body——redeemedBy 只取 authUser.userId） */
function currentUserId(c: Context): string {
  const authUser = c.get('authUser') as { userId?: string } | undefined;
  return String(authUser?.userId ?? '');
}

/** 到店核销门店守卫：NO_STORE → 403 */
function storeGuard(c: Context): string | Response {
  const storeId = resolveStoreId(c);
  if (storeId === NO_STORE) return c.json({ success: false, error: '请先选择门店后再核销' }, 403);
  return storeId;
}

// ===== 领奖码（LY）—— claims 直写 pms-server 本库 =====

// GET /claims/by-code/:code — 预览（不含 miniUserId/condition 等敏感字段）
route.get('/claims/by-code/:code', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const code = c.req.param('code');
    const [claim] = await db.select().from(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.code, code)).limit(1);
    if (!claim) return c.json({ success: false, error: '领奖码不存在' }, 404);
    const [productRows, tierRows, rewardRows] = await Promise.all([
      db.select({ name: pmsBuiWenlvProducts.name, mode: pmsBuiWenlvProducts.mode }).from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, claim.productId)).limit(1),
      db.select({ name: pmsBuiWenlvRewardTiers.name, order: pmsBuiWenlvRewardTiers.order }).from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.id, claim.tierId)).limit(1),
      claim.rewardId
        ? db.select({ name: pmsBuiWenlvRewards.name, type: pmsBuiWenlvRewards.type, value: pmsBuiWenlvRewards.value }).from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, claim.rewardId)).limit(1)
        : Promise.resolve([] as { name: string; type: string; value: string | null }[]),
    ]);
    const product = productRows[0]; const tier = tierRows[0]; const reward = rewardRows[0] ?? null;
    return c.json({ success: true, data: {
      id: claim.id, code: claim.code, status: claim.status,
      productId: claim.productId, productTitle: product?.name ?? null, productMode: product?.mode ?? null,
      tierId: claim.tierId, tierName: tier?.name ?? null, tierOrder: tier?.order ?? 0,
      rewardId: claim.rewardId, rewardName: reward?.name ?? null, rewardType: reward?.type ?? null, rewardValue: reward?.value ?? null,
      claimedAt: claim.claimedAt, redeemedAt: claim.redeemedAt, redeemedBy: claim.redeemedBy, redeemedStoreId: claim.redeemedStoreId,
    } });
  } catch (e: any) {
    return serverError(c, e, '查询失败');
  }
});

// POST /claims/:id/redeem — 确认核销（仅 claimed → redeemed；区分 404/已核销/已取消 幂等文案）
route.post('/claims/:id/redeem', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const id = c.req.param('id');
    const [row] = await db.update(pmsBuiWenlvClaims)
      .set({ status: 'redeemed', redeemedAt: new Date(), redeemedBy: currentUserId(c), redeemedStoreId: g, updatedAt: new Date() })
      .where(and(eq(pmsBuiWenlvClaims.id, id), eq(pmsBuiWenlvClaims.status, 'claimed')))
      .returning();
    // 脱敏：与 by-code 一致，不下发 miniUserId/progressId 等敏感字段，仅回显审计字段
    if (row) return c.json({ success: true, data: {
      id: row.id, code: row.code, status: row.status, redeemedAt: row.redeemedAt,
      redeemedBy: row.redeemedBy, redeemedStoreId: row.redeemedStoreId,
    } });
    const [cur] = await db.select().from(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.id, id)).limit(1);
    if (!cur) return c.json({ success: false, error: '领奖码不存在' }, 404);
    if (cur.status === 'redeemed') return c.json({ success: false, error: '该领奖码已核销' }, 409);
    if (cur.status === 'cancelled') return c.json({ success: false, error: '该领奖码已取消' }, 409);
    return c.json({ success: false, error: '该领奖码状态不允许核销' }, 409);
  } catch (e: any) {
    return serverError(c, e, '核销失败');
  }
});

// ===== 门票（W）—— 代理 pms-platform（券码在平台库），storeId 由本端注入 =====

async function platformFetch(path: string, options?: { method?: string; body?: any }): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${PLATFORM_URL}${path}`, {
      method: options?.method || 'GET',
      headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e: any) {
    // 超时/平台不可达：回稳定 5xx + 中文，不透传底层技术文案（店员端只看「服务繁忙」）
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    console.error('[wenlv-store] 平台请求失败', path, e);
    return { status: timedOut ? 504 : 502, json: { success: false, error: '平台服务繁忙，请稍后再试' } };
  }
  const json = await res.json().catch(() => null);
  if (json === null) {
    // 平台非 JSON 响应（网关 5xx 纯文本）：服务端留痕，客户端拿稳定中文
    console.error('[wenlv-store] 平台非 JSON 响应', res.status, path);
    return { status: 502, json: { success: false, error: '平台服务繁忙，请稍后再试' } };
  }
  return { status: res.status, json };
}

// GET /tickets/by-code/:code — 预览（透传状态码/文案）
route.get('/tickets/by-code/:code', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const { status, json } = await platformFetch(`/api/wenlv/internal/tickets/by-code/${encodeURIComponent(c.req.param('code'))}`);
    return c.json(json, status as any);
  } catch (e: any) {
    console.error('[wenlv-store] by-code 意外错误', c.req.path, e);
    return c.json({ success: false, error: '查询失败' }, 500);
  }
});

// POST /tickets/consume — 验票核销 { code }（storeId 由本端解析注入，不信 body）
route.post('/tickets/consume', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const body = (await c.req.json().catch(() => ({}))) ?? {};
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) return c.json({ success: false, error: '参数错误' }, 400);
    const { status, json } = await platformFetch('/api/wenlv/internal/tickets/consume-by-code', { method: 'POST', body: { code, storeId: g } });
    return c.json(json, status as any);
  } catch (e: any) {
    console.error('[wenlv-store] consume 意外错误', c.req.path, e);
    return c.json({ success: false, error: '核销失败' }, 500);
  }
});

// ===== 文创商品（M 码）—— B 端到店核销 / 发货 / 确认收货 =====
// GET /merch-redeems/by-code/:code — 预览（店员扫 M 码查兑换单）
route.get('/merch-redeems/by-code/:code', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const code = c.req.param('code');
    const [redeem] = await db.select().from(pmsBuiWenlvMerchRedeems).where(eq(pmsBuiWenlvMerchRedeems.claimCode, code)).limit(1);
    if (!redeem) return c.json({ success: false, error: '兑换码不存在' }, 404);
    const [reward] = redeem.rewardId
      ? await db.select({ name: pmsBuiWenlvRewards.name, merchandiseSku: pmsBuiWenlvRewards.merchandiseSku }).from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, redeem.rewardId)).limit(1)
      : [undefined];
    return c.json({ success: true, data: { ...redeem, rewardName: reward?.name ?? null, merchandiseSku: reward?.merchandiseSku ?? null } });
  } catch (e: any) {
    return serverError(c, e, '查询失败');
  }
});

// POST /merch-redeems/by-code/:code/redeem — 到店自提核销（pending → redeemed）
route.post('/merch-redeems/by-code/:code/redeem', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const code = c.req.param('code');
    const [redeem] = await db.update(pmsBuiWenlvMerchRedeems)
      .set({ status: 'redeemed', redeemedBy: currentUserId(c), redeemedStoreId: g, redeemedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pmsBuiWenlvMerchRedeems.claimCode, code), eq(pmsBuiWenlvMerchRedeems.status, 'pending')))
      .returning();
    if (redeem) return c.json({ success: true, data: redeem });
    const [cur] = await db.select().from(pmsBuiWenlvMerchRedeems).where(eq(pmsBuiWenlvMerchRedeems.claimCode, code)).limit(1);
    if (!cur) return c.json({ success: false, error: '兑换码不存在' }, 404);
    return c.json({ success: false, error: `该兑换码已${cur.status === 'redeemed' ? '核销' : cur.status === 'shipped' ? '发货' : cur.status === 'completed' ? '完成' : '处理'}` }, 409);
  } catch (e: any) {
    return serverError(c, e, '核销失败');
  }
});

// POST /merch-redeems/:id/ship — 快递发货（pending/redeemed → shipped）
route.post('/merch-redeems/:id/ship', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const [row] = await db.update(pmsBuiWenlvMerchRedeems)
      .set({ shipmentNo: body.shipmentNo ?? null, shipmentCarrier: body.shipmentCarrier ?? null, shippedAt: new Date(), status: 'shipped', updatedAt: new Date() })
      .where(eq(pmsBuiWenlvMerchRedeems.id, id))
      .returning();
    if (!row) return c.json({ success: false, error: '兑换记录不存在' }, 404);
    return c.json({ success: true, data: row });
  } catch (e: any) {
    return serverError(c, e, '发货失败');
  }
});

// POST /merch-redeems/:id/complete — 确认收货（shipped → completed）
route.post('/merch-redeems/:id/complete', async (c) => {
  try {
    const g = storeGuard(c);
    if (g instanceof Response) return g;
    const id = c.req.param('id');
    const [row] = await db.update(pmsBuiWenlvMerchRedeems)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(pmsBuiWenlvMerchRedeems.id, id))
      .returning();
    if (!row) return c.json({ success: false, error: '兑换记录不存在' }, 404);
    return c.json({ success: true, data: row });
  } catch (e: any) {
    return serverError(c, e, '操作失败');
  }
});

export default route;
