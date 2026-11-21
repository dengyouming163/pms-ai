/**
 * 文旅素材生成 admin 端点（S3）。
 *
 * 与 routes/admin/wenlv.ts 同构：/api/admin/* 在全局 authMiddleware 里是跳过 JWT 的，
 * **必须**自己挂内部 token 守卫（漏了就等于裸奔）。调用方只有 BFF。
 *
 * ⚠️ `authMiddleware` 指的是**本包**（pms-server）的 src/middleware/auth.ts ——
 * 跳过 `/api/admin/` 的那一处在它的 PUBLIC_PATHS 判断里。仓库里另有多个**同名**
 * middleware/auth.ts（pms-platform-server、platform-server 等），各自有各自的跳过表，
 * 读的时候别串了包（Task 17 清单 B-8）。
 *
 * 端点刻意全是**短请求**：触发立刻返回 batchId，进度另查。
 * 因为 BFF 的 internalFetch 有固定 10s 超时（wenlv-studio-client.ts 里那句
 * `signal: AbortSignal.timeout(10000)` —— 不写行号：跨仓行号会漂，写死了就是一条会过期的假事实）。
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
// `and` 是 2026-09-20（Task 13）新增 `GET /review-stats` 时按需引入的：
// 那里要按 productId 过滤，而该过滤的真源写法在 `routes/admin/wenlv-design.ts`
// 的 `GET /assets`（Task C6 起是 `eq(pmsBuiWenlvDesignAssets.productId, productId)`）
// —— 照抄那一份，别在这里另发明一种（两处口径分叉后，按产品筛出来的行会不一致）。
// `sql` 原本用于此处的 `meta->>'productId'` 过滤，C6 切到真列后**已无真用法**，已从 import 删掉。
// `inArray` 仍然**一处都没用到**，别顺手加进来。
// （统计聚合本身仍是在 **JS** 里做的，不走 SQL —— 见 `/review-stats` 的注释。）
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvCharacters, pmsBuiWenlvCollectibles, pmsBuiWenlvDesignAssets,
  pmsBuiWenlvNpcs, pmsBuiWenlvProducts, pmsBuiWenlvRewardTiers, pmsBuiWenlvRewards,
  pmsBuiWenlvVenues, pmsBuiWenlvScenes,
} from '../../db/schema/index.js';
import { loadRuntimeGraph } from '../../services/wenlv/script-room.js';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';
import { serverError, diagnosableErrorText } from '../../lib/http-error.js';
import { planBatch, enqueueBatch, enqueueIteration, fitTag, iterationBlockReason, MAX_EDIT_INPUT_URL } from '../../services/wenlv/asset-gen/enqueue.js';
import type { GeneratableType } from '../../services/wenlv/asset-gen/enqueue.js';
import { designAssetIdFor, selectCandidate } from '../../services/wenlv/asset-gen/candidate-store.js';
import { applyWriteback, buildWritebackPlan } from '../../services/wenlv/asset-gen/writeback.js';
import { ASSET_TYPES, GENERATABLE_TYPES, type JobAssetType } from '../../services/wenlv/asset-gen/asset-types.js';
import { isReviewableType } from '../../services/wenlv/asset-gen/reviewer.js';
import { MAX_CANDIDATES } from '../../services/wenlv/asset-gen/candidates.js';
import { MAX_ATTEMPT } from '../../services/wenlv/asset-gen/claim.js';
// 停摆信号（GET /batch/:batchId）复用的两个判定 —— **不要**在这里手写 `spent >= limit`：
// `>=` 的语义（含「读不到金额时不误停」的 Number.isFinite 守卫）在 batch-budget.ts 里
// 定义，抄成第二份必然漂移。
import { batchBudgetLimit, exceededBatchBudget } from '../../services/wenlv/asset-gen/batch-budget.js';
import { getVideoProvider } from '../../services/wenlv/asset-gen/video-provider.js';
import { checkBlackBackground } from '../../services/wenlv/asset-gen/ar-quality-check.js';
import { acquire, release, hold } from '../../lib/in-flight-guard.js';
import { bootstrapStyleBible, setAssetGenPaused, isAssetGenPaused, reviewAssetJob } from '../../services/wenlv-asset-gen-scheduler.js';
import type { WenlvStyleBible } from '../../db/schema/wenlv.js';

const route = new Hono();

route.use('*', async (c, next) => {
  if (c.req.header('X-Internal-Service-Token') !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ success: false, error: '禁止访问：内部服务认证失败' }, 403);
  }
  return next();
});

// 白名单从**注册表**派生 —— 两处各写一份的代价是加类型时静默漏一处，而漏掉的那一处
// 表现为「勾了这个类型但什么都没发生」，不报错。真源是 `services/wenlv/asset-gen/asset-types.ts`
// 的 `GENERATABLE_TYPES`（它自己又由 `ASSET_TYPES` 滤掉 anchor/style_bible/review 得到）。
// ⚠️ 滤 `review` 那一条是**承重**的：`review` 混进来，`types:['review']` 就成了一次合法请求，
//    `planBatch` 会给这条合成行排一张**真实付费**的文生图 job（它根本没有画面）。
// ⚠️ `GENERATABLE_TYPES` 里那句 `(t): t is GeneratableType` 是**类型断言**，TS 不校验完备性
//    —— 日后若把注册表里的 `review` 改名，TS 不会报错。
const VALID_TYPES: readonly GeneratableType[] = GENERATABLE_TYPES;
// ⚠️ 名字是**每次请求**的节点数，不是「每批的 job 数」（Task 17 清单 B-13 改名）。
//    原名 `MAX_NODES_PER_BATCH` 承诺的是后者 —— 而一次请求会把它展开成
//    `nodes × 2（注册表里 scope === 'node' 的只有 background/narration）+ 1 锚图 + 1 封面`，
//    50 节点 ⇒ 单批 **102 行**。
//    ⚠️ 别用 `VALID_TYPES.length`（它随注册表增长而漂 —— 正因如此才不能拿它当乘数）
//       或「非产品级都算节点级」去推这个乘数：展开键**互不重叠**
//       （product / node / collectible / ending / reward / tier / npc / character，见 asset-types.ts 的 `AssetScope`），
//       只有 `scope === 'node'` 随 nodes 放大；其余各自 1:1 展开、**不随 nodes 放大**：
//         `cover` 是产品级；`stamp` / `collectible` 随图鉴条目；`icon` 随奖励档位（tier）；
//         `ending` / `reward` 随各自实体。
//       唯一真源是 `asset-types.ts` 的 `ASSET_TYPES` 里每个类型的 `scope` 字段。
//    限流作用仍成立（它挡的是**单次请求能展开出的 job 量** = 节点级类型 × 节点数），
//    只是名字不能读成「一批最多 102 个 job 是有意的」。
//    ⚠️ 别说成「挡请求体大小」：请求体只有 productId + types，节点数是服务端从库里查的
//       —— 照「请求体很小」去抬高这个 50，挡不住真正的展开量。
//    真要限 job 数得单独校验 `jobs.length`；本 Task 不做（会与 MAX_ATTEMPT/分页口径纠缠），
//    这里只把名字改准。
const MAX_NODES_PER_REQUEST = 50;

// `editInputUrl` 的**码点**上界不在本文件定义 —— 真源是服务层的
// `enqueue.ts` 的 `MAX_EDIT_INPUT_URL`（注释里写明它等于 `asset_jobs.edit_input_url`
// 的列宽 `varchar(500)`）。原先这里手抄了一个 `EDIT_INPUT_URL_MAX = 500`：两处各写一份
// 会在列宽改动后静默漂移，而漂移的失败形态是「路由放行了超宽值、落库撞 22001 变 500」。

/**
 * 本模块**四个花钱端点**（/batch /iterate /retry /style-bible/bootstrap）共用一个
 * 进程内守卫（`acquire`/`release` 挡住真正重叠的并发，`hold` 给成功路径加冷却）。
 * 机制细节见 lib/in-flight-guard.ts 的模块注释（含单实例假设与覆盖范围的准确说法）。
 *
 * 触发形态是**同一个浏览器双击**：两次点击发两个并发请求，此前各建一整批 job、各记一次费
 * （`costAmount` 是 SQL `+=`）。
 * ⚠️ 2026-09-14 修正：**在飞集合挡不住这个形态**（窗口只有一次 INSERT/UPDATE，数十毫秒，
 * 而双击间隔 100–300ms ⇒ 第二个请求到达时锁多已释放）。
 *
 * ⚠️ **「真正挡住双击的是 hold」这句话对四个端点并不一致地成立**（0e5a2c33 初版的过度承诺）。
 * 按端点如实描述：
 *  - `/batch`：校验 → 查产品 → enqueue → 200，第二次点击会**真的再 enqueue 一批**（各记一次费），
 *    ⇒ 冷却**是真保护，保留**。
 *  - `/iterate`：只校验父行 `status === 'succeeded'`、**不改父行状态**，第二次点击能走到 `acquire`
 *    ⇒ 冷却**是真保护，保留**。
 *  - `/style-bible/bootstrap`：`existing?.artStyle && !force` 的 `reused` 捷径在 `acquire` **之前**，
 *    不传 `force` 时第二次点击直接 200 reused（免费）、冷却用不上；但 `force === true` 会**绕过**
 *    该捷径，此时冷却是防第二次付费 LLM 的**唯一**防线 ⇒ **保留**。
 *  - `/retry`：`acquire` 之前有 `if (job.status !== 'failed') return 400`，重试成功即把行改回
 *    `pending`，**双击的第二次在状态判断处就 400 了，永远到不了 `acquire`** ⇒ 冷却挡不住任何
 *    双倍付费。它唯一的可观测效果是：任务 3s 内又失败（调度器 60s 一跳，重试撞上跳点即可发生）时，
 *    用户再点会拿到 409「该任务正在重试中」而**此刻并没有任何请求在飞**——文案是假的。
 *    故 `hold` 在 `/retry` 上**已摘除**：第二次点击得到的是准确的 400「只有失败的任务可以重试」。
 * 多副本部署下 `acquire` 与 `hold` 都失效（各进程一份内存），届时换 DB claim。
 *
 * 三条实现纪律（改动时别丢）：
 *  1. **自然键必须带端点名前缀**（`batch:${productId}` 而不是 `${productId}`）——
 *     否则「同一产品的自举基线」会把「同一产品的生成批次」挡住，而这两件事可以合法并行。
 *  2. `acquire` 一律放在**全部前置校验之后**：400/404/409-空基线 都要先照常返回。
 *     放到校验之前会把那些请求的 400/404 悄悄改判成 409。
 *  3. 占了就必须在 `finally` 里 `release`，异常路径也要 —— 否则该 key 永久锁死。
 *  4. **总闸也在「全部前置校验之后、`acquire` 之前」**（与第 2 条同源）。
 *     暂停确实不是「校验失败」，但把闸放到校验之前，暂停期间「缺 productId」的 400、
 *     「产品不存在」的 404、「没有风格基线」的 409 会被统统改判成
 *     409「资产生成已暂停」—— 调用方拿到的诊断与真实原因无关，且与第 2 条禁止的是同一件事。
 *     ⚠️ `/style-bible/bootstrap` 上有一处**有意**的例外：`reused` 捷径（纯读、零花费、
 *     不打 LLM）在闸**之前**照常 200；只有真正会花钱的分支才被挡。理由见该端点内的注释。
 */
