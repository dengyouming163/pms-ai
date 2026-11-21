/**
 * 批次展开（S3）：把「为这个场地生成这些类型的素材」变成 N 条 job 行。
 *
 * planBatch 是**纯函数**（可单测，不碰 DB）；enqueueBatch 只负责把结果写库。
 * 分开是因为「展开逻辑」才是容易出错的复杂部分，它必须能在无库环境下被钉死。
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvAssetJobs } from '../../../db/schema/index.js';
import type { WenlvStyleBible } from '../../../db/schema/wenlv.js';
import type { WritebackEntity } from './writeback-type.js';
import {
  ASSET_TYPES, PUBLIC_POOL_TYPES,
  type GeneratableType, type JobAssetType,
} from './asset-types.js';

/**
 * `GeneratableType` / `JobAssetType` 的**定义处已迁到 `asset-types.ts`** ——
 * 本文件要用注册表，若继续在这里定义就会形成 enqueue ↔ asset-types 的循环依赖。
 * re-export 是为了不改既有 import 点：`routes/admin/wenlv-asset-gen.ts` 从这里引
 * `GeneratableType`，`wenlv-asset-gen-scheduler.ts` 从这里引 `JobAssetType`。
 *
 * ⚠️ **re-export 不建立局部绑定** —— `export type { X } from './y.js'` 不会把 `X`
 * 带进本模块作用域。下面 `mk` 的形参、`PlannedJob.assetType`、`iterationBlockReason`
 * 都还在用这两个类型，所以上面必须**同时** `import type`。漏了只写 re-export 会在
 * `pnpm ts-check` 报 TS2304，而 vitest 用 `as never` 把类型全绕过了 —— 测试永远抓不到。
 *
 * ⚠️ 关于 `JobAssetType` 里的 `style_bible`（原先挂在类型定义处的踩坑记录，随类型迁移保留）：
 * 它与 `anchor` 都**不是**用户勾选出来的任务，也不进生成流水线 ——
 * `bootstrapStyleBible` 用它在 `pms_bui_wenlv_asset_jobs` 里记一笔「这次自举花了多少钱」
 * （`cost_amount` 全库只存在于这张表）。行**直接以 succeeded 写入**，绝不停在 pending：
 * 调度器第 3 步的领取没有类型过滤，一条 pending 的 style_bible 行会被领走、
 * 丢给 `generateImageJob` —— 那是一次**真实付费**的、语义完全错误的文生图调用。
 */
export type { GeneratableType, JobAssetType };

// 展开键全部改由注册表的 `scope` 派生 —— 一处真源。
// 原先这里有三个常量（PUBLIC_POOL_TYPES / NODE_SCOPED_TYPES / PRODUCT_LEVEL_NAME），
// 彼此语义交叉，`collectible` 当年就是被它们归错类而按节点成倍出图。
// 现在 NODE_SCOPED_TYPES / PRODUCT_LEVEL_NAME **整体删除**（不再有任何消费方）；
// PUBLIC_POOL_TYPES 保留但定义处搬到 asset-types.ts（见下）。
//
// ⚠️ 那两段注释里记的坑**没有丢** —— 已搬进 `asset-types.ts` 的 `AssetScope` 与
// `AssetTypeDef` 注释（展开键互不重叠；别按「不是 product 就是 node」去推断新类型）。
//
// PUBLIC_POOL_TYPES 从 asset-types.ts 引进来后再 re-export 一次：消费方是
// `wenlv-asset-gen-scheduler.ts` 的 writeAsset（它按 assetType 判 design_assets.venue_id），
// 那个 import 点不动 —— 两处各写一份清单的话，改了一处另一处不会红。
export { PUBLIC_POOL_TYPES };

/** `pms_bui_wenlv_asset_jobs.name` 的列宽。节点标题列宽是 200，比它宽一倍，
 *  所以「标题 + 类型后缀」这个拼接**天然可能超宽**。
 *
 *  导出给**在同列宽上再拼前缀**的调用方（`wenlv-asset-gen-scheduler.ts` 的评审行
 *  `评审·<素材名>`）：手抄一个 100 会在列宽改动后静默过期，而那一处的失败形态是
 *  INSERT 撞 22001、被 fire-and-forget 的 `.catch` 吞成一条 warn（记账行静默消失）。
 *  同款先例见下面的 `MAX_TAG`。 */
export const MAX_NAME = 100;

/** `pms_bui_wenlv_asset_jobs.community_style_tag` 的列宽。导出给 `fitTag` 的调用方/测试。 */
export const MAX_TAG = 50;

/**
 * `pms_bui_wenlv_asset_jobs.edit_input_url` 的列宽（`varchar(500)`，见 `db/schema/wenlv.ts`）。
 *
 * 导出给**路由层**的形态闸用（`routes/admin/wenlv-asset-gen.ts` 的 `/iterate`）——
 * 在别处手抄一个 500，会在列宽改动后静默过期，而那一处的失败形态是：>500 码点的 URL
 * 落库撞 PG `22001`、被 catch 成 **500**，而它本该是一条 400。同款先例见
 * `MAX_NAME` / `MAX_TAG`（都是「列宽常量定义在服务层、调用方 import」）。
 *
 * ⚠️ 它**同时**是 `enqueueIteration` 服务层自守的宽度（见那个函数体最前面的守卫）：
 *    导出函数必须能挡住绕过路由的调用方。
 */
