// C 端文旅交易代理的场次贯通（无 DB：断言代理出的出站请求形状）
//
// ⚠️ MINI_JWT_SECRET 不在 constants.ts 的顶层 eager 读取里 —— parseMiniToken 请求时经
// requireEnv('MINI_JWT_SECRET') 取 ⇒ 本行赋值只需早于首个 route.request()。
//
// ⚠️ 本仓**没有** signMiniToken 之类的造 token 辅助函数 —— `middleware/mini-auth.ts`
// 是解析侧的（`parseMiniToken` / `miniAuthMiddleware` / `getMiniUser` / `isMiniPath` 等）。
// 既有测试一律自己 jwt.sign —— 这里照做。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import route from '../wenlv-trade.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const mkMini = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json' };
};
const AUTH = mkMini('u-mini-1');

const jsonResp = (obj: any) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonResp({ success: true, data: { list: [], total: 0 } }));
});

describe('GET /slots 代理', () => {
  it('缺 productId → 400，且不打上游', async () => {
    const res = await route.request('/slots');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('打上游 /api/wenlv/slots 并带 from 与内部 token', async () => {
    await route.request('/slots?productId=abc-123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/wenlv/slots?productId=abc-123');
    expect(String(url)).toContain('from=');
    expect((init as any).headers['X-Internal-Token']).toBeTruthy();
  });

  it('productId 被 URL 编码（含特殊字符不会拼坏上游查询串）', async () => {
    await route.request('/slots?productId=' + encodeURIComponent('a b&c=d'));
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('productId=a%20b%26c%3Dd');
  });
});

describe('POST /orders 透传 slotId', () => {
  // 🔴 别再用 `calls[0]`：POST /orders 现在会**先打一次上游产品列表**（免费剧本单品下单守卫，
  //    见 wenlv-trade.ts），所以第 0 次出站调用不一定还是这次下单。按 URL 定位，不依赖顺序。
  // 🔴 用 `for...of`，别写成 `.find((c) => …)` —— 后者会让 `c` 报 TS7006
  //    （`fetchMock` 是裸 `vi.fn()`；本仓 `ts-check` = `tsc --noEmit` 覆盖测试文件）。
  const orderBody = (): any => {
    for (const c of fetchMock.mock.calls) {
      if (String(c[0]).includes('/api/wenlv/orders')) return JSON.parse((c[1] as any).body);
    }
    throw new Error('没有找到 /api/wenlv/orders 的出站调用');
  };
  it('带 slotId → 出站 body 含该 slotId', async () => {
    await route.request('/orders', { method: 'POST', headers: AUTH, body: JSON.stringify({ productId: 'p-1', quantity: 2, slotId: 's-1' }) });
    const body = orderBody();
    // Task 11 收口：白名单 body 恒带服务端算出的 premium（本桩未配内容行 ⇒ 钳 0）。
    expect(body).toEqual({ productId: 'p-1', quantity: 2, slotId: 's-1', miniUserId: 'u-mini-1', premium: 0 });
  });

  it('不带 slotId → 出站是显式 null（不能是 undefined，否则被 JSON.stringify 丢掉、key 消失）', async () => {
    await route.request('/orders', { method: 'POST', headers: AUTH, body: JSON.stringify({ productId: 'p-1', quantity: 1 }) });
    const body = orderBody();
    expect(body.slotId).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(body, 'slotId')).toBe(true);
  });

  it('🔴 请求体里的 miniUserId 被忽略，一律用 token 里的那个', async () => {
    await route.request('/orders', { method: 'POST', headers: AUTH, body: JSON.stringify({ productId: 'p-1', miniUserId: 'u-attacker' }) });
    const body = orderBody();
    expect(body.miniUserId).toBe('u-mini-1');
  });

  it('未登录 → 401，且不打上游', async () => {
    const res = await route.request('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上游 409（场次已满）→ 状态码与 error 原样透传给 C 端', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ success: false, error: '场次已满或不可预订' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ));
    const res = await route.request('/orders', { method: 'POST', headers: AUTH, body: JSON.stringify({ productId: 'p-1', quantity: 1, slotId: 's-1' }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('场次已满或不可预订');
  });
});
