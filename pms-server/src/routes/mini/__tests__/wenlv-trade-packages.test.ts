// C 端文旅交易代理的套餐贯通（无 DB：断言代理出的**出站请求形状**）。
// 骨架与 `wenlv-trade-slots.test.ts` 同款（`vi.stubGlobal('fetch')` + `route.request`）。
//
// ⚠️ MINI_JWT_SECRET 不在 constants.ts 的顶层 eager 读取里 —— parseMiniToken 请求时经
// requireEnv('MINI_JWT_SECRET') 取 ⇒ 本行赋值只需早于首个 route.request()。
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

describe('GET /packages 代理', () => {
  it('🔴 打上游 /api/wenlv/packages，且**不透传** includeUnavailable', async () => {
    // 两句一起才是判据：只断言「打了 /packages」的话，把 query 原样透传出去也照样绿；
    // 而 `includeUnavailable` 是「给运营看全量」的开关，C 端恒取服务端默认 ⇒ 不许出现在出站 URL 里。
    await route.request('/packages?includeUnavailable=1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/wenlv\/packages$/);
    expect(String(url)).not.toContain('includeUnavailable');
    expect((init as any).headers['X-Internal-Token']).toBeTruthy();
  });
});

describe('POST /orders 透传 packageId（二选一仍归交易层）', () => {
  it('🔴 带 packageId ⇒ 出站 body 含该 packageId，且 productId 键不出现', async () => {
    await route.request('/orders', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ packageId: 'pk-1', quantity: 1, slotId: 's-1' }),
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    // Task 11 收口：白名单 body 恒带服务端算出的 premium（套餐单不合成溢价 ⇒ 恒 0，BFF 套餐分支不读）。
    expect(body).toEqual({ packageId: 'pk-1', quantity: 1, slotId: 's-1', miniUserId: 'u-mini-1', premium: 0 });
  });

  it('两个都不给 ⇒ 两个键都不出现（BFF 不替交易层判二选一）', async () => {
    await route.request('/orders', {
      method: 'POST', headers: AUTH, body: JSON.stringify({ quantity: 1 }),
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(Object.prototype.hasOwnProperty.call(body, 'productId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'packageId')).toBe(false);
  });

  it('🔴 夹具里的杂散字段不得进白名单（实现改成 `...body` 时此用例即红）', async () => {
    await route.request('/orders', {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ packageId: 'pk-1', quantity: 1, slotId: 's-1', note: 'attacker', price: 0.01 }),
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    // 杂散字段（note/price）仍不得进白名单；premium 是**服务端算出**的合法键，恒在。
    expect(body).toEqual({ packageId: 'pk-1', quantity: 1, slotId: 's-1', miniUserId: 'u-mini-1', premium: 0 });
  });
});