export const MAX_EDIT_INPUT_URL = 500;

/**
 * 按**码点**计的字符串长度。
 *
 * **口径必须与 `fitName` 和 Postgres 的 varchar 一致：都数码点。**
 * `str.length` 数的是 UTF-16 码元：一个 emoji（代理对）算 2，而 Postgres 的
 * `varchar(n)` 数的是**字符**（码点），同一个 emoji 算 1。两者混用会让
 * 「`length <= n`」这个判据不再等价于「放得进列宽」—— 一个 100 码点的纯 emoji
 * 名字 `.length` 是 200，会被误判超长而抛错，而它其实完全合法。
 * 别改回 `.length`。
 */
const codePointLen = (s: string): number => Array.from(s).length;

/**
 * 把风格标签归一到列宽内（**按码点**，与 `fitName` 同一条口径 —— 见上面的码点说明）。
 * null / undefined / 纯空白一律归为 null（空串是「对读侧隐形的脏值」，不是合法的 tag）。
 *
 * **为什么必须有这个函数**：同一个值此前有两条写路径、两套规则 ——
 *   · `enqueueBatch`（写 **job 行**）对超宽是**硬抛** → 整批 INSERT 回滚 → 端点 500；
 *   · `wenlv-asset-gen-scheduler.ts` 的 `writeAsset`（写 **design_assets 行**）是**静默截断**。
 * 结果：一条 51 字的场地名（**合法数据** —— `routes/admin/wenlv.ts` 的 zod 允许 max(100)，
 * 列也是 varchar(100)）会让「生成素材」稳定 500，而它对应的素材行本来会被正常截断。
 * 现在两条路径都调这里，规则只有一个来源；`/batch` 在入口就先归一。
 *
 * ⚠️ 「规则只有一个来源」**只对宽度成立，别读成全套口径都统一了**（Task 17 清单 D-15 纠偏）：
 *   · **宽度**：真统一 —— 本函数与 `fitName` 都按**码点**截到各自列宽。
 *   · **空白**：**不统一**。本函数把 `'   '` / `''` 归成 `null`；而 `enqueueBatch`
 *     对 job 名不做这一步（`codePointLen('   ')` = 3 ≤ 50 ⇒ 原样放行）。
 *   今天摸不到这个差异，**只因为** `/batch` 唯一调用方在入口已经先归一 ——
 *   是**调用点的**保证，不是 `enqueueBatch` 自己的保证。将来若出现新调用方
 *   （例如从别的路由直接调 `enqueueBatch`），纯空白名就会以脏值落库。
 *
 * 截断**按码点**（`Array.from`）而非 `.slice()`：后者按 UTF-16 码元切，从代理对中间切开
 * 会留下孤立代理项，落库时被编码成 U+FFFD（`�`）—— 无报错、无日志的脏值。
 */
export function fitTag(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, MAX_TAG).join('');
}

/**
 * 拼一条 job 的展示名并保证不超过列宽。
 *
 * 为什么必须在这里截：整批 job 是**一条多行 INSERT**（enqueueBatch），Postgres 里
 * 一条语句是原子的 —— 只要有一行超宽，`22001 value too long` 会让**整批**全部回滚，
 * 连锚图一起丢，而错误文本里不会出现是哪个节点。标题截断只损失展示；`nodeId` 才是
 * 写回点位的权威键，所以这是安全取舍。
 *
 * 截的是**标题**不是后缀：后缀（`·background`/`·旁白`）是「这条是什么」的唯一展示信号。
 *
 * **按码点截断，不是按 UTF-16 码元**（后者是本函数先前自己引入的缺陷，2026-09-13 修）：
 * `.slice()` 数的是码元，截断点落在代理对中间时会留下**孤立代理项**，落库时
 * `Buffer.from(name, 'utf8')` 把它编码成 `EF BF BD`（U+FFFD，`�`）。PG 不会因此报
 * 22001、不会回滚 —— 只是名字里多一个乱码字符，正是本项目反复栽的「静默脏值」。
 * 改用 `Array.from` 后，JS 的计数口径与 Postgres 的 varchar(n)（数码点）完全一致，
 * 孤立代理项与「判据口径不等价」两个问题一起消掉。
 */
function fitName(title: string, suffix: string): string {
  const tail = `·${suffix}`;
  return `${Array.from(title).slice(0, Math.max(0, MAX_NAME - codePointLen(tail))).join('')}${tail}`;
}

