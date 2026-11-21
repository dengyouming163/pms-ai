import { describe, it, expect, vi, afterEach } from 'vitest';
import { getWenlvOrder, confirmWenlvOrderPaid, getWenlvOrderByLeaderCode, transferWenlvTicket, returnWenlvTicket } from '../platform-client.js';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';

afterEach(() => vi.unstubAllGlobals());

describe('platform-client 文旅订单客户端', () => {
  it('getWenlvOrder 带 X-Internal-Token 且 URL 含 miniUserId 归属参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { id: 'o1', productName: '龙门镇·武侠' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const r = await getWenlvOrder('o1', 'u1');
    expect(r.ok).toBe(true);
    expect(r.data.data.productName).toBe('龙门镇·武侠');
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method?: string; headers: Record<string, string | undefined> }];
    expect(url).toContain('/api/wenlv/orders/o1');
    expect(url).toContain('miniUserId=u1');
    expect(opts.headers['X-Internal-Token']).toBe(INTERNAL_SERVICE_TOKEN);
  });

  it('confirmWenlvOrderPaid POST 到 pay-confirm 且携带 transactionId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { activated: 1 } }) });
    vi.stubGlobal('fetch', fetchMock);
    await confirmWenlvOrderPaid('o1', 'txn1');
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method?: string; body?: string }];
    expect(url).toContain('/api/wenlv/orders/o1/pay-confirm');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body!)).toEqual({ transactionId: 'txn1' });
  });

  it('confirmWenlvOrderPaid 回读响应体的 seatReacquireFailed 与 miniUserId（D1）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { orderId: 'o1', activated: 0, reversed: false, seatReacquireFailed: true, miniUserId: 'u1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await confirmWenlvOrderPaid('o1', 'txn1');
    expect(r.ok).toBe(true);
    expect(r.data.data.seatReacquireFailed).toBe(true);
    expect(r.data.data.miniUserId).toBe('u1');
  });
});

describe('platform-client 团队准入客户端（P2）', () => {
  it('getWenlvOrderByLeaderCode 打 /api/wenlv/internal/orders/by-leader-code 且带 code 与内部 token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { orderId: 'o1', status: 'paid', contentProductId: 'cp1', availableTicketCount: 3 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await getWenlvOrderByLeaderCode('ABCD2345WXYZ');
    expect(r.ok).toBe(true);
    expect(r.data.data.availableTicketCount).toBe(3);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string | undefined> }];
    // 🔴 整条路径都要断：漏掉 `/api/wenlv` 前缀在生产是静默 404（本机单测打桩照样绿）
    expect(url).toBe('http://pms-platform-server:9092/api/wenlv/internal/orders/by-leader-code?code=ABCD2345WXYZ');
    expect(opts.headers['X-Internal-Token']).toBe(INTERNAL_SERVICE_TOKEN);
  });

  it('transferWenlvTicket POST 到 /internal/tickets/transfer 且 409 时 ok=false、status 原样', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: '本场名额已满' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await transferWenlvTicket('o1', 'u-member-1');
    // 调用方（Task 7 的 join）就是靠这两个字段区分「满员 409」与「上游挂了 status=0」
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method?: string; body?: string }];
    expect(url).toBe('http://pms-platform-server:9092/api/wenlv/internal/tickets/transfer');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body!)).toEqual({ orderId: 'o1', toMiniUserId: 'u-member-1' });
  });

  it('returnWenlvTicket POST 到 /internal/tickets/return 且带 fromMiniUserId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { returned: true } }) });
    vi.stubGlobal('fetch', fetchMock);
    const r = await returnWenlvTicket('o1', 'u-member-1');
    expect(r.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method?: string; body?: string }];
    expect(url).toBe('http://pms-platform-server:9092/api/wenlv/internal/tickets/return');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body!)).toEqual({ orderId: 'o1', fromMiniUserId: 'u-member-1' });
  });
});
