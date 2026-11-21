/**
 * 任务领取与超时收口（S3）。
 *
 * ⚠️ 领取用**带条件的原子 UPDATE ... RETURNING**，而不是既有的「先 SELECT 再 UPDATE」。
 *    这一点**刻意偏离** services/asset-task-scheduler.ts:24-33 的写法：
 *    那里是 `SELECT` 查重再 `INSERT`，两个 tick 之间（或将来多实例）会双建。
 *    pms-server 当前是单实例（docker-compose.yml 无 replicas），
 *    但这个形状本身是错的，且 S3 的任务是**花钱**的，双领 = 重复计费。
 *
 *    ⚠️ 后人若要「统一风格」把它改回 SELECT-then-UPDATE，请先读这段注释 ——
 *    并发用例 (claim.db.test.ts) 会变红。
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvAssetJobs } from '../../../db/schema/index.js';
import { batchBudgetLimit } from './batch-budget.js';

/** 重试上限。达到后不再被领取（spec §7.2）。 */
export const MAX_ATTEMPT = 3;

/** 超时阈值（分钟）。没有这一步，卡住的行会永远占着 running，进度永远不到 100%。 */
export const STALE_MINUTES = 15;

/**
 * 原子领取最多 limit 条 pending。
 * 返回**真正抢到**的行 —— 没抢到的不会出现在结果里。
 *
 * `assetTypes` 是可选的类型过滤：调度器靠它**先领锚图、再领其余**。
 * 锚图是其余素材的参考图，必须先就绪（spec §4.7）—— 否则同一 tick 里
 * 一起领走，图会因为「还没有锚图」整批判失败。
 *
 * `requireAnchorReady`：只领「其产品的风格锚图已就绪」的图类 job。
 *
 * ⚠️ **这是第 3 步（无类型过滤那一轮）的必需前置条件，不是可选的优化。**
 *    调度器第 2 步用 `anchors.length === 0` 判「锚图都写回了，可以领其余了」——
 *    这个判断把两种情况混为一谈：
 *      ① 锚图全部 succeeded 并回写（安全，正是要等的那一刻）；
 *      ② 某个产品的锚图**已经 failed**（不是「还没回写」，是**永远不会回写**）。
 *    情况 ② 下第 2 步同样立刻空转退出，第 3 步照常执行，于是那个产品**尚未生成**的
 *    图类 job 被领走 → `generateImageJob` 抛「该剧本还没有风格锚图」→ 也变 failed。
 *    `claimNextJobs` 只认 `status='pending'`，**没有任何自动路径把 failed 变回 pending**
 *    ⇒ 那些素材被**永久判死**，只能人工 /retry。触发条件是**任何**一次锚图失败
 *    （LLM/文生图/OSS 报错，或停机后被我 `reclaimStale` 收回）——
 *    这正是 S3 联调期那 7 次「防永久判死」红所暴露的形状。
 *
 *    豁免三类，照抄 `generateImageJob` 的真实依赖：
 *      - `anchor`：它就是锚图的产出者，不能要求「锚图先就绪」；
 *      - `narration`：走 TTS，全程不碰参考图（spec §4.6）；
 *      - `product_id IS NULL`：**故意放它进来**，让它走到 `generateImageJob`
 *        那句「缺少 productId，无法生成（数据不完整）」显式失败。
 *        在这里挡掉只会让它无声地永远 pending，连诊断都没有。
 *
 *    空串也要排除：`style_anchor_url` 可能是 `''`（见 zod 空串脏值那条纪律），
 *    而消费方判的是 `!referenceUrl` —— `''` 是假值，一样会被那句守卫判死。
 *
 *    默认**关闭**：只有第 3 步需要它，第 2 步（领锚图）必须保持原样。
 */