const IN_FLIGHT_MSG = '该剧本正在生成中，请稍候再试';

/**
 * 总闸命中时的统一文案。四个花钱端点共用这一份 —— 各写一份日后必然漂移，
 * 而调用方（BFF / 运维脚本）是按文案判断的。
 */
const PAUSED_MSG = '资产生成已暂停';

/**
 * 读 JSON body 并保证拿到一个**对象**。
 *
 * `JSON.parse('null')` 是**成功**的（返回 `null`），所以 `.catch()` **不会**触发 ——
 * `const body = await c.req.json().catch(() => ({}))` 之后 `body` 就是 `null`，
 * 紧接着的 `body.productId` 抛 `TypeError: Cannot read properties of null` → 端点 500。
 * 同仓既有的 admin 路由走 `zodSchema.safeParse(await c.req.json().catch(...))`，
 * zod 会把 null 判成 `Expected object, received null` → 400，**天生免疫**；
 * 本文件用 `typeof` 手写形状校验，丢掉的就是这一层，故在这里补回。
 * 非对象（`true` / `"x"` / `[]` / `123`）本来就会被下面的 typeof 判断挡成 400，这里一并归成 `{}`。
 * `[]` 要单独判：`typeof [] === 'object'` 为真，只写 `typeof raw === 'object'` 的话数组会**原样透出**，
 * 与本段承诺的「保证是对象」不符（行为上无害 —— `[].productId` 是 undefined，下游照样 400 ——
 * 但注释与实现不一致，而本仓已经栽过「注释描述不存在的保障」好几次）。
 *
 * 2026-09-14 实测：`!Array.isArray(raw)` **这一支没有任何用例覆盖** ——
 * 删掉它（只留 `typeof raw === 'object'`）全量用例仍然全绿，因为没有任何一条用例
 * 真的把 `[]` 当作合法 body 往下走（`[]` 在上层就因缺 `productId` 被 400 挡掉，
 * 与本分支无关）。留在这里是为了让实现与上面这段承诺一致，不是因为有测试在钉它。
 */
