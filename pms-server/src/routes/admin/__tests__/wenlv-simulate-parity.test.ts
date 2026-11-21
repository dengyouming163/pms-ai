/**
 * 块 D Task 7：防分歧闸 —— 模拟器 vs **真实 HTTP 路由**。
 *
 * ## 为什么这条闸是本块最重要的测试
 * `simulateWenlv`（`services/wenlv-simulate.ts`）的风险是「它自己发明了一套引擎语义」。
 * Task 2 的单测只证明它对**纯函数**自洽；本文件证明它与**真实 mini 路由**（`/start`、`/trigger`、
 * `/answer` 的整条写库链）同结论 —— 两者都必需。
 *
 * 顺带补一条**今天零覆盖**的路径：`settleEndings` 的正向终态（`status='completed'` + `endingId`）。
 * 本仓没有任何既有测试驱动完整的 `start → trigger → trigger → trigger` 链。
 *
 * ## 为什么是独立文件（不是追加进 Task 3 的 `wenlv-simulate-route.test.ts`）
 * 那个文件通篇**不设 `WENLV_BYPASS_TICKET`**（它只走 admin 内部 token，见其 `:22-24`）。
 * 本文件必须设它 + `MINI_JWT_SECRET`（要过真实 mini 路由的票券门与 JWT 验签）。
 * 把两个 env 塞进一个原本不需要它们的文件 = 凭空给它加一份泄漏面，而它自己的用例对此毫无感知。
 * 主题也不同：Task 3 测「admin simulate 端点」，本文件测「两侧同结论」。
 *
 * ## env 与清理（红线）
 * 下面两行照抄 `routes/mini/__tests__/wenlv.test.ts:3-4`。ESM 会把 `import` 提升到所有顶层语句之前，
 * 故「写在 import 之前」并不改变执行顺序 —— 但这两个键都是**请求时**才读（`parseMiniToken` 的
 * `requireEnv` 在每次调用时执行；`assertTicket` 在每次请求时读 `process.env`），所以放哪都行。
 *
 * ⚠️ `afterAll` 里**必须**清掉 `WENLV_BYPASS_TICKET`：vitest 同 worker 内 `process.env` 跨测试文件共享
 * （同目录 `wenlv-enter.test.ts:8`、`wenlv-m5.test.ts:6` 都是为此在文件顶部**防御性 delete** 的），
 * 本文件的用例走真实 HTTP 路由，该键一旦泄漏到别的套件就**静默绕掉票券门** —— 不报错、不变红。
 *
 * `MINI_JWT_SECRET` 则**不删**：参考文件（`wenlv.test.ts`）也没删，且它与票券门不同 ——
 * 一个泄漏的测试密钥不会绕掉任何门（同 worker 内其它 mini 套件本就各自把同名键设成同一个桩值），
 * 删了反而会与参考文件的写法不一致，并可能让「依赖前一个文件已设该键」的套件在 `requireEnv` 上硬崩。
 */
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
process.env.WENLV_BYPASS_TICKET = '1';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import miniWenlvRoute from '../../mini/wenlv.js';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProgress } from '../../../db/schema/index.js';
import {
  fixtureLinear, fixtureCycle, fixtureUpgradeLadder, ref,
  seedNarrativeFixture, deleteNarrativeFixture,
} from '../../../test-utils/wenlv-narrative-fixture.js';
import type { NarrativeFixture } from '../../../test-utils/wenlv-narrative-fixture.js';
import type { SimResult } from '../../../services/wenlv-simulate.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const INTERNAL_H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

// 游客 JWT（模块加载即能签发；env 已注入）
const mkMini = (id: string) => ({
  Authorization: `Bearer ${jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' })}`,
  'Content-Type': 'application/json',
});

// ──────────────────── 本文件专有夹具（不动共享的 test-utils 文件） ────────────────────

/**
 * **带 `grant` 的**链式夹具 —— 专为 bite 1 准备。
 *
 * `fixtureLinear` 每个节点的 `effects.grant` 都是**空数组** ⇒ 它证明不了模拟器的
 * collected 语义与引擎一致：把 `simulateWenlv` 里的 `applyEffects` 换成「只写 completed、
 * 不写 collected」，`fixtureLinear` 的结局（只要求 completed n3）照样可达，正例**仍然全绿**。
 * 本夹具的结局同时要求「末节点完成」与「线索 c2 已收集」，于是 collected 语义一旦漂移，
 * 用例 3 的等价性断言与 `finalState.collected` 断言都会红。
 */