export type PlannedJob = {
  id: string;
  batchId: string;
  venueId: string | null;
  productId: string | null;
  assetType: JobAssetType;
  name: string;
  /**
   * 来源点位 id（锚图为 null）。旁白写回 `nodes.narration_url` 靠它 ——
   * **不要靠标题字符串匹配**：节点会被改名，标题也可能重名。
   */
  nodeId: string | null;
  /**
   * 来源**图鉴条目** id（仅 collectible 类型非空，其余一律 null）。回写 `collectibles.image` 的**键是 `targetId`，不是它** —— 它供画面描述取条目真名。
   * 与 nodeId 同样的道理：**不要靠标题字符串匹配** —— 条目会被改名，标题也可能重名。
   */
  collectibleId: string | null;
  /**
   * 通用回写键对（迁移 0033）：targetKind ∈ node/product/collectible/ending/reward/tier/npc/character。
   * 与 `writeback-type.ts` 的 `WritebackEntity` 一一对应。
   * ⚠️ 旧列 `nodeId` / `collectibleId` **今天仍被读，但不在本回写路径上**（本路径只读 `targetId`）：`nodeId` 是旁白回写的键（调度器 `if (job.nodeId) writeNarrationUrl(...)`）、`collectibleId` 供画面描述取真名；0033 把存量行的 `target_id` 就是从它们回填来的。
   *
   * **类型是 `WritebackEntity` 而不是 `string`**：把 `'ending'` 敲成 `'endnig'` 在 `string`
   * 下**编译期毫无信号** —— ts-check 全绿、库里落一个脏值；今天它**也不报错**，只是会在
   * 「用在」列**看得出来** —— 拼错落成 `—`，填成另一类的合法值则显示成那一类的名字、或退回裸 id。
   * 收窄后这类拼写错误在**编译期**就红，代价是零。别为了「将来可能加一类」
   * 把它放宽回 `string`：真加一类时该改的是 `writeback-type.ts` 的联合类型（一处真源），不是这里。
   *
   * ⚠️ **本字段今天已被读取** —— 素材库「用在」列的数据源：`GET /assets`（`pms-server/src/routes/admin/wenlv-design.ts`）批量补查 job 行 → BFF 白名单（`pms-platform/pms-platform-server/src/routes/wenlv-studio.ts`）→ 前端 `asset-usage.ts`（`pms-platform/pms-wenlv-web`）解析。
   *    **回写的判据是 `assetType`（→注册表拿目标表/列）+ `targetId`（→拿行），不是 kind**
   *    —— `buildWritebackPlan` 的函数体里根本不出现 kind（`writeback.ts`）。所以：
   *      · 填错 kind **不影响回写**，但会让「用在」列显示成**错误的要素**（另一类的名字）、或查不到而退回裸 id（拼错则整列显示 `—`）；危险的是**以为它决定目标表**，从而省掉 `targetId` 的正确性；
   *      · 别照这一段去「修」`buildWritebackPlan` 让它改读 kind —— 存量 `style_bible` 行
   *        的 kind 是 NULL，改读会让它们的目标解析不出来。
   *
   * ⚠️ **每一类都必须填**（含 node 与 product）。迁移 0033 **按类型白名单**回填存量行：
   * `anchor`/`cover` → `product_id`，`background`/`narration` → `node_id`，
   * `collectible` → `collectible_id`。**不是**「凡 node_id 非空就填 node」—— 旧代码里
   * cover / stamp / icon 也曾经是节点级展开，一刀切会把它们的 `target_id` 钉成**节点 id**，
   * 回写就变成 `UPDATE products … WHERE id = <节点 id>`：匹配不到任何行，**静默 no-op**。
   * 回写泛化后统一读 `targetId`（不读 kind，见上）。
   * 漏填 ⇒ **业务表永远不回写**：`buildWritebackPlan` 拿到 null 直接返回，
   * job 是 succeeded、素材库里也有图，**只有业务表是空的**，且无任何报错。
   *
   * ⚠️ 迁移**有意不填**存量 `stamp` / `icon` 行的 `target_id`（它们旧形态的展开键是错的，
   *    没有权威键可填）。**实测生产 `pms_bui_wenlv_asset_jobs` 里这两类各 0 行**
   *    （64 行分布：background 23 / collectible 22 / narration 17 / anchor 1 / cover 1），
   *    所以这条留空今天**不触达任何数据**；而新建的 stamp / icon 行由 `planBatch` 的
   *    collectible / tier 两个展开分支**直接写 `targetId`**，不经迁移回填。
   *    **若将来要接旧行**，注意 `enqueueIteration` 原样继承 `parent.targetId`
   *    ⇒ 旧行的迭代版同样不回写（用户在集章页看不到新章）。
   * （旁白**不走这条路** —— 它由 `writeNarrationUrl` 单点写 `nodes.narrationUrl`，
   *   不经 `buildWritebackPlan`/`applyWriteback`。别把它并列进上面这句来推演。）
   */
  targetKind: WritebackEntity | null;
  targetId: string | null;
  /** 该素材对应的故事文本（背景/旁白用）。**必须落库**，轮询器从行上读它 */
  sourceText: string | null;
  /** 素材本身是否进公共池 —— 决定 design_assets.venue_id 写不写 */
  assetIsPublic: boolean;
  communityStyleTag: string | null;
  styleBibleSnapshot: WenlvStyleBible;
  iteration: number;
  parentJobId: string | null;
  guidance: string | null;
  /**
   * 涂鸦重绘的输入图 / 迭代底图 URL（仅迭代行可能非空，入队期一律 null）。
   *
   * ⚠️ **它参与生成，不只是审计用**：调度器把它 push 进 `refs`
   *   （`wenlv-asset-gen-scheduler.ts` 的 `if (job.editInputUrl?.trim()) refs.push(...)`），
   *    经 `image-provider` 作为参考图**真的发给上游图像 API** —— 直接改变出图结果。
   *    别把它读成「仅审计/复现用，对生成没有影响」（那是过期说法）。
   * · 「不参与回写」**只成立于「回写目标」这个意义上**：它不是 `buildWritebackPlan`
   *   认的列，不会写进 `products/node/…` 的业务列。
   * · 空串在入库前已被归成 `null`（`enqueueIteration` 的 `.trim() || null`），
   *   故库里不存在 `''` 这种「对读侧隐形」的脏值。
   */
  editInputUrl: string | null;
  /** 请求的候选张数（入队期输入，默认 1）。实际张数由 design_assets 行数得出。 */
  candidateCount: number;
};

