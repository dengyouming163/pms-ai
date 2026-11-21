// 平台端内部接口客户端（pms-platform-server）
// 项目规范：跨模块仅走 HTTP + INTERNAL_SERVICE_TOKEN，禁止直接 import 平台代码 / 跨 schema 直查平台表。
// 平台服务地址：Docker 网络内 pms-platform-server:9092；本地/其他部署可用 PLATFORM_SERVER_URL 覆盖。
// 鉴权 Token 复用 constants.ts 的 INTERNAL_SERVICE_TOKEN（未配置即启动失败，避免空 Token 静默 401 导致支付回调永久重试）。

import { INTERNAL_SERVICE_TOKEN } from '../constants.js';

const PLATFORM_URL = process.env.PLATFORM_SERVER_URL || 'http://pms-platform-server:9092';

export interface PlatformResult {
  ok: boolean;
  status: number;
  data?: any;
}

/** 通用平台内部请求（X-Internal-Token 鉴权；默认 10s 超时）；业务 success===false 或非 2xx 均视为失败
 *  @param options.timeoutMs 覆盖默认超时。**只在能容忍降级的读路径上传**（见 routes/mini/unified-orders.ts）：
 *         平台真需要更长时，本路径会显示成「降级」而不是等它 —— 这是刻意的取舍。 */
async function platformFetch(
  path: string,
  options?: { method?: string; body?: any; timeoutMs?: number },
): Promise<PlatformResult> {
  try {
    const res = await fetch(`${PLATFORM_URL}${path}`, {
      method: options?.method || 'GET',
      headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN, 'Content-Type': 'application/json' },
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data?.success !== false, status: res.status, data };
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: e?.message || '平台接口调用失败' } };
  }
}

/** 仅供测试：把私有函数暴露成可注入 timeoutMs 的入口（生产代码请直接用下面的具名读口） */
export const platformFetchForTest = platformFetch;

/** 查询平台套餐订单（服务端取价，创建支付单前用）。返回体 data.data 为订单对象 */
export function getPlatformProductOrder(orderId: string, miniUserId?: string): Promise<PlatformResult> {
  const qs = miniUserId ? `?miniUserId=${encodeURIComponent(miniUserId)}` : '';
  return platformFetch(`/api/product-orders/${orderId}${qs}`);
}

/**
 * 分页拉取平台预约已确认（reservationStatus=confirmed）的套餐订单。
 * 平台列表接口支持 reservationStatus 过滤但不支持按 reservationDate 过滤，
 * 故分页遍历全部 confirmed 订单，由调用方（入住提醒调度器）在本地按入住日期筛选。
 * @param pageSize 每页条数；页面无数据或非 2xx 时提前结束
 */
export async function listConfirmedProductOrders(pageSize = 200): Promise<any[]> {
  const orders: any[] = [];
  let page = 1;
  while (page <= 50) {
    const res = await platformFetch(`/api/product-orders?reservationStatus=confirmed&page=${page}&limit=${pageSize}`);
    if (!res.ok) {
      console.error(`[platform-client] 拉取 confirmed 订单失败 status=${res.status}`, res.data?.error || '');
      break;
    }
    const batch: any[] = res.data?.list ?? [];
    orders.push(...batch);
    if (batch.length < pageSize) break;
    page++;
  }
  return orders;
}

/**
 * 分页拉取平台已核销（status='used'）的套餐订单。
 * 平台列表接口支持 status 过滤但不支持按 usedAt 过滤，
 * 故分页遍历全部 used 订单，由调用方（离店回访调度器）在本地按「离店 1h」时间窗筛选。
 * @param pageSize 每页条数；页面无数据或非 2xx 时提前结束
 */
export async function listUsedProductOrders(pageSize = 200): Promise<any[]> {
  const orders: any[] = [];
  let page = 1;
  while (page <= 50) {
    const res = await platformFetch(`/api/product-orders?status=used&page=${page}&limit=${pageSize}`);
    if (!res.ok) {
      console.error(`[platform-client] 拉取 used 订单失败 status=${res.status}`, res.data?.error || '');
      break;
    }
    const batch: any[] = res.data?.list ?? [];
    orders.push(...batch);
    if (batch.length < pageSize) break;
    page++;
  }
  return orders;
}

/** 平台订单支付确认（幂等）：pending+unpaid → paid。供支付回调（微信/抖音）调用 */
export function confirmPlatformProductOrderPaid(orderId: string, transactionId?: string): Promise<PlatformResult> {
  return platformFetch(`/api/product-orders/${orderId}/pay-confirm`, {
    method: 'POST',
    body: transactionId ? { transactionId } : {},
  });
}

/** 平台退款试算（不写库）：返回体 data.data.refundAmount */
export function getPlatformProductOrderRefundQuote(orderId: string, storeId?: string): Promise<PlatformResult> {
  const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
  return platformFetch(`/api/product-orders/${orderId}/refund-quote${qs}`, { method: 'GET' });
}

/** 平台退款成功落定（幂等）：退款回调后确认订单 refunded */
export function confirmPlatformProductOrderRefund(orderId: string, reason: string, refundAmount: number): Promise<PlatformResult> {
  return platformFetch(`/api/product-orders/${orderId}/refund-confirm`, {
    method: 'POST',
    body: { reason, refundAmount },
  });
}

/** 查询平台商品（用于转化服务解析商品关联房型 extraAttrs.roomTypeIds；失败返回 null） */
export async function getPlatformProduct(productId: string): Promise<any | null> {
  const res = await platformFetch(`/api/products/${productId}`);
  if (!res.ok || !res.data) return null;
  return res.data?.data ?? null;
}