async function readJsonObject(c: { req: { json: () => Promise<unknown> } }): Promise<any> {
  const raw = await c.req.json().catch(() => ({}));
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** POST /batch → 建批次，立刻返回 batchId。**不在这里生成**，由轮询器异步做。 */
route.post('/batch', async (c) => {
  const body = await readJsonObject(c);
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!productId) return c.json({ success: false, error: '缺少 productId' }, 400);
  // 白名单过滤 **+ 去重**。不去重的话 `types:['background','background']` 会展开成两条同名 job，
  // 而这两个 job 都会被轮询器各生成一次、各记一次费（costAmount 是 SQL `+=` 累加）——
  // 用户传重复项是笔误，不该按两份收费。`Set` 保持插入顺序，故输出顺序仍是用户给的顺序。
  const types: GeneratableType[] = Array.isArray(body.types)
    ? Array.from(new Set(body.types.filter((t: unknown) => VALID_TYPES.includes(t as GeneratableType))))
    : [];
  if (types.length === 0) return c.json({ success: false, error: '未指定要生成的素材类型' }, 400);

  // 候选张数（可选）。缺省 = 1 ⇒ 与接线前**逐字节相同**的单图路径。
  //
  // ⛔ **不能写 `Number(body.candidates ?? 1)`**（计划原文就是这么写的，是错的）：
  //    · `candidates: ""` —— `''` **不是 nullish**，`??` 不兜 ⇒ `Number('') === 0`
  //      ⇒ `candidateCount = 0` ⇒ 这一批**一张都不生成**，而 HTTP 照样回 200（静默失效）；
  //    · `candidates: "abc"` ⇒ `NaN` ⇒ 脏值落进 `asset_jobs.candidate_count`；
  //    · `1.5` 会被下游 `Math.floor` 静默吞成 1，而 candidates.ts 明确只收整数。
  //    形状校验口径与 productId 一致（本文件既有风格是 `typeof` 严格判）：只认**正整数**，
  //    **不接受数字字符串**（`Number.isInteger('4')` 为 false，天然排掉）。
  // 位阶：放在**产品查询之前**，故非法 candidates 与「产品不存在」的优先级是确定的
  //（400 先于 404），且这一段完全不碰 DB。
  // 上界用 candidates.ts 的 `MAX_CANDIDATES`，**不在这里另写一个数字**（两处各写一份会漂）。
  const rawCandidates = body.candidates;
  if (rawCandidates !== undefined && rawCandidates !== null
    && (!Number.isInteger(rawCandidates) || rawCandidates < 1 || rawCandidates > MAX_CANDIDATES)) {
    // 不静默夹紧：夹紧会让调用方以为拿到 4 张、实际 1 张，且没有任何信号。
    return c.json({
      success: false,
      error: `候选数必须是 1 到 ${MAX_CANDIDATES} 之间的整数`,
    }, 400);
  }
  const candidates: number = rawCandidates ?? 1;

  const [product] = await db.select().from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  if (!product) return c.json({ success: false, error: '产品不存在' }, 404);

  const bible = product.styleBible as WenlvStyleBible | null;
  // 出图必须有基线 —— 空基线等于放弃防漂移，出一批风格漂移的图比不出更糟（spec §8）。
  // 纯旁白批次不涉及画风，不拦。
  const needsVisual = types.some(t => t !== 'narration');
  if (needsVisual && (!bible || !bible.artStyle)) {
    return c.json({
      success: false,
      error: '该剧本还没有风格基线，请先自举（POST /style-bible/bootstrap）再生成',
    }, 409);
  }

  // ⚠️ 不能把上面这个**可空**的 `bible` 直接交给 `planBatch` —— 两处都会炸：
  //   1) 类型：`planBatch` 的入参是**非空** `bible: WenlvStyleBible`（见 `enqueue.ts` 的 `planBatch` 签名）。
  //      上面的守卫在 `needsVisual === false`（纯旁白批次）时**不收窄** `bible`，
  //      TS strict 下 `planBatch({ bible })` 报 TS2322 —— `pnpm ts-check` 不会「无输出」。
  //   2) 运行时：`bible` 为 null 时 `structuredClone(null)` 得到 null，`toJobRow`
  //      `toJobRow`（`enqueue.ts`）把它**显式**写进 `style_bible_snapshot`。该列是
  //      `notNull().default({})`（见 `schema/wenlv.ts` 的 `style_bible_snapshot` 列定义），而**默认值只在列被省略时生效** ——
  //      显式 NULL 会触发 NOT NULL 冲突，**整批 INSERT 原子回滚**（连锚图一起丢，
  //      正是 enqueue.ts 里 fitName 那段注释在防的同一类事故）。
  //    空基线在库里的既有表示就是 `{}`（列默认值即如此），故这里兜成 `{}`。
  //    `WenlvStyleBible` 的字段**全部可选**（见 `schema/wenlv.ts` 的该类型定义），`{}` 是它的合法值，
  //    **不需要任何 cast** —— 写成 `as WenlvStyleBible` 会把「这里本来就合法」伪装成
  //    「这里在骗类型系统」，下一个读到的人就不敢动了。
  const bibleForJobs: WenlvStyleBible = bible ?? {};

  // 0079 统一模型：节点/结局从规范图 loadRuntimeGraph 取（scenes 投影）。
  const runtime = await loadRuntimeGraph(productId);
  const nodes = runtime.nodes.map((n) => ({ id: n.id, title: n.title, storyText: n.storyText }));
  if (nodes.length > MAX_NODES_PER_REQUEST) {
    return c.json({ success: false, error: `节点数超过 ${MAX_NODES_PER_REQUEST}，请分批生成` }, 400);
  }

  // 图鉴条目：与 nodes 同理，作为**上一级筛选**放在 planBatch 之前。
  // 不过 MAX_NODES_PER_REQUEST 那道闸 —— 它是为「节点数 × 类型数」的笛卡尔积设的，
  // 图鉴是 1:1 展开，不放大。真要限就单设一个常量，别复用一个语义不同的阈值。
  const collectibles = await db.select({
    id: pmsBuiWenlvCollectibles.id,
    name: pmsBuiWenlvCollectibles.name,
    description: pmsBuiWenlvCollectibles.description,
  }).from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, productId));

  // 三个新展开键（ending / reward / tier）的数据源。与 collectibles **完全同一套约定**：
  // **一次查出整个产品**的列表，由 `planBatch` 的 `types` 设闸 —— 少了那道闸，勾「插画」
  // 也会为全部结局/奖励/档位建 job（每条各记一次费，且不报错）。
  // 同样**不过** MAX_NODES_PER_REQUEST：那道闸是为「节点数 × 节点级类型数」的笛卡尔积设的，
  // 这三类各自 1:1 展开（一条实体一条 job），不放大。
  //
  // ⚠️ 上面两句只回答了「**不随 nodes 放大**」，**别读成「这个请求量有界」**：这三张表是
  //    **整个产品一次查出、条数无上限**的。挂 500 个档位的产品，勾 `icon` + `candidates: 4`
  //    ⇒ 单请求就是 2000 张图。
  //    位阶要说清：`candidates.ts` 的 `MAX_CANDIDATES` 是**每 job 行**的张数上界，
  //    **不是每请求**的上界（既不是每请求 job 数，也不是每请求总张数）。单请求的真实上界
  //    在别处 —— `services/wenlv/asset-gen/batch-budget.ts` 的**批次花费熔断**
  //    （`DEFAULT_LIMIT_YUAN`，可被 env `WENLV_BATCH_BUDGET_YUAN` 覆盖），由 `claim.ts`
  //    的领取 SQL 消费 ⇒ 超发不会无界，但会**一直烧到上限才停**，且本次请求照常回 200。
  //    （这里**刻意不复述上限的具体数字**：两处各写一份会漂，要看数字请点进那个文件。）
  // 结局从规范图投影取（type='ending' 的 scenes），id/title/text 与旧 endings 表同形。
  const endings = runtime.endings.map((e) => ({ id: e.id, title: e.title, text: e.text }));
  const rewards = await db.select({
    id: pmsBuiWenlvRewards.id,
    name: pmsBuiWenlvRewards.name,
    description: pmsBuiWenlvRewards.description,
  }).from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, productId));
  const tiers = await db.select({
    id: pmsBuiWenlvRewardTiers.id,
    name: pmsBuiWenlvRewardTiers.name,
    description: pmsBuiWenlvRewardTiers.description,
  }).from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, productId));
  // NPC 列表（T18，spec §5.4 S2）：与 endings/rewards/tiers 同一套约定——
  // 一次查出整个产品的列表，由 `planBatch` 的 `types` 设闸。`description` 这里读
  // `portrait_prompt` 作为出图提示词源文本（与 enqueue.ts 的 npcs 入参口径一致）。
  // ⚠️ 与上面三类同源：**不过** MAX_NODES_PER_REQUEST（NPC 1:1 展开，不放大）。
  const npcs = await db.select({
    id: pmsBuiWenlvNpcs.id,
    name: pmsBuiWenlvNpcs.name,
    description: pmsBuiWenlvNpcs.portraitPrompt,
  }).from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, productId));

  const characters = await db.select({
    id: pmsBuiWenlvCharacters.id,
    name: pmsBuiWenlvCharacters.name,
    ipPrompt: pmsBuiWenlvCharacters.ipPrompt,
  }).from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId))
    .orderBy(pmsBuiWenlvCharacters.order, pmsBuiWenlvCharacters.createdAt);

  const venueId = product.venueId ?? null;
  let styleTag: string | null = null;
  if (venueId) {
    const [v] = await db.select({ name: pmsBuiWenlvVenues.name }).from(pmsBuiWenlvVenues)
      .where(eq(pmsBuiWenlvVenues.id, venueId)).limit(1);
    // 归一在**入口这一处**（`fitTag`：按码点截到 MAX_TAG、空/纯空白归 null），
    // 而不是把 51 字的场地名原样传给 planBatch —— `enqueueBatch` 对超宽是硬抛（整批回滚 → 500），
    // 而场地名 max(100) 是**合法可存**的值（列 varchar(100)，见 routes/admin/wenlv.ts 的 zod）。
    // 素材行那侧的同一列走 scheduler 的 writeAsset，也调同一个 fitTag。
    styleTag = fitTag(v?.name ?? null);
  }

  const batchId = randomUUID();
  // skipAnchorInsert 决定要不要**先插一条锚图** —— 锚图不对用户开放，由这里自动补（spec §4.7）
  //
  // ⚠️ 纯旁白批次必须传 `true`（= 不补锚图）。`planBatch` 里的补锚图是**无条件**的
  //    （enqueue.ts 的 `if (!input.skipAnchorInsert)`），只按这个入参决定。传 `!!styleAnchorUrl` 的后果：
  //      (a) 产品有基线但没锚图 → 用户点「生成旁白」实际会**真花钱出一张图**；
  //      (b) 产品没有基线（正是上面 `needsVisual` 守卫刻意放行的那条路）→ 该锚图行快照是 `{}`
  //          → 调度器 `resolveBible` 抛「该任务没有风格基线」→ 落 failed；而 `claimNextJobs`
  //          只领 pending、**不会自动重领** ⇒ 用户在「只要旁白」的批次里永久看到一条红色失败行。
  //    旁白与画风无关，本来就不需要锚图，所以这里直接跳过补图。
  const jobs = planBatch({
    batchId, venueId, productId, bible: bibleForJobs, nodes, collectibles, types,
    endings, rewards, tiers, npcs, characters, candidateCount: candidates,
    communityStyleTag: styleTag, skipAnchorInsert: needsVisual ? !!product.styleAnchorUrl : true,
  });
  if (jobs.length === 0) return c.json({ success: false, error: '没有可生成的素材' }, 400);
  // 总闸：在位阶上与下面的 acquire 同一条线 —— **全部前置校验之后、唯一副作用之前**
  //（见文件头纪律第 4 条）。放在这里而不是函数体第一行，是为了让暂停期间的
  //「缺 productId(400) / 产品不存在(404) / 没基线(409)」仍返回各自的真实诊断；
  // 挪到校验之前，它们会被统统改判成 409「资产生成已暂停」。
  // 暂停时**显式拒绝**，而不是照常建批次：照常建的话调用方拿到 200、批次永远停在 pending，
  // 界面「看着在跑其实没跑」—— 这正是本项目反复出现的失败模式。宁可在这里 409。
  if (isAssetGenPaused()) return c.json({ success: false, error: PAUSED_MSG }, 409);

  // 守卫放在这里 = **全部前置校验之后、唯一副作用之前**（见文件头 IN_FLIGHT 注释第 2 条）：
  // 上面任何一条 400/404/409 都已提前返回，这里的 409 只会给「本该成功的那次双击」。
  const key = `batch:${productId}`;
  if (!acquire(key)) return c.json({ success: false, error: IN_FLIGHT_MSG }, 409);
  try {
    await enqueueBatch(jobs);
  } finally {
    release(key);
  }
  // 成功后才冷却（见 lib/in-flight-guard.ts 文件头第 2 层）：`enqueueBatch` 抛错时上面就出去了，
  // 根本走不到这一行，所以失败不冷却、用户可立刻重试。这里**不需要** try/finally 兜底 ——
  // 冷却本身就是靠过期消失的，没有「必须撤销」的配对动作。
  // 没有这一行的话，本端点的守卫窗口就只剩一次 INSERT（数十毫秒），而双击间隔 100–300ms
  // 通常大于它 ⇒ 在飞集合**多半**挡不住（并非绝对：第二个请求正落在写窗口内时仍会命中）。
  hold(key);
  return c.json({ success: true, data: { batchId, total: jobs.length } });
});

/**
 * 总闸的运维端点（不重启进程暂停 / 恢复）。
 *
 * ⚠️ **停止不是立刻生效的**：闸只在 `runAssetGenOnce` 开头判一次，已经越过闸的那一 tick
 * 会跑完（锚图循环的墙钟预算 5 分钟）—— 要立刻止血仍然只有停容器。
 * 准确说法见 services/wenlv-asset-gen-scheduler.ts 的 isAssetGenPaused 注释。
 *
 * 路径用 `pause-state` 而不是 `GET /pause`：同一个路径上挂 GET+POST，会让
 * 「`GET /pause` 是查询还是幂等暂停」产生歧义。（**不是**因为本文件全是动宾命名 ——
 * 本文件另有三个资源式 GET：`/batch/:batchId`、`/jobs/:jobId/versions`、
 * `/style-bible/:productId`，`POST /batch` 本身也是名词。）
 *
 * 响应体的 `paused` 一律回**当前有效状态**（`isAssetGenPaused()`），不是「本次动作的目标态」：
 * env `WENLV_ASSET_GEN_PAUSED=1` 时 `/resume` 恢复不了，此刻回 `{paused:false}` 就是撒谎 ——
 * 而运维拿到「已恢复」之后唯一会做的事就是不再管它。
 */
/** POST /pause → 暂停资产生成（不重启进程）。 */
route.post('/pause', async (c) => {
  setAssetGenPaused(true);
  const paused = isAssetGenPaused();
  // 事后要能回答「谁在什么时候把花钱停了」——没有这行日志就查不出来。
  console.warn('[wenlv-asset-gen] 总闸：收到 /pause，当前有效状态 paused =', paused);
  return c.json({ success: true, data: { paused } });
});

/** POST /resume → 恢复。env=1 时恢复不了，响应如实回 true。 */
route.post('/resume', async (c) => {
  setAssetGenPaused(false);
  const paused = isAssetGenPaused();
  console.warn('[wenlv-asset-gen] 总闸：收到 /resume，当前有效状态 paused =', paused,
    paused ? '（env WENLV_ASSET_GEN_PAUSED=1 仍生效，进程内开关已清但总闸仍关着）' : '');
  return c.json({ success: true, data: { paused } });
});

/** GET /pause-state → 当前**有效**状态是否暂停。**给运维看的**，不是给控制台轮询的。 */
route.get('/pause-state', async (c) => {
  return c.json({ success: true, data: { paused: isAssetGenPaused() } });
});