export function planBatch(input: {
  batchId: string;
  venueId: string | null;
  productId: string | null;
  bible: WenlvStyleBible;
  /**
   * 是否**跳过**「补一条锚图 job」这一步。`false` = 补。
   *
   * ⚠️ 名字曾叫 `hasAnchor`（"产品是否已有 style_anchor_url"），那是个**反向命名**：
   * 语义是「跳过」，不是「已有」。纯旁白批次该传 `true`（旁白与画风无关，不该顺带出一张图），
   * 但按旧文档读 `true` 就成了「产品已有锚图」—— 未来调用方照旧文档写
   * `!!product.styleAnchorUrl` 会让「纯旁白批次仍补锚图」的缺陷原地复活
   * （有基线无锚图时白花一笔出图钱；无基线时留一条永久 failed 行）。
   */
  skipAnchorInsert: boolean;
  nodes: { id: string; title: string; storyText?: string | null }[];
  /**
   * 图鉴条目。**默认空数组**，既有调用方不传也不破 —— 缺省只是「这一批不要图鉴素材」。
   * `description` 是出图提示词的源文本（落成 job.sourceText 快照）。
   */
  collectibles?: { id: string; name: string; description?: string | null }[];
  /**
   * 三个新展开键的数据源（**整个产品**的列表，由 `types` 设闸 —— 见下面 switch 的注释）。
   * 全部**可选、缺省空数组**，与 `collectibles?` 同一套约定：既有调用方不传也不破。
   */
  endings?: { id: string; title: string; text?: string | null }[];
  rewards?: { id: string; name: string; description?: string | null }[];
  tiers?:   { id: string; name: string; description?: string | null }[];
  /**
   * NPC 列表（T18，spec §5.4 S2）。与 endings/rewards/tiers 同一套约定：
   * **整个产品**的列表，由 `types` 设闸 —— 少了那道闸，勾任何类型都会为全部 NPC 各建一条 job。
   * `description` 在本表是 NPC 的 `portrait_prompt`（出图提示词的源文本，落成 job.sourceText 快照）。
   */
  npcs?:    { id: string; name: string; description?: string | null }[];
  /**
   * 角色列表（T11，spec §11）。与 endings/rewards/tiers/npcs 同一套约定：
   * **整个产品**的列表，由 `types` 设闸。
   * `ipPrompt` 是出图提示词的源文本（落成 job.sourceText 快照）。
   */
  characters?: { id: string; name: string; ipPrompt?: string | null }[];
  /**
   * 请求的候选张数（输入）。默认 1。
   *
   * **本参数已生效**（Task 10 接的线）：`planBatch` 末尾把它统一盖到每条 job 上、
   * `toJobRow` 投影进 `asset_jobs.candidate_count`、轮询器按它算出实际要几张
   *（`candidates.ts` 的 `resolveCandidateCount`），一次上游调用返回 N 张、
   * 落 N 行 `design_assets`、按实际张数计费。
   *
   * ⚠️ **HTTP 入口已接线**：`POST /batch` 收请求体里的 `candidates` 并盖到这个参数上
   *（缺省 1、上界 `candidates.ts` 的 `MAX_CANDIDATES`；「路由传的值真的落进
   * `asset_jobs.candidate_count`」有判据钉住）。所以经路由进来的批次能真的出 N 张了。
   *
   * ⛔ **但迭代行有意不继承 `candidateCount`**：`enqueueIteration` 不把它从父行带过来
   *（理由见那里的注释），迭代（涂鸦重绘 / 反馈重出）默认只出 1 张。
   *    这是**产品决策，不是遗漏** —— 别照邻居字段（`nodeId` / `targetId` 等）的模式
   *    把它「补上」。
   */
  candidateCount?: number;      // 默认 1
  types: GeneratableType[];
  communityStyleTag: string | null;
}): PlannedJob[] {
  const out: PlannedJob[] = [];

  // 归一：`types` 表达的是「这一批要哪几类素材」，是**集合**语义 —— 重复项无意义。
  // 去重放在这里（而不是指望调用方），是因为重复项会**成倍放大**成多条 job：
  // 节点级类型会随 `node × 重复次数` 展开，产品级类型会重复产出多条。
  // 生产入口 `/batch` 目前自己用 `new Set` 去了重，但那是**另一个文件里的保证** ——
  // 一旦它被改动，这里就会静默回到「N 条互相覆盖、N 次计费」的老形态。
  const types = [...new Set(input.types)];

  // 缺省空数组：让下面的 `for (const c of collectibles)` 在调用方不传时也安全。
  // 直接写 `for (const c of input.collectibles)` 会在缺省时 `for...of undefined` 抛错。
  const collectibles = input.collectibles ?? [];
  const characters = input.characters ?? [];
  const endings = input.endings ?? [];
  const rewards = input.rewards ?? [];
  const tiers   = input.tiers ?? [];
  const npcs    = input.npcs ?? [];

  const mk = (
    assetType: JobAssetType, name: string,
    sourceText: string | null, nodeId: string | null,
    collectibleId: string | null = null,
    targetKind: WritebackEntity | null = null,
    targetId: string | null = null,
  ): PlannedJob => ({
    id: randomUUID(),
    batchId: input.batchId,
    venueId: input.venueId,
    productId: input.productId,
    assetType,
    name,
    nodeId,
    collectibleId,
    targetKind,
    targetId,
    sourceText,
    assetIsPublic: PUBLIC_POOL_TYPES.has(assetType),
    communityStyleTag: input.communityStyleTag,
    // **快照**不是引用：这里必须深拷贝调用方的活对象。整批共用同一个引用的话，
    // 调用方事后改 `bible.artStyle`，所有历史 job 的「这一版为何长这样」会跟着变，
    // 快照就白存了（schema 注释见 wenlv.ts 的 style_bible_snapshot）。
    styleBibleSnapshot: structuredClone(input.bible),
    iteration: 1,
    parentJobId: null,
    guidance: null,
    // 入队期的行一律没有涂鸦输入图（只有迭代行可能非空，见 enqueueIteration）。
    editInputUrl: null,
    // 默认 1，真正的批次级值由 planBatch 末尾统一盖章（别在这六个分支里各写一遍）。
    candidateCount: 1,
  });

  // 锚图排在最前 —— 它是后续全部的参考图。没有它，图类 job 会被调度器判 failed（spec §8）。
  //
  // **但这个数组顺序在落库后即丢失**：整批是一条 INSERT，`created_at` 走 `DEFAULT now()`，
  // 同一条语句里所有行时间戳完全相同，`id` 又是随机 UUID —— 没有任何列能还原数组顺序。
  // 真正保证「先生成锚图」的是调用方的**两趟领取**（先 `claimNextJobs(..., { assetTypes: ['anchor'] })`
  // 再领其余），不是这里的顺序。别指望靠这个数组去承重。
  // 锚图是 `product` 级（`ASSET_TYPES.anchor.scope`）：回写 `products.style_anchor_url`
  // 靠的是 `targetId = productId`，所以这里必须把通用键对一起填上。
  if (!input.skipAnchorInsert) {
    out.push(mk('anchor', '风格定调图', null, null, null, 'product', input.productId));
  }

  // 按**注册表声明的展开键**逐类展开。
  //
  // ⚠️ 必须由 `types` 设闸：`collectibles`/`endings`/… 是调用方一次查出来的**整个产品**的
  //    列表，而 `types` 才是「这一批要哪几类」。少了这道闸，任何一次批次 —— 哪怕用户
  //    只勾了「插画」—— 都会为全部条目建 job：龙门镇 22 条 ⇒ 勾「插画」白出 22 张图鉴图、
  //    白计 22 次费，**且不报任何错**。这与注册表取代掉的「节点循环漏跳过」是同一个形状：
  //    展开键与筛选键不是同一个东西，就不能指望其中一个替你筛另一个。
  //
  // 产品级（`scope: 'product'`，今天只有 cover）：每批只产一条，nodeId/sourceText 均为
  // null —— 回写靠 `targetId = productId`，也无需来源文本。曾按节点展开
  //（`node × type` 笛卡尔积）：N 节点剧本勾一次封面出 N 张图、计 N 次费，而回写只有
  // 一个 `products.cover_image` 列 ⇒ N 张互相覆盖，终值取决于哪条 job 最后完成 ——
  // 不确定、不可复现，且游客端 play.vue 的主题 Banner 就在读这一列。
  //
  // 名字为什么必须是注册表里的中文 `label`（而不是把 `node.title` 拼上类型后缀）：
  // 产品级 job 没有也不该有 `node.title`；它的名字会经 scheduler 的 `String(job.name)`
  // 回落逐字进喂给 LLM 的 `素材：` 那一行，带 `·cover` 后缀就是素材类型污染。
  for (const type of types) {
    const def = ASSET_TYPES[type];
    if (!def) continue;                       // 白名单外的值由路由层拦，这里静默跳过
    switch (def.scope) {
      case 'product':
        out.push(mk(type, def.label, null, null, null, 'product', input.productId));
        break;
      case 'node':
        for (const node of input.nodes) {
          // 旁白没有词就不产 job —— 合成空音频只会得到一个坏 URL
          if (type === 'narration' && !(node.storyText ?? '').trim()) continue;
          // 后缀用中文（旁白/灵体），避免 `·ar` 污染展示名与可能的提示词上下文。
          const suffix = type === 'narration' ? '旁白' : type === 'ar' ? '灵体' : type;
          out.push(mk(type, fitName(node.title, suffix),
            node.storyText ?? null, node.id, null, 'node', node.id));
        }
        break;
      // 条目 / 结局 / 奖励 / 档位级：按**自身实体**展开，一条 job 对应一个。
      // 不与节点做笛卡尔积（节点数与它们无关），nodeId 恒为 null；`fitName` 复用同一套
      // 码点截断防撑爆 name 列，`sourceText` 是该实体的描述文本快照（轮询器从行上读）。
      case 'collectible':
        for (const c of collectibles) {
          out.push(mk(type, fitName(c.name, type), c.description ?? null, null, c.id, 'collectible', c.id));
        }
        break;
      case 'ending':
        for (const e of endings) {
          out.push(mk(type, fitName(e.title, type), e.text ?? null, null, null, 'ending', e.id));
        }
        break;
      case 'reward':
        for (const r of rewards) {
          out.push(mk(type, fitName(r.name, type), r.description ?? null, null, null, 'reward', r.id));
        }
        break;
      case 'tier':
        for (const t of tiers) {
          out.push(mk(type, fitName(t.name, type), t.description ?? null, null, null, 'tier', t.id));
        }
        break;
      // NPC 级（T18）：与 collectible/ending/reward/tier 同族——按**自身实体**展开，
      // 一条 job 对应一个 NPC。`target_id` = NPC id（回写 `npcs.portrait_url` 的权威键）。
      // `sourceText` 取 NPC 的 `portrait_prompt`（出图提示词源文本快照）。
      case 'npc':
        for (const n of npcs) {
          out.push(mk(type, fitName(n.name, type), n.description ?? null, null, null, 'npc', n.id));
        }
        break;
      // 角色级（T11，spec §11）：与 collectible/ending/reward/tier/npc 同族——按**自身实体**展开，
      // 一条 job 对应一个角色。`target_id` = 角色 id（回写 `characters.avatar_url` 的权威键）。
      // `sourceText` 取角色的 `ip_prompt`（出图提示词源文本快照）。
      case 'character':
        for (const ch of characters) {
          out.push(mk(type, fitName(ch.name, type), ch.ipPrompt ?? null, null, null, 'character', ch.id));
        }
        break;
      default: {
        // ⚠️ 这个 `default` **不是**防御性冗余：没有它，将来给 `AssetScope` 加一个成员
        //    （子项目③ 很可能加，例如「章节」「场景」）而这里漏了 case 时，
        //    **ts-check 不会报**，`switch` 直接落到末尾 —— 那一类素材**一条 job 也不产**，
        //    且**没有日志、没有报错**，用户只看到「勾了却没反应」。
        //    `never` 断言把这件事提到**编译期**。（回写器 Task 5 用的是同一手法。）
        const _exhaustive: never = def.scope;
        throw new Error(`planBatch 未支持的展开键：${String(_exhaustive)}`);
      }
    }
  }
  // 批次级输入统一盖章，而不是在六个 case 里各写一遍（六个分支漏一个就是
  // 「某些类型永远只有 1 张候选」，且不报错）。`?? 1` 只挡 null/undefined，
  // 不挡 0 —— 显式的 0 会被 `resolveCandidateCount` 拦下（那是故意的，见 candidates.ts）。
  return out.map((j) => ({ ...j, candidateCount: input.candidateCount ?? 1 }));
}