/** 查询文旅订单（服务端取价/描述/归属校验用）。返回体 data.data 为订单对象（含 productName/tickets） */
export function getWenlvOrder(orderId: string, miniUserId?: string): Promise<PlatformResult> {
  const qs = miniUserId ? `?miniUserId=${encodeURIComponent(miniUserId)}` : '';
  return platformFetch(`/api/wenlv/orders/${orderId}${qs}`);
}

/** 我的文旅订单列表（C 端合并列表用）。返回体 `data.data` = `{ list, total }`，每行含 productName。
 *  与 getWenlvOrder 同路：platformFetch 恒带 X-Internal-Token。 */
export function listWenlvOrders(miniUserId: string, timeoutMs?: number): Promise<PlatformResult> {
  return platformFetch(`/api/wenlv/orders?miniUserId=${encodeURIComponent(miniUserId)}`, { timeoutMs });
}

/** 文旅订单支付确认（幂等）：pending+unpaid → paid 并激活券。供微信支付回调调用 */
export function confirmWenlvOrderPaid(orderId: string, transactionId?: string): Promise<PlatformResult> {
  return platformFetch(`/api/wenlv/orders/${orderId}/pay-confirm`, {
    method: 'POST',
    body: transactionId ? { transactionId } : {},
  });
}

/** 文旅退款预留 + 复核（pms-server 编排第 6 步）：可退时 BFF 侧 CAS 订单 paid→refunding */
export function getWenlvOrderRefundCheck(orderId: string, miniUserId?: string): Promise<PlatformResult> {
  const qs = miniUserId ? `?miniUserId=${encodeURIComponent(miniUserId)}` : '';
  return platformFetch(`/api/wenlv/orders/${orderId}/refund-check${qs}`);
}

/** 文旅退款落定（幂等）：微信退款回调后确认订单 refunded + 券 refunded */
export function confirmWenlvOrderRefund(orderId: string, reason: string, refundAmount: number): Promise<PlatformResult> {
  return platformFetch(`/api/wenlv/orders/${orderId}/refund-confirm`, {
    method: 'POST',
    body: { reason, refundAmount },
  });
}

/** 文旅退款回滚：渠道明确拒绝时把订单 refunding→paid，让用户可重试（状态不明时不得调用） */
export function revertWenlvOrderRefund(orderId: string, reason?: string): Promise<PlatformResult> {
  return platformFetch(`/api/wenlv/orders/${orderId}/refund-revert`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

/** 领队码 → 订单（P2 团队准入）。无此码 ⇒ 404（ok=false、status=404） */
export function getWenlvOrderByLeaderCode(leaderCode: string): Promise<PlatformResult> {
  return platformFetch(`/api/wenlv/internal/orders/by-leader-code?code=${encodeURIComponent(leaderCode)}`);
}

/** 票随人走：从该订单票池取一张**可用**票改挂 toMiniUserId（幂等；池空 ⇒ 409） */
export function transferWenlvTicket(orderId: string, toMiniUserId: string): Promise<PlatformResult> {
  return platformFetch('/api/wenlv/internal/tickets/transfer', { method: 'POST', body: { orderId, toMiniUserId } });
}

/** 退票回池：把 fromMiniUserId 名下该订单的票改回 orders.mini_user_id（幂等；已核销 ⇒ 409） */
export function returnWenlvTicket(orderId: string, fromMiniUserId: string): Promise<PlatformResult> {
  return platformFetch('/api/wenlv/internal/tickets/return', { method: 'POST', body: { orderId, fromMiniUserId } });
}

/**
 * 我的套餐产品订单（第三来源；C 端合并列表用）。
 * 🔴 该端点的信封是 `{ success, list, data }` —— **list 在信封顶层**，
 *    与 `listWenlvOrders` 的 `data.data.list` **不是一个形状**。
 *    平台侧原文见 pms-platform/pms-platform-server/src/routes/product-orders.ts 的 `productOrdersRoute.get('/')` 的 return。
 *    照抄文旅那边的 `r.data?.data?.list` ⇒ 本来源恒降级（不报错，只是订单页少一整类单）。
 */
export function listProductOrders(miniUserId: string, limit = 50, timeoutMs?: number): Promise<PlatformResult> {
  // 🔴 平台该端点是 `if (miniUserId) conditions.push(...)` ⇒ 空值**不过滤**，`.where(undefined)` 会返回至多 limit 条**任意用户**的订单（含 guestName/guestPhone）；另两个读口由平台侧 400 兜住，只有这个要自守
  if (!miniUserId) return Promise.resolve({ ok: false, status: 400, data: { error: '缺少 miniUserId' } });
  return platformFetch(`/api/product-orders?miniUserId=${encodeURIComponent(miniUserId)}&limit=${limit}`, { timeoutMs });
}

/**
 * 我的文旅券列表（券列表的数据源）。信封与文旅订单同族：`data.data.list`，
 * 每行含 contentProductId / productId / productName / status / expiresAt / isGifted。
 * 平台侧原文见 pms-platform/pms-platform-server/src/routes/wenlv.ts 的 `wenlvRoute.get('/tickets')`。
 */
export function listWenlvTickets(miniUserId: string): Promise<PlatformResult> {
  return platformFetch(`/api/wenlv/tickets?miniUserId=${encodeURIComponent(miniUserId)}`);
}