/** POST /iterate → 对一条已成功的素材带反馈重出一版。 */
route.post('/iterate', async (c) => {
  const body = await readJsonObject(c);
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  const guidance = typeof body.guidance === 'string' ? body.guidance.trim() : '';
  if (!jobId) return c.json({ success: false, error: '缺少 jobId' }, 400);
  // 迭代必须带反馈 —— 没有反馈就是重试，不该走这条路
  if (!guidance) return c.json({ success: false, error: '请填写本轮要修改的地方' }, 400);

  // ── 涂鸦重绘输入图（editInputUrl）──
  // 与 guidance 同层解析（都在 readJsonObject 之后、job 查找之前），**完全不碰 DB**。
  //
  // ⛔ **存在但不是字符串 ⇒ 400，不静默当没传**：静默吞掉正是
  //    `zod-empty-string-dirty-reference` 那一类脏引用 —— 用户画了标注上传，
  //    后端收下就扔，出来一张没按标注改的图，且**没有任何信号**。
  // ⛔ **长度闸承重**：`edit_input_url` 是 `varchar(500)`（schema/wenlv.ts），而
  //    `enqueueIteration` 只做 `.trim() || null`、**没有任何长度钳制** —— 本 Task
  //    正是让这个字段变成 HTTP 可达的那一跳。不设闸的后果：>500 码点 ⇒ 落库撞
  //    PG `SQLSTATE 22001` ⇒ 冒泡成 **500**，而它本该是 400。
  //    按**码点**数（`Array.from`），与 `fitName` / `fitTag` 同一条口径。
  const rawEditInputUrl = body.editInputUrl;
  let editInputUrl: string | null = null;
  if (rawEditInputUrl !== undefined && rawEditInputUrl !== null) {
    if (typeof rawEditInputUrl !== 'string') {
      return c.json({ success: false, error: 'editInputUrl 必须是字符串' }, 400);
    }
    const v = rawEditInputUrl.trim();
    if (v) {
      if (Array.from(v).length > MAX_EDIT_INPUT_URL) {
        return c.json({ success: false, error: `editInputUrl 过长（上限 ${MAX_EDIT_INPUT_URL} 字符）` }, 400);
      }
      // 最小形态闸：只认 `http(s)://` 绝对地址。刻意**不做 host 白名单** ——
      // 已核实（grep 全仓）本服务端**从不 dereference** 这个 URL：它只被调度器
      //（`wenlv-asset-gen-scheduler.ts`）push 进 `refs`，经 `image-provider` 作为
      // `body.image` **转发**给上游图像 API，由上游自己去取；全仓没有任何
      // 「拿到 URL 后再 fetch/请求」的代码路径 ⇒ **不存在 SSRF 面**，
      // host 白名单只会挡住合法外链而毫无安全收益。
      if (!/^https?:\/\//.test(v)) {
        return c.json({ success: false, error: 'editInputUrl 必须是 http(s) 地址' }, 400);
      }
      editInputUrl = v;
    }
    // 空串 / 纯空白 ⇒ 保持 null（与 `enqueueIteration` 的 `.trim() || null` 同义）。
  }

  // ── 版本底图（fromIndex）──
  // 非负整数，否则 400（不静默忽略 —— 忽略会让用户以为选中的那一版被用上了）。
  // 同样**不碰 DB**；真正解析成底图 URL 的那一步在下面（需要查 design_assets）。
  const rawFromIndex = body.fromIndex;
  let fromIndex: number | null = null;
  if (rawFromIndex !== undefined && rawFromIndex !== null) {
    if (!Number.isInteger(rawFromIndex) || (rawFromIndex as number) < 0) {
      return c.json({ success: false, error: 'fromIndex 必须是非负整数' }, 400);
    }
    fromIndex = rawFromIndex as number;
  }

  // ⚠️ 两道前置校验必须**在这里**显式做，不能靠 catch `enqueueIteration` 抛的普通 `Error`
  //    再去分辨「业务拒绝」与「DB 故障」：两者都是 `Error`，唯一能区分的只有 message 文本，
  //    而把 e.message 直接写进响应是**全仓库禁止**的 —— drizzle 的错误 message 里带
  //    完整 SQL 与参数（闸门见 src/__tests__/no-raw-error-leak.test.ts，
  //    它正是抓出本例初版 `String(e?.message || e)` 的那道闸）。
  //    `enqueueIteration` 内部的两道校验原样保留（服务层自守，别的调用方也拿得到），
  //    这里只是把**用户可见的文案**与**正确的状态码**（404 而非 400）给出来。
  const [parent] = await db.select().from(pmsBuiWenlvAssetJobs)
    .where(eq(pmsBuiWenlvAssetJobs.id, jobId)).limit(1);
  if (!parent) return c.json({ success: false, error: '要迭代的任务不存在' }, 404);
  if (parent.status !== 'succeeded') return c.json({ success: false, error: '只能迭代已成功的素材' }, 400);
  // 反馈无处可施的类型（旁白 / 风格锚图）在这里**显式拒绝** —— 理由与文案同源取自服务层
  // （`iterationBlockReason`），不在这里另写一份。若只把守卫留在服务层，它会走 catch 变成
  // 500「迭代失败，请稍后重试」：用户看不懂为什么失败，而那其实是一条**确定的**规则。
  const blocked = iterationBlockReason(parent.assetType);
  if (blocked) return c.json({ success: false, error: blocked }, 400);

  // ── fromIndex → 底图 URL → editInputUrl ──
  // 这是**唯一**能把「组内第 N 张」送进新 job 参考图的路：`enqueueIteration` 既不接受
  //   `fromIndex` 也没有 `referenceUrls` 形参（后者是 `generateImageJob` 的运行期字段，
  //   由 `db.update(...).set({ referenceUrls: refs })` 直接写在 job 行上 —— 见 enqueue.ts
  //   里那段明确禁止把它当入队期字段的注释）。所以只能把第 N 张的 `design_assets.url`
  //   解析成 `editInputUrl`，再由调度器 push 进 `refs`：
  //     fromIndex ──designAssetIdFor──▶ design_assets.url ──▶ editInputUrl
  //               ──enqueueIteration──▶ job.editInputUrl ──scheduler──▶ 上游参考图
  //   `designAssetIdFor(jobId, 0)` 就是单候选那张（index 0 无 `-N` 后缀）。
  //
  // **优先级**：`editInputUrl` 优先 —— 它是用户**当场画的标注图**，是这一轮迭代的直接输入；
  //   `fromIndex` 只是「拿哪一版当底图」的间接指代。两个都给时，用户画的那张说了算。
  //
  // ⛔ **刻意不实现**计划里那句「不传 `fromIndex` 则用被采纳的那张」：迭代 job 当前的
  //    `refs` 是 `[锚图, ...风格参照]`，**不含父行被采纳的那张图**。实现出来等于让
  //    **每一次既有迭代**都多带一张参考图（`edit_input_url` 由 null 变有值、`refs` 变长、
  //    成本与「参考图 + 生成图 ≤ 15」的硬约束都动）—— 那是**产品决策**，不是本 Task 的
  //    实现细节，已上报待拍板。故只做「显式传 `fromIndex` 才生效」，缺省行为逐字节不变。
  if (!editInputUrl && fromIndex !== null) {
    const baseAssetId = designAssetIdFor(jobId, fromIndex);
    const [base] = await db.select({ url: pmsBuiWenlvDesignAssets.url })
      .from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, baseAssetId)).limit(1);
    // 行不存在 **或** 该行没有 URL 都归 404（与 /select 同码）：把「有行但取不到图」
    // 静默降级成 null 会让用户以为「选了第 N 版当底图」生效了，实际什么也没带上 ——
    // 正是本仓最怕的那种静默失效。
    if (!base?.url) return c.json({ success: false, error: '该候选不存在' }, 404);
    editInputUrl = base.url;
  }

  // 总闸（同 /batch：全部前置校验之后、acquire 之前，见文件头纪律第 4 条）。
  // 不加这一道，暂停期间迭代照常 `enqueueIteration` 建一条 pending 行并回 200 ——
  // 与 /batch 被挡下的那个形状**一模一样**：界面看着在跑，调度器不动，行永远 pending。
  if (isAssetGenPaused()) return c.json({ success: false, error: PAUSED_MSG }, 409);

  // 守卫在全部前置校验之后（同 /batch）。自然键取**父行的 productId**（请求体里没有 productId，
  // 只有 jobId）—— 这样「同一剧本的两条素材同时被点迭代」也归一到同一把锁。
  // 父行没挂产品时（productId 可空）退化到 jobId：那是「这条任务自己的迭代」，仍是正确粒度；
  // 若写成 `productId` 裸拼，所有无产品的任务会共用一个字符串 `null` 键而互相误挡。
  const key = `iterate:${parent.productId ?? jobId}`;
  if (!acquire(key)) return c.json({ success: false, error: IN_FLIGHT_MSG }, 409);
  try {
    const batchId = randomUUID();
    const { id } = await enqueueIteration({ parentJobId: jobId, guidance, batchId, editInputUrl });
    // 成功后冷却（进 try 内、catch 之前）：`enqueueIteration` 抛错会走 catch，不会到这里，
    // 故失败不冷却，用户可立刻改反馈重试。
    hold(key);
    // ⚠️ 响应字段叫 `newJobId`，**不叫** `jobId`（Task 17 清单 B-11 改名）：
    //    请求体里的 `jobId` 是**父行**（被迭代的那条），而这里回的是 `enqueueIteration`
    //    **新建的那一行**。同一个词在同一个端点的入参与出参里指两个不同的行 —— 这正是
    //    「跨跳丢参」那一类静默错误的温床（调用方一眼看去以为回的是自己传进去的那个）。
    //    调用方需同步用新名（pms-wenlv-web 的 wenlv-api.ts 类型 + asset-generation.tsx）。
    return c.json({ success: true, data: { batchId, newJobId: id } });
  } catch (e) {
    // ⚠️ 别写成「走到这里只剩 DB/IO 故障」——**不成立**（Task 17 清单 B-9 纠偏）。
    //    `enqueueIteration` 内部**自己又查了一次父行**并会为业务原因抛错：
    //      · `要迭代的任务不存在`（父行在 /iterate 首读父行、`enqueueIteration` 复读之间被删；不写行号，会漂）
    //      · `只能迭代已成功的素材`（父行 status 在这两次读之间被改）
    //    这两条语义上是 404 / 400，落到这里却一律变成 500 —— 窗口极窄（两次读之间），
    //    但不是零。这正是「业务拒绝不在 catch 里按 message 分辨」那条纪律的代价：
    //    正确修法是让 `enqueueIteration` 回**类型化**的拒绝而不是抛通用 Error，
    //    本 Task 不做（属接口改造，超出收口范围），故这里只把话说准。
    //    原文只进服务端日志 —— serverError 内部 `console.error(msg, e)` 传的是**对象**，
    //    堆栈与 SQL 都留在日志里。
    return serverError(c, e, '迭代失败，请稍后重试', 500);
  } finally {
    release(key);
  }
});