function fixtureLinearWithGrant(p: string): NarrativeFixture {
  return {
    nodes: [
      { id: `${p}-g1`, nodeType: 'scene', title: '发放一',
        requires: null, grants: [`${p}-c1`] },
      { id: `${p}-g2`, nodeType: 'scene', title: '发放二',
        requires: ref('visited', `${p}-g1`), grants: [`${p}-c2`] },
    ],
    endings: [{
      id: `${p}-eg`, title: '集齐通关',
      triggerCondition: { type: 'all', conditions: [ref('visited', `${p}-g2`), ref('collected', `${p}-c2`)] },
    }],
  };
}

/**
 * 互锁环的**谜题**版 —— 覆盖 `/answer` 的前置条件门（`routes/mini/wenlv.ts:411`）。
 *
 * `fixtureCycle` 两个节点都是 `scene`，`/answer` 会先被「该节点不是谜题」400 挡掉，
 * **够不到** :411 那条 403 ⇒ 该入口只能用谜题节点覆盖。
 * 两个谜题互相要求对方 completed ⇒ 固定点为空：`/trigger`（:361）与 `/answer`（:411）
 * 两个入口都会以「前置条件未满足」403。
 */
function fixturePuzzleLock(p: string): NarrativeFixture {
  return {
    nodes: [
      { id: `${p}-qa`, nodeType: 'puzzle', title: '谜题甲',
        requires: ref('visited', `${p}-qb`), grants: [] },
      { id: `${p}-qb`, nodeType: 'puzzle', title: '谜题乙',
        requires: ref('visited', `${p}-qa`), grants: [] },
    ],
    endings: [{ id: `${p}-eq`, title: '永远到不了', triggerCondition: ref('visited', `${p}-qa`) }],
  };
}

/**
 * **多结局阶梯**夹具 —— 专为「两结局同时满足」这条缺口准备。
 *
 * 既有四个夹具每个产品**恰好 1 个结局**，于是 `reachableEndingIds`（全部满足项）
 * 与「收成单值的 `[resolvedEndingId]`」在那里**观测完全等价** —— 把模拟器的那行
 * 解构收窄成单值，四夹具全绿、无人察觉。本夹具让 `n1` 一个节点同时满足两个结局：
 * `e1` 只要求 `completed n1`，`e2` 要求 `all(completed n1, collected c1)`，
 * 而 `n1` 的 effects 恰好 grant c1 + complete n1 ⇒ 两者**同时**成立。
 * 于是「只保留胜出者」会把另一个**满足但非胜出**的结局误报进 `unreachableEndings`。
 */
function fixtureLadder(p: string): NarrativeFixture {
  return {
    nodes: [
      { id: `${p}-n1`, nodeType: 'scene', title: '触发点',
        requires: null, grants: [`${p}-c1`] },
    ],
    endings: [
      { id: `${p}-e1`, title: '普通结局',
        triggerCondition: ref('visited', `${p}-n1`) },
      { id: `${p}-e2`, title: '真相结局',
        triggerCondition: { type: 'all', conditions: [ref('visited', `${p}-n1`), ref('collected', `${p}-c1`)] } },
    ],
  };
}

// ──────────────────────────────── 真实路由 / 直读辅助 ────────────────────────────────

const start = (productId: string, miniUserId: string) =>
  miniWenlvRoute.request(`/${productId}/start`, {
    method: 'POST', headers: mkMini(miniUserId), body: JSON.stringify({}),
  });

const trigger = (productId: string, nodeId: string, miniUserId: string) =>
  miniWenlvRoute.request('/trigger', {
    method: 'POST', headers: mkMini(miniUserId), body: JSON.stringify({ productId, nodeId }),
  });

const answer = (productId: string, nodeId: string, ans: unknown, miniUserId: string) =>
  miniWenlvRoute.request('/answer', {
    method: 'POST', headers: mkMini(miniUserId),
    body: JSON.stringify({ productId, nodeId, interactionIndex: 0, answer: ans }),
  });

