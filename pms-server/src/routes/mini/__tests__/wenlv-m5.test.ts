// M5 已完成用户可回看：独立测试文件。
// 不设 WENLV_BYPASS_TICKET（同目录 wenlv.test.ts 设了会旁路门票断言使 completed 用例即使未修复也绿；
// 但会让 active 无票期望 403 的用例反向变红）。
// 用 fetch 桩把 checkTicket 结果钉死为 invalid/valid。
// 防御性兜底：显式清掉旁路 env，防日后 vitest pool 共用进程泄漏 env 使 completed 用例假绿。
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
const jsonResp = (obj: any) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
function stubTicket(valid: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResp({ success: true, data: { valid, ticketId: valid ? 'tk-m5' : null } })));
}

const PRODUCT = 'm5-' + Date.now();
const DONE_USER = 'm5-done';
const ACTIVE_USER = 'm5-active';
const postStart = (mini: string, productId: string) =>
  wenlvRoute.request(`/${productId}/start`, { method: 'POST', headers: mkMini(mini) });
// 记录「进行中用户持有效票首建」返回的 progress id，供重进幂等用例断言返既有行
let activeProgressId = '';

describe('M5 start 放行已通关用户（DB）', () => {
  beforeAll(async () => {
    stubTicket(false); // 默认无有效票
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: 'M5测试', status: 'published', mode: 'narrative' });
    await db.insert(pmsBuiWenlvProgress).values({
      id: 'm5-prg-done', productId: PRODUCT, miniUserId: DONE_USER, status: 'completed',
      endingId: 'm5-ending', completedAt: new Date(), state: { visited: {}, collected: {}, completed: {} },
    });
  });

  it('已通关用户无有效票重进 → 200 返回既有进度（可回看）', async () => {
    const res = await postStart(DONE_USER, PRODUCT);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data).toMatchObject({ miniUserId: DONE_USER, status: 'completed' });
  });

  it('进行中用户无有效票 → 403 付费墙', async () => {
    const res = await postStart(ACTIVE_USER, PRODUCT);
    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
  });

  it('进行中用户持有效票 → 200 并建进度', async () => {
    stubTicket(true);
    const res = await postStart(ACTIVE_USER, PRODUCT);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data).toMatchObject({ miniUserId: ACTIVE_USER, status: 'active' });
    activeProgressId = b.data.id; // 记录首次建行 id，供重进幂等断言
  });

  it('已通关用户持有效票 → 200 只读返回既有进度（早退在 assertTicket 前，不重插行）', async () => {
    stubTicket(true); // completed 早退本就先于 assertTicket，即便有票也不走到票券断言
    const res = await postStart(DONE_USER, PRODUCT);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data).toMatchObject({ miniUserId: DONE_USER, status: 'completed' });
    // 不重插行：completed 行仍只一条（重插会撞 uq_wenlv_progress_solo 唯一索引 500）
    const rows = await db.select({ id: pmsBuiWenlvProgress.id }).from(pmsBuiWenlvProgress)
      .where(and(eq(pmsBuiWenlvProgress.productId, PRODUCT), eq(pmsBuiWenlvProgress.miniUserId, DONE_USER)));
    expect(rows.length).toBe(1);
  });

  it('进行中用户持有效票重进 → 200 返回既有 active 不重插（幂等分支）', async () => {
    stubTicket(true);
    expect(activeProgressId).toBeTruthy(); // 前置：上一条已建行
    const res = await postStart(ACTIVE_USER, PRODUCT);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.id).toBe(activeProgressId); // 返既有行，非重插新行
    const rows = await db.select({ id: pmsBuiWenlvProgress.id }).from(pmsBuiWenlvProgress)
      .where(and(eq(pmsBuiWenlvProgress.productId, PRODUCT), eq(pmsBuiWenlvProgress.miniUserId, ACTIVE_USER)));
    expect(rows.length).toBe(1);
  });

  afterAll(async () => {
    // 先删 events（case 3 建行时插了 eventType:'start'，防真库留孤儿行），再删子表/父表（对齐 wenlv.test.ts 惯例）
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(and(eq(pmsBuiWenlvProgress.productId, PRODUCT)));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    vi.unstubAllGlobals();
  });
});
