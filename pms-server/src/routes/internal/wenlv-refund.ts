// 文旅退款内部端点（后台客服代退）：BFF 创作台 → 本端点。
// 鉴权由 /api/internal/* 的 internalAuthMiddleware 统一提供（X-Internal-Service-Token）。
// 归属：**必须由调用方（BFF 创作台）提供订单归属的 miniUserId** —— 下游第 1 步 getWenlvOrder 会带它回打
// BFF 的 GET /api/wenlv/orders/:id，而该端点 miniUserId 必填，缺失直接 400「参数错误」。
// 提供后归属仍由 getWenlvOrder 二次校验（不匹配即 404，fail-closed），此处不做信任假设。
import { Hono } from 'hono';
import { refundWenlvOrder, WenlvRefundError } from '../../services/wenlv-refund.js';

const route = new Hono();

route.post('/refund', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const orderId = String((body as any).orderId || '').trim();
  if (!orderId) return c.json({ success: false, error: '缺少 orderId' }, 400);
  const miniUserId = String((body as any).miniUserId || '').trim() || undefined;
  const reason = String((body as any).reason || '').trim() || '客服代退';
  try {
    const r = await refundWenlvOrder(orderId, { miniUserId, reason });
    return c.json({ success: true, data: r });
  } catch (e: any) {
    if (e instanceof WenlvRefundError) return c.json({ success: false, error: e.message }, e.status as 400);
    console.error('[internal/wenlv-refund] 退款异常', e);
    return c.json({ success: false, error: '退款失败，请稍后重试' }, 500);
  }
});

export default route;
