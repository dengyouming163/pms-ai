import { Hono } from 'hono';
import type { Context } from 'hono';
import { getTenantScope } from '../utils/tenant.js';
import { isAllStoresScope } from '../utils/scope.js';
import { INTERNAL_SERVICE_TOKEN } from '../constants.js';

// ============================================================
// 平台端配置代理路由（预订模式/取消政策/协议价）→ pms-platform-server
//
// 鉴权：全局 authMiddleware（Bearer JWT）+ 租户隔离（tenantMiddleware）。
// 门店归属（C1 跨门店 IDOR 修复）：storeId 一律以 getTenantScope 解析结果为准，
//   不信任客户端传入的 storeId —— 普通员工强制使用其门店，超管(tenant)可指定任意门店，
//   未分配门店的普通员工一律 403。平台端另有商品归属校验兜底。
// ============================================================

const route = new Hono();
const PLATFORM_URL = process.env.PLATFORM_SERVER_URL || 'http://pms-platform-server:9092';

/** 哨兵门店：未分配门店的普通员工 → 无任何门店配置权限 */
const NO_STORE = '__none__';

/**
 * 解析当前员工可配置的门店：
 * - 具体门店 → 返回该门店（强制以该门店为配置对象，覆盖客户端传入的 storeId）；
 * - 通配 '*'（未分配具体门店）：超管(scope=tenant) 可配置任意门店 → 返回 ''（用客户端指定 storeId）；
 *   普通员工 → 返回哨兵 __none__（禁止访问任意门店配置）。
 */
function resolveStoreId(c: Context): string {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser') as { scope?: string } | undefined;
  const sid = scope.storeId && scope.storeId !== '*' ? scope.storeId : '';
  if (!sid) {
    // 全部门店（兼容 'tenant' 与历史中文值「全部门店」）→ 可配置任意门店
    return isAllStoresScope(authUser?.scope) ? '' : NO_STORE;
  }
  return sid;
}

/** 计算最终用于转发的 storeId：具体门店强制覆盖；tenant 用客户端指定；未分配员工拒绝 */
function effectiveStoreId(c: Context, clientStoreId: string): { storeId: string; error?: Response } {
  const scoped = resolveStoreId(c);
  if (scoped === NO_STORE) {
    return {
      storeId: '',
      error: new Response(JSON.stringify({ success: false, error: '未分配门店，无配置权限' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
  if (scoped) return { storeId: scoped }; // 具体门店 → 覆盖客户端传入的 storeId
  return { storeId: clientStoreId }; // tenant → 使用客户端指定 storeId
}

/** 代理请求到 pms-platform（支持 GET/PUT，透传状态码与响应体） */
async function platformConfigFetch(path: string, options?: { method?: string; body?: any }): Promise<{ status: number; json: any }> {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method: options?.method || 'GET',
    headers: {
      'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ============================================================
// GET /api/platform/config/products — 商品列表（配置页选择商品用，按门店过滤）
// ============================================================
route.get('/products', async (c) => {
  const { storeId, error } = effectiveStoreId(c, c.req.query('storeId') || '');
  if (error) return error;
  // 只列「已上架」：这个列表是给商家选商品用的，而下单口
  // （pms-platform-server/src/routes/product-orders.ts:380 `product.status !== 'approved'`）
  // 会拒掉非 approved 的商品 —— 不筛的话草稿/已驳回/已下架/已删除的商品全都选得到、下不了单。
  const qs = new URLSearchParams({ storeId, status: 'approved' }).toString();
  const { status, json } = await platformConfigFetch(`/api/products?${qs}`);
  return c.json(json, status as any);
});

// ============================================================
// 预订模式配置 GET/PUT
// ============================================================
route.get('/booking-mode-config', async (c) => {
  const { storeId, error } = effectiveStoreId(c, c.req.query('storeId') || '');
  if (error) return error;
  const qs = new URLSearchParams({ storeId, productId: c.req.query('productId') || '' }).toString();
  const { status, json } = await platformConfigFetch(`/api/platform/config/booking-mode-config?${qs}`);
  return c.json(json, status as any);
});

route.put('/booking-mode-config', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { storeId, error } = effectiveStoreId(c, body.storeId || '');
  if (error) return error;
  const { status, json } = await platformConfigFetch('/api/platform/config/booking-mode-config', {
    method: 'PUT',
    body: { ...body, storeId },
  });
  return c.json(json, status as any);
});

// ============================================================
// 取消政策 GET/PUT
// ============================================================
route.get('/cancel-policy', async (c) => {
  const { storeId, error } = effectiveStoreId(c, c.req.query('storeId') || '');
  if (error) return error;
  const qs = new URLSearchParams({ storeId, productId: c.req.query('productId') || '' }).toString();
  const { status, json } = await platformConfigFetch(`/api/platform/config/cancel-policy?${qs}`);
  return c.json(json, status as any);
});

route.put('/cancel-policy', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { storeId, error } = effectiveStoreId(c, body.storeId || '');
  if (error) return error;
  const { status, json } = await platformConfigFetch('/api/platform/config/cancel-policy', {
    method: 'PUT',
    body: { ...body, storeId },
  });
  return c.json(json, status as any);
});

// ============================================================
// 协议价/分佣 GET/PUT
// ============================================================
route.get('/agreement-config', async (c) => {
  const { storeId, error } = effectiveStoreId(c, c.req.query('storeId') || '');
  if (error) return error;
  const qs = new URLSearchParams({ storeId, productId: c.req.query('productId') || '' }).toString();
  const { status, json } = await platformConfigFetch(`/api/platform/config/agreement-config?${qs}`);
  return c.json(json, status as any);
});

route.put('/agreement-config', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { storeId, error } = effectiveStoreId(c, body.storeId || '');
  if (error) return error;
  const { status, json } = await platformConfigFetch('/api/platform/config/agreement-config', {
    method: 'PUT',
    body: { ...body, storeId },
  });
  return c.json(json, status as any);
});

export default route;