/**
 * 把展开结果写库。返回实际插入条数。
 *
 * `nodeId`/`sourceText`/`communityStyleTag` **必须在这里落库**。轮询器是重新
 * 从库里把行读出来（`claimNextJobs` 领回后返回的 drizzle 行）再生成的，行上没有的字段
 * 它就拿不到 —— 而它没有别的途径回头去查节点。漏写这三列的后果：
 *   · 旁白任务 100% 失败（`buildTtsText` 拿到空串会抛错）
 *   · 图类任务的画面描述静默丢掉故事部分，且事后无从发现
 *   · 生成出的素材 style_tag 恒为 null
 * 这三列是「快照」（与 styleBibleSnapshot 同理）：源文本事后会被编辑，
 * 而这一版素材必须永远能解释自己是用什么文本生成的。
 */
type JobRow = typeof pmsBuiWenlvAssetJobs.$inferInsert;

/**
 * PlannedJob → 插入行。
 *
 * **抽成独立函数是为了能被测试钉住**：这段映射是「轮询器拿不拿得到
 * nodeId/sourceText/communityStyleTag」的**唯一环节**，此前它埋在 enqueueBatch 的
 * `.values()` 里 —— 2026-09-13 实测：删掉那三列，当时整个 planBatch 用例组仍然全绿。
 * （这里**刻意不写死条数**：条数会随用例增删失真，而失真的注释比没有注释更坏。）
 * 有了名字，测试就能直接断言它的输出。
 *
 * 各字段的理由见 `PlannedJob` 上各字段的 JSDoc（有 JSDoc 的字段），以及 `JobRow` 上方那段（`nodeId`/`sourceText`/`communityStyleTag` 为什么必须落库）。
 *
 * ⛔ **本函数是 `PlannedJob → job 行` 的唯一映射表** —— `PlannedJob` 上加了字段而这里没带，
 * 落到库就是 null，**不报错、ts-check 也不报**（对象字面量少一个可选属性不是错误），
 * 而下游读到空值后**静默失效**：`targetId` 为空 ⇒ `buildWritebackPlan` 返回 null ⇒
 * job 是 succeeded、素材库里有图，**只有业务表永远是空的**。
 * 新增字段必须在这里显式投影（Task 10 的 referenceUrls / editInputUrl / candidateCount 同理）。
 */