export async function claimNextJobs(
  limit: number,
  opts?: { assetTypes?: string[]; requireAnchorReady?: boolean },
) {
  const types = opts?.assetTypes;
  const typeFilter = types && types.length > 0
    ? sql` AND asset_type IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})`
    : sql``;
  const anchorReadyFilter = opts?.requireAnchorReady
    ? sql` AND (
        asset_type IN ('anchor', 'narration', 'ar')
        OR product_id IS NULL
        OR EXISTS (
          SELECT 1 FROM pms_bui_wenlv_products p
           WHERE p.id = pms_bui_wenlv_asset_jobs.product_id
             AND p.style_anchor_url IS NOT NULL
             AND p.style_anchor_url <> ''
        )
      )`
    : sql``;
  // 批次花费熔断。与上面两个 filter 同款：拼成 sql 片段，参数走 sql`` 占位符
  // （**不要**用模板字符串拼数值进 SQL）。
  //
  // 语义：**该批次已花金额 ≥ 上限时，这个批次的所有待领行都不再被领走。**
  // 只影响本批，不动他批 —— 这正是它不共用总闸的原因。
  //
  // `cost_amount` 是 numeric，`SUM` 出来还是 numeric；右边显式 ::numeric 只是把
  // PG 的推断结果**写出来给人看**，便于阅读 —— **不加强转也不会报错**：
  // node-postgres 在没显式给 `types` 时**不发参数类型 OID**（Parse 里声明 0 个参数类型），
  // PG 按 `>=` 的上下文把 `$1` 推断成 numeric。同一条 SQL 里 `attempt < ${MAX_ATTEMPT}`
  // 就是同款「未强转的 JS number 比整数列」，生产一直在跑。
  const budgetFilter = sql` AND NOT EXISTS (
      SELECT 1 FROM pms_bui_wenlv_asset_jobs b
       WHERE b.batch_id = pms_bui_wenlv_asset_jobs.batch_id
       GROUP BY b.batch_id
      HAVING SUM(b.cost_amount) >= ${String(batchBudgetLimit())}::numeric
    )`;
  // 单条 SQL 内完成「筛选 + 改状态 + 抢占」，并发下天然互斥。
  //
  // ⚠️ **只 RETURNING id，整行另外查一次。** 不要图省事改成 `RETURNING *` 并直接把
  //    行当 camelCase 用 —— `db.execute(sql…)` 走的是 node-postgres 的**原始通道**，
  //    drizzle 在这里**不做列名映射**：拿回来的是 `asset_type` / `style_bible_snapshot`
  //    / `parent_job_id` 这样的 snake_case，而下面的消费方（以及 run-once.ts 每一处）
  //    读的都是 `job.assetType` / `job.styleBibleSnapshot` / `job.parentJobId`。
  //    结果是**静默全 undefined**：不抛异常、ts-check 也过（返回类型是 `any`），
  //    但每一行都判错类型、读不到基线、锚图任务全灭。
  //    仓内既有实证：src/routes/video.ts:129 读 `task.output_url`、
  //    src/routes/inventory.ts:67 读 `r.room_type_id`、
  //    src/db/__tests__/wenlv-asset-gen-schema.db.test.ts:24 读 `x.column_name`。
  //
  //    第二条查询不与任何领取者竞争：这些行的 status 已经不是 'pending' 了，
  //    别的 tick 抢不到。代价是每 tick 多一次往返，可接受。
  const claimed = await db.execute(sql`
    UPDATE pms_bui_wenlv_asset_jobs
       SET status = 'running',
           started_at = now(),
           attempt = attempt + 1,
           updated_at = now()
     WHERE id IN (
       SELECT id FROM pms_bui_wenlv_asset_jobs
        WHERE status = 'pending' AND attempt < ${MAX_ATTEMPT}${typeFilter}${anchorReadyFilter}${budgetFilter}
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id`);
  const ids: string[] = ((claimed as any).rows ?? (claimed as any)).map((r: any) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, ids));
}

/**
 * 租约截止时刻。**唯一定义**。
 *
 * `reclaimStale` 的 `lt(startedAt, cutoff)` 与纯函数 `isLeaseExpired` 共用它 ——
 * 这样「多长算过期」这个**取值**只可能有一处，改一处两边同时变。
 * （严格性 `lt` ⟺ `<` 仍靠注释看守：要区分它们需要两个时钟落在同一毫秒，见下。）
 */
export function leaseCutoff(minutes: number, now: number): Date {
  return new Date(now - minutes * 60_000);
}

/**
 * 租约是否过期。**纯函数**，便于钉住边界语义。
 *
 * 取严格 `>`（与 SQL 的 `lt` 同向）：与 `>=` 的差别只是那一毫秒谁赢，方向是
 * 「宁可晚收口 1ms」。
 * ⚠️ 真正被钉住的是 `leaseCutoff` 的**取值**。`<` 与 SQL `lt` 的**严格性**也各有一条
 *    边界用例（`claim-lease.test.ts` 的「正好等于阈值」那条；`claim.db.test.ts` 的对应
 *    那条要靠 `reclaimStale` 注入的 `now` 才可判）。测不到的只是「生产里两个时钟恰好
 *    落在同一毫秒」这个巧合 —— 那是「宁可晚收口 1ms」的取舍，不是缺陷。
 */