/**
 * POST /select → 采纳候选组里的某一张。
 *
 * 三件事，**顺序不能反**：
 *   1. `selectCandidate`（内部先清后设，避开不变量索引 `uq_wenlv_design_assets_selected`
 *      在「新的已 true、旧的还没清」的那一刻的瞬时冲突）
 *   2. 重跑业务表回写（业务表只认**被采纳**的那张 —— 改选后 `products/node/…` 的图
 *      必须跟着换）
 *   3. 若新选中项还没评过分**且类型可评**，**补一条评审**（fire-and-forget，不连坐采纳）
 *
 * ⚠️ 第 3 步的顺序与「不挂 guard / 不查暂停闸」是**刻意**的，不是漏了：
 *   · **不挂 `acquire`/`release`** —— 采纳是一次纯 DB 短操作，不排队生成、不占候选额度，
 *     没有「双击变成双倍付费」这个形态（与 `/batch`、`/iterate` 那类端点不同）。
 *     ⚠️ 但**并发面不是零**，如实说清它的真实形态：`selectCandidate` 是「先按 jobId 全量清、
 *     再单选置 true」两条 UPDATE、**中间无事务**。两个并发 `/select` 交错时的后果：
 *       · 不变量索引 `uq_wenlv_design_assets_selected`（一个 job 至多一行 true）保证
 *         **不会有脏状态**落库；
 *       · 但可能出现「偶发 500（后一条 UPDATE 撞唯一索引）」或「后到者静默胜出」
 *         （谁最后置 true 谁赢）。
 *     两者都**不多花一分钱**，也都能靠重试自愈 —— 故不值得为它引入进程内锁
 *     （锁本身在多副本下也失效，见文件头）。
 *     ⚠️ 与调度器收尾那一次**自选**的竞争，由下面的 `status === 'succeeded'` 闸**完全闭合**
 *     （调度器的顺序是 `selectCandidate` → `applyWriteback` → **最后**才把行改成
 *     `succeeded`，故它那次自选**严格早于** succeeded 可见；见 scheduler 的收尾段）。
 *   · **不查暂停闸** —— 采纳本身不花钱；它顺带触发的评审由 `reviewAssetJob(…).catch(…)`
 *     兜住（评审失败只让这张没分，不影响已采纳的图）。给一个零花费的短操作加 409
 *     「资产生成已暂停」只会让暂停期间连「选图」都做不了，而它并不产出任何上游调用。
 *     （若日后产品要求「暂停期间连评审都不许触发」，那要挡的是第 3 步那一次**付费**调用，
 *      与总闸的语义不同，需单独拍板 —— 别顺手把整个端点挂上总闸。）
 */
route.post('/select', async (c) => {
  // 函数体**整体**包一层 try/catch（与 /iterate `serverError(c, e, '迭代失败…', 500)`、
  // /style-bible/bootstrap 的 502 同一范式）：兜底的 DB/IO 故障经 `serverError` 出去 ——
  // 它把**完整错误对象（含堆栈）**记进服务端日志（前缀是 `[pms-server] 未预期错误:`,
  // 由 lib/http-error.ts 统一打，不是本文件的 `[wenlv-asset-gen]`），客户端只拿通用文案。
  // ⚠️ 下面所有 `return c.json({ success:false, … }, 4xx)` 是**业务分支**，必须原样透出
  //    各自的真实状态码；`catch` 只接**抛出**的异常，别把它改判成 500。
  try {
    const body = await readJsonObject(c);
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (!jobId) return c.json({ success: false, error: '缺少 jobId' }, 400);
    // index 必须是**非负整数**。不静默夹紧、不回落：越界若被静默当成 index 0，
    // 「点了第 3 张却采纳了第 1 张」会无声发生。
    const index = body.index;
    if (!Number.isInteger(index) || (index as number) < 0) {
      return c.json({ success: false, error: 'index 必须是非负整数' }, 400);
    }
    const idx = index as number;

    const [job] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, jobId)).limit(1);
    if (!job) return c.json({ success: false, error: '任务不存在' }, 404);

    // ⚠️ **状态闸**（与 `/iterate` 的 `status !== 'succeeded' → 400` 同族，但**不是同一句话**
    //    —— 两个端点的动作不同）。少了它，job 还在 `running` 时点采纳会被调度器收尾那一次
    //    **自选**覆盖掉：调度器收尾的顺序是 `selectCandidate` → `applyWriteback` →
    //    **最后**才把行改成 `succeeded`（见 scheduler 的收尾段）⇒ 它那次自选**严格早于**
    //    `succeeded` ⇒ 加上这道闸，竞争窗口是**完全闭合**的，不是只收窄。
    //    ⚠️ 但「完全闭合」**只对上面这条 `selectCandidate` 的竞争成立**，别外推 ——
    //       本端点末尾那次**补评**不在它的管辖内（那发生在 `succeeded` 之后，闸管不到）。
    //       补评的去重闸在 `reviewAssetJob` 内部（`reviewScore !== null || reviewSource === 'human'`），
    //       不在本端点，见 scheduler 里该函数的开头。
    //       ⚠️ 2026-09-20（T13 §2 扩闸）订正：原文这里写着「两条路径会在同一窗口对同一张图
    //          各发起一次付费评审」—— **那个竞争面已经不存在了**。本端点的采纳恒写
    //          `reviewSource='human'`，而闸现在也判这一列 ⇒ 本端点的补评一律被收口点拦下
    //          （整段调用点因此不可达，见下面那段注释）；于是同一张图上只剩调度器那一次自动评。
    if (job.status !== 'succeeded') return c.json({ success: false, error: '只能采纳已成功的素材' }, 400);

    // ⚠️ 这一步的存在性前置查找是**承重的**，不能省：
    //    `selectCandidate` 内部第二条 `UPDATE … WHERE id = <designAssetIdFor(jobId,index)>
    //    AND jobId = …` **匹配到 0 行也算成功**（不抛、不报）—— 也就是越界/不存在的候选
    //    会被它**静默接受**，而第一条「把组内全部置 false」已经先执行了 ⇒ 结果是
    //    「一个候选都没被采纳」。少了这次查找，越界就是一条**静默**的破坏性写入。
    const assetId = designAssetIdFor(jobId, idx);
    const [asset] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
    if (!asset) return c.json({ success: false, error: '该候选不存在' }, 404);

    // `'human'`：这条路是**人**点的（另一个调用点是调度器收尾的机器自选，传 `'machine'`）。
    // 传错会让「人工采纳」这个信号被机器自选污染，且把首轮自动评整体拦掉
    // —— 见 `selectCandidate` 函数头 `source` 那段。
    await selectCandidate(jobId, idx, 'human');
    // 回写：目标为空（`targetId` 缺失）时 `buildWritebackPlan` 返回 null，
    // `applyWriteback(null)` 是 no-op —— 素材已进资源库、只是没有写回目标，这不构成失败。
    await applyWriteback(buildWritebackPlan(
      job.assetType as JobAssetType, job.targetId, asset.url ?? '', assetId,
    ));
    // ⚠️ 下面这段补评**自 2026-09-20（T13 §2 扩闸）起已不可达 —— 但故意保留**。
    //    为什么不达：上一句 `selectCandidate(…, 'human')` 刚把这一行写成
    //    `reviewSource = 'human'`，而 `reviewAssetJob` 收口点的去重闸现在判
    //    `a.reviewScore !== null || a.reviewSource === 'human'` ⇒ 它**必在闸上返回**，
    //    走不到任何付费调用。逐条核对过的后果：
    //      · `isReviewableType(...)` 这一半在**本路径**上已成死代码（它仍是
    //        `shouldReview` 的一半，由 `review-enqueue.test.ts` 单测承重）；
    //      · 本条 `.catch` 的 warn 不再覆盖「视觉调用失败」—— 那个失败面在本路径上
    //        **不存在了**。「评审失败不得完全无声」只剩调度器收尾那一个活着的调用点，
    //        看守已搬到 `asset-gen/__tests__/run-once.db.test.ts`。
    //    为什么**保留**而不是删掉：闸是**另一个函数**里的不变量，删掉这里等于让「谁赢」
    //    这个决定散落在两个文件里；保留则「human 赢」只有一处实现（收口点）。
    //    `.catch` 也仍有一个（很窄的）可达面：`selectCandidate` 之后、`reviewAssetJob`
    //    第一次读库之前若发生**连接级**故障，promise 会 reject —— 那时它就是唯一的日志。
    //    ⛔ 谁若把 `selectCandidate` 的人工标记挪走，这里立刻重新变成活的防护
    //      —— 别把它当成「已死可以删」的代码。
    // fire-and-forget：评审失败只让这张没分，**不连坐**本次采纳（与 scheduler 调用点同一条纪律）。
    if (isReviewableType(job.assetType) && asset.reviewScore === null) {
      // ⚠️ **绝不能写成 `.catch(() => {})`**（初版就是）：`reviewAssetJob` 内部没有
      //    try/catch，`callLlmVision` / `parseReview` 也不自我记日志 ⇒ 评审一失败，
      //    「这张图**永远**没有分数」会**完全无声**，生产上没人能发现。
      //    ⛔ 也不许改成会 `throw` 的：评审失败**不得**连坐采纳 —— 这是刻意的纪律。
      reviewAssetJob(assetId).catch(e =>
        console.warn(`[wenlv-asset-gen] /select 补评未完成（分数或记账可能未落）assetId=${assetId}：`, diagnosableErrorText(e)));
    }
    // 响应形状与**本组其余端点**对齐：`{ success, data: { … } }`。
    // 原来这里回的是 `{ success: true, assetId }`（assetId 在**顶层**）—— 本组唯一一个
    // 不平坦的端点。前端 `selectCandidate` 声明的是 `Env<{ assetId: string }>` 并读
    // `data.assetId`，与顶层形状**对不上**：调用方拿到 undefined 且**不会报错**
    // （只是「采纳成功了但拿不到 id」）。放在 `data` 下后与 `/batch`、`/iterate` 一致。
    return c.json({ success: true, data: { assetId } });
  } catch (e) {
    return serverError(c, e, '采纳失败，请稍后重试', 500);
  }
});