export function toJobRow(j: PlannedJob): JobRow {
  return {
    id: j.id, batchId: j.batchId,
    venueId: j.venueId, productId: j.productId,
    assetType: j.assetType, name: j.name,
    nodeId: j.nodeId, collectibleId: j.collectibleId,
    // ── 本轮新增（缺一行 = 该字段在库里恒 null，且无任何报错）──
    targetKind: j.targetKind ?? null,
    targetId: j.targetId ?? null,
    // ── 本 Task 加（同样：漏一行 = 库里恒 null，且 **ts-check 不报错**）──
    // ⛔ `referenceUrls` **绝不能加**：它不是入队期字段，是 `generateImageJob` 运行期
    //    按产品行 + 涂鸦图定下来后用 `db.update(...).set({ referenceUrls: refs })` 直接
    //    写在 job 行上的。加在这里会让后人以为「入队期就该有值」，进而删掉运行期那次
    //    update ⇒ 参考图快照静默失效。
    editInputUrl: j.editInputUrl ?? null,
    candidateCount: j.candidateCount ?? 1,
    sourceText: j.sourceText, communityStyleTag: j.communityStyleTag,
    prompt: null,                       // 由轮询器领取时现算（见 scheduler）
    styleBibleSnapshot: j.styleBibleSnapshot,
    iteration: j.iteration, parentJobId: j.parentJobId, guidance: j.guidance,
    status: 'pending' as const, attempt: 0, costAmount: '0',
  };
}