export function isLeaseExpired(startedAt: Date, minutes: number, now: number): boolean {
  return startedAt.getTime() < leaseCutoff(minutes, now).getTime();
}

/**
 * 超时收口：把 running 超过 minutes 分钟的任务判 failed。
 * 必须在领取**之前**跑 —— 先收回卡住的，再领新的。
 *
 * `now` 可注入**只为测试**：不注入，「正好等于阈值」那一毫秒永远测不出来
 *（种子行的时刻与这里的 `Date.now()` 是两次独立取值，不可能相等），
 * `lt` 与 `lte` 也就无法真正区分。生产调用点 `reclaimStale(STALE_MINUTES)` 不受影响。
 */
export async function reclaimStale(
  minutes: number = STALE_MINUTES,
  now: number = Date.now(),
): Promise<number> {
  // ⚠️ 截止时刻**只从 `leaseCutoff` 来** —— 与纯函数 `isLeaseExpired` 同源，
  //    「多长算过期」这个取值只可能有一处。不要在 SQL 里自己再算一遍 cutoff，
  //    也不要改成 `<=`（那会让心跳与收口在同一毫秒互相打脸，方向是「宁可晚收口 1ms」）。
  //
  // ⚠️ 对 NULL 不匹配：schema 里 `started_at` 是
  //    `timestamp('started_at', { withTimezone: true })` —— **无 `.notNull()`、无
  //    `.defaultNow()`**（同文件另一个**也叫 `started_at`** 的列 —— `pmsBuiWenlvProgress`
  //    那张表 —— 就带 `notNull().defaultNow()`，本列没有）。
  //    「经 claim 领取必有值」是**调用约定**而非约束：全仓唯一的 `status='running'`
  //    写入者就是 `claimNextJobs`，它恒写值。但 `lt` 对 NULL **不匹配** ⇒ 将来任何一个
  //    新的 `running` 写入者忘写 `started_at`，那行会**永远停在 running**
  //    （进度永远不到 100%、零日志）—— 正是本仓反复栽的那类静默失效。
  //    本轮只留注释，不加迁移 / CHECK 约束。
  const cutoff = leaseCutoff(minutes, now);
  const rows = await db.update(pmsBuiWenlvAssetJobs)
    .set({
      status: 'failed',
      errorMessage: `超时未返回（running 超过 ${minutes} 分钟）`,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(pmsBuiWenlvAssetJobs.status, 'running'),
      lt(pmsBuiWenlvAssetJobs.startedAt, cutoff),
    ))
    .returning({ id: pmsBuiWenlvAssetJobs.id });
  return rows.length;
}