/**
 * POST /review → **人工给意见**（spec §8.5 口径①b）。
 *
 * 与 `/select` 是同一路评价的两个入口：`/select` 表达「人工**采纳**了这张」，
 * 本端点表达「人工**给它打了分 / 写了意见 / 明确淘汰了它**」。两者都写
 * `review_source = 'human'`，都让紧随的 AI 补评**不再发起**。
 *
 * ⚠️ **只写人工列族**（`human_review_score` / `human_review_detail` /
 *    `human_reviewed_at` / `is_rejected` / `review_source`），
 *    `review_score` / `review_detail` / `reviewed_at` / `review_model` 四个 AI 列
 *    **一个字都不许碰**。覆写它们就等于把 `human - ai` 的分差指标删掉 ——
 *    而那个分差正是 §8.5 的副产品指标（两者长期背离 ⇒ 自动评价器不可信）。
 *    ⛔ 尤其不要「顺手」把人工分也写进 `review_score` 让它「看起来一致」：
 *       一致的表象下，`GET /review-stats` 的分母会永远算不出东西。
 *
 * ⚠️ 三态参数（`undefined` = 本次不动这一项）。这与全仓「跨跳丢参」那条教训同源：
 *    用 `?? null` 把「没传」和「显式传 null」合并，会让将来的「清空分数」需求
 *    静默变成一个空操作（传 null 想清空，结果被当成没传）。
 *    一次都没动任何一项 ⇒ 400：空动作不该盖一个 `'human'` 的时间戳上去，
 *    那会让「人工看过」与「人工评过」在数据上不可分。
 */
route.post('/review', async (c) => {
  try {
    const body = await readJsonObject(c);
    const assetId = typeof body.assetId === 'string' ? body.assetId : '';
    if (!assetId) return c.json({ success: false, error: '缺少 assetId' }, 400);

    // 分数：给了就必须是 0-10 的有限数。**不夹紧**（与 `parseReview` 同一条纪律）——
    // 越界说明调用方算错了，夹成 10 会把异常伪装成一次满分人工评价。
    //
    // ⚠️ **先验类型再 `Number()`**，与 `reviewer.ts` 的 `parseReview` 逐字同款：
    //    `Number(true)` === 1、`Number([])` === 0、`Number('  ')` === 0 —— 全是**有限数**，
    //    于是 `{ score: true }` 会静默落成一次「人工打 1 分」的真实评价，
    //    既进了分差统计，又挡住这张图的 AI 补评。**本任务的自测抓到的真 bug**
    //    （2026-09-20：`for (const bad of [-1, 11, 'abc', true])` 里只有 `true` 那一轮红了）。
    //    数字字符串（`"8.5"`）是前端表单的常见写法，**刻意接受**；其余非 number/string 一律 400。
    const rawScore = body.score;
    let humanReviewScore: string | null | undefined;
    if (rawScore === undefined) {
      humanReviewScore = undefined;
    } else if (rawScore === null || rawScore === '') {
      humanReviewScore = null;
    } else {
      const scoreIsNumeric =
        typeof rawScore === 'number' || (typeof rawScore === 'string' && rawScore.trim() !== '');
      if (!scoreIsNumeric) {
        return c.json({ success: false, error: '分数必须是 0-10 的数' }, 400);
      }
      const n = Number(rawScore);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        return c.json({ success: false, error: '分数必须是 0-10 的数' }, 400);
      }
      // `numeric(4,2)` 列，按 string 写（本仓金额/分数列一律 string mode）。
      humanReviewScore = String(n);
    }

    const rawComment = body.comment;
    if (rawComment !== undefined && rawComment !== null && typeof rawComment !== 'string') {
      return c.json({ success: false, error: '意见必须是字符串' }, 400);
    }
    let humanReviewDetail: { comment: string } | null | undefined;
    if (rawComment === undefined) humanReviewDetail = undefined;
    else {
      const t = (rawComment ?? '').trim();
      // 全空白 = 清空（显式 null），不是「写了一段空白意见」——
      // 后者会在参照样本里渲染成一条看起来有话、实际什么都没有的样本。
      humanReviewDetail = t === '' ? null : { comment: t };
    }

    const rawRejected = body.isRejected;
    if (rawRejected !== undefined && typeof rawRejected !== 'boolean') {
      return c.json({ success: false, error: 'isRejected 必须是布尔' }, 400);
    }
    const isRejected = rawRejected === undefined ? undefined : rawRejected;

    if (humanReviewScore === undefined && humanReviewDetail === undefined && isRejected === undefined) {
      return c.json({ success: false, error: '至少要有分数、意见或淘汰标记之一' }, 400);
    }

    // 存在性前置查找是**承重的**（与 `/select` 同一条理由）：`UPDATE … WHERE id = ?`
    // 匹配到 0 行**也算成功**（不抛、不报）⇒ 少了这次查找，给一个不存在的 assetId
    // 会拿到 `{ success: true }`，而实际上什么都没写。
    const [asset] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
    if (!asset) return c.json({ success: false, error: '该素材不存在' }, 404);

    await db.update(pmsBuiWenlvDesignAssets).set({
      ...(humanReviewScore !== undefined ? { humanReviewScore } : {}),
      ...(humanReviewDetail !== undefined ? { humanReviewDetail } : {}),
      ...(isRejected !== undefined ? { isRejected } : {}),
      // 人工介入的印记：`reviewAssetJob` 的去重闸读这一列决定不再发起 AI 补评。
      reviewSource: 'human',
      humanReviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvDesignAssets.id, assetId));

    return c.json({ success: true, data: { assetId } });
  } catch (e) {
    return serverError(c, e, '保存人工评审失败，请稍后重试', 500);
  }
});

/**
 * GET /review-stats?productId= → 人工评审的**只读**统计（spec §8.5 口径③）。
 *
 * 分母口径是本端点的全部要点：**只有同一张图同时有 AI 分与人工分时才计入分差**。
 * 只加「只有人工分」的行会让分差被稀释成看起来「两者差不多」——
 * 而实际上「人工评了、AI 没评」这件事本身就说明评价器没跑到（或跑了没落分），
 * 把它当成一致是**反向**的结论。故两个数分开报（`compared` = 分母，
 * `humanOnly` / `aiOnly` = 被排除掉的两类），不合并成一个「覆盖率」。
 *
 * ⚠️ 聚合在 **JS** 里做（与 `GET /batch/:batchId` 的统计同款），不走 SQL：
 *    `numeric` 列在 drizzle 下是 **string mode**，`SUM()` 出来的类型与精度口径
 *    都要另行对齐；而本表当前是数十行量级，JS 聚合没有性能理由非走 SQL 不可。
 *    上量后再改成 SQL 聚合 —— 那时**分母口径必须逐字保留**（它是本端点的语义）。
 */
route.get('/review-stats', async (c) => {
  const productId = c.req.query('productId');
  const conds = [];
  if (productId) conds.push(eq(pmsBuiWenlvDesignAssets.productId, productId));
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db.select({
    reviewScore: pmsBuiWenlvDesignAssets.reviewScore,
    humanReviewScore: pmsBuiWenlvDesignAssets.humanReviewScore,
  }).from(pmsBuiWenlvDesignAssets).where(where);

  let compared = 0;
  let sumAi = 0;
  let sumHuman = 0;
  let humanOnly = 0;
  let aiOnly = 0;
  for (const r of rows) {
    const hasAi = r.reviewScore !== null;
    const hasHuman = r.humanReviewScore !== null;
    // ★ 分母：**两者都有**。这两个分支的顺序不能反 —— 先判「双评」再判单评，
    //   否则「只有人工」会被 `hasHuman` 那一支截走，分母永远为空。
    if (hasAi && hasHuman) {
      compared += 1;
      sumAi += Number(r.reviewScore);
      sumHuman += Number(r.humanReviewScore);
    } else if (hasHuman) humanOnly += 1;
    else if (hasAi) aiOnly += 1;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return c.json({
    success: true,
    data: {
      productId: productId ?? null,
      /** 分差的**分母**：同一张图同时有 AI 分与人工分。 */
      compared,
      avgAiScore: compared === 0 ? null : round2(sumAi / compared),
      avgHumanScore: compared === 0 ? null : round2(sumHuman / compared),
      /** `人工 − AI`。**正的 = 人工比评价器松**，负的 = 人工更严。 */
      avgDelta: compared === 0 ? null : round2((sumHuman - sumAi) / compared),
      /** 落在分母外、**不参与**分差的两类。报出来是为了让「分母很小」这件事可见。 */
      humanOnly,
      aiOnly,
    },
  });
});

/** POST /retry → 失败重来。**复用同一行**，prompt 不变（与迭代本质不同）。 */
route.post('/retry', async (c) => {
  const body = await readJsonObject(c);
  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) return c.json({ success: false, error: '缺少 jobId' }, 400);
  const [job] = await db.select().from(pmsBuiWenlvAssetJobs)
    .where(eq(pmsBuiWenlvAssetJobs.id, jobId)).limit(1);
  if (!job) return c.json({ success: false, error: '任务不存在' }, 404);
  if (job.status !== 'failed') return c.json({ success: false, error: '只有失败的任务可以重试' }, 400);
  // 用 claim.ts 的同一个常量 —— 两处各写一个字面量会各自漂移
  if (job.attempt >= MAX_ATTEMPT) return c.json({ success: false, error: '已达重试上限，请改用迭代' }, 400);
  // 总闸（同 /batch：全部前置校验之后、acquire 之前，见文件头纪律第 4 条）。
  // 不加这一道，暂停期间重试会把 failed 行改回 pending 并回 200 —— 同样落进
  //「界面看着在跑、调度器不动、行永远 pending」的坑（attempt 也不涨，看起来毫无异常）。
  if (isAssetGenPaused()) return c.json({ success: false, error: PAUSED_MSG }, 409);

  // 守卫在全部前置校验之后（同 /batch）。重试的作用域是**单条任务**，自然键用 jobId。
  // ⚠️ 这里**刻意不调 `hold`**（与另外三个端点不同，见文件头「按端点如实描述」一节）：
  //    本端点 `acquire` 之前有 `status !== 'failed' → 400`，重试成功即把行改回 `pending`，
  //    双击的第二次在**状态判断处**就 400 了、根本到不了 `acquire` ⇒ 冷却挡不住任何双倍付费。
  //    保留它反而有害：任务 3s 内又失败时，用户再点会拿到 409「该任务正在重试中」，
  //    而此刻并无请求在飞 —— 文案是假的。摘掉后第二次点击得到准确的 400。
  const key = `retry:${jobId}`;
  if (!acquire(key)) return c.json({ success: false, error: '该任务正在重试中，请稍后重试' }, 409);
  try {
    await db.update(pmsBuiWenlvAssetJobs).set({
      status: 'pending', providerTaskId: null, errorMessage: null,
      startedAt: null, finishedAt: null, updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvAssetJobs.id, jobId));
  } finally {
    release(key);
  }
  return c.json({ success: true, data: { jobId } });
});