export async function enqueueBatch(jobs: PlannedJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  for (const j of jobs) {
    // ⚠️ 这道抛现在的定位是**最后一道不变量断言**，不再是「唯一的拦截点」：
    //    唯一的生产入口 `POST /batch` 已在建 job 前把 tag 归一（`fitTag`，见该函数），
    //    所以从这里进来的行**不该**再超宽 —— 真超了就是有别的调用方绕过了归一，
    //    此时硬抛（整批回滚、报错指向具体行）比静默写坏公共池分组键更正确。
    //    别因为「反正上游归一了」就把这段删掉：它保护的是未来的调用方。
    //
    // 计数口径必须与 fitName 和 Postgres 的 varchar 一致：**都数码点**（见 codePointLen）。
    // 用 `.length`（码元）会把「100 码点的纯 emoji」按 200 误判超长而错杀。
    if (j.communityStyleTag !== null && codePointLen(j.communityStyleTag) > MAX_TAG) {
      throw new Error(`风格标签超长（${codePointLen(j.communityStyleTag)} > ${MAX_TAG}）：${j.communityStyleTag}`);
    }
    if (codePointLen(j.name) > MAX_NAME) {
      throw new Error(`素材名超长（${codePointLen(j.name)} > ${MAX_NAME}）：${j.name}`);
    }
  }
  await db.insert(pmsBuiWenlvAssetJobs).values(jobs.map(toJobRow));
  return jobs.length;
}

/**
 * 本轮反馈**无处可施**的素材类型 → 拒绝原因；可迭代的类型返回 null。
 *
 * 为什么需要这道判断：`/iterate` 的全部价值来自「把用户反馈并进新一版的提示词」，
 * 而 `job.guidance` 只有**非锚图的图类**分支在读（见 wenlv-asset-gen-scheduler.ts 的
 * `generateImageJob`）。另三类传了 feedback 也是原样重跑：
 *   · `narration`：只读 `sourceText`，文案没变 ⇒ 合成出**一模一样**的音频。
 *   · `anchor`：由风格基线直接生成（`bootstrapStyleBible`），且重出会覆盖
 *     `products.style_anchor_url` —— 连带把**整个剧本**的参考图换掉，
 *     而它恰恰是「不能偏离总体剧本风格」那条硬约束的锚。
 *   · `style_bible`：**没有画面可施反馈** —— 它记的是自举那一次 LLM 调用，
 *     重跑只会原样再调一次付费 LLM。要重跑请走 `/style-bible/bootstrap` 带 `force`。
 * 三者的共同代价都是**白花一次钱**（TTS 合成费 / 文生图费 / LLM token 费）
 * 而用户看不到任何变化 —— 直接违反 S3 交付判据「知道花了多少钱」。
 *
 * 文案与服务层同源导出（不是各写一份）：`/iterate` 路由与这里必须**逐字一致**，
 * 否则「端点拒了但服务层没拒」的缝会在别的调用方那里裂开，而两边文案不同还看不出。
 */
export function iterationBlockReason(assetType: string | null | undefined): string | null {
  if (assetType === 'narration') {
    return '旁白不支持迭代：文案没变，重出只会得到一段一模一样的音频（白花一次语音合成费）。改文案请重新生成。';
  }
  if (assetType === 'anchor') {
    return '风格锚图不支持迭代：它由剧本的风格基线直接生成，本轮反馈不会生效，重出还会覆盖整个剧本的参考图。';
  }
  if (assetType === 'style_bible') {
    return '风格基线自举不支持迭代：它没有可施反馈的画面，重跑只会原样再调一次付费 LLM。要重跑请用 /style-bible/bootstrap 带 force。';
  }
  if (assetType === 'review') {
    return '评审不是素材，不支持迭代：要重新评审请重新入队一条评价任务。';
  }
  if (assetType === 'ar') {
    return 'AR 灵体视频不支持迭代：视频生成成本高，且黑底质检规则固定，用户反馈不会改变黑底比例，重出只会白花钱。';
  }
  return null;
}

