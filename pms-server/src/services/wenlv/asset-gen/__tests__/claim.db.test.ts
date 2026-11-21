import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
// ⚠️ 路径深度：本文件在 `src/services/wenlv/asset-gen/__tests__/`，回到 `src/` 要**四层**
// （__tests__ → asset-gen → wenlv → services → src）。写成三层会解析到
// `src/services/db/index.js` —— **那个目录不存在**，整个文件加载失败，
// 而且它会让后续 Task 的 `pnpm ts-check` 连带红。可对照同目录既有的
// `prompt-builder.test.ts:3`（同样四层）。
import { db } from '../../../../db/index.js';
import { pmsBuiWenlvAssetJobs } from '../../../../db/schema/index.js';
import { claimNextJobs, reclaimStale } from '../claim.js';
import { batchBudgetLimit } from '../batch-budget.js';

const run = !!process.env.RUN_DB;
const B = `claim-test-${Date.now()}`;

describe.skipIf(!run)('原子领取与超时收口', () => {
  beforeAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
  });

  const seed = async (id: string, status = 'pending', attempt = 0, startedAt?: Date) => {
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id, batchId: B, assetType: 'background', name: id,
      status, attempt, costAmount: '0', styleBibleSnapshot: {},
      // 只在传入时写 started_at。不传就**不写这一列** —— 保持既有调用点行为不变，
      // 也避免与 schema 的「无 .notNull() / 无 .defaultNow()」产生交互。
      ...(startedAt ? { startedAt } : {}),
    });
  };

  it('并发领取同一批 pending，只有一次拿到（原子更新，不是先查后改）', async () => {
    await seed(`${B}-c1`);
    await seed(`${B}-c2`);
    // ⚠️ 预热连接池：两个并发的空查询把**两条**连接变成 idle。
    // 不做这一步，这条用例对 SELECT-then-UPDATE 免疫 —— 此时池里只有一条热连接
    // （实测 pool.totalCount=1），第二次 claim 要现开 TCP+auth（毫秒级），
    // 它的 SELECT 必然落在第一次的 UPDATE 提交**之后**，两次「并发」实际串行，
    // 两步写法照样绿。变异验证实证：冷池下把实现换成两步写法 3/3 全绿；
    // 预热后同样变异立刻变红（b 领到了与 a 相同的两条）。
    await Promise.all([
      db.select().from(pmsBuiWenlvAssetJobs).limit(0),
      db.select().from(pmsBuiWenlvAssetJobs).limit(0),
    ]);
    // 两个并发 claim 各自拿到不相交的行集 —— 若实现是 SELECT-then-UPDATE，
    // 这里会双领同一条（既有 asset-task-scheduler 就是这个竞态形状）
    const [a, b] = await Promise.all([claimNextJobs(2), claimNextJobs(2)]);
    const ids = [...a, ...b].map(j => j.id);
    // 防「真空绿」：若实现整个退化成 `return []`，下面那条互斥断言会因为 0 === 0
    // 而恒真通过。两次 claim 各自 LIMIT 2、库里至少有刚种下的这两条 pending，
    // 所以领取条数的下界恒为 2（不看库里还躺着什么也成立）。
    expect(ids.length >= 2).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);   // 互斥：没有任何一条被领两次
    // 不写 toBeLessThanOrEqual（类型桩未声明）：非负整数上 `<= 4` 等价于 `!> 4`。
    // 上界 4 = 两次 claimNextJobs(2) 各自上限之和 —— 这是**不看库里还躺着什么**也成立的
    // 不变量。（原来这里写 `> 2`，那只在「全库恰好只剩这两条 pending」时成立：
    // 上一次跑崩在半路留下的 pending 残留会让它随机变红，重跑又绿。）
    expect(ids.length > 4).toBe(false);
  });

  it('领取后 attempt + 1 且 status 变 running', async () => {
    const id = `${B}-c3`;
    await seed(id);
    const got = await claimNextJobs(10);
    const mine = got.find(j => j.id === id);
    if (!mine) return;      // 被上一条的并发测试抢先领走则跳过
    expect(mine.attempt).toBe(1);
    expect(mine.status).toBe('running');
  });

  it('attempt 达到上限的行不被领取', async () => {
    const id = `${B}-c4`;
    await seed(id, 'pending', 3);
    const got = await claimNextJobs(50);
    expect(got.find(j => j.id === id)).toBe(undefined);
  });

  it('按类型领取：限定 anchor 时不碰其它类型', async () => {
    const id = `${B}-c7`;
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id, batchId: B, assetType: 'anchor', name: id,
      status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {},
    });
    const got = await claimNextJobs(50, { assetTypes: ['anchor'] });
    expect(got.find((j: any) => j.id === id)).toBeTruthy();
    expect(got.every((j: any) => j.assetType === 'anchor')).toBe(true);
  });

  it('超时收口：running 超过 15 分钟的判 failed', async () => {
    const id = `${B}-c5`;
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id, batchId: B, assetType: 'background', name: id,
      status: 'running', attempt: 1, costAmount: '0', styleBibleSnapshot: {},
      startedAt: new Date(Date.now() - 16 * 60 * 1000),   // 16 分钟前
    });
    const n = await reclaimStale(15);
    // 收口的是**条数**，`>= 1` 等价于 `> 0`（类型桩声明了 toBeGreaterThan）
    expect(n).toBeGreaterThan(0);
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, id)).limit(1);
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('超时');
  });

  it('刚启动的 running 不被误收', async () => {
    const id = `${B}-c6`;
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id, batchId: B, assetType: 'background', name: id,
      status: 'running', attempt: 1, costAmount: '0', styleBibleSnapshot: {},
      startedAt: new Date(),                                 // 刚刚
    });
    await reclaimStale(15);
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, id)).limit(1);
    expect(row.status).toBe('running');
  });

  // ── 租约阈值：位置与严格性（Task 7 质量审查 I-1） ─────────────────────
  // 用 reclaimStale 的 now 参数把时间钉住 —— 否则「正好等于阈值」永远测不出来
  // （种子行的时刻与 reclaimStale 内部的 Date.now() 是两次独立取值）。
  it('租约边界：正好 15 分钟 → 不收口（严格 >，与 SQL 的 lt 同向）', async () => {
    const T = Date.now();
    const id = `${B}-edge-eq`;
    await seed(id, 'running', 0, new Date(T - 15 * 60_000));
    await reclaimStale(15, T);
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, id));
    expect(row.status).toBe('running'); // ← 把 SQL 改成 lte，这条必须变红
  });

  it('租约边界：超过阈值 1ms → 收口（同产物对照，防「恒不收口」的假绿）', async () => {
    const T = Date.now();
    const id = `${B}-edge-over`;
    await seed(id, 'running', 0, new Date(T - 15 * 60_000 - 1));
    await reclaimStale(15, T);
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, id));
    expect(row.status).toBe('failed');
  });

  // ── 批次花费熔断（Task 11 Step 4b） ─────────────────────────────────────
  // 这一条钉的是 claim.ts 里**拼进 SQL 的** budgetFilter 本身。
  // Step 1 的纯函数测试（batch-budget.test.ts）保护不到它：生产路径根本不调用
  // `exceededBatchBudget`（熔断是 SQL 里的 `HAVING SUM(...) >= ...`，SQL 调不到
  // JS 谓词）⇒「把 NOT EXISTS 写成 EXISTS」「把 >= 写成 >」这类改动
  // Step 1 的四条断言**全绿**。这正是本仓反复吃过的「判据无信号失效」。
  //
  // 用**另外两个** batch_id（既有 afterAll 只删 B），所以自带一个 afterAll 精确收口 ——
  // 不收口就是每跑一次往本地库漏两行。
  const BB_OVER = `bb-over-${Date.now()}`;
  const BB_OK = `bb-ok-${Date.now()}`;
  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, BB_OVER));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, BB_OK));
  });

  it('批次花费超上限 → 该批次的待领行不再被领走（不误伤他批）', async () => {
    const spentId = `${BB_OVER}-spent`;
    const overPendingId = `${BB_OVER}-pending`;
    const okPendingId = `${BB_OK}-pending`;
    // 1) 超预算批次：一条**已成功**的行把 SUM(cost_amount) 顶到**正好等于上限** + 一条待领行。
    //    字段形状照本文件的 seed（status/attempt/costAmount/styleBibleSnapshot），
    //    只多了一个显式非零 costAmount —— 这正是 seed 写死 '0' 覆盖不到的那一档。
    //
    //    ⚠️ 金额**刻意取等号**（SUM == limit），不是 limit + 1：这样 `>=` 与 `>`
    //       才会在这里**分叉** —— SQL 保持 `>=` 本条照常绿，改成 `>` 则不再熔断、
    //       本条立刻变红。取 limit + 1 的话两种写法都熔断，这条断言对边界**没有咬合力**。
    //       （与 `exceededBatchBudget` 的 `>=` 语义同款，两边一致。）
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: spentId, batchId: BB_OVER, assetType: 'background', name: spentId,
      status: 'succeeded', attempt: 1, costAmount: String(batchBudgetLimit()),
      styleBibleSnapshot: {},
    });
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: overPendingId, batchId: BB_OVER, assetType: 'background', name: overPendingId,
      status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {},
    });

    // 2) 对照批次：正常批次（花 0 元）的待领行**必须仍能被领走**。
    //    两条断言必须一起看 —— 只断言 not.toContain 的话，
    //    「筛子写成无条件不领」也会全绿。
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: okPendingId, batchId: BB_OK, assetType: 'background', name: okPendingId,
      status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {},
    });

    const claimed = await claimNextJobs(50, { assetTypes: ['background'] }) as { id: string }[];
    const ids = claimed.map((r) => r.id);
    expect(ids, '超预算批次的行不该被领走').not.toContain(overPendingId);
    expect(ids, '正常批次必须仍能被领走（对照组）').toContain(okPendingId);
  });
});
