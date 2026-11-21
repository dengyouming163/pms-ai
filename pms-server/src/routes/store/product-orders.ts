import { Hono } from 'hono';
import type { Context } from 'hono';
import { getTenantScope } from '../../utils/tenant.js';
import { isAllStoresScope } from '../../utils/scope.js';
import { refundPlatformProductOrder, RefundError } from '../../services/product-refund.js';
import { serverError } from '../../lib/http-error.js';

// ============================================================
// 民宿端平台套餐订单代理路由 — 转发到 pms-platform-server
//
// 鉴权：store 员工 JWT（全局 authMiddleware 校验 Bearer）+ 门店租户隔离
// （tenantMiddleware 从 X-Store-Id Header / JWT homeStoreId 提取门店并校验门店权限）。
// 民宿端只连 pms-server(:9090)，通过 X-Internal-Token 代理调用平台(:9092)。
//
// 安全约束：
//  - 跨门店 IDOR（C1）：所有转发（列表/详情/接单/补尾款/核销）注入当前门店 storeId，
//    平台端按 order.storeId 归属校验；未分配门店的普通员工限制为空列表。
//    拒单走 money-first（product-refund 内部按 storeId 在 refund-quote 校验归属）。
//  - 预约可见性（Task3d）：列表只返回「已预约(reservationStatus=confirmed)」或
//    「已接单(status=store_accepted)」订单；详情同样做可见性过滤（I3），待预约订单不可见。
//  - 状态码透传（I2）：平台返回非 2xx（如业务拒绝 400/越权 403）时透传状态码，
//    避免被前端当成成功。
// ============================================================

const route = new Hono();
const PLATFORM_URL = 'http://pms-platform-server:9092';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';

/** 哨兵门店：未分配门店的普通员工 → 无任何门店访问权（列表返回空、操作一律 403） */
const NO_STORE = '__none__';

/**
 * 解析当前员工可操作的门店：
 * - 正常：返回当前门店 storeId（X-Store-Id Header / JWT homeStoreId）；
 * - 通配 '*'（未分配具体门店）：超管(scope=tenant)可跨店查看 → 返回 ''（不加门店过滤）；
 *   普通员工 → 返回哨兵 __none__（禁止访问任意门店数据）。
 */
function resolveStoreId(c: Context): string {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser') as { scope?: string } | undefined;
  const sid = scope.storeId && scope.storeId !== '*' ? scope.storeId : '';
  if (!sid) {
    // 全部门店（兼容 'tenant' 与历史中文值「全部门店」）→ 可跨店查看
    return isAllStoresScope(authUser?.scope) ? '' : NO_STORE;
  }
  return sid;
}

/** 平台订单对民宿端的可见性（预约可见性） */
function isVisibleToStore(order: any): boolean {
  if (!order || !order.id) return false;
  return order.reservationStatus === 'confirmed' || order.status === 'store_accepted';
}

/** 构建员工端套餐订单列表转发参数：scope=pending|done 用状态过滤，否则保持预约可见性（兼容存量调用方） */
export function buildStoreProductListQs(params: {
  storeId: string;
  scope?: string;
  keyword?: string;
  page?: string;
  limit?: string;
}): URLSearchParams {
  const qs = new URLSearchParams();
  if (params.storeId) qs.set('storeId', params.storeId);
  if (params.scope === 'pending' || params.scope === 'done') {
    qs.set('scope', params.scope);
  } else {
    // 预约可见性：只显示已预约或已接单（平台端按 confirmed|store_accepted 并集过滤）
    qs.set('reservationStatus', 'confirmed|store_accepted');
  }
  if (params.keyword) qs.set('keyword', params.keyword);
  qs.set('page', params.page || '1');
  qs.set('limit', params.limit || '20');
  return qs;
}

/** 代理请求到 pms-platform（支持 GET/POST/PUT，返回 { status, json } 以透传状态码） */
async function platformFetch(path: string, options?: { method?: string; body?: any }): Promise<{ status: number; json: any }> {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method: options?.method || 'GET',
    headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  return { status: res.status, json };
}

