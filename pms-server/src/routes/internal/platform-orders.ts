// 平台套餐订单 → pms 住宿订单联动内部回调端点（需 internalAuthMiddleware，见 index.ts）
// 协议见 spec §5.5：reservation-confirmed / used / cancelled / refunded。
// 全部幂等：重复调用返回成功，无副作用（转化/联动内部以 platform_order_id 唯一索引 + 条件更新保证）。
import { Hono } from 'hono';
import { z } from 'zod';
import { getPlatformProductOrder } from '../../services/platform-client.js';
import { createStayOrderFromPlatform, linkPlatformStayOrder } from '../../services/platform-order-converter.js';

const route = new Hono();

const orderIdSchema = z.object({ orderId: z.string().min(1, 'orderId 不能为空') });

/** 校验 orderId + 回源拉取平台订单（不信任 body 中的订单字段） */
async function fetchOrder(c: any, body: any): Promise<{ order: any } | Response> {
  const parsed = orderIdSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: '缺少 orderId' }, 400);
  const res = await getPlatformProductOrder(parsed.data.orderId);
  if (!res.ok || !res.data?.data) return c.json({ success: false, error: '平台订单不存在' }, 404);
  return { order: res.data.data };
}

/** 预约确认（reservation-approve 成功后回调）：生成住宿订单（status=confirmed，占房态）；已核销则初始即 checked_in */
route.post('/reservation-confirmed', async (c) => {
  const r = await fetchOrder(c, await c.req.json().catch(() => ({})));
  if (r instanceof Response) return r;
  const { order } = r;
  if (order.reservationStatus !== 'confirmed') {
    return c.json({ success: false, error: '订单尚未预约确认' }, 400);
  }
  const initialStatus = order.status === 'used' ? 'checked_in' : 'confirmed';
  const res = await createStayOrderFromPlatform(order, { initialStatus });
  return c.json({ success: true, data: { stayOrderId: res.id, created: res.created } });
});

/** 核销（use 成功后回调）：住宿订单 → checked_in（不存在则补转化生成） */
route.post('/used', async (c) => {
  const r = await fetchOrder(c, await c.req.json().catch(() => ({})));
  if (r instanceof Response) return r;
  const { order } = r;
  if (order.status !== 'used') return c.json({ success: false, error: '订单未核销' }, 400);
  const res = await linkPlatformStayOrder(order, 'checked_in');
  return c.json({ success: true, data: { handled: res.handled, stayOrderId: res.id } });
});

/** 取消（cancel 成功后回调，安全网）：已生成住宿订单 → cancelled */
route.post('/cancelled', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await fetchOrder(c, body);
  if (r instanceof Response) return r;
  const { order } = r;
  if (order.status !== 'cancelled') return c.json({ success: false, error: '订单未取消' }, 400);
  await linkPlatformStayOrder(order, 'cancelled', body.reason || '平台订单取消');
  return c.json({ success: true });
});

/** 退款落定（refund-confirm 后回调，安全网）：已生成住宿订单 → cancelled */
route.post('/refunded', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const r = await fetchOrder(c, body);
  if (r instanceof Response) return r;
  const { order } = r;
  if (order.status !== 'refunded') return c.json({ success: false, error: '订单未退款' }, 400);
  await linkPlatformStayOrder(order, 'cancelled', body.reason || '平台订单退款');
  return c.json({ success: true });
});

export default route;
