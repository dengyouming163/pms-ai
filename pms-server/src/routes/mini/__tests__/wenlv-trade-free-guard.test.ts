delete process.env.WENLV_BYPASS_TICKET;
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import tradeRoute from '../wenlv-trade.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvVenues } from '../../../db/schema/index.js';

const FREE = 'gfree-' + Date.now();
const PAID = 'gpaid-' + Date.now();
const VN = 'gvn-' + Date.now();          // 场地 id —— 见下面夹具处的 🔴
const TRADE_FREE = 'tr-free-' + Date.now();
const TRADE_PAID = 'tr-paid-' + Date.now();

// 平台侧桩：/api/wenlv/products 回两条交易产品；/api/wenlv/orders 记下是否被调用。
// 🔴 打桩点 = **全局 fetch**：wenlv-trade.ts 自带一个**本地** platformFetch（:16-32），
//    用全局 fetch 拼 `${PLATFORM_SERVER_URL}${path}` —— **不是** services/platform-client.ts 那份。
let orderPosted = false;
function stubPlatform() {
  orderPosted = false;
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    const j = (o: any) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/api/wenlv/products'))
      return j({ success: true, data: { list: [
        { id: TRADE_FREE, contentProductId: FREE, name: '免费剧本', price: '39.00', validDays: 30 },
        { id: TRADE_PAID, contentProductId: PAID, name: '付费剧本', price: '39.00', validDays: 30 },
      ] } });
    if (u.includes('/api/wenlv/orders')) { orderPosted = true; return j({ success: true, data: { order: { id: 'o1' } } }); }
    return j({ success: true, data: {} });
  }));
}

const mkMini = (id: string) => ({
  Authorization: `Bearer ${jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' })}`,
  'Content-Type': 'application/json',
});

// 夹具在**文件顶层**建立，供本段与 Task 6 段共用（两段同文件）
// 🔴 场地**必须插、且必须 `status:'live'`**（**本行原写「只插内容产品」是错的**，2026-09-28 订正）：
//    `wenlv-trade.ts` 的 `visible` 过滤器（在合并之后）有两条会把这些行**从列表里滤掉** ——
//    `if (!ct.venueId) return false`（无场地）与 `venueMap.get(ct.venueId)?.status === 'live'`（场地非运营）。
//    不插场地 ⇒ `list` 恒为空数组 ⇒ 下面 `find` 返回 `undefined` ⇒ 抛 TypeError，**看着像环境问题**。
//    ⚠️ 场地 `status` 列 **`notNull().default('lead')`**（`db/schema/wenlv.ts` 的 `pmsBuiWenlvVenues`）
//    —— 「线索」不是「已运营」，不显式写 `'live'` 就过不了闸。别与**产品**表的 `status` 默认 `'draft'` 混。
beforeAll(async () => {
  await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, FREE));
  await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PAID));
  await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VN));
  await db.insert(pmsBuiWenlvVenues).values({ id: VN, name: '免费剧本场地', status: 'live', city: '安顺' });
  await db.insert(pmsBuiWenlvProducts).values({ id: FREE, name: '免费', status: 'published', isFree: true, venueId: VN });
  await db.insert(pmsBuiWenlvProducts).values({ id: PAID, name: '付费', status: 'published', isFree: false, venueId: VN });
});
afterAll(async () => {
  await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, FREE));
  await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PAID));
  await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VN));
  vi.unstubAllGlobals();
});

describe.skipIf(!process.env.RUN_DB)('交易列表下发 isFree', () => {
  beforeAll(() => { stubPlatform(); });

  it('🔴 免登录可达，且免费/付费两条的 isFree 一真一假', async () => {
    // 不带 Authorization —— 该路径在 MINI_PUBLIC_PREFIXES 里（公开浏览）
    const res = await tradeRoute.request('/products');
    expect(res.status).toBe(200);                       // ← 「免登录可达」的判据，**不是** 401
    const list = (await res.json()).data.list;
    const free = list.find((p: any) => p.productId === TRADE_FREE);
    const paid = list.find((p: any) => p.productId === TRADE_PAID);
    // 🔴 先钉「两条都在列表里」，再断言字段：漏配场地（或场地非 live）时 `list` 是空数组，
    //    少了这两条，失败形态就退化成下一行的 `Cannot read properties of undefined` —— 看着像环境问题。
    expect(free, '免费那条必须在列表里（夹具的场地必须 live）').toBeTruthy();
    expect(paid, '付费那条必须在列表里').toBeTruthy();
    expect(free.isFree).toBe(true);
    expect(paid.isFree).toBe(false);                    // ← 阳性对照：不是「恒 true」
  });
});

const postOrder = (mini: string, body: any) =>
  tradeRoute.request('/orders', { method: 'POST', headers: mkMini(mini), body: JSON.stringify(body) });

describe.skipIf(!process.env.RUN_DB)('免费剧本 —— 单品下单守卫', () => {
  beforeEach(() => { stubPlatform(); });

  it('给免费剧本的单品下单 ⇒ 400，且**上游一单都没建**', async () => {
    const res = await postOrder('u1', { productId: TRADE_FREE, quantity: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('免费');
    expect(orderPosted).toBe(false);      // ← 关键：不是「建了再退」，是根本没发出去
  });

  it('给付费剧本的单品下单 ⇒ 照常透传（阳性对照）', async () => {
    const res = await postOrder('u1', { productId: TRADE_PAID, quantity: 1 });
    expect(res.status).toBe(200);
    expect(orderPosted).toBe(true);
  });

  it('套餐下单**不**受本守卫影响（免费剧本作赠品是合法构造）', async () => {
    const res = await postOrder('u1', { packageId: 'pkg-1', quantity: 1 });
    expect(res.status).toBe(200);
    expect(orderPosted).toBe(true);
  });
});