/** 真实路径**落库**的进度行（断言用直读，不经任何投影）。 */
async function landedOf(productId: string, miniUserId: string) {
  const [row] = await db.select().from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.productId, productId), eq(pmsBuiWenlvProgress.miniUserId, miniUserId)))
    .limit(1);
  return row ?? null;
}

/** 走 admin 只读模拟端点。 */
async function simulateOf(productId: string): Promise<SimResult> {
  const res = await adminWenlvRoute.request(`/products/${productId}/simulate`, { method: 'POST', headers: INTERNAL_H });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.data as SimResult;
}

// ──────────────────────────────────── 用例 ────────────────────────────────────

describe.skipIf(!process.env.RUN_DB)('模拟器 vs 真实 mini 路由：等价性闸（DB）', () => {
  const TS = Date.now();
  const P_LIN = `parity-lin-${TS}`;
  const P_CYC = `parity-cyc-${TS}`;
  const P_GRANT = `parity-gnt-${TS}`;
  const P_LOCK = `parity-lck-${TS}`;
  // 多结局阶梯：唯一产品**两个结局都满足** —— 见 `fixtureLadder` 与新增用例的注释。
  const P_LADDER = `parity-ladder-${TS}`;
  // Task 2「首次盖章」用例专用：独立 productId + 独立游客，使自己掌管进度行的完整生命周期
  // （status 从 active → completed 的那次「首次盖章」必须发生在本用例内部）。
  const P_STAMP = `parity-stamp-${TS}`;
  // 「结局只升不降」专用：**两档结局先后脚满足**的阶梯，独立产品 + 独立游客
  // （P_STAMP 的 `fixtureLinear` 只有 1 个结局 ⇒ 升级路径构造上走不到，见 `fixtureUpgradeLadder`）。
  const P_UPG = `parity-upg-${TS}`;
  // 唯一约束是 uq_wenlv_progress_solo(mini_user_id, product_id) WHERE session_id IS NULL ⇒ 用例之间用不同游客。
  const U_LIN = `parity-ul-${TS}`;
  const U_CYC = `parity-uc-${TS}`;
  const U_GRANT = `parity-ug-${TS}`;
  const U_LOCK = `parity-uk-${TS}`;
  const U_LADDER = `parity-ulad-${TS}`;
  const U_STAMP = `parity-us-${TS}`;
  const U_UPG = `parity-uupg-${TS}`;

  beforeAll(async () => {
    await seedNarrativeFixture(db, fixtureLinear(P_LIN), P_LIN);
    await seedNarrativeFixture(db, fixtureCycle(P_CYC), P_CYC);
    await seedNarrativeFixture(db, fixtureLinearWithGrant(P_GRANT), P_GRANT);
    await seedNarrativeFixture(db, fixturePuzzleLock(P_LOCK), P_LOCK);
    await seedNarrativeFixture(db, fixtureLinear(P_STAMP), P_STAMP);
    await seedNarrativeFixture(db, fixtureLadder(P_LADDER), P_LADDER);
    await seedNarrativeFixture(db, fixtureUpgradeLadder(P_UPG), P_UPG);
  });

  afterAll(async () => {
    await deleteNarrativeFixture(db, P_LIN);
    await deleteNarrativeFixture(db, P_CYC);
    await deleteNarrativeFixture(db, P_GRANT);
    await deleteNarrativeFixture(db, P_LOCK);
    await deleteNarrativeFixture(db, P_STAMP);
    await deleteNarrativeFixture(db, P_LADDER);
    await deleteNarrativeFixture(db, P_UPG);
    // 泄漏即静默绕掉票券门（见文件头）——必须清。
    delete process.env.WENLV_BYPASS_TICKET;
  });

  it('正例（链式）：真实 start→trigger×3 落 completed + endingId=e1；simulate 同结论且节点集覆盖真实走过的三个', async () => {
    const p = P_LIN;
    const res = await start(p, U_LIN);
    expect(res.status).toBe(200);

    for (const n of ['n1', 'n2', 'n3']) {
      const r = await trigger(p, `${p}-${n}`, U_LIN);
      expect(r.status).toBe(200);
    }

    // ★ 这条今天零覆盖：settleEndings 的正向终态
    const landed = await landedOf(p, U_LIN);
    expect(landed).not.toBeNull();
    expect(landed!.status).toBe('completed');
    expect(landed!.endingId).toBe(`${p}-e1`);

    const sim = await simulateOf(p);
    expect(sim.reachableEndingIds).toContain(`${p}-e1`);
    // reachableNodeIds ⊇ 真实走过的三个节点
    const reached = new Set(sim.reachableNodeIds);
    for (const n of ['n1', 'n2', 'n3']) expect(reached.has(`${p}-${n}`)).toBe(true);
  });

  it('反例（互锁环）：start 成功但任何 trigger 都 403「前置条件未满足」；simulate 报 2 个不可达 —— 两侧一致：都通不过', async () => {
    const p = P_CYC;
    const res = await start(p, U_CYC);
    expect(res.status).toBe(200);

    // 两个入口都点不动（同一条 :361 前置条件门；节点互锁 ⇒ 逐个都试）
    for (const n of ['a', 'b']) {
      const r = await trigger(p, `${p}-${n}`, U_CYC);
      expect(r.status).toBe(403);
      expect(String((await r.json()).error)).toContain('前置条件未满足');
    }

    // 真实路径**什么结局都没落**
    const landed = await landedOf(p, U_CYC);
    expect(landed!.status).toBe('active');
    expect(landed!.endingId).toBe(null);

    const sim = await simulateOf(p);
    expect(sim.reachableNodeIds.length).toBe(0);
    expect(sim.unreachable.length).toBe(2);
    expect(sim.reachableEndingIds).toEqual([]);
  });

  it('反例（互锁环·谜题）：/answer 也走同一条前置条件门 403（:411 入口，与 :361 是两个消费点）', async () => {
    const p = P_LOCK;
    const res = await start(p, U_LOCK);
    expect(res.status).toBe(200);

    // :361 —— /trigger 入口
    const t = await trigger(p, `${p}-qa`, U_LOCK);
    expect(t.status).toBe(403);
    expect(String((await t.json()).error)).toContain('前置条件未满足');

    // :411 —— /answer 入口。节点确实是 puzzle（否则会先被 400「该节点不是谜题」挡掉，
    // 那条文案与本断言不符 ⇒ 这里的 403 只能来自前置条件门）。
    const a = await answer(p, `${p}-qa`, '是', U_LOCK);
    expect(a.status).toBe(403);
    expect(String((await a.json()).error)).toContain('前置条件未满足');

    // 两侧一致：模拟器也判两个谜题都不可达
    const sim = await simulateOf(p);
    expect(sim.reachableNodeIds.length).toBe(0);
    expect(sim.unreachable.length).toBe(2);
  });

  it('等价性：simulate 的 reachableEndingIds 排序后 === 真实路径实际落库的 endingId 集合（四个夹具）', async () => {
    const cases: { p: string; user: string; nodes: string[]; step: 200 | 403; ending: string | null }[] = [
      { p: P_LIN, user: U_LIN, nodes: [`${P_LIN}-n1`, `${P_LIN}-n2`, `${P_LIN}-n3`], step: 200, ending: `${P_LIN}-e1` },
      { p: P_CYC, user: U_CYC, nodes: [`${P_CYC}-a`, `${P_CYC}-b`], step: 403, ending: null },
      { p: P_GRANT, user: U_GRANT, nodes: [`${P_GRANT}-g1`, `${P_GRANT}-g2`], step: 200, ending: `${P_GRANT}-eg` },
      { p: P_LOCK, user: U_LOCK, nodes: [`${P_LOCK}-qa`, `${P_LOCK}-qb`], step: 403, ending: null },
    ];

    for (const c of cases) {
      // 这四个用例复用正例/反例里已建好的进度行（同 productId + 同 miniUserId ⇒ 幂等：
      // start 返回既有行，trigger 重复应用 effects 无副作用）——故此处只重跑一次触发序列。
      const r = await start(c.p, c.user);
      expect(r.status).toBe(200);
      for (const nodeId of c.nodes) {
        const res = await trigger(c.p, nodeId, c.user);
        expect(res.status).toBe(c.step);
      }

      const landed = await landedOf(c.p, c.user);
      const realEndings = landed!.endingId ? [landed!.endingId] : [];
      expect([...realEndings].sort()).toEqual(c.ending ? [c.ending] : []);

      const sim = await simulateOf(c.p);
      expect([...sim.reachableEndingIds].sort()).toEqual([...realEndings].sort());
      // 方案 A 新增：模拟器不仅说"哪几个满足"，还要说"结算会落哪个" —— 必须与真实落库逐字相同。
      expect(sim.resolvedEndingId).toBe(c.ending);
    }

    // 带 grant 夹具的**直接**取证：模拟器的 finalState 真收下了 grant 的效果
    //（否则「只写 completed 不写 collected」的漂移会让上面那条等价性断言红 —— 这里给出红在哪）。
    const simGrant = await simulateOf(P_GRANT);
    expect(simGrant.finalState.collected[`${P_GRANT}-c2`]).toBe(true);
    const landedGrant = await landedOf(P_GRANT, U_GRANT);
    expect((landedGrant!.state as any).collected[`${P_GRANT}-c2`]).toBe(true);
  });

  // spec §6 判据 3 / 路线图 D6「时间戳一律首次进入时盖章，不覆盖」。
  // 旧实现每次命中结局都写 `completedAt: new Date()` ⇒ 游客每多答一题完成时间就被刷新一次，
  // 端到端时长被掩盖。守卫（`current.status !== 'completed'`）必须让「已完成后」的触发不改写。
  it('首次盖章：已 completed 后再触发一次，completed_at 与 ending_id 均不变（D6）', async () => {
    const p = P_STAMP;
    const res = await start(p, U_STAMP);
    expect(res.status).toBe(200);

    for (const n of ['n1', 'n2', 'n3']) {
      const r = await trigger(p, `${p}-${n}`, U_STAMP);
      expect(r.status).toBe(200);
    }

    // 首次进入终态：这一次是「首次盖章」，completedAt 必须被写上。
    const first = await landedOf(p, U_STAMP);
    expect(first).not.toBeNull();
    expect(first!.status).toBe('completed');
    expect(first!.endingId).toBe(`${p}-e1`);
    expect(first!.completedAt).not.toBeNull();
    const firstStamp = first!.completedAt!.getTime();

    // 让下一次 `new Date()` 必然落到不同的毫秒 —— 否则「守卫失效」与「两次恰在同一毫秒」
    // 无法区分，用例会在变异后仍绿（假证据）。20ms 远大于 new Date() 的 1ms 分辨率。
    await new Promise((r) => setTimeout(r, 20));

    // 再触发一次已完成的节点：unlockCondition（completed n2）仍满足 ⇒ 200，
    // settleEndings 会再跑一遍并（若无守卫）改写 completedAt。
    const again = await trigger(p, `${p}-n3`, U_STAMP);
    expect(again.status).toBe(200);

    const second = await landedOf(p, U_STAMP);
    expect(second!.status).toBe('completed');
    expect(second!.endingId).toBe(`${p}-e1`);
    // 核心断言：逐字不变（守卫生效）。
    expect(second!.completedAt!.getTime()).toBe(firstStamp);
  });

  // 2026-10-01 订正：`settleEndings` 原先把「不改时间戳」与「不改结局」**捆在同一个守卫**里
  // （`current.status !== 'completed'`）⇒ 低档结局一旦落库就被永久钉死，更高档再也拿不到。
  // ⚠️ 上面那条「首次盖章」用例**证明不了**这条修正：它的夹具每产品恰好 1 个结局，
  // 改完守卫它照样绿（零判别力）。所以这里用真阶梯夹具（`fixtureUpgradeLadder`）分开钉两条正交语义。
  it('结局只升不降：低档先落库，再触发满足更高档 ⇒ ending_id 升级、completed_at 逐字不变', async () => {
    const p = P_UPG;
    expect((await start(p, U_UPG)).status).toBe(200);

    // ── 第 1 关：只有低档满足（刻意复刻线上致病形态：入口关发放的线索 == 最低档结局的条件）
    expect((await trigger(p, `${p}-n1`, U_UPG)).status).toBe(200);
    const afterN1 = await landedOf(p, U_UPG);
    expect(afterN1, '前置自证：第 1 关必须已经落库').not.toBeNull();
    expect(afterN1!.status).toBe('completed');
    expect(afterN1!.endingId, '低档在第 1 关就满足 —— 线上受害剧本就是这个形态').toBe(`${p}-e-low`);
    expect(afterN1!.completedAt, '首次进入终态 ⇒ 盖章').not.toBeNull();
    const firstStamp = afterN1!.completedAt!.getTime();

    // 让下一次 `new Date()` 必然落到不同毫秒，否则「时间戳没被改」与「两次恰在同一毫秒」无法区分。
    await new Promise((r) => setTimeout(r, 20));

    // ── 第 2 关：高档也满足了 ⇒ 结局升级，但**不重新盖章**
    const r2 = await trigger(p, `${p}-n2`, U_UPG);
    expect(r2.status).toBe(200);
    const afterN2 = await landedOf(p, U_UPG);
    expect(afterN2!.status).toBe('completed');
    // ★ 承重断言 1：旧守卫（`current.status !== 'completed'`）下这里是 `${p}-e-low` ⇒ 必红。
    expect(afterN2!.endingId, '达成度提高 ⇒ 升级到 priority 更大者').toBe(`${p}-e-high`);
    // ★ 承重断言 2：升级**不得**顺带刷新时间戳 —— 「只升不降」与 D6 是两条正交规则，捆在一起正是原缺陷。
    expect(afterN2!.completedAt!.getTime(), 'D6：时间戳只在首次盖章，升级不改它').toBe(firstStamp);

    // 响应体里的 `endings[0]` 必须已经是胜出者：客户端 `applyProgressRes`（`play.vue:2419-2427`）
    // 直接把 `endings[0]` 当新 endingId 写回本地状态，不会另发一次详情请求。
    const body = await (await trigger(p, `${p}-n2`, U_UPG)).json();
    expect(body.data.endings, 'selectEnding 契约：胜出者排首位，其余按 id 字典序').toEqual([`${p}-e-high`, `${p}-e-low`]);

    // 重复触发已在最高档 ⇒ 值没变 ⇒ 不写（幂等），时间戳仍不动
    const afterN3 = await landedOf(p, U_UPG);
    expect(afterN3!.endingId).toBe(`${p}-e-high`);
    expect(afterN3!.completedAt!.getTime()).toBe(firstStamp);
  });

  // ★ 多结局阶梯：**同时满足两个结局** —— 上一轮变异逃逸（把 simulate 的
  // `satisfiedIds` 收成 `[resolvedEndingId]`）在既有四夹具上观测等价的唯一补丁。
  // 既有四夹具每产品恰好 1 个结局；本夹具让 n1 一个节点同时满足 e1 与 e2，于是：
  //   ① reachableEndingIds 必须保留**两者**（收成单值 ⇒ 此处红）
  //   ② unreachableEndings 必须为空（收成单值 ⇒ 会把非胜出者误报成不可达）
  //   ③ 结算只落一个且确定（无 priority 列 ⇒ 全 0 ⇒ 平手取 id 字典序小者 ⇒ e1）
  //   ④ 真实 /trigger 链落库的正是同一个 —— 模拟器与运行时同结论（共用 selectEnding）
  it('多结局阶梯：两结局同时满足 ⇒ reachableEndingIds 保留两者、unreachableEndings 为空；结算落 e1 且真实路径同结论', async () => {
    const p = P_LADDER;
    const res = await start(p, U_LADDER);
    expect(res.status).toBe(200);

    // 触发唯一节点 n1：effects grant c1 + complete n1 ⇒
    // e1（completed n1）与 e2（all: completed n1 ∧ collected c1）**同时**成立。
    const t = await trigger(p, `${p}-n1`, U_LADDER);
    expect(t.status).toBe(200);

    const sim = await simulateOf(p);
    // ① 两个都满足 ⇒ reachableEndingIds 保留**两者**
    expect([...sim.reachableEndingIds].sort()).toEqual([`${p}-e1`, `${p}-e2`].sort());
    // ② 都可达 ⇒ unreachableEndings 必须为空（收成单值就会把 e1 或 e2 误报进来）
    expect(sim.unreachableEndings).toEqual([]);
    // ③ 结算只落一个，且确定（此刻无 priority 列 ⇒ 全 0 ⇒ 平手按 id 字典序 ⇒ e1）
    expect(sim.resolvedEndingId).toBe(`${p}-e1`);
    // ④ 真实路径落的就是同一个 —— 模拟器与运行时同结论
    const landed = await landedOf(p, U_LADDER);
    expect(landed).not.toBeNull();
    expect(landed!.status).toBe('completed');
    expect(landed!.endingId).toBe(`${p}-e1`);
  });
});
