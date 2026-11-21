import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { internalAuthMiddleware } from '../../../middleware/internal-auth.js';
import route from '../platform-orders.js';

// mock 外部依赖：回调端点只做编排，不直连平台/DB
vi.mock('../../../services/platform-client.js', () => ({ getPlatformProductOrder: vi.fn() }));
vi.mock('../../../services/platform-order-converter.js', () => ({
  createStayOrderFromPlatform: vi.fn(),
  linkPlatformStayOrder: vi.fn(),
}));

import { getPlatformProductOrder } from '../../../services/platform-client.js';
import { createStayOrderFromPlatform, linkPlatformStayOrder } from '../../../services/platform-order-converter.js';

const app = new Hono();
app.use('*', internalAuthMiddleware);
app.route('/api/internal/platform/order', route);

const authHeaders = { 'Content-Type': 'application/json', 'X-Internal-Service-Token': 'test-internal-token' };
const confirmedOrder = {
  id: 'po_1', orderNo: 'PROD1', storeId: 'store_1', productId: 'prod_1', miniUserId: 'mini_1',
  guestName: '张三', guestPhone: '13800000001', productName: '豪华大床房套餐', roomNights: 2,
  totalAmount: '299', reservationDate: '2026-08-20', verifyCode: '123456',
  status: 'platform_approved', reservationStatus: 'confirmed',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/internal/platform/order/*', () => {
  it('无内部 Token → 403（internalAuthMiddleware 校验 X-Internal-Service-Token，缺失/错误均 403）', async () => {
    const res = await app.request('/api/internal/platform/order/reservation-confirmed', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: 'po_1' }),
    });
    expect(res.status).toBe(403);
  });
  it('缺 orderId → 400', async () => {
    const res = await app.request('/api/internal/platform/order/reservation-confirmed', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
  it('reservation-confirmed：订单未预约确认 → 400', async () => {
    (getPlatformProductOrder as any).mockResolvedValue({
      ok: true, status: 200, data: { data: { ...confirmedOrder, reservationStatus: 'submitted' } },
    });
    const res = await app.request('/api/internal/platform/order/reservation-confirmed', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: 'po_1' }),
    });
    expect(res.status).toBe(400);
  });
  it('reservation-confirmed：已确认 → 调转化服务并返回 id', async () => {
    (getPlatformProductOrder as any).mockResolvedValue({ ok: true, status: 200, data: { data: confirmedOrder } });
    (createStayOrderFromPlatform as any).mockResolvedValue({ id: 'ord_x', created: true });
    const res = await app.request('/api/internal/platform/order/reservation-confirmed', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: 'po_1' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.stayOrderId).toBe('ord_x');
    expect(createStayOrderFromPlatform).toHaveBeenCalledTimes(1);
  });
  it('used：订单已核销 → linkPlatformStayOrder(checked_in)', async () => {
    (getPlatformProductOrder as any).mockResolvedValue({
      ok: true, status: 200, data: { data: { ...confirmedOrder, status: 'used' } },
    });
    (linkPlatformStayOrder as any).mockResolvedValue({ handled: true, id: 'ord_x' });
    const res = await app.request('/api/internal/platform/order/used', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: 'po_1' }),
    });
    const json = await res.json();
    expect(json.data.handled).toBe(true);
    expect(linkPlatformStayOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'po_1' }), 'checked_in');
  });
  it('cancelled：订单已取消 → linkPlatformStayOrder(cancelled, reason)', async () => {
    (getPlatformProductOrder as any).mockResolvedValue({
      ok: true, status: 200, data: { data: { ...confirmedOrder, status: 'cancelled' } },
    });
    const res = await app.request('/api/internal/platform/order/cancelled', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: 'po_1', reason: '用户取消' }),
    });
    expect(res.status).toBe(200);
    expect(linkPlatformStayOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'po_1' }), 'cancelled', '用户取消');
  });
  it('refunded：订单已退款 → linkPlatformStayOrder(cancelled, reason)', async () => {
    (getPlatformProductOrder as any).mockResolvedValue({
      ok: true, status: 200, data: { data: { ...confirmedOrder, status: 'refunded' } },
    });
    const res = await app.request('/api/internal/platform/order/refunded', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: 'po_1', reason: '退款' }),
    });
    expect(res.status).toBe(200);
    expect(linkPlatformStayOrder).toHaveBeenCalledWith(expect.objectContaining({ id: 'po_1' }), 'cancelled', '退款');
  });
  it('平台订单不存在 → 404', async () => {
    (getPlatformProductOrder as any).mockResolvedValue({ ok: false, status: 404, data: { error: 'not found' } });
    const res = await app.request('/api/internal/platform/order/used', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ orderId: 'po_x' }),
    });
    expect(res.status).toBe(404);
  });
});
