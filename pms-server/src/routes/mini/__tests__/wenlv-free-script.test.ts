// 免费剧本：放行判定 + 试玩计数。
// 不设 WENLV_BYPASS_TICKET（防御性显式清掉，防 vitest pool 共用进程泄漏 env 造成假绿）。
delete process.env.WENLV_BYPASS_TICKET;
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvProgress, pmsBuiWenlvEvents } from '../../../db/schema/index.js';

const mkMini = (id: string) => ({
  Authorization: `Bearer ${jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' })}`,
  'Content-Type': 'application/json',
});
const postStart = (mini: string, productId: string) =>
  wenlvRoute.request(`/${productId}/start`, { method: 'POST', headers: mkMini(mini) });

// 🔴 免费用例的**核心判据**：把 fetch 换成一个「一被调用就抛」的桩。
//    assertTicket 若正确地在 `checkTicket` **之前**短路，fetch 一次都不会被调；
//    若写错顺序（先查票再查免费），fetch 会被调用 ⇒ 本用例**响亮地红**，而不是恰好绿。
function stubFetchMustNotBeCalled() {
  const spy = vi.fn(async () => { throw new Error('免费剧本不应调 checkTicket（不应产生任何跨服务请求）'); });
  vi.stubGlobal('fetch', spy);
  return spy;
}
function stubTicket(valid: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ success: true, data: { valid, ticketId: valid ? 'tk-free' : null } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

const FREE = 'free-' + Date.now();
const PAID = 'paid-' + Date.now();
const U = 'free-user';

// 🔴 必须带 skipIf：不加 --config vitest.local.config.ts 时 RUN_DB 未设，
//    这些用例会被**静默跳过**，而 vitest 的汇总行照样显示「全绿」。
describe.skipIf(!process.env.RUN_DB)('免费剧本 —— assertTicket 放行', () => {
  beforeAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, FREE));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PAID));
    await db.insert(pmsBuiWenlvProducts).values({ id: FREE, name: '免费测试', status: 'published', isFree: true });
    await db.insert(pmsBuiWenlvProducts).values({ id: PAID, name: '付费测试', status: 'published', isFree: false });
  });

  it('免费剧本 + 无票 ⇒ 200，且**一次 fetch 都不发**', async () => {
    const spy = stubFetchMustNotBeCalled();
    const res = await postStart(U, FREE);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(spy).not.toHaveBeenCalled();   // ← 这条才是「短路在 checkTicket 之前」的证据
  });

  it('付费剧本 + 无票 ⇒ 仍 403（阳性对照：断言没被整个拆掉）', async () => {
    stubTicket(false);
    const res = await postStart(U, PAID);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('请先购买门票券');
  });

  it('免费剧本 + NODE_ENV=production + 未设 WENLV_BYPASS_TICKET ⇒ 仍 200（走独立分支，不是借用旁路）', async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.WENLV_BYPASS_TICKET;    // 双守卫之一，显式关掉
    try {
      const spy = stubFetchMustNotBeCalled();
      const res = await postStart(U + '-prod', FREE);
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = old;
    }
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, FREE));
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PAID));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, FREE));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PAID));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, FREE));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PAID));
    vi.unstubAllGlobals();
  });
});

describe.skipIf(!process.env.RUN_DB)('免费剧本 —— visit_count 计数', () => {
  const P = 'cnt-' + Date.now();
  const U = 'cnt-user';
  const load = () => db.select({ v: pmsBuiWenlvProgress.visitCount, s: pmsBuiWenlvProgress.status })
    .from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.productId, P), eq(pmsBuiWenlvProgress.miniUserId, U)));

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '计数测试', status: 'published', isFree: true });
  });

  it('首次开始 ⇒ visit_count = 1', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('免费剧本不应发 fetch'); }));
    expect((await postStart(U, P)).status).toBe(200);
    expect((await load())[0].v).toBe(1);
  });

  it('再次进入 ⇒ visit_count = 2（且不重插行）', async () => {
    expect((await postStart(U, P)).status).toBe(200);
    const rows = await load();
    expect(rows.length).toBe(1);       // 幂等：仍是一行
    expect(rows[0].v).toBe(2);
  });

  it('第三次进入 ⇒ 3（递增不是恒 2）', async () => {
    expect((await postStart(U, P)).status).toBe(200);
    expect((await load())[0].v).toBe(3);
  });

  it('已通关回看 ⇒ visit_count **不变**（钉死「只读返回」契约）', async () => {
    await db.update(pmsBuiWenlvProgress).set({ status: 'completed', completedAt: new Date() })
      .where(and(eq(pmsBuiWenlvProgress.productId, P), eq(pmsBuiWenlvProgress.miniUserId, U)));
    const before = (await load())[0].v;
    expect(before).toBe(3);            // 🔴 前置自证：没有它，本条在实现缺失时会「0 == 0」假绿
    expect((await postStart(U, P)).status).toBe(200);
    expect((await load())[0].v).toBe(before);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, P));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    vi.unstubAllGlobals();
  });
});