/**
 * 续租：把 `started_at` 刷成现在。
 *
 * ## ⚠️ 先说清它今天**不**修什么（这一段是本函数最容易被误读的地方）
 *
 * 本函数**不是**在修一个正在发生的故障。它的由来是一条**实测不成立**的诊断：
 *「一批 3 条顺序处理、单条最坏 300s ⇒ 队尾那条轮到自己时已计了 600s，会被
 * `reclaimStale` 判 failed」。按**函数名**逐条核过调用链（不按行号 —— 行号会漂），
 * 那条**不可达**：
 *
 *   · `reclaimStale` 生产里**只有一个调用点** —— `runAssetGenOnce` 的第 1 步
 *     （`wenlv-asset-gen-scheduler.ts` 里 `reclaimStale(STALE_MINUTES)`）；
 *   · `runAssetGenOnce` 生产里也**只有一个调用点** —— `startWenlvAssetGenScheduler`
 *     的 `setInterval`（同文件 `await runAssetGenOnce()`），而它被 `running` 守卫
 *     **整个**包住（`if (running) return; running = true;` 在 `await` 之前同步置位）；
 *   · `claimNextJobs` 的生产调用点亦全在 `runAssetGenOnce` 体内。
 *
 *   ⇒ 一个 tick 的 `runAssetGenOnce` 没 resolve 之前，**下一个 tick 的 `reclaimStale`
 *     根本不会跑**；等它跑时那批 job 早已 `succeeded`/`failed`，`lt(started_at, cutoff)`
 *     匹配不到任何一行。**队尾 job 的年龄没有任何人会读到。**
 *
 *   ⇒ 例外：`markFailed` **连抛两次**会把某行留在 `running`（见
 *     `wenlv-asset-gen-scheduler.ts` 里 `runJobs` 的兜底注释）。那一行**会**被下一 tick
 *     的 `reclaimStale` 收口 —— 但它的**生成确实已经失败**（第一次 `markFailed` 正是那次
 *     业务失败触发的），不是误杀在途任务。只是 `error_message` 会被写成「超时未返回」而非
 *     真实的 DB 抖动；`runJobs` 那处注释本身就把这标为**误诊**，与本段不冲突。
 *
 * ## 那它为什么仍然留着
 *
 * 因为上面那条链的每一环都依赖一个**部署属性**（单实例、无旁路入口），而不是代码保证 ——
 * 本文件头部与 `wenlv-asset-gen-scheduler.ts` 的「单实例假设」注释都明写了这一点
 *（今天 compose 里 pms-server 无 `deploy.replicas`，已核实）。一旦出现**多副本**，
 * 或有人加一个「立即跑一轮」的 admin 路由（它与 tick 并发），「收口」与「在途生成」
 * 就能真的同时发生 —— 那时本函数是承重的。它是**前置于那个形态的补强**，
 * 代价是每条 job 一次小 UPDATE。
 *
 * 另一个边界一并说清：进程在生成中途崩溃时，该行会留在 `running` 直到被收口 ——
 * 续租只把这一刻**推后**，不会阻止它。那是**应该**的：那次生成真的死了。
 *
 * 两个时钟：`claimNextJobs` 写的是 DB 的 `now()`，而 `reclaimStale` / `renewLease`
 * 用的是 app 的 `Date.now()`；同一宿主的容器共享 `CLOCK_REALTIME`，Δ≈0，今天无风险。
 * 但 `started_at` 现在有**两个来源**，PG 挪到异机那一天，「15 分钟」会带上时钟差。
 * **这不本次引入**（`reclaimStale` 一直用 app 时钟），且 `renewLease` 用 app 时钟反而
 * 与 `reclaimStale` **同源**，方向是好的。
 *
 * ## 为什么不改成「加长 STALE_MINUTES」
 *
 * 加长阈值只是把边界推远，且「多长才够」永远答不准。
 *
 * ## ⚠️ 它**不**覆盖「单条生成本身超过 STALE_MINUTES」
 *
 * 一次性续租只把租约**起点**从「被整批领走」移到「开始生成」；`started_at` 之后不再更新。
 * 单条生成本身就超过 15 分钟的情形它管不着 —— 那要按心跳周期续租，**今天没有**。
 * 本 Task 原本的立项理由是「多候选把单条最坏耗时拉长」，而那拉长的正是**单条生成本身**，
 * 恰好落在这里不覆盖的那一半。别据此以为「加多候选有续租兜底」。
 *
 * ## 万一收口真的落在一条在途 job 上
 *
 * `reclaimStale` 把它判 `failed` 之后，**没有任何自动路径把 failed 变回 pending**
 *（见本文件上方 claimNextJobs 的注释）。所以误杀 = 永久判死 + 钱已花 + 素材没落库。
 * 这正是上面那笔「每条一次小 UPDATE」值得花的原因。
 *
 * ## ⚠️ 守卫：只续**还在 running** 的行
 *
 * UPDATE 带 `status = 'running'` 条件，理由不是「今天会改坏」，而是**多副本/多入口**
 * 形态（正是本函数存在的理由）下「副本 B 已把该行收口为 failed」与「副本 A 的续租」
 * 可以**真的同时发生** —— 此时无守卫的 UPDATE 会把**已 failed 行**的 `started_at`
 * 刷成现在，造成 `finished_at < started_at`，事后任何「跑了多久」的读取都是错的。
 * 它**不会**让任务复活（`claimNextJobs` 只认 `pending`），所以这是**数据完整性**问题。
 * 单实例下本函数紧跟在同 tick 的 `claim` 之后、期间无写入者，今天改不到终态行。
 * 若要接那个形态，下一步是返回受影响行数、让 `runOne` 据此提前放弃 —— 那在今天
 * **不可测**，属于投机，故本轮只加守卫、不改返回值。
 */
export async function renewLease(jobId: string): Promise<void> {
  await db.update(pmsBuiWenlvAssetJobs)
    .set({ startedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(pmsBuiWenlvAssetJobs.id, jobId),
      eq(pmsBuiWenlvAssetJobs.status, 'running'),
    ));
}