/** GET /asset-gen/batches?productId=xxx&limit=20 → 该剧本最近 N 个批次摘要。
 *
 * 供 AI 任务中心首次加载与刷新恢复使用：不逐条返回 job，只给每批的
 * 类型集合、状态计数、累计花费、整体状态，前端据此决定要不要继续轮询
 * 单批明细（GET /batch/:batchId）。
 *
 * ⚠️ 聚合仍在 **JS** 里做（同 /review-stats 的口径）：按 batchId 分桶后
 *    自己数 status、加 costAmount。不走 SQL GROUP BY —— 一是 `counts`
 *    要按 status 分桶成对象而非行集，二是 `assetType` 的去重集合在 SQL
 *    里写起来比 JS 啰嗦且不便维护。
 * ⚠️ 先按 createdAt DESC 取最多 500 行再在 JS 里取前 N 个 batch —— 「最近
 *    N 个 batch」没法直接用 SQL LIMIT（一个 batch 多行），500 行上限是
 *    防御性的：单批 ~100 行，500 行 ≈ 5 批，足够覆盖「最近 20 个」的请求
 *    上限；若产品真有 >5 批且都各 100 行，limit=20 也只取到前 5 批的摘要，
 *    但那是极端长尾，不影响首次加载体验。
 */
route.get('/batches', async (c) => {
  const productId = c.req.query('productId') ?? '';
  if (!productId) return c.json({ success: false, error: 'productId 必填' }, 400);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 50);

  const rows = await db.select().from(pmsBuiWenlvAssetJobs)
    .where(eq(pmsBuiWenlvAssetJobs.productId, productId))
    .orderBy(desc(pmsBuiWenlvAssetJobs.createdAt))
    .limit(500);

  const map = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = map.get(r.batchId) ?? [];
    arr.push(r);
    map.set(r.batchId, arr);
  }

  const batches = Array.from(map.entries()).slice(0, limit).map(([batchId, jobs]) => {
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0 } as Record<string, number>;
    let totalCost = 0;
    const typeSet = new Set<string>();
    for (const r of jobs) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      totalCost += Number(r.costAmount ?? 0);
      typeSet.add(r.assetType);
    }
    const types = Array.from(typeSet);
    const typeLabels = types.map((t) => ASSET_TYPES[t as JobAssetType]?.label ?? t);
    const hasPending = counts.pending > 0 || counts.running > 0;
    const allSucceeded = counts.succeeded === jobs.length && jobs.length > 0;
    const hasFailed = counts.failed > 0;
    const status = hasPending ? 'running' : allSucceeded ? 'done' : hasFailed ? 'failed' : 'running';
    return {
      batchId,
      createdAt: jobs[0].createdAt.toISOString(),
      types, typeLabels,
      total: jobs.length, counts,
      totalCost: Math.round(totalCost * 10000) / 10000,
      status,
    };
  });

  return c.json({ success: true, data: { batches } });
});

/** GET /batch/:batchId → 进度（GROUP BY 派生）+ 逐条明细 + 版本链。 */
route.get('/batch/:batchId', async (c) => {
  const batchId = c.req.param('batchId');
  const rows = await db.select().from(pmsBuiWenlvAssetJobs)
    .where(eq(pmsBuiWenlvAssetJobs.batchId, batchId))
    .orderBy(pmsBuiWenlvAssetJobs.createdAt);
  const counts = { pending: 0, running: 0, succeeded: 0, failed: 0 } as Record<string, number>;
  let totalCost = 0;
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    totalCost += Number(r.costAmount ?? 0);
  }
  // 本批「还能不能继续推进」的判定。前端据此停止轮询（见 pms-wenlv-web 的
  // asset-batch-state.ts）—— 没有这个信号时，被预算熔断的批次会永久 5s 空转。
  //
  // ⚠️ 只判这两条是**刻意**的，别顺手加第三条：
  //   · `anchorReadyFilter` 会让「产品还没有风格锚图」的 job 暂时领不走 ——
  //     那是**等待**不是停摆（锚图 job 跑完它们就会继续）。
  //   · `typeFilter` 同理。
  //   判进去会把正常等待误报成停摆，反而让用户以为批次死了。
  //
  // ⚠️ 预算那条**复用 `exceededBatchBudget`**，不要手写 `spent >= limit`：
  //    `>=` 的语义（以及「读不到金额时不误停」的守卫）在那一个函数里定义，
  //    抄成第二份必然漂移。该函数**永不为 0 上限**导致误判的坑也不存在：
  //    `batchBudgetLimit()` 在未配置时返回默认 20，非法值也回落默认值。
  //
  // ⚠️ 判据形状是「**还有 pending 行剩下** 且 这批再推进不下去」——两个条件缺一不可：
  //    少了 `pendingRows.length > 0`，一批**全部成功**的批次也会因为「已花 >= 上限」
  //    被判成停摆（它是跑完了，不是卡住了）。
  const limit = batchBudgetLimit();
  const spent = Math.round(totalCost * 10000) / 10000;
  const pendingRows = rows.filter(r => r.status === 'pending');
  const attemptExhausted = pendingRows.length > 0 && pendingRows.every(r => r.attempt >= MAX_ATTEMPT);
  const budgetStopped = pendingRows.length > 0 && exceededBatchBudget(spent, limit);
  return c.json({
    success: true,
    data: {
      batchId, total: rows.length, counts,
      totalCost: spent,
      stalled: attemptExhausted || budgetStopped,
      stalledReason: attemptExhausted ? 'attempt_exhausted' : budgetStopped ? 'budget' : null,
      budget: { limit, spent },
      jobs: rows.map(r => ({
        id: r.id, assetType: r.assetType, name: r.name, status: r.status,
        attempt: r.attempt, iteration: r.iteration, parentJobId: r.parentJobId,
        guidance: r.guidance, costAmount: Number(r.costAmount ?? 0),
        assetId: r.assetId, errorMessage: r.errorMessage, prompt: r.prompt,
      })),
    },
  });
});

/** GET /jobs/:jobId/versions → 沿 parent_job_id 回溯的版本链。 */
route.get('/jobs/:jobId/versions', async (c) => {
  const jobId = c.req.param('jobId');
  const chain: any[] = [];
  let cursor: string | null = jobId;
  const seen = new Set<string>();
  // 第一跳落空 = 这个 jobId 根本不存在 → 404，与本文件其它端点（/retry、/iterate、
  // /style-bible）保持一致。此前是 200 + `versions: []`，调用方无法区分「id 写错了」
  // 与「这条素材是第一版、没有历史」。
  // 后续跳落空（parent 指向一条已被删掉的行）仍然是 `break`：那是链的**正常终止**，
  // 不是「id 不存在」，不该 404。
  let first = true;
  // 层数上界：命中时必须**显式记下来**并回给调用方（Task 17 清单 B-10）。
  // 此前是 `while (... && chain.length < 20)` —— 25 层链静默返回 20 条，而
  // `versions[0].iteration === 6`：UI 把数组第一个当成「首版」展示，读起来就是
  // 「这个素材的首版是第 6 版」，属**误导**而非「短了一截」。
  // 判据精确到「因上界而停在还有下一个新父节点时」，不把环（seen 命中）算成截断。
  // 唯一会**多报**的边角：正好 20 层、且第 21 个父节点那行已被删 —— 那时 `truncated: true`
  // 但实际没有第 21 版；此时语义退化为「链被我提前停了」，仍不算错，故不额外查一次库。
  let truncated = false;
  while (cursor && !seen.has(cursor)) {
    if (chain.length >= 20) { truncated = true; break; }
    seen.add(cursor);
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, cursor)).limit(1);
    if (!row) {
      if (first) return c.json({ success: false, error: '任务不存在' }, 404);
      break;
    }
    first = false;
    chain.push({
      id: row.id, iteration: row.iteration, status: row.status,
      prompt: row.prompt, guidance: row.guidance,
      assetId: row.assetId, costAmount: Number(row.costAmount ?? 0),
      createdAt: row.createdAt,
    });
    cursor = row.parentJobId;
  }
  return c.json({ success: true, data: { versions: chain.reverse(), truncated } });
});

/** GET /style-bible/:productId → 读取（含是否已自举、锚图是否已就绪）。 */
route.get('/style-bible/:productId', async (c) => {
  const [p] = await db.select({
    id: pmsBuiWenlvProducts.id,
    styleBible: pmsBuiWenlvProducts.styleBible,
    styleAnchorUrl: pmsBuiWenlvProducts.styleAnchorUrl,
  }).from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, c.req.param('productId'))).limit(1);
  if (!p) return c.json({ success: false, error: '产品不存在' }, 404);
  const bible = p.styleBible as WenlvStyleBible | null;
  return c.json({
    success: true,
    data: {
      styleBible: bible,
      ready: !!bible?.artStyle,
      styleAnchorUrl: p.styleAnchorUrl,        // 创作台只读展示：让用户看见基准图长什么样
      anchorReady: !!p.styleAnchorUrl,
    },
  });
});