// ============================================================
// GET /api/store/product-orders — 民宿端平台套餐订单列表
// 只返回已预约/已接单的订单（预约可见性），按当前门店过滤 + 关键词/分页
// ============================================================
route.get('/', async (c) => {
  try {
    const storeId = resolveStoreId(c);
    // 未分配门店的普通员工 → 空列表
    if (storeId === NO_STORE) {
      return c.json({ success: true, list: [], data: [], total: 0 });
    }

    const keyword = c.req.query('keyword') || '';
    const scope = c.req.query('scope') || '';
    const page = c.req.query('page') || '1';
    const limit = c.req.query('limit') || '20';

    const qs = buildStoreProductListQs({ storeId, scope, keyword, page, limit });

    const { status, json } = await platformFetch(`/api/product-orders?${qs.toString()}`);
    return c.json(json, status as any);
  } catch (e: any) {
    return serverError(c, e, '加载订单列表失败');
  }
});

// ============================================================
// GET /api/store/product-orders/:id — 订单详情
// 门店归属（C1，平台校验）+ 可见性过滤（I3）：待预约/不可见订单经 id 直查也返回 404
// ============================================================
route.get('/:id', async (c) => {
  try {
    const storeId = resolveStoreId(c);
    const id = c.req.param('id');
    const qs = new URLSearchParams();
    if (storeId) qs.set('storeId', storeId);

    const { status, json } = await platformFetch(`/api/product-orders/${id}?${qs.toString()}`);
    // 平台已按 storeId 做归属校验（越权 403）；此处追加可见性校验（I3）
    if (json?.success === true && json?.data && !isVisibleToStore(json.data)) {
      return c.json({ success: false, error: '订单不可见' }, 404);
    }
    return c.json(json, status as any);
  } catch (e: any) {
    return serverError(c, e, '加载订单详情失败');
  }
});

// ============================================================
// POST /api/store/product-orders/:id/accept — 民宿接单
// 转发平台 PUT /:id/store-accept（platform_approved → store_accepted），注入 storeId 归属校验
// ============================================================
route.post('/:id/accept', async (c) => {
  try {
    const storeId = resolveStoreId(c);
    const id = c.req.param('id');
    const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    const { status, json } = await platformFetch(`/api/product-orders/${id}/store-accept${qs}`, { method: 'PUT' });
    return c.json(json, status as any);
  } catch (e: any) {
    return serverError(c, e, '接单失败');
  }
});

// ============================================================
// POST /api/store/product-orders/:id/reject — 民宿拒单（money-first：先真退钱再落定平台订单）
// 平台试算（refund-quote 内部按 storeId 校验门店归属，防 IDOR）→ 查支付单 → 金额封顶 →
// 标记 refunding → 调微信/抖音退款。资金最终态由退款回调落定（refund-confirm）。
// ============================================================
route.post('/:id/reject', async (c) => {
  try {
    const storeId = resolveStoreId(c);
    // 未分配门店的普通员工 → 拒绝操作（门店归属门禁；哨兵 ID 不发给平台）
    if (storeId === NO_STORE) return c.json({ success: false, error: '无门店操作权限' }, 403);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const data = await refundPlatformProductOrder(id, (body.reason || '民宿拒单').slice(0, 80), { storeId });
    return c.json({ success: true, data });
  } catch (e: any) {
    if (e instanceof RefundError) return c.json({ success: false, error: e.message }, e.status as any);
    return serverError(c, e, '退款失败');
  }
});

// ============================================================
// PUT /api/store/product-orders/:id/use — 核销（store_accepted → used，生成结算单）
// 模式A 订单需先补尾款（平台侧校验 balancePaidAt），否则返回 400 提示。
// 请求体可带 verifyCode（前台核销码）：订单有码时平台侧比对校验，无码（存量订单）不校验并补生成。
// ============================================================
route.put('/:id/use', async (c) => {
  try {
    const storeId = resolveStoreId(c);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    const { status, json } = await platformFetch(`/api/product-orders/${id}/use${qs}`, {
      method: 'PUT',
      // 数字/字符串类型兼容：请求体可能传 number（uni-app input type=number 返回字符串，但防御性处理）
      body: { verifyCode: body.verifyCode != null ? String(body.verifyCode) : undefined },
    });
    return c.json(json, status as any);
  } catch (e: any) {
    return serverError(c, e, '核销失败');
  }
});

// ============================================================
// PUT /api/store/product-orders/:id/pay-balance — 补尾款（仅模式A）
// ============================================================
route.put('/:id/pay-balance', async (c) => {
  try {
    const storeId = resolveStoreId(c);
    const id = c.req.param('id');
    const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    const { status, json } = await platformFetch(`/api/product-orders/${id}/pay-balance${qs}`, { method: 'PUT' });
    return c.json(json, status as any);
  } catch (e: any) {
    return serverError(c, e, '补尾款失败');
  }
});

export default route;
