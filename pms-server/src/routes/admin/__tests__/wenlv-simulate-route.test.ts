/**
 * `POST /products/:id/simulate` —— 只读走场模拟端点（块 D Task 3）。
 *
 * 测试装置**照抄 `wenlv.test.ts`**：拿 app 用 `adminWenlvRoute.request`、内部 token 走
 * `X-Internal-Service-Token`、DB 用例用 `describe.skipIf(!process.env.RUN_DB)` 门控
 * （本地真跑 `--config vitest.local.config.ts`，该配置自带 `assertLoopback` 硬闸）。
 *
 * 数据用 `test-utils/wenlv-narrative-fixture.ts` 的夹具——本地库没有 narrative 数据，
 * 不铺夹具的话「结局可达 / 节点不可达」这类断言会**无声恒绿**（见该文件顶部说明）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { count, eq } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProgress, pmsBuiWenlvEvents } from '../../../db/schema/index.js';
import {
  fixtureLinear, fixtureCycle, seedNarrativeFixture, deleteNarrativeFixture,
} from '../../../test-utils/wenlv-narrative-fixture.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

// 门禁用例不需要 DB，放在 skipIf 之外 —— 它证明的是「端点不是裸的」。
// ⚠️ 注意：中间件 `route.use('*')` 对**未匹配**的路径同样生效，所以本用例在端点
// 尚未实现时也会是 403/绿。它证明「门禁挂着」，但**不能**证明端点存在（那由 DB 用例负责）。
describe('simulate 端点门禁', () => {
  it('未带内部 token 返回 403（不是裸端点）', async () => {
    const res = await adminWenlvRoute.request('/products/whatever/simulate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!process.env.RUN_DB)('POST /products/:id/simulate（DB）', () => {
  const P_LINEAR = 'sim-linear-' + Date.now();
  const P_CYCLE = 'sim-cycle-' + Date.now();
  const P_MISSING = 'sim-missing-' + Date.now();

  beforeAll(async () => {
    await seedNarrativeFixture(db, fixtureLinear(P_LINEAR), P_LINEAR);
    await seedNarrativeFixture(db, fixtureCycle(P_CYCLE), P_CYCLE);
  });

  afterAll(async () => {
    await deleteNarrativeFixture(db, P_LINEAR);
    await deleteNarrativeFixture(db, P_CYCLE);
  });

  it('线性剧本 ⇒ 200，结局可达且 unreachable 为空', async () => {
    const res = await adminWenlvRoute.request(`/products/${P_LINEAR}/simulate`, { method: 'POST', headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.reachableEndingIds).toContain(`${P_LINEAR}-e1`);
    expect(b.data.unreachable).toEqual([]);
  });

  it('互锁环 ⇒ 200，0 个可达节点、2 个不可达（静态闸抓不到的增量价值）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P_CYCLE}/simulate`, { method: 'POST', headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.reachableNodeIds).toEqual([]);
    expect(b.data.unreachable.length).toBe(2);
  });

  // ★ 安全判据（E8）：模拟器是分析工具，**不得代玩家玩**。
  // 先自己铺 1 行 progress + 1 行 events（否则空表比空表是空断言），
  // 再断言 simulate 前后**计数不变 + 整行内容不变**。
  // ⚠️ 单看 count(*) **抓不到原地 UPDATE**（计数不变、只有内容变），
  //    而「代玩家玩」最可能的错误实现恰恰是 UPDATE 已有 progress（如把 state 写成模拟结果）
  //    —— 故这里额外比对整行快照，见下面 `snapshot`。
  it('只读：simulate 前后 progress / events 的计数与整行内容均不变', async () => {
    const miniUserId = 'sim-user-' + P_LINEAR;
    await db.insert(pmsBuiWenlvProgress).values({
      id: 'sim-prog-' + P_LINEAR, productId: P_LINEAR, miniUserId,
    });
    await db.insert(pmsBuiWenlvEvents).values({
      id: 'sim-evt-' + P_LINEAR, productId: P_LINEAR, miniUserId, eventType: 'checkin',
    });

    const countOf = async (t: any) => {
      const [row] = await db.select({ c: count() }).from(t).where(eq(t.productId, P_LINEAR));
      return Number(row.c);
    };

    // 整行快照：比 count(*) 多抓一层「原地 UPDATE」。按 id 排序保证顺序稳定。
    const snapshot = async (t: any) => {
      const rows = await db.select().from(t).where(eq(t.productId, P_LINEAR));
      return JSON.stringify(rows.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))));
    };

    const progressBefore = await countOf(pmsBuiWenlvProgress);
    const eventsBefore = await countOf(pmsBuiWenlvEvents);
    const progressRowsBefore = await snapshot(pmsBuiWenlvProgress);
    const eventsRowsBefore = await snapshot(pmsBuiWenlvEvents);
    // 夹具真的落库了才谈得上「不变」——否则 0==0 是空断言。
    expect(progressBefore).toBe(1);
    expect(eventsBefore).toBe(1);

    const res = await adminWenlvRoute.request(`/products/${P_LINEAR}/simulate`, { method: 'POST', headers: H });
    expect(res.status).toBe(200);

    expect(await countOf(pmsBuiWenlvProgress)).toBe(progressBefore);
    expect(await countOf(pmsBuiWenlvEvents)).toBe(eventsBefore);
    expect(await snapshot(pmsBuiWenlvProgress)).toBe(progressRowsBefore);
    expect(await snapshot(pmsBuiWenlvEvents)).toBe(eventsRowsBefore);
  });

  // ⚠️ Hono 对**未匹配**的路径默认也回 404 ⇒ 单看状态码没有区分力。
  // 断言文案才是判别式（框架默认 404 的 body 不是这个 JSON 文案）。
  it('产品不存在 ⇒ 404 且文案为「内容产品不存在」', async () => {
    const res = await adminWenlvRoute.request(`/products/${P_MISSING}/simulate`, { method: 'POST', headers: H });
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.error).toBe('内容产品不存在');
  });
});