/** POST /style-bible/bootstrap → 为某产品自举风格基线并落库。 */
route.post('/style-bible/bootstrap', async (c) => {
  // ⚠️ 2026-09-14 修正：**必须**用本文件 Task 10 已经抽好的 `readJsonObject(c)`，
  //    不能写 `await c.req.json().catch(() => ({} as any))`。
  //    后者正是 Task 10 的 D2 缺陷原文：`JSON.parse('null')` 是**成功**的（返回 `null`），
  //    所以 `.catch()` **不会**触发，`body` 就是 `null`，下一行 `body.productId` 抛
  //    `TypeError: Cannot read properties of null` → 端点 **500**。
  //    （同仓 admin 路由走 `zodSchema.safeParse(...)` 时天生免疫 —— zod 把 null 判成
  //     `Expected object, received null` → 400；本文件是 `typeof` 手写校验，丢了这一层。）
  //    `readJsonObject` 就在**同一个文件**里，直接可用，不需要 import。
  const body = await readJsonObject(c);
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!productId) return c.json({ success: false, error: '缺少 productId' }, 400);
  const [product] = await db.select().from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  if (!product) return c.json({ success: false, error: '产品不存在' }, 404);
  const existing = product.styleBible as WenlvStyleBible | null;
  // **只有真布尔 `true` 才算「强制重跑」**。写成 `!body.force` 的话 `"false"` / `"0"` 都是真值
  // → 被当成强制 → 绕过复用守卫重跑一次**付费** LLM 并覆盖既有基线。今天无调用方所以零影响，
  // 但 BFF 若从 query / 表单里读到字符串 `"false"`，失败既静默又花钱。
  const force = body.force === true;
  // **尽力而为**的复用守卫：已有基线且非强制 → 直接回，省一次 LLM 调用。
  // ⚠️ 这是「查后写」，**DB 层没有并发控制**：两个并发请求会同时看到 artStyle 为空。
  //    **今天这一层已被下面的进程内守卫补上**（2026-09-14 拍板：单实例假设够用，见文件头
  //    IN_FLIGHT 注释），所以真实触发形态（同一浏览器双击）不会再各调一次付费 LLM。
  //    仍然**没有**解决的是多副本：那时两个进程各持一份内存锁，会双双通过，需要 DB 条件更新
  //    claim（会碰 drizzle 的错误包装，本仓已知的深坑）——本行守卫不是那件事的替代品。
  if (existing?.artStyle && !force) {
    // `batchId` 与**真跑**那条分支逐字同源（`bootstrapStyleBible` 用同一个固定前缀写的行）。
    // reused 分支也带它的理由：控制台拿这一个 id 就能查到这个产品**历史累计**花了多少
    //（GET /batch/:batchId 的 totalCost），哪怕这一次没花钱。两处各写一份拼接会各自漂移，
    // 所以这里只写这一个字面量前缀，含义由 scheduler 那行合成 job 定义。
    return c.json({ success: true, data: { styleBible: existing, reused: true, batchId: `stylebible:${productId}` } });
  }
  // 总闸（同 /batch：acquire 之前，见文件头纪律第 4 条）。
  //
  // ⚠️ 位阶**在 `reused` 捷径之后**是**有意**的：上面那条 200 是纯读 + 零花费，
  //    暂停它没有意义（它既不建行也不打 LLM）。只有走到这里、**即将打付费 LLM** 的分支才被挡。
  //    所以「暂停期间 bootstrap 一定 409」不成立 —— 传 `force` 才会；不传 force 且已有
  //    基线时仍是 200 reused。判据（测试）必须用 `force: true` 才咬得住这道闸。
  //
  // 不加这一道的后果最重：本端点**压根不走调度器**，暂停期间它会照常同步打一次付费 LLM
  //（本端点 catch 块里的注释自己写着「bootstrapStyleBible 会打 LLM 并落库」）——
  // 也就是说「总闸」若只盖住调度器与 /batch，最大的一笔按需花费反而完全没被挡住。
  if (isAssetGenPaused()) return c.json({ success: false, error: PAUSED_MSG }, 409);
  // 守卫在**复用分支之后**（上面那条 200 reused 不花钱，不走锁也不该被锁挡），
  // 且在全部前置校验之后：400（缺 productId）/404（产品不存在）都已提前返回。
  // 这条锁填补的正是上面注释里那处「查后写」TOCTOU 的**单实例**部分：
  // 双击时第二个请求在这里被拒成 409，而不是各自再调一次付费 LLM。
  const key = `bootstrap:${productId}`;
  if (!acquire(key)) return c.json({ success: false, error: IN_FLIGHT_MSG }, 409);
  try {
    const bible = await bootstrapStyleBible(productId, product.venueId ?? null);
    // 成功后冷却（进 try 内、catch 之前）：LLM/解析/落库失败都走 catch，不会到这里，
    // 故失败不冷却，用户可立刻重试。本端点窗口跨秒级、在飞集合本来就挡得住重叠，
    // 冷却补的是「第一次已返回、第二次刚发出」那一段。
    hold(key);
    // `batchId` = 上面那次自举落进 `pms_bui_wenlv_asset_jobs` 的**合成行**的批次 id
    //（`bootstrapStyleBible` 里拼的同一个字面量）。控制台凭它就能查到这次（与历史各次）
    // 自举花了多少钱 —— 本子项目的交付判据之一是「知道花了多少钱」。
    return c.json({ success: true, data: { styleBible: bible, reused: false, batchId: `stylebible:${productId}` } });
  } catch (e) {
    // 自举失败即失败，**不静默用空基线继续**（spec §8）。
    //
    // 为什么是 502 而不是 500/409：「失败即失败」任何非 2xx 都能表达，502 实际表达的是
    // 「**上游**给了坏响应」。bootstrapStyleBible 的失败面里，LLM HTTP 调用失败与
    // parseStyleBible 解析失败都属上游坏响应，502 贴切（lib/http-error.ts 允许集合含 502，
    // mini/pay 系列也有先例），故保持 502。
    // ⚠️ **既知不精确**：该行也会兜住 DB **写入**失败，那类语义上是 500 却被归成 502。
    //    要区分得让服务层抛可辨别的错误类型（不是靠 message 文本分辨 —— 见下）。
    //
    // ⚠️ 2026-09-14 修正：**不要**把捕获到的异常对象的 message 直接塞进响应体
    //    （计划原文的示例是「响应体的 error 字段取 `String(e?.message || e)`」，那个写法
    //    会把 drizzle 的 `Failed query: <完整SQL> params: <参数>` 原文透给客户端）。
    //    ⚠️ 连**注释里**都不能出现那个字面组合：no-raw-error-leak 是**逐行源码扫描、不剥注释**的，
    //    2026-09-14 实测：计划原文把示例代码原样抄进注释，该闸直接红（本段即为此改写）。
    //    这是 Task 10 初版踩过的同一个坑，且是**确定复现**的（不是"可能"）：
    //    src/__tests__/no-raw-error-leak.test.ts 是**逐行**源码扫描器，会命中「把异常对象的
    //    message/stack 塞进 JSON 响应体」的写法。**正则原文只在闸文件里，此处刻意不复述**：
    //    抄过来既会随它漂移、成为无护栏的假事实，也会让闸因为**注释**而红（本文件已中过一次）。
    //    它跳过 `__tests__/` 与豁免文件 lib/http-error.ts，其他一律进 offenders。
    //    而且泄露是真的：bootstrapStyleBible 会打 LLM 并落库，drizzle 的
    //    DrizzleQueryError.message 就是 `Failed query: <完整SQL> params: <参数>`。
    //    serverError 把完整错误（**对象**，含堆栈）记进服务端日志，客户端只拿通用文案。
    //    `serverError` 在本文件的 import 已由 Task 10 加好，这里**不需要新增 import**。
    return serverError(c, e, '风格基线自举失败，请稍后重试', 502);
  } finally {
    // 异常路径也必须释放：失败就把 key 永久锁死的话，用户重试永远拿到 409。
    release(key);
  }
});

/**
 * POST /api/admin/wenlv/assets/ar-batch
 *
 * 为指定节点批量生成 AR 显影视频素材（黑底），质检通过后回写 arAssetUrl。
 *
 * Body: { productId, nodeIds: string[], prompt?: string }
 *  - prompt 可选，覆盖默认 prompt 模板
 */
route.post('/ar-batch', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { productId, nodeIds, prompt } = body as {
    productId?: string; nodeIds?: string[]; prompt?: string;
  };
  if (!productId || !Array.isArray(nodeIds) || nodeIds.length === 0) {
    return c.json({ success: false, error: '缺少 productId 或 nodeIds' }, 400);
  }

  // 查询节点信息（0079：节点即 scenes，content 列对应旧 storyText）
  const allNodes = await Promise.all(nodeIds.map((id) =>
    db.select({ id: pmsBuiWenlvScenes.id, title: pmsBuiWenlvScenes.title, storyText: pmsBuiWenlvScenes.content })
      .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, id)).limit(1).then((r) => r[0]),
  ));

  const provider = getVideoProvider();
  const results: Array<{ nodeId: string; success: boolean; url?: string; reason?: string }> = [];

  for (const node of allNodes) {
    if (!node) continue;
    try {
      const nodePrompt = prompt || `为「${node.title}」生成一个神秘的灵体形象，用于 AR 显影。${node.storyText ? `场景：${node.storyText.slice(0, 100)}` : ''}`;
      const gen = await provider.generate(nodePrompt, { duration: 5, resolution: '720p', ratio: '16:9' });

      // 黑底质检
      const check = await checkBlackBackground(gen.url);
      if (!check.passed) {
        results.push({ nodeId: node.id, success: false, reason: `黑底质检未通过（${(check.blackRatio * 100).toFixed(1)}%）` });
        continue;
      }

      // 回写到节点 arAssetUrl（0079：写 scenes.arAssetUrl）
      await db.update(pmsBuiWenlvScenes)
        .set({ arAssetUrl: gen.url })
        .where(eq(pmsBuiWenlvScenes.id, node.id));

      results.push({ nodeId: node.id, success: true, url: gen.url });
    } catch (e: any) {
      results.push({ nodeId: node.id, success: false, reason: e?.message || '生成失败' });
    }
  }

  return c.json({ success: true, data: results });
});

export default route;