/** 迭代：为一条已成功的 job 建一条新版本行。 */
export async function enqueueIteration(input: {
  parentJobId: string;
  guidance: string;
  batchId: string;
  /** 涂鸦重绘的输入图（仅迭代行可能非空）。空串归一成 null。 */
  editInputUrl?: string | null;
}): Promise<{ id: string }> {
  // ── 长度自守（放在**父行 SELECT 之前**）──
  // 与下面三条同源：`/iterate` 会在更早处给出用户可见的 400，但本函数是**导出的**，
  // 别的调用方绕过去照样得被挡住。`edit_input_url` 是 `varchar(500)`，而本函数此前
  // 对入参只做 `.trim() || null`、**没有任何长度钳制** ⇒ >500 码点会在 INSERT 撞
  // PG `22001` —— 那是**响亮报错**，不是静默写坏（只是报得晚、且发生在 INSERT 时）——
  // 被调用方的 catch 成 500（本该是 400）。
  //
  // ⛔ **只守长度，不在服务层再抄一遍 `^https?://` 正则**：格式判定的规格已经存在于
  //    路由层（`/iterate`），在这里复刻会变成**第二份**、日后必然漂移（本仓
  //    「文案与条件对不上」的教训）。长度是**列宽**约束 —— 它与格式无关，且 `22001`
  //    是服务层自己就该防住的失败面，不是调用方的用法错误。
  const editInputUrl = (input.editInputUrl ?? '').trim() || null;
  if (editInputUrl && codePointLen(editInputUrl) > MAX_EDIT_INPUT_URL) {
    throw new Error(`涂鸦重绘的输入图 URL 超过 ${MAX_EDIT_INPUT_URL} 个字符`);
  }

  const [parent] = await db.select().from(pmsBuiWenlvAssetJobs)
    .where(eq(pmsBuiWenlvAssetJobs.id, input.parentJobId)).limit(1);
  if (!parent) throw new Error('要迭代的任务不存在');
  if (parent.status !== 'succeeded') throw new Error('只能迭代已成功的素材');
  // 服务层自守（同上面两条）：`/iterate` 会在更早处给出用户可见的 400，
  // 但 `enqueueIteration` 是导出的，别的调用方绕过去照样得被挡住。
  const blocked = iterationBlockReason(parent.assetType);
  if (blocked) throw new Error(blocked);
  const id = randomUUID();
  await db.insert(pmsBuiWenlvAssetJobs).values({
    id,
    batchId: input.batchId,
    venueId: parent.venueId,
    productId: parent.productId,
    assetType: parent.assetType,
    name: parent.name,
    // 来源快照必须**原样继承** —— 迭代行同样由轮询器领回后读取生成，
    // 漏了这几行，迭代一条点位插画（`background`）时不会报错，只会静默失效：画面描述里的「素材」名退化成 `…·background`（字段理由见 `JobRow` 的文档注释）。
    nodeId: parent.nodeId,
    // 与上面几行同源：`collectibleId` 供画面描述取条目真名（调度器 `else if (job.collectibleId)`
    // 那一支），漏了它名字会退化成 `…·collectible`。**图鉴回写不看它** —— 已改走 `targetId`
    //（见下面 `targetKind` / `targetId` 的注释），所以这里漏掉丢的是「名字」，不是「回写」。
    collectibleId: parent.collectibleId,
    // ⚠️ 与上面 nodeId / collectibleId 同源、同样的坑：回写改成走 targetId 之后，
    //    这两行漏了 = 迭代版永远写不回业务表（图已生成、钱已花、界面显示成功）。
    targetKind: parent.targetKind,
    targetId: parent.targetId,
    sourceText: parent.sourceText,
    communityStyleTag: parent.communityStyleTag,
    // ⚠️ **有意不继承 `candidateCount`**：迭代（涂鸦重绘 / 反馈重出）默认出 **1 张**，
    //    不跟原 job 走 —— 上面那几行都写了「漏了 = 静默失效」，唯独这一项是**反例**，
    //    别照邻居的模式把它补上。若日后产品要「迭代也出 N 张」，这里必须像 `targetKind`
    //    一样显式继承 `parent.candidateCount`（否则迭代一个 4 候选的 job 只会得到 1 张，
    //    且不报错）。这是**产品决策**，不是遗漏。
    prompt: null,
    styleBibleSnapshot: parent.styleBibleSnapshot as WenlvStyleBible,
    iteration: parent.iteration + 1,
    parentJobId: parent.id,
    guidance: input.guidance,
    // 涂鸦重绘的输入图。空串归一成 null —— 前端可能传 ''，
    // 而 ''.trim() 用在下面 `if (job.editInputUrl?.trim())` 上是假值，
    // 存进库只是脏值、不报错（见 zod-empty-string-dirty-reference 的先例）。
    // 归一与长度自守都在**函数体最前面**那一段做（同一个局部变量），这里只消费它 ——
    // 别在这里再写一遍 `.trim() || null`（两处各写一份会漂）。
    editInputUrl,
    status: 'pending', attempt: 0, costAmount: '0',
  });
  return { id };
}
