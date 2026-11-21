/**
 * 素材生成轮询器（S3）。
 *
 * 骨架照抄 services/asset-task-scheduler.ts：startXxxScheduler() 在 server.ts 调用一次，
 * 60s tick，`let running = false` 重入守卫，逐项 try/catch（一条失败不影响本轮其余）。
 *
 * **两处刻意偏离**：
 *   1. 领取用原子更新（claim.ts），不是 SELECT-then-UPDATE。原因见 claim.ts 头注释。
 *   2. provider 是**同步** `generate()`，所以没有「推进在途」那一支（见 spec §5.2）。
 *
 * 每 tick 两件事，**顺序不能反**：
 *   1. 超时收口（把卡住的 running 判 failed）
 *   2. 领取待办 → 生成 → 转存 OSS → 落库 → 记账
 *
 * 为什么天然可恢复：所有状态都在行上，进程重启不丢任何东西；单条失败只影响该条。
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvCharacters, pmsBuiWenlvCollectibles, pmsBuiWenlvDesignAssets,
  pmsBuiWenlvNpcs, pmsBuiWenlvProducts,
  pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers, pmsBuiWenlvVenuePoints, pmsBuiWenlvScenes,
} from '../db/schema/index.js';
import { loadRuntimeGraph } from './wenlv/script-room.js';
import { claimNextJobs, reclaimStale, renewLease, STALE_MINUTES } from './wenlv/asset-gen/claim.js';
import { PUBLIC_POOL_TYPES, fitTag, MAX_NAME, type JobAssetType } from './wenlv/asset-gen/enqueue.js';
import { applyWriteback, buildWritebackPlan, writeNarrationUrl } from './wenlv/asset-gen/writeback.js';
import { getImageProvider, ImageGenError, type GenResult } from './wenlv/asset-gen/image-provider.js';
import { resolveCandidateCount, MAX_STYLE_REFS } from './wenlv/asset-gen/candidates.js';
import { writeCandidate, selectCandidate, targetFieldsOf, designAssetIdFor } from './wenlv/asset-gen/candidate-store.js';
import { sniffImageType } from './wenlv/asset-gen/image-type.js';
import { mapNpcVoiceToDashScope, synthesizeNarration } from './wenlv/asset-gen/tts-provider.js';
import { getVideoProvider } from './wenlv/asset-gen/video-provider.js';
import { checkBlackBackground } from './wenlv/asset-gen/ar-quality-check.js';
import {
  buildAnchorPrompt, buildImagePrompt, buildScenePrompt, buildTtsText,
} from './wenlv/asset-gen/prompt-builder.js';
import { buildStyleBiblePrompt, parseStyleBible, STYLE_BIBLE_SYSTEM } from './wenlv/asset-gen/style-bible.js';
import { calcImageCost, calcPromptCost, calcTtsCost, calcVideoCost } from './wenlv/asset-gen/pricing.js';
import { buildVisionMessages, reviewModel } from './wenlv/asset-gen/llm-vision.js';
import {
  SYSTEM_REVIEW, buildReviewPrompt, parseReview, shouldReview, type ReviewExamples,
} from './wenlv/asset-gen/reviewer.js';
import { loadReviewExamples } from './wenlv/asset-gen/review-examples.js';
import { callDashScope, type LlmResult } from './wenlv/asset-gen/dashscope.js';
import { uploadToOSS } from './aliyun/oss.js';
import { diagnosableErrorText } from '../lib/http-error.js';
import type { WenlvProductConfig, WenlvStyleBible } from '../db/schema/wenlv.js';

/**
 * 领取行在流水线里的类型。
 *
 * `claimNextJobs` 的返回类型是 `any`（`db.execute` 不做列名映射，见 claim.ts 头注释）——
 * 那个 `any` 只允许停在**领取边界**：这里强转一次之后，下面 5 个函数收到的都是真类型。
 * 全链路 `any` 的代价是静默的：写错一个字段名（如 `job.styleBibbleSnapshot`）ts-check 照过、
 * 运行时 undefined，`resolveBible` 会**静默回落**到产品当前基线 —— 一次无声的换锚点。
 */
type WenlvJobRow = typeof pmsBuiWenlvAssetJobs.$inferSelect;

const CHECK_INTERVAL_MS = 60_000;
const CLAIM_LIMIT = 3;   // 一批同步调上游，3 条足够且不撑爆单 tick

/**
 * 锚图领取的**墙钟预算**（5 分钟）。见 runAssetGenOnce 第 2 步。
 *
 * 为什么是墙钟而不是轮数：轮数 × CLAIM_LIMIT 换算不出时间。按 spec §5.2 自估 10–20s/条、
 * CLAIM_LIMIT=3，20 轮 = 60 条锚图，单 tick 可达 10–20 分钟 —— 这期间第 3 步与下一 tick 的
 * `reclaimStale` 都不跑，且下一次 tick 因重入守卫被整个跳过，所有**其它**素材的推进
 * 都被这一批锚图堵在门外。5 分钟 ≈ 15–30 条，是「推进一批锚图」与「不让单 tick 卡死」的折中。
 */
const ANCHOR_BUDGET_MS = 5 * 60_000;

/**
 * 锚图领取的**轮数兜底上界**。墙钟依赖 `Date.now()`，正常路径靠「领到空就 break」终止，
 * 但万一时钟异常或某轮耗时约 0 仍持续返回行，用轮数保证循环一定终止。
 * 见 runAssetGenOnce 第 2 步 —— 到界一律 `return`（不是 break），理由写在那个循环里。
 */
const MAX_ANCHOR_ROUNDS = 20;

/** LLM 只负责「内容 → 画面描述」。风格基线不经过它 —— 见 generateImageJob。 */
const SCENE_SYSTEM =
  '你是影视美术。把用户给的内容翻译成一段具体的画面描述（场景、构图、主体、光线、氛围）。'
  + '不要描述画风、色调、笔触或时代美术特征 —— 这些由统一规范另行指定，你不要提。'
  + '不要解释，直接输出画面描述。';

/**
 * LLM 的两个入口：文本（`callLlm`）与看图（`callLlmVision`）。
 *
 * 传输骨架、错误阶梯、`readUsage` 与 `LlmResult`（含 token 计费口径）
 * 都在 `./wenlv/asset-gen/dashscope.js` 的 `callDashScope` 里 —— 这里各自只负责
 * **填那 5 个值**：model / messages / temperature / timeout / 失败文案。
 */

/**
 * 文本调用。这 5 个值（含缺 key 文案与错误前缀）**必须保持原值**：
 * 生成路径与自举路径的历史行为、以及 run-once 的既有断言都建立在其上。
 */
async function callLlm(system: string, user: string): Promise<LlmResult> {
  return callDashScope({
    model: process.env.WENLV_PROMPT_MODEL || 'qwen-max',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.3,
    timeoutMs: 60000,
    failLabel: 'LLM 调用失败',
    missingKeyHint: '未配置 DASHSCOPE_API_KEY，无法生成提示词',
  });
}

/**
 * 视觉调用。与 `callLlm` 同构，只有 `messages` 的 content 形状与上面那 5 个值不同。
 * 错误文本里带 `body=` 前缀与 `callLlm` 一致 —— 排障时同一套手法可用。
 *
 * 导出供测试直接驱动（与本文件的 `bootstrapStyleBible` / `isAssetGenPaused` 同一理由）：
 * 它要到 Task 13/14 才被生产路径调用，在那之前**没有别的办法**从外部断言它
 * 发出去的 request body（尤其 `model` 那一项 —— 写回纯文本模型不会报错）。
 */
export async function callLlmVision(system: string, userText: string, imageUrls: string[]): Promise<LlmResult> {
  // ⛔ 必须挡在发请求**之前**：`buildVisionMessages` 会把空 / 空白 URL **静默丢掉**，
  //    于是 `['', '  ']` 会滑成一条**只带文本**的请求、拿回一个「评审分」，
  //    而调用方完全看不出图全被丢了 —— 正是本模块立志防的「基于瞎猜的自信输出」。
  //    错误里带上张数与原始入参：排障要能一眼分清「传了空串」还是「压根没传」。
  const usable = imageUrls.filter(u => u.trim() !== '');
  if (usable.length === 0) {
    throw new Error(
      `视觉调用失败：没有可用的图片 URL（收到 ${imageUrls.length} 个：${JSON.stringify(imageUrls)}）`,
    );
  }
  return callDashScope({
    model: reviewModel(),
    messages: buildVisionMessages(system, userText, imageUrls),
    temperature: 0.2,   // 比生成更低：评审要的是可复现，不是多样性
    timeoutMs: 90000,   // 比文本调用宽：图片 token 更多
    failLabel: '视觉调用失败',
    missingKeyHint: '未配置 DASHSCOPE_API_KEY，无法进行素材评审',
  });
}

/**
 * 从产品数据自举风格基线并落库（只在 products.style_bible 为空时调用）。
 *
 * 导出供测试直接驱动 —— 它不在 runAssetGenOnce 的路径上（基线为空时 resolveBible 抛错，
 * 不会走到这里），所以**没有别的办法**从外部断言它喂给 LLM 的 user 消息。
 *
 * ⚠️ **当前生产侧没有任何调用方**：唯一的调用方是 Task 10 的 admin 端点，
 *    在那条线**接线之前，本函数在任何运行路径上都不可达**。也就是说「基线为空 → 自动自举」
 *    这套机制眼下并不存在：`resolveBible` 会先抛「该任务没有风格基线」，
 *    于是**任何产品的首批素材都以永久失败告终**（failed 不会被自动重领）。
 *    `style_bible` 只能靠别的路径（如控制台）预先写好。
 */
export async function bootstrapStyleBible(productId: string, venueId: string | null): Promise<WenlvStyleBible> {
  const [product] = await db.select().from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  if (!product) throw new Error('产品不存在，无法自举风格基线');
  // 0079 统一模型：节点从规范图取（scenes 投影），含 title/venuePointId。
  const runtime = await loadRuntimeGraph(productId);
  const nodes = runtime.nodes.map((n) => ({ title: n.title, venuePointId: n.venuePointId }));

  // 真实点位名来自 venue_points.name（location 文本列已移除，无回退）。
  const names: string[] = [];
  const push = (v?: string | null) => {
    const s = (v ?? '').trim();
    if (s && !names.includes(s)) names.push(s);
  };
  const pointIds = nodes.map(n => n.venuePointId).filter((x): x is string => !!x);
  if (pointIds.length) {
    const pts = await db.select({ name: pmsBuiWenlvVenuePoints.name })
      .from(pmsBuiWenlvVenuePoints).where(inArray(pmsBuiWenlvVenuePoints.id, pointIds));
    for (const p of pts) push(p.name);
  }
  if (names.length === 0 && venueId) {
    // 最后兜底：节点一个点位都没挂，但剧本归属了场地 —— 用场地的点位名，
    // 至少比让模型自由发挥更贴近现场。
    const pts = await db.select({ name: pmsBuiWenlvVenuePoints.name })
      .from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, venueId));
    for (const p of pts) push(p.name);
  }
  if (names.length === 0) {
    // 不抛错（该剧本可能确实没有点位），但**不静默**：基线里 mustHave 会由模型发挥。
    console.warn('[wenlv-asset-gen] 产品', productId, '没有任何真实点位名，风格基线的 mustHave 将由模型自由发挥');
  }

  const user = buildStyleBiblePrompt({
    productName: product.name,
    subtitle: product.subtitle,
    theme: product.theme,
    config: product.config,
    nodeTitles: nodes.map(n => n.title),
    venuePointNames: names,
  });
  const llm = await callLlm(STYLE_BIBLE_SYSTEM, user);
  let bible: WenlvStyleBible;
  try {
    bible = parseStyleBible(llm.text);   // 解析失败抛错 → 批次整体失败，不静默用空基线
  } catch (e) {
    // 解析失败 ⇒ 本次调用的 token 费**已经花了**，但不写就永远查不到。
    // 落一行 `status='failed'` 的 style_bible job（**不是 pending** —— pending 会被调度器
    // 领走并真的去建图，见本函数下方「行**直接以 succeeded 写入**」那段注释），钱记在该行上。
    // ⚠️ 必须在 `throw e` **之前**：放在之后等于这行永远不写（异常直接冒泡）。
    // ⚠️ 错误文本走 `diagnosableErrorText`（不是裸 `e.message`）：这条 error_message 会经
    //    `GET /admin/wenlv-asset-gen/batch/:batchId` 原样回给浏览器，与 markFailed 同一道消毒。
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: randomUUID(),
      batchId: `stylebible:${productId}`,
      venueId, productId,
      assetType: 'style_bible',
      // 列宽 varchar(100)。按**码点**截（`Array.from`，不是 `.slice()`）—— 与成功行同一口径，
      // 见下面「风格基线自举·」那一行的注释（代理对落库会成 U+FFFD）。
      name: Array.from(`风格基线自举失败·${productId}`).slice(0, 100).join(''),
      prompt: user,                                   // 留痕：这一次失败的自举是用什么问出来的
      provider: 'dashscope-chat',
      model: process.env.WENLV_PROMPT_MODEL || 'qwen-max',
      status: 'failed',
      iteration: 1,
      costAmount: String(calcPromptCost(llm.inputTokens, llm.outputTokens)),
      errorMessage: diagnosableErrorText(e),
      startedAt: new Date(), finishedAt: new Date(),
    });
    throw e;
  }
  await db.update(pmsBuiWenlvProducts).set({ styleBible: bible, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, productId));

  // 风格圣经的账落在**合成 job 行**上（`cost_amount` 全库只存在于这张表，没有批次表）。
  // 用固定 batchId 而不是随机 id：同一个产品的多次自举要汇到**同一个批次**上，
  // 「这个产品的基线调了三次花了多少钱」才是一个能查到的问题（GET /batch/:batchId）。
  //
  // 行**直接以 succeeded 写入**，绝不经过 pending：调度器的领取只认 pending，
  // 一条 pending 的 style_bible 行会被第 3 步的无类型过滤领取领走、丢给 generateImageJob，
  // 于是它去建图 —— 那是一次**真实付费**的、语义完全错误的调用。
  //
  // 位置：`parseStyleBible` 成功**之后**、products 更新**之后**。之后的理由是本行是
  // **新增的失败面**（一次 INSERT）：放在更新之前的话，它一旦失败就连刚算出来的基线
  // 一起丢；放在之后，最坏情况下基线已存、用户重进走 `reused` 免费捷径。
  //
  // ✅ **解析失败**那一次已花的 token 费自 2026-09-20 起也进账了：上面 `parseStyleBible`
  //    的 catch 会落一行 `status='failed'` 的合成行（同样 `batchId='stylebible:<pid>'`），
  //    于是同一产品的「自举花了多少钱」= 该批次全部行的 SUM，成功与失败都在里面。
  const batchId = `stylebible:${productId}`;
  const promptCost = calcPromptCost(llm.inputTokens, llm.outputTokens);
  await db.insert(pmsBuiWenlvAssetJobs).values({
    id: randomUUID(),
    batchId,
    venueId,
    productId,
    assetType: 'style_bible',
    // 列宽 varchar(100)。按**码点**截（`Array.from`，不是 `.slice()`）：`.slice` 数码元，
    // 截断点落在代理对中间会留下孤立代理项，落库被编码成 U+FFFD（无报错、无日志）。
    // 本行的输入（中文前缀 + ASCII productId）全是 BMP，两种写法结果相同 —— 写成码点形态
    // 是为了不给下一个照抄的人示范 `.slice()`（见 enqueue.ts 的 fitName / codePointLen）。
    name: Array.from(`风格基线自举·${productId}`).slice(0, 100).join(''),
    prompt: user,                                       // 留痕：这一版基线是用什么问出来的
    provider: 'dashscope-chat',
    model: process.env.WENLV_PROMPT_MODEL || 'qwen-max',
    status: 'succeeded',
    iteration: 1,
    costAmount: String(promptCost),
    startedAt: new Date(),
    finishedAt: new Date(),
  });
  return bible;
}

/** 取该 job 的基线：优先行上的快照，缺失则用产品当前的基线。 */
async function resolveBible(job: WenlvJobRow): Promise<WenlvStyleBible> {
  const snap = job.styleBibleSnapshot;
  if (snap && Object.keys(snap).length > 0) return snap;
  if (job.productId) {
    const [p] = await db.select({ styleBible: pmsBuiWenlvProducts.styleBible })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, job.productId)).limit(1);
    if (p?.styleBible && Object.keys(p.styleBible).length > 0) return p.styleBible;
  }
  throw new Error('该任务没有风格基线，拒绝在无锚点的情况下生成');
}

/**
 * 把素材写成资源库一行，返回 assetId。
 *
 * ⚠️ **导出只为测试能直接驱动**（同 `bootstrapStyleBible` / `generateImageJob` 的处境）：
 *    生产路径上只有 `generateNarrationJob` 调它，而那个调用点是**无条件**的
 *    —— 从外部想把「同一个 asset id 连写两次」这条链（⇒ `exist` 为真 ⇒ update 支）
 *    钉住，唯有直接调本函数；经 `runAssetGenOnce` 走不到第二条写。
 *    看守用例：`routes/admin/__tests__/wenlv-design.test.ts` 的
 *    「writeAsset 重跑（update 支）仍写 product_id 列，不只 insert 支」。
 */
export async function writeAsset(job: WenlvJobRow, url: string, extraMeta: Record<string, unknown>): Promise<string> {
  // id 规则与图类**同一个函数**（index 0 无后缀）。原先这里是 `wa-${job.id}`.slice(0, 50)
  // —— 与 designAssetIdFor 是两份规格，但分叉**与长度无关**：后者按**码点**截到 47
  // （`Array.from`），前者按 **UTF-16 码元**截 50 ⇒ 只有当 job id 的**前 47 个码点内有
  // 非 BMP 字符**（emoji 等）时，旧式才会从代理对中间切开、吐出一个孤立高位代理项，
  // 两边算出**不同的 id**，于是「同一个 job 的素材」会分裂成两行，且完全静默。
  // 长度本身从不导致分叉（实测 ascii 46/47/48/50/60、36 位 UUID、47×'a'+emoji 全等价；
  // 唯一不等价的是 `'a'.repeat(46) + '😀'`）。
  // 对**本行适用的一切**现状逐字节不变：能走到这里的 job（图类 / 旁白）其 id 都由
  // randomUUID() 生成（`enqueue.ts` 的批量 `toJobRow` 与 iteration 两处、`scheduler.ts` 里两条
  // style_bible 合成行同此）⇒ 恒 36 个 ASCII 字符、且无非 BMP ⇒ 两条公式等价。
  // ⚠️ **别读成「asset_jobs.id 恒 36 字符」** —— 反例是评审记账行 `review:${assetId}`
  //   （`scheduler.ts` 里那一处，最长 7+50=57 > 47，是全 5 处**生产** insert 里唯一的非 UUID id）。
  //   它**不产出 design_assets 行**（`writeAsset` / `writeCandidate` 的调用点**各只有一处**：
  //   `generateNarrationJob` / `generateImageJob`）⇒ 不影响本行结论；且它整串都是 ASCII
  //   （无非 BMP）⇒ 即便将来有人让评审行也写素材，这条等价**照样成立**，不会失效。
  const assetId = designAssetIdFor(job.id, 0);
  const [exist] = await db.select({ id: pmsBuiWenlvDesignAssets.id })
    .from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
  // 公共池判定**复用 planBatch 那一份清单**（PUBLIC_POOL_TYPES，**定义处**在
  // asset-types.ts；本文件仍从 enqueue.ts 引是因为那边 re-export，import 点不动）。
  // 在轮询器里再手写一遍 `=== 'stamp' || === 'icon' || === 'anchor'` 是两处规格：
  // 日后加一个公共池类型时，planBatch 的测试仍是绿的，而这里悄悄把它的 venue_id 写成了私有。
  // 行上的 asset_type 是 varchar（不是 TS 联合），强转只为过类型：不认识的值 `.has` 返回 false
  // → 落私有池。与 `as any` 时期的行为一致，但**只在这一个点**放宽，不贯穿整条流水线。
  const publicPool = PUBLIC_POOL_TYPES.has(job.assetType as JobAssetType);
  // 截断**按码点**（`Array.from`），不能用 `.slice()` —— 后者按 UTF-16 码元切，
  // 从代理对中间切开会产生孤立代理项，落库时被编码成 U+FFFD：无报错、无日志的脏值
  //（name 是 `fitName` 产出的，它按码点算长度，含 emoji 时 UTF-16 长度 > 100）。
  // 与 enqueue.ts 的 fitName 同一条口径。宽度沿用列定义，不新造常量。
  const values = {
    type: job.assetType,
    name: Array.from(String(job.name)).slice(0, 100).join(''),
    url,
    // 口径唯一来源是 enqueue.ts 的 `fitTag`（trim；空/纯空白归 null；按码点截到 MAX_TAG）。
    //
    // ⚠️ 在**这条写路径上真正可达**的差异只有 trim / 空白归一 / 空串归 null —— **不是截断**。
    //    本行的来源 `pms_bui_wenlv_asset_jobs.community_style_tag` 本身就是 varchar(50)
    //    （schema/wenlv.ts:437）—— **列宽本身**就决定了调度器读到的标签不可能超过 50 码点。
    //    （超长值在更上游就被 `enqueueBatch` 的 JS 不变量断言 `throw` 掉了，压根走不到 INSERT；
    //    SQLSTATE 22001 只是绕开那个断言时的**数据库兜底**，不是这里的实际拦截点。）
    //    所以「51 字的场地名会让素材行被静默截断」是一条**不可达**的路径，别照着它做风险判断。
    //    参数化这里的意义是**规则只有一个来源**（两处各写一份会各自漂移），截断只是顺带产物。
    styleTag: fitTag(job.communityStyleTag),
    venueId: publicPool ? null : job.venueId,   // 风格化进公共池，写实落私有（spec §4.2）
    // 剧本级归属真列（迁移 0036）。与下面 `meta.productId` **双写**（同 candidate-store）。
    // ⚠️ 写进 `values` 而非某一条分支：本函数是 `if (exist) update else insert`，
    //    只加在 insert 那一支的话，重跑命中的是 update 支（`set: { ...values, updatedAt }`），
    //    该列被**省略**（不更新）⇒ 真值是「**保留旧值**」，**不是**「重跑把列打回 NULL」；
    //    旧值本就是 NULL 时（首写即走 update 支、或命中迁移前的预存行）才停在 NULL。
    productId: job.productId,
    // ── 坐标系与出处（迁移 0038 补）────────────────────────────────
    // ⚠️ 本函数此前**三样都没写**（job_id / target_kind / target_id），只有 meta 里有
    //    jobId。后果是旁白行成了坐标系外的行：
    //      ① 素材列表的「用在」列对旁白恒显示 `—`（前端按 jobId 找 target）；
    //      ② `reviewAssetJob` 靠 `!a?.jobId` 那一句**巧合地**绕过了旁白；
    //      ③ `selectCandidate` 的两条 UPDATE 都匹配不到旁白行（静默 no-op）。
    //    这是「加列只加了一条写路径」的第五例，见设计文档 §2.3。
    //    ②③ 是**行为变化**，不是纯加列 —— 判定与看守见 Task 5 Step 1 / Task 6。
    jobId: job.id,
    // 与图类同一个函数取坐标（candidate-store.ts）。
    ...targetFieldsOf(job),
    meta: { jobId: job.id, productId: job.productId, iteration: job.iteration, ...extraMeta },
    isBuiltin: false,
  };
  if (exist) {
    await db.update(pmsBuiWenlvDesignAssets).set({ ...values, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId));
    return assetId;
  }
  await db.insert(pmsBuiWenlvDesignAssets).values({ id: assetId, ...values });
  return assetId;
}

/**
 * 记 failed。**不动 costAmount** —— 已发生的费用由调用点在生成成功后立即写入。
 *
 * 失败自动重试 1 次：首次失败不写 failed，而是置回 `pending`、`attempt += 1`、
 * 清空 `errorMessage`，等调度器下次领取自动重试。指数退避由调度器 pending 领取
 * 间隔自然实现，无需额外 sleep。已重试过 1 次才真正标记 `failed`。
 *
 * ⚠️ **阈值是 `attempt < 2`，不是 `< 1`**：`claimNextJobs` 在领取时已经做过一次
 *    `attempt = attempt + 1`（claim.ts:114），所以本函数拿到的 `job.attempt` 是
 *    **领取后**的值——首次失败时 attempt=1，不是 0。若写成 `< 1`，重试分支永不
 *    触发（`1 < 1` 恒假），等于没加重试。完整链路：
 *      创建 attempt=0 → 领取→1 → 首次失败：1<2 → 重试置 attempt=2、pending
 *      → 再领取→3 → 二次失败：3<2 假 → failed（共跑 2 次 = 自动重试 1 次）
 *    上限 `MAX_ATTEMPT=3`（claim 侧的领取过滤 `attempt < 3`）天然兜底：重试后置
 *    attempt=2 仍可领取，二次领取后 attempt=3 不再被领取。
 */
async function markFailed(job: WenlvJobRow, e: unknown): Promise<void> {
  // 完整错误（堆栈 / SQL / 参数）**只进日志**；落库的是消毒过的一行诊断。
  // 这条不是洁癖：`error_message` 会经 `GET /admin/wenlv-asset-gen/batch/:batchId`
  // 原样回给创作台前端，而 drizzle 的 message 是 `Failed query: <完整SQL> params: <参数>`
  // —— 直接落库即等于把 SQL 与参数透给浏览器（response 侧有 serverError 守着，
  // 落库侧此前没人管）。消毒规则与理由见 lib/http-error.ts 的 diagnosableErrorText。
  console.error('[wenlv-asset-gen] job', job.id, '失败:', e);
  if (job.attempt < 2) {
    // 自动重试：重置为 pending，attempt+1，等下次领取（指数退避由调度器领取间隔实现）
    await db.update(pmsBuiWenlvAssetJobs).set({
      status: 'pending', attempt: job.attempt + 1, errorMessage: null, updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));
    return;
  }
  // 已重试过 1 次，标记 failed
  await db.update(pmsBuiWenlvAssetJobs).set({
    status: 'failed', errorMessage: diagnosableErrorText(e),
    finishedAt: new Date(), updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));
}

/** 评审记账行的名字前缀。`reviewAssetJob` 与它的列宽截断共用这一份，别在别处再抄一遍。 */
const REVIEW_ROW_PREFIX = '评审·';

/**
 * 评审一条素材并写回 `design_assets.review_*`。
 *
 * ⚠️ **不连坐生成**：评审失败只让这条素材没分，绝不影响已经生成好的图。
 *    （生成与评审是两次独立付费，把后者失败算进前者会让一张好图被误判成失败。）
 *    调用点因此**只记日志**，不 catch 进 job 状态。
 *
 * ⚠️ **导出供 Task 15 的 `/select` 复用**（改选后为新选中项补一条评审）。
 * ⚠️ 调用方**必须先过可评类型判定**（`asset-gen/reviewer.ts` 的 `isReviewableType`；
 *    `shouldReview` 内部就是复用它，故自动调用点天然满足）—— 本函数**不做类型守卫**。
 *    真正**可达**的暴露面是 **`anchor`**：它也走 `generateImageJob` → `writeCandidate`，
 *    而调度器第 3 步的领取是**无类型过滤**的（见上面 style_bible 那段同源注释）
 *    ⇒ 一条已成功的锚图行能被原样交进来。锚图的 `reviewScore` 恒为 null，评它是
 *    **范畴错误**：锚图是风格基准本身，refs 自过滤掉同 URL 后只剩风格图集（可能为空），
 *    分数**无参照语义**，且多花一次白花的图 token。
 *    （`review` / `style_bible` 是合成行，没有 design_assets 行 ⇒ 本函数在 `!a?.jobId` 处提前 return。
 *      `narration` 有行（`writeAsset` 建的）且**现在也写了 `job_id`** —— 本片之前它恒为 NULL，
 *      那时这处提前 return 确实顺手挡住了旁白行；**该巧合已经随本片消失**，
 *      旁白行不再在 `!a?.jobId` 处返回。
 *      真正拦住旁白行、使它不会发起一次付费视觉调用的，是 `asset-gen/reviewer.ts` 的
 *      `isReviewableType`（它排除 `'narration'`），而不是本函数里的这个判空。
 *      **别据此以为类型守卫可以省** —— 那两道闸都不归本函数管，是巧合，不是设计。）
 */
export async function reviewAssetJob(assetId: string): Promise<void> {
  const [a] = await db.select().from(pmsBuiWenlvDesignAssets)
    .where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
  if (!a?.jobId || !a.url) return;
  // ⚠️ **去重闸，加在收口点而不是调用点。** 调用点有两个（调度器收尾的自动评审、
  //    `/select` 的补评），二者都会走到这里；把闸加在任一个调用点上，
  //    另一条路径依旧漏。
  //
  // 为什么要它：调度器收尾是「先把 job 写成 succeeded，再 fire-and-forget 评审」
  // （见本文件收尾段），而评审是一次**多秒**的视觉调用 ⇒ 这段窗口里
  // `/select` 的 `asset.reviewScore === null` **恒为真**，同一张图会被评两次。
  //
  // 后果不只是多花一次图 token：本函数的记账行主键是 `review:<assetId>`，
  // 第二次会把那行**原地覆盖**成新花费 ⇒ **第一次已付的钱从账面上消失**
  // （而 S3/S4 的交付判据正是「知道花了多少钱」）。
  //
  // ⚠️ **人工已介入的行必须一并跳过**（spec §8.5，迁移 0035 新增的半个条件）。
  //    起因：口径① 原本写「human 写入后 `/select` 的 fire-and-forget AI 补评**跳过**，
  //    复用已建的同类去重闸思路」—— 但那个前提**不成立**：闸当时只判 `reviewScore`，
  //    而人工采纳一张图**不产生** `reviewScore`（`selectCandidate` 只写 `isSelected`）
  //    ⇒ `reviewScore !== null` 恒假 ⇒ **闸不拦** ⇒ 补评照跑、把 `reviewSource`
  //    从 `'human'` 改写成 `'ai'` ⇒ 人工标签被覆盖。
  //    所以这里**必须**判 `reviewSource === 'human'` 这一半；只判分数那半边等于没闸。
  //    ⛔ 不要把这个条件挪到调用点（`/select` 或调度器收尾）：调用点有两个，
  //      加在任一个上另一条路径依旧漏 —— 这是本函数上方那段注释已经交代过的纪律。
  //    ⚠️ 判 `reviewSource` 而不是 `humanReviewedAt`：后者是「钱的影子」的同类 ——
  //      它是**动作留痕**，本闸要拦的是**动作本身的后果**。用时间戳当闸，语义上等于
  //      「人工看过就不许 AI 评」，而人工**看**（打开面板）与人工**评**（写意见/采纳）
  //      是两件事，将来加了「浏览即记录」就会静默把闸关死。
  if (a.reviewScore !== null || a.reviewSource === 'human') return;
  const [job] = await db.select().from(pmsBuiWenlvAssetJobs)
    .where(eq(pmsBuiWenlvAssetJobs.id, a.jobId)).limit(1);
  if (!job) return;
  const [product] = job.productId
    ? await db.select().from(pmsBuiWenlvProducts)
        .where(eq(pmsBuiWenlvProducts.id, job.productId)).limit(1)
    : [undefined];

  // 参照图 = 锚图 + 风格图集（**没有锚图就判不了风格漂移**，那是本评价器存在的主要理由）
  // ⚠️ 自过滤掉与待评素材**同 URL** 的参照图：防将来 `/select` 把基准图自身传进来
  //    ⇒ 同一张图发两遍（重复计图 token、且与自己比风格漂移结构性恒达标）。
  const refs = [product?.styleAnchorUrl, ...(product?.styleReferences ?? []).map(r => r.url)]
    .filter((u): u is string => !!u?.trim() && u !== a.url);

  const input = {
    assetType: job.assetType as JobAssetType,
    assetName: a.name, productName: product?.name ?? '',
    // 用**生成时的快照**而不是产品当前基线：这一版素材是照那份基线出的，
    // 用今天的基线去评它，会在基线被编辑后把老素材全部误判成不合格。
    bible: job.styleBibleSnapshot,
    contextText: job.sourceText,
  };
  // §8.5 正反例参照：人工采纳 / 明确淘汰过的样本自动累积（**不跨产品**）。
  // ⚠️ 取数失败**不得**连坐评审：参照样本是校准增强，不是打分的前提。一次查询故障
  //    不该让一张已经付过钱的图永远没有分数（那正是本函数开头「不连坐生成」的同一条
  //    纪律，方向反过来）。故降级成空集 —— 但**必须留日志**，否则「参照样本从此永远
  //    是空」会完全无声（表现为分数悄悄变了，而没人知道为什么）。
  let examples: ReviewExamples | null = null;
  if (job.productId) {
    try {
      examples = await loadReviewExamples(job.productId, assetId);
    } catch (e) {
      console.warn(
        `[wenlv-asset-gen] 评审参照样本读取失败，本次不带参照评审 assetId=${assetId}：`,
        diagnosableErrorText(e),
      );
    }
  }
  const llm = await callLlmVision(
    SYSTEM_REVIEW, buildReviewPrompt({ ...input, examples }), [a.url, ...refs],
  );
  const detail = parseReview(llm.text);

  await db.update(pmsBuiWenlvDesignAssets).set({
    reviewScore: String(detail.score),
    reviewDetail: detail,
    reviewSource: 'ai',
    reviewedAt: new Date(),
    reviewModel: reviewModel(),
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvDesignAssets.id, assetId));

  // 评审的 token 花费落在**合成 job 行**上（cost_amount 全库只此一表，见 schema 注释）。
  // 与 style_bible 同款：固定 batchId，使「这个剧本评审花了多少钱」是一个能查到的问题。
  //
  // `id = review:<assetId>` 让重评**幂等** —— 同一张素材被评两次（首轮自动 + `/select` 补评）
  // 不撞主键，而是把那一行原地更新成最新一次的花费。
  // ⚠️ **幂等的是「行」，不是「钱」**：上面这句只保证不会出现两行 / 撞主键，它**不阻止**
  //    第二次付费调用发生 —— 而 `onConflictDoUpdate` 会把那一行**原地覆盖**成本次花费
  //    ⇒ 第一次已付的钱从账面上消失（而 S3/S4 的交付判据正是「知道花了多少钱」）。
  //    真正的重复付费由函数开头那道去重闸挡住（`reviewScore !== null || reviewSource === 'human'`
  //    → return）；只剩「两个调用都在对方写入前读到 null」那条窄竞态仍由本行的 ON CONFLICT 兜底。
  const reviewJobRow = {
    id: `review:${assetId}`,
    batchId: `review:${job.productId ?? 'unknown'}`,
    productId: job.productId, venueId: job.venueId,
    assetType: 'review',
    // 列宽 varchar(100)。`评审·` 是 3 码点，而素材名本身可**恰好填满** 100
    // （fitName 按码点截到列宽；节点标题上限 200 ⇒ 89 字标题即产出 100 码点名）
    // ⇒ 直接拼是 103，INSERT 撞 SQLSTATE 22001。本行是**记账行**，它失败 = 这笔 token 费
    // 从账面上消失（UPDATE 已在前面，故分数不丢、只有账丢）—— 本子项目最怕的静默少算。
    // 截**素材名**、保留前缀（与 fitName「截标题不截后缀」同理：前缀是这行的身份信号）。
    // 按**码点**截（`Array.from`），不是 `.slice()` —— 否则 emoji 会从代理对中间切开成 U+FFFD。
    name: `${REVIEW_ROW_PREFIX}${Array.from(a.name)
      .slice(0, MAX_NAME - Array.from(REVIEW_ROW_PREFIX).length).join('')}`,
    status: 'succeeded',
    provider: 'dashscope', model: reviewModel(),
    prompt: null,
    styleBibleSnapshot: job.styleBibleSnapshot,
    costAmount: String(calcPromptCost(llm.inputTokens, llm.outputTokens)),
    iteration: 1, attempt: 0,
    startedAt: new Date(), finishedAt: new Date(),
  };
  await db.insert(pmsBuiWenlvAssetJobs).values(reviewJobRow).onConflictDoUpdate({
    target: pmsBuiWenlvAssetJobs.id,
    set: {
      model: reviewJobRow.model,
      costAmount: reviewJobRow.costAmount,
      finishedAt: reviewJobRow.finishedAt,
      updatedAt: new Date(),
    },
  });
}

/**
 * 按 `(targetKind, targetId)` 解析要素的**真名**（0033 起的权威键对），供画面描述
 * 「素材：」那一栏使用。查不到（要素已删）返回 null，调用方回落 `job.name`。
 *
 * ⚠️ 只处理**没有 nodeId / collectibleId 兜底键**的那五类：character / npc / ending /
 *    reward / tier。node / product / collectible 三类**有意不覆盖**（落到 `default`
 *    直接返回 null，**不查库**）—— 它们仍走既有的 nodeId / collectibleId 旧键兜底，
 *    或（product 合成行）直接回落 `job.name`；在这里再解一遍只会是重复。
 *
 * ⚠️ 显示名字段以 `db/schema/wenlv.ts` 为准，**别猜**：
 *    · `ending` 的显示名是 `title`（**不是** `name`）；
 *    · `reward` / `tier` / `npc` / `character` 是 `name`（**不是** `title`）。
 *    `ending` 写 `name`、`tier` 写 `title` 都不报错、不变红 —— 只是那一栏永远回落到
 *    `job.name`（带类型后缀），正是本函数要消灭的缺陷。
 */
async function resolveTargetTitle(kind: string, targetId: string): Promise<string | null> {
  switch (kind) {
    case 'character': {
      const [r] = await db.select({ name: pmsBuiWenlvCharacters.name })
        .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, targetId)).limit(1);
      return r?.name ?? null;
    }
    case 'npc': {
      const [r] = await db.select({ name: pmsBuiWenlvNpcs.name })
        .from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, targetId)).limit(1);
      return r?.name ?? null;
    }
    case 'ending': {
      // 0079：结局即 scenes（type='ending'），按 id 直查 title。
      const [r] = await db.select({ title: pmsBuiWenlvScenes.title })
        .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, targetId)).limit(1);
      return r?.title ?? null;
    }
    case 'reward': {
      const [r] = await db.select({ name: pmsBuiWenlvRewards.name })
        .from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, targetId)).limit(1);
      return r?.name ?? null;
    }
    case 'tier': {
      const [r] = await db.select({ name: pmsBuiWenlvRewardTiers.name })
        .from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.id, targetId)).limit(1);
      return r?.name ?? null;
    }
    default:
      // node / product / collectible / 未知 kind：不查库，交由调用方走旧键或 job.name 兜底。
      return null;
  }
}

/**
 * 文生图一条（含锚图）。上游返回即已计费 —— 此后的任何失败都不撤销这笔钱。
 *
 * ⚠️ **导出只为测试能直接驱动**（同 `bootstrapStyleBible` 的处境）：
 *    「没有锚图就拒绝生成」这条守卫在**生成期**，而第 3 步的领取已经先用
 *    `requireAnchorReady` 把这类行挡在门外 —— 于是它再也无法经由 `runAssetGenOnce`
 *    到达。但守卫必须继续承重：领取 SQL 是**一道**门，若将来有人以不带该过滤的
 *    `claimNextJobs()` 领走这些行（该函数是导出的），这里是唯一的兜底。
 *    删掉它 = 资源库里出现事后无从分辨的脱锚版本（spec §4.7）。
 */
export async function generateImageJob(job: WenlvJobRow, bible: WenlvStyleBible): Promise<void> {
  // productId 在列上可空（旁白/其它行未必挂产品），但**图类任务离了它什么都做不了**
  //（参考图、锚图回写都按它定位）。这里显式守卫，别让 `eq(id, null)` 静默查出 0 行、
  // 最后报成「该剧本还没有风格锚图」—— 一条指向错误原因的诊断。
  if (!job.productId) throw new Error('素材任务缺少 productId，无法生成（数据不完整）');
  const isAnchor = job.assetType === 'anchor';
  let prompt: string;
  let referenceUrl: string | null = null;
  // 风格参考图集（products.style_references，spec §4.3）。与 referenceUrl 同因：
  // 产品行只在 else 分支内查，出了分支就取不到 ⇒ 必须在这里先声明、在分支内赋值。
  let styleRefs: { role?: string; url?: string }[] = [];
  // 本次的 LLM 用量。**只在 `!isAnchor && !reusePrompt` 那一支里赋值**（下面唯一的 `callLlm`
  // 调用点）—— 另外三条路径（锚图复用 prompt / 锚图走模板 / 非锚图复用 prompt）**不调 LLM**，
  // 这里必须保持 null。把它提到分支外去调 LLM 会让那三条生产主路径**平白多花一次钱**。
  //
  // ⚠️ 别因为「初值 = null 了」就在下面直接写 `llm.inputTokens`：TS 在 if/else **汇合点**
  //    取的是各分支的并集，有分支从未赋值 ⇒ 那里仍是 `LlmResult | null`（TS18047）。
  //    也不能用 `llm!` —— 它在上述三条路径上**确实是 null**，是给编译器撒谎、运行时抛
  //    TypeError。读它的地方一律 `llm?.x ?? 0`。
  let llm: LlmResult | null = null;

  // 重试**不改 prompt**（spec §7.2：与失败前逐字相同）。
  // `prompt` 是在上游返回后、OSS 转存**之前**就写进行上的，所以「生成成功但转存失败」
  // 这条真实路径下它已存在 → 重试复用（否则同一行会拿到另一段 temperature 0.3 的画面描述，
  // 用户点「重试」得到的是另一张图）；而「LLM 本身失败」时它仍是 null → 照旧现算，也对。
  //
  // ⚠️ **不能**再加 `!job.parentJobId` 这个条件。`parentJobId` 非空只说明「这是一条迭代行、
  //    由 `enqueueIteration` 建的」—— 那是**首次**要按新反馈重算的语义。而**重试**的语义是
  //    「原样再来一次」。两者被混为一谈时：迭代行首次算出的 prompt 已落库、OSS 转存失败 →
  //    failed → 用户点重试（Task 10 端点按 §7.2 保留 prompt、仅置回 pending）→
  //    parentJobId 非空 ⇒ 判定不复用 ⇒ **重新调 LLM**，用户拿到另一张图，外加一次无账的调用。
  //    去掉这个条件天然正确：迭代行**新建**时 `prompt` 本就是 null（`enqueueIteration`
  //    显式写 `prompt: null`）⇒ 不会误复用；只有「已经算过一次」的行才复用 —— 正是想要的。
  const reusePrompt = !!job.prompt?.trim();

  if (isAnchor && reusePrompt) {
    prompt = job.prompt!;
  } else if (isAnchor) {
    // 锚图是**画风样张**，提示词由模板直接给，不经 LLM 转述（spec §5.2）
    prompt = buildAnchorPrompt(bible);
  } else {
    const [p] = await db.select({
      name: pmsBuiWenlvProducts.name,
      config: pmsBuiWenlvProducts.config,
      styleAnchorUrl: pmsBuiWenlvProducts.styleAnchorUrl,
      styleReferences: pmsBuiWenlvProducts.styleReferences,   // ⛔ 漏这一行 = 图集恒空
    }).from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, job.productId)).limit(1);
    referenceUrl = p?.styleAnchorUrl ?? null;
    // 图集上限 6（spec §4.3）：吃满 15 配额前先截断，别让用户配了 20 张把候选挤成 0。
    // `MAX_STYLE_REFS` 从 candidates.js 引（Task 8 已建）。
    styleRefs = (p?.styleReferences ?? [])
      .filter((r) => r?.url?.trim())
      .slice(0, MAX_STYLE_REFS);
    if (!referenceUrl) {
      // **不降级为「无参考图生成」**：脱锚的那一版事后无从分辨，等于污染资源库
      throw new Error('该剧本还没有风格锚图，拒绝生成（防风格漂移）');
    }
    if (reusePrompt) {
      prompt = job.prompt!;
    } else {
      let previousPrompt: string | null = null;
      if (job.parentJobId) {
        const [prev] = await db.select({ prompt: pmsBuiWenlvAssetJobs.prompt })
          .from(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.id, job.parentJobId)).limit(1);
        previousPrompt = prev?.prompt ?? null;
      }
      // 画面描述里的「素材」一栏必须是**真名字**（节点标题 / 图鉴条目名）。
      //
      // ⚠️ 不能用 `job.name`：`planBatch` 给它拼了类型后缀（`入镇·background`、
      //    半枚残破铜钱·collectible），直接用等于把**素材类型**当成内容名喂给 LLM，
      //    而这段描述正是出图模型的输入 —— 出的每一张图都带着类型后缀的语义污染。
      //    nodeId / collectibleId 才是权威键：标题只用于展示，改名后 job.name 是旧名。
      //    两个键都查不到才回落 `job.name`（此时它至少是个能给 LLM 看的字符串）。
      let nodeTitle = String(job.name);
      // 0033 起 `targetKind` + `targetId` 是权威键对。character/npc/ending/reward/tier 这五类
      // **既没有 nodeId 也没有 collectibleId**（见 enqueue.ts 的展开循环）—— 只有这一条路
      // 能拿到真名，否则回落 job.name、把 `沈砚·character_avatar` 之类带类型后缀的名字喂给 LLM。
      if (job.targetKind && job.targetId) {
        nodeTitle = (await resolveTargetTitle(job.targetKind, job.targetId)) ?? nodeTitle;
      }
      // 兜底（targetKind 为 null 的 0033 前历史行，或 node/product/collectible 三类）：
      // 走旧键，最后才 job.name。
      if (nodeTitle === String(job.name)) {
        if (job.nodeId) {
          // 0079：节点即 scenes。
          const [node] = await db.select({ title: pmsBuiWenlvScenes.title })
            .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, job.nodeId)).limit(1);
          if (node?.title) nodeTitle = node.title;
        } else if (job.collectibleId) {
          // 图鉴条目的 job.nodeId 恒为 null（见 enqueue.ts 的 collectibles 展开循环）——
          // 缺了这一支，nodeTitle 就会停在 `…·collectible` 上。
          const [c] = await db.select({ name: pmsBuiWenlvCollectibles.name })
            .from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, job.collectibleId)).limit(1);
          if (c?.name) nodeTitle = c.name;
        }
      }
      // `world_setting` 是 S2 落进 jsonb 的键，**不在 `WenlvProductConfig` 的 TS 形状里**
      //（schema 只声明了 checkinRule/collectRule/validDays）。所以这里不能只写
      // `as WenlvProductConfig` —— 那会 ts-check 报错。用交集把已知的额外键声明出来，
      // 比 `as any` 收紧，也不至于让整个 config 失去类型。
      const cfg = (p?.config ?? null) as (WenlvProductConfig & { world_setting?: unknown }) | null;
      // LLM 只把内容翻译成**画面描述**；风格基线由 buildImagePrompt 逐字拼上，不经 LLM 转述
      const instruction = buildScenePrompt({
        productName: p?.name ?? '',
        worldSetting: cfg?.world_setting ?? null,
        nodeTitle,
        storyText: job.sourceText, assetType: job.assetType,
      });
      const extra = [
        previousPrompt ? `上一版的画面描述：${previousPrompt}` : '',
        job.guidance ? `本次修改要求：${job.guidance}` : '',
      ].filter(Boolean).join('\n');
      llm = await callLlm(SCENE_SYSTEM, extra ? `${instruction}\n\n${extra}` : instruction);
      prompt = buildImagePrompt({ bible, scene: llm.text.trim() });   // 基线的唯一注入点
    }
  }

  // 参考图数组的**顺序即发给上游的顺序**：锚图在前（世界一致性的最强约束），
  // 其后是风格图集。涂鸦重绘时涂鸦图追加在最后 —— 它是本次意图的直接载体，
  // 但不能挤掉锚图。
  const refs: string[] = [];
  if (referenceUrl) refs.push(referenceUrl);
  for (const r of styleRefs) {
    if (r?.url?.trim()) refs.push(r.url.trim());
  }
  if (job.editInputUrl?.trim()) refs.push(job.editInputUrl.trim());

  // 配额算式在 candidates.ts：算不出 ≥1 会**抛错**（绝不静默降级成少发参考图）。
  const candidates = resolveCandidateCount(job.candidateCount ?? 1, refs.length);

  // 参考图快照落库。参考图**会变**（图集可编辑、锚图可重生成），
  // 没有快照就事后无法回答「这张图当时参考了什么」。
  await db.update(pmsBuiWenlvAssetJobs)
    .set({ referenceUrls: refs, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvAssetJobs.id, job.id));

  // ⚠️ **账面缺口 T-I（2026-09-20 已闭合 —— 图片费那一半）**：`generate()` 自身抛错时
  //    （网络失败 / 非 2xx / URL 形态非法），下面的成本自增不会执行，而 `markFailed`
  //    不写成本 ⇒ 上游**可能已产出并真计了费**（尤其「第一张合法 + 第二张非法」这种：
  //    上游出了图，只是我们按 `malformed > 0` 整条拒收），账上却纹丝不动。
  //
  //    修法是结构性的：provider 在抛错时把「上游实际产出的张数」挂在错误对象上
  //    （`image-provider.ts` 的 `ImageGenError`），下面的 catch 拿到就补记一笔。
  //    **不能**去解析错误消息里那句「（N 张 URL 形态非法）」的 N —— 它是**被拒收**的张数，
  //    不是本次实际产出的张数，拿它计费只会从「少算」变成「按错的数少算」。
  //
  //    ⚠️ 这条路径上**本次文本 LLM 的提示词费**（`calcPromptCost`）**也在本次一并记了**：
  //    能走到 catch 且 `llm` 非 null，就说明本次那次 LLM 调用**已经成功返回、token 已花**，
  //    图片那步失败不能把它一起抹掉。注意 catch 里的守卫因此**不是** `produced > 0`：
  //    纯网络失败时上游一张图都没出（`produced === 0`）而提示词费照样要记 —— 见下面的
  //    `promptCost` 与那道 `produced > 0 || promptCost > 0` 守卫。
  let r: GenResult;
  // provider 实例只取一次：catch 里补账要用**同一个** provider 的 name 计价
  //（再调一次 `getImageProvider()` 会按那一刻的 env 重新构造，还可能对未识别 provider
  //  多打一条重复告警）。
  const provider = getImageProvider();
  // 本次的提示词费**提前算一次、只算一次**：LLM 已经成功返回 ⇒ 这笔钱已经花了，
  // 下面图片那步失败不能把它一起抹掉。放在 `try` 之前（而不是 catch 里）是为了让
  // 图片费与提示词费共用**同一份** token 结果；`llm` 在 catch 里可见（声明在本函数靠前处）。
  // `?.` + `?? 0`：三条不调 LLM 的路径让 `llm` 恒为 null，语义上正是「没调 LLM ⇒ 提示词费为 0」。
  const promptCost = calcPromptCost(llm?.inputTokens ?? 0, llm?.outputTokens ?? 0);
  try {
    r = await provider.generate(prompt, {
      assetType: job.assetType, referenceUrls: refs, candidates,
    });
  } catch (e) {
    // ★ 原始业务原因**先落日志**（与 runOne 的 A-3 同一条口径）：若下面的补账写库自己抛，
    //   冒泡上去的是那条 DB 错误 —— 不先写日志，真因就只剩「DB 抖动」这一种解释了。
    console.warn(
      `[wenlv-asset-gen] job ${job.id} 生成调用抛错，上游可能已产出并计费：`,
      diagnosableErrorText(e),
    );
    // 上游已产出 = 钱已经花了。这条路径此前**不记账**（代码里自陈为「已知账面缺口 T-I」），
    // 于是「花了多少钱」系统性少算，而它是本子项目的交付判据之一。
    // 图片费：只有 provider 知道实际产出张数（见 ImageGenError）。
    // 提示词费：LLM 已成功返回（见上面的 `promptCost`），与图片成败无关。
    const produced = e instanceof ImageGenError ? e.producedCount : 0;
    // ⚠️ **守卫是「图片费或提示词费任一非零」，不是 `produced > 0`**：LLM 成功但上游
    //    一张图都没出（纯网络失败）时 `produced === 0` 而 `promptCost > 0` —— 钱照样花了。
    //    只把 `promptCost` 塞进原来的 `if (produced > 0)` 里，等于把「LLM 成功 + 图片全失败」
    //    这条路径继续漏掉，正是本次修法要闭的那一笔。
    if (produced > 0 || promptCost > 0) {
      await db.update(pmsBuiWenlvAssetJobs).set({
        // **+= 不是 =**：重试复用同一行，「上游成功 → 转存失败 → 重试」这条路径会让
        // 上游收两次钱，覆盖式写入只留下后一次 ⇒ 「花了多少钱」少算。
        // 图片费（按**实际产出**张数）+ 本次文本 LLM 的提示词费。
        costAmount: sql`${pmsBuiWenlvAssetJobs.costAmount} + ${String(calcImageCost(produced, provider.name) + promptCost)}::numeric`,
        updatedAt: new Date(),
      }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));
    }
    throw e;   // 交给 runOne 的 catch → markFailed（成本已在上面的补账里记下）
  }
  // 上游已返回 = 钱已经花了。先落 prompt/provider/成本，后面的失败都不会抹掉它（spec §6）
  //
  // 成本是 **+= 不是 =**（spec §6「加到 cost_amount，不是覆盖」）：重试复用同一行，
  // 「上游成功 → OSS 转存失败 → 重试成功」这条真实路径会让上游收两次钱，
  // 覆盖式写入只留下后一次 ⇒ 「花了多少钱」少算，而这是本子项目的交付判据之一。
  // 用 SQL 侧自增而非读-改-写，避免并发下的丢失更新。
  await db.update(pmsBuiWenlvAssetJobs).set({
    prompt,
    provider: r.provider, model: r.model,
    // 图片费 **+ 本次文本 LLM 的分价费**（`calcPromptCost`）。
    // `?.` + `?? 0` 不是防御性冗余：`llm` 在 if/else 汇合点仍是 `LlmResult | null`
    //（三条不调 LLM 的路径让它恒为 null，有分支从未赋值），写 `llm.inputTokens` 是
    // TS18047、写 `llm!` 是运行时 TypeError —— 那三条正是生产主路径。
    // 语义上 `?.` 恰好就是「没调 LLM ⇒ 提示词费为 0」。
    costAmount: sql`${pmsBuiWenlvAssetJobs.costAmount} + ${String(
      // ⚠️ 这里曾是写死的 `calcImageCost(1, …)`。出了 N 张只记 1 张的钱，
      //    会让「花了多少钱」系统性少算，而它是本子项目的交付判据之一。
      //    用**实际返回张数**而不是请求张数：上游可能少返回。
      calcImageCost(r.urls.length, r.provider) + calcPromptCost(llm?.inputTokens ?? 0, llm?.outputTokens ?? 0),
    )}::numeric`,
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));

  // 逐张转存 + 落库。**部分成功不整批失败**：已转存的照常落库，缺口记进 errorMessage。
  const landed: { index: number; assetId: string; ossUrl: string }[] = [];
  const failed: number[] = [];
  // 第一个失败的真实原因 —— 全失败时要带进 error_message（见下面 landed.length === 0 那一支）。
  let firstFailure: unknown = null;
  for (let i = 0; i < r.urls.length; i++) {
    try {
      // 转存 OSS：**不直接落上游 URL** —— 上游 URL 会过期，素材几个月后 404
      const imgRes = await fetch(r.urls[i], { signal: AbortSignal.timeout(60000) });
      if (!imgRes.ok) throw new Error(`下载上游图片失败：${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      // 扩展名与 Content-Type 由**实际字节**决定，不写死：字节 Seedream 返回的是 JPEG，
      // 写死 `.png` 会让 OSS 对象名与 Content-Type 双双说谎（2026-09-14 生产取证发现，
      // 此前前端不可见、测试也抓不到 —— provider 被 mock）。判定规则见 image-type.ts。
      // `?.` 不是防御性冗余：测试桩的 Response 可能没有 `headers`（run-once.db.test.ts 就是），
      // 写成 `imgRes.headers.get(...)` 会抛 TypeError —— 那会让「桩不完整」伪装成业务失败。
      // 真实 fetch 一定带 headers，故生产路径不受影响。
      const { ext, mime } = sniffImageType(buf, imgRes.headers?.get?.('content-type') ?? null);
      const ossUrl = await uploadToOSS(buf, `pms/wenlv/image/${job.id}-${i}.${ext}`, mime);
      const assetId = await writeCandidate({
        jobId: job.id, index: i, assetType: job.assetType, name: job.name, url: ossUrl,
        productId: job.productId, venueId: job.venueId, iteration: job.iteration,
        communityStyleTag: job.communityStyleTag,
        // 坐标（迁移 0038）。取法与旁白路径**同一个函数** —— 两条写路径的坐标
        // 必须来自同一处，否则「加列只加了一条写路径」那个前科会换一副面孔重演。
        target: targetFieldsOf(job),
        extraMeta: { provider: r.provider, model: r.model },
        // ⚠️ 这里**先不自报采纳**，等循环走完、知道了「实际被采纳的是哪一个 index」
        //    再补一次。理由见下面第 5 点 —— 在这个位置写 `i === 0` 会造成
        //    「业务表指向第 1 张，而 design_assets 里零行 is_selected」。
        isSelected: false,
      });
      landed.push({ index: i, assetId, ossUrl });
    } catch (e) {
      // **部分成功**：已转存的照常落库，job 仍算 succeeded —— 钱已经花了、素材也有了。
      // 整批重试会对已成功的几张**重复付费**。
      failed.push(i);
      if (firstFailure === null) firstFailure = e;
      console.warn(`[wenlv-asset-gen] job ${job.id} 第 ${i} 张转存失败：`, diagnosableErrorText(e));
    }
  }
  if (landed.length === 0) {
    // 一张都没落 = 真失败。费用已在上面记下，这里的 failed 不带 costAmount。
    //
    // ⚠️ **必须把第一个真实原因带出去**，不能只写一句「全部候选转存失败」的套话：
    //    `error_message` 是批管理 API **唯一**回给前端的通道（`markFailed` 会经
    //    `diagnosableErrorText` 消毒后落库），套话会让运维看不到「下载上游图片失败：403」
    //    这类真因。用文件里既有的 `diagnosableErrorText`，别新造诊断函数。
    await markFailed(job, new Error(
      `全部候选转存失败（首个原因：${firstFailure === null ? '未知' : diagnosableErrorText(firstFailure)}）`,
    ));
    return;
  }

  // ⚠️ **必须 `?? landed[0]`，不能只认 index 0。**
  //
  // 第 1 张转存失败时（上面 catch 的 failed.push(0)），landed 里没有 index 0，
  // 只有 1..N-1。若这里回退到 landed[0]（= 实际是 index 1）去回写业务表，
  // 而落库时只把 `i === 0` 标成 is_selected，就会出现：
  //
  //     业务表（nodes.image / products.cover_image / collectibles.image）指向第 2 张，
  //     而 design_assets 里这个 job **零行 is_selected = true**
  //
  // 后果是静默的且会往后传：子项目④（文创商品化）按「is_selected=true 的行即已被采纳的
  // IP 资产」取数，会**漏掉这张真实在用的图**；前端九宫格显示「没有选中项」。
  // 全程无报错。
  //
  // 所以：**先算出被采纳的 index，再用它同时驱动「标 is_selected」与「回写」。**
  //
  // ⚠️ 走 `selectCandidate`（不是就地 UPDATE 那一行）—— 它内部是「**先按 job_id 全量清、
  //    再单选置 true**」。只 UPDATE 本轮这一行会踩到重试路径上的唯一索引：
  //    第 1 次尝试把 index 0 置了 true → 之后回写/末尾 UPDATE 抛错 → 运维 `/retry`；
  //    第 2 次尝试若 index 0 转存失败，循环只重写 1..n，**index 0 那行仍是 true**，
  //    而这里再置 index 1 也 true ⇒ 两行 true ⇒ 撞
  //    `uq_wenlv_design_assets_selected` ⇒ job 卡死，且 error_message 报的是一条
  //    与真实原因无关的约束错误。全量清把上一轮的 true 一并清掉，这条链就不存在了。
  const selected = landed.find(l => l.index === 0) ?? landed[0];
  // `'machine'`：这一步是**调度器自己**挑的（`landed.find(index===0) ?? landed[0]`），
  // 没有任何人参与 ⇒ 不得写人工列族。写了的后果是本函数末尾那次 `shouldReview` →
  // `reviewAssetJob` 会被去重闸整个拦掉（`reviewSource === 'human'`），
  // 也就是**每一张刚生成的图的首轮评审从此不再发生**，且完全静默
  // —— 看守用例见 `run-once.db.test.ts`「图类 job 带锚图作参考图」。
  await selectCandidate(job.id, selected.index, 'machine');

  // 图类素材回写业务表引用列（spec §4.7「素材在资源库，业务表存引用 URL」的最后一跳）。
  //
  // 目标表/列由**注册表**给出（asset-types.ts 的 writeback），不再在这里写 if/else：
  // 原先的三个硬编码分支（background / cover / collectible）随着类型增加会变成第 4、5、6 个
  // 分支。而 `stamp` / `icon` 当年没有回写，**不是「漏写了一个分支」** —— 是它们的展开键
  // 被归错了维度（按节点展开，回写目标却是条目/档位），拿不到权威的 `target_id`，于是
  // **有意**不写（「与其猜错，不如不写」）。归回正确维度后它们各自拿到了权威键，现在
  // 与其余图类走同一条路径。详见 asset-types.ts 里 `scope` 字段的两条注释。
  //
  // 键是 `targetKind` + `targetId`（迁移 0033），取代 nodeId / collectibleId 的
  // 「一类型一列」。缺键时 `applyWriteback` 静默跳过 —— 缺键不构成任务失败
  //（素材已经生成并进了资源库，只是没找到写回目标）。
  //
  // **锚图也走这里**：注册表里 `anchor.writeback` 指向 products.styleAnchorUrl，
  // 与 cover 同表不同列，由 `applyWriteback` 按 column 分派。
  //
  // ⚠️ URL 与 assetId **必须同源**（都取自 `selected`）：一处用 `landed[0].ossUrl`、
  //    另一处用 `selected.assetId` 会在「第 1 张转存失败」时指向两张不同的图。
  const plan = buildWritebackPlan(job.assetType as JobAssetType, job.targetId, selected.ossUrl, selected.assetId);
  await applyWriteback(plan);

  await db.update(pmsBuiWenlvAssetJobs).set({
    status: 'succeeded',
    assetId: selected.assetId,
    // 部分转存失败的缺口写进 error_message：状态是 succeeded（素材有了），
    // 但缺口必须可见，否则「请求 4 张只得到 3 张」可以被静默吞掉一个月。
    errorMessage: failed.length ? `部分候选转存失败，缺 index=${failed.join(',')}` : null,
    finishedAt: new Date(), updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));

  // 生成成功后**再**入评价 —— 不同步挂在生成路径上：那会让每次生成慢一倍，
  // 且打分失败会连坐掉已经付过钱的生成。
  //
  // ⚠️ **传 `selected.index` 是刻意的策略，不是等价写法。** `shouldReview` 只对**传入的**
  //    `candidateIndex` 判 `!== 0` ⇒ 传它 = 「首轮只评 index 0（组内第一张）」。
  //    上面 `selected` 有回退路径（第 1 张转存失败 ⇒ 实际采纳的是 index N）：那条路径下
  //    本素材**不自动评**，由 Task 15 的 `/select`（用户改选时）或人工补评承接。
  //    （若这里写死 `0`，反而会去评那张回退采纳的图 —— 与「首轮只评组内第一张」的策略相反。）
  if (shouldReview({ candidateIndex: selected.index, isSelected: true, assetType: job.assetType })) {
    // 评审失败只记日志，**不**让本 job 变失败。
    // 措辞如实覆盖**两个失败面**：分数（design_assets UPDATE）或记账行（INSERT）都可能没落
    // —— 记账行撞列宽时分数已在、只丢账，别把它说成「评审失败」。
    reviewAssetJob(selected.assetId).catch(e =>
      console.warn(`[wenlv-asset-gen] 素材评审未完成（分数或记账可能未落）assetId=${selected.assetId}：`, diagnosableErrorText(e)));
  }
}

/** 旁白一条：TTS 同步返回 Buffer，一次做完。 */
async function generateNarrationJob(job: WenlvJobRow): Promise<void> {
  const text = buildTtsText({ storyText: job.sourceText });
  // npc 节点旁白用绑定 NPC 的特色音色（火山 voice_id → DashScope 映射）；
  // scene 节点或无绑定 NPC 时回落默认旁白声 longxing_v3（保持既有行为）。
  let voiceId: string | undefined;
  if (job.nodeId) {
    // 0079：节点即 scenes；scene.type==='npc' 等价旧 nodeType==='npc'。
    const [node] = await db.select({ type: pmsBuiWenlvScenes.type, npcId: pmsBuiWenlvScenes.npcId })
      .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, job.nodeId)).limit(1);
    if (node?.type === 'npc' && node.npcId) {
      const [npc] = await db.select({ voiceId: pmsBuiWenlvNpcs.voiceId })
        .from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, node.npcId)).limit(1);
      voiceId = mapNpcVoiceToDashScope(npc?.voiceId);
    }
  }
  // ⚠️ 记账放在 `onSynthesized` 里（= 合成刚返回、转存还没开始的那一刻），
  //    **不能**等 `synthesizeNarration` 整体返回再记：它内部还有一次 OSS 转存，
  //    转存抛错时函数根本不 return，记账语句永不执行 ⇒ 一笔已经花掉的 TTS 费
  //    从账面上消失（终审发现 1，2026-09-14 修）。图路径本来就是「provider 一返回
  //    就记、转存失败不抹掉」（见上面 generateImageJob），这里与它对齐。
  const r = await synthesizeNarration({
    text, jobId: job.id, voiceId,
    onSynthesized: async ({ charCount, provider, model }) => {
      await db.update(pmsBuiWenlvAssetJobs).set({
        prompt: text, provider, model,
        // model 是 resolveModel(voiceId) 的**实际**结果（qwen 克隆音色与 cosyvoice 走
        // 不同模型、单价也不同），故直接用回调给的它，而不是在记账处重读 BAILIAN_TTS_MODEL
        // —— 重读会在克隆音色那批 job 上把实际模型记错，而单价正是按模型查表的（NEW-08）。
        costAmount: sql`${pmsBuiWenlvAssetJobs.costAmount} + ${String(calcTtsCost(charCount, model))}::numeric`,
        updatedAt: new Date(),
      }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));
    },
  });

  try {
    const assetId = await writeAsset(job, r.url, { provider: r.provider, model: r.model });
    // 回写点位旁白 —— 与图同构：素材在资源库，点位存引用。
    // 用 **node_id** 精确定位：按标题匹配会在节点改名后静默写空、在重名时写错行，
    // 且两种失败都不会报错。
    // 旁白不走注册表的图类回写（它没有候选、没有评审），目标列显式给出。
    if (job.nodeId) await writeNarrationUrl(job.nodeId, r.url);
    await db.update(pmsBuiWenlvAssetJobs).set({
      status: 'succeeded', assetId, finishedAt: new Date(), updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));
  } catch (e) {
    await markFailed(job, e);   // 音频已合成，费用照记
  }
}

/**
 * AR 灵体视频生成（P2-C）。
 *
 * 与 generateNarrationJob 同族——不走图类的候选/评审/基线流程，直接调 provider 生成、
 * 质检、回写。差别在 provider（video-provider 文生视频）和质检（黑底检测）。
 *
 * 流程：
 *   1. 从 job.sourceText（节点剧情）+ job.name 拼提示词
 *   2. 调 Seedance 生成 5s 720p 16:9 视频（provider 内部强制黑底）
 *   3. checkBlackBackground 质检：黑底占比 < 70% 判失败（不回写、标记 failed）
 *   4. writeAsset 入素材库 → applyWriteback 回写 nodes.arAssetUrl → succeeded
 *
 * ⚠️ 质检失败必须 markFailed：不合格的视频若回写，前端 screen 混合后会有明显背景残留，
 *    体验崩坏。失败不回写业务表，但视频 URL 不入素材库（钱已花，费用照记）。
 */
async function generateArJob(job: WenlvJobRow): Promise<void> {
  const story = job.sourceText ?? '';
  // 提示词与独立路由一致：节点名 + 剧情摘要。provider 内部会追加「纯黑背景」硬约束。
  const prompt = `为「${job.name}」生成一个神秘的灵体形象，用于 AR 显影。${story ? `场景：${story.slice(0, 100)}` : ''}`;

  const provider = getVideoProvider();
  const gen = await provider.generate(prompt, { duration: 5, resolution: '720p', ratio: '16:9' });

  // provider 一返回就记 provider/model + 费用（calcVideoCost 按分辨率/时长/模型算 token × 单价）。
  const videoCost = calcVideoCost({ duration: 5, resolution: '720p', ratio: '16:9', model: gen.model });
  await db.update(pmsBuiWenlvAssetJobs).set({
    prompt, provider: gen.provider, model: gen.model,
    costAmount: sql`${pmsBuiWenlvAssetJobs.costAmount} + ${String(videoCost)}::numeric`,
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));

  // 黑底质检：不合格直接判 failed（不回写、不入素材库）
  const check = await checkBlackBackground(gen.url);
  if (!check.passed) {
    await markFailed(job, new Error(`AR 黑底质检未通过（黑底占比 ${(check.blackRatio * 100).toFixed(1)}% < 70%）`));
    return;
  }

  try {
    const assetId = await writeAsset(job, gen.url, { provider: gen.provider, model: gen.model });
    // 回写 nodes.arAssetUrl —— 走注册表的通用回写路径（buildWritebackPlan 读 ar 的 writeback 定义）。
    const plan = buildWritebackPlan(job.assetType as JobAssetType, job.targetId, gen.url, assetId);
    await applyWriteback(plan);
    await db.update(pmsBuiWenlvAssetJobs).set({
      status: 'succeeded', assetId, finishedAt: new Date(), updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvAssetJobs.id, job.id));
  } catch (e) {
    await markFailed(job, e);
  }
}

/** 逐条处理：**隔离在循环层**，一条抛错不影响本轮其余（见 runAssetGenOnce 的注释）。 */
async function runJobs(rows: WenlvJobRow[]): Promise<void> {
  for (const job of rows) {
    try {
      await runOne(job);
    } catch (e) {
      // 这里兜住的是 `runOne` 内部 catch **之外**的抛错 —— 只有 `markFailed` 自己抛
      // （DB 抖动 / 连接池耗尽）这一种。没有它，循环会中断，同轮已置 running 的其余行
      // 从未被处理，要等下一 tick 的 reclaimStale（≥15 分钟）才置 failed，
      // 而 error_message 写的是「超时未返回」—— 把「根本没跑」误诊成「上游超时」。
      console.error('[wenlv-asset-gen] job', job.id, '处理抛错（已隔离，不影响本轮其余）:', e);
      // **best-effort 补记一次 failed**：走到这里说明 `markFailed` 自己失败了，那一行的
      // status 仍是 running。不补这一次，`reclaimStale` 下一 tick 就会把它写成
      //「超时未返回（running 超过 15 分钟）」—— 把 DB 抖动误诊成上游超时，
      // 而真相只剩在上面那条可能已滚掉的日志里。误诊范围从「整轮 N 条」缩到「1 条」，
      // 补上这一次才算归零。
      // 二次失败必须**内层吞掉**：再抛一次就等于循环被中断，同轮其余已置 running 的行
      // 又回到「没人处理」的老问题。
      try {
        await markFailed(job, e);
      } catch (e2) {
        console.error('[wenlv-asset-gen] job', job.id, '兜底 markFailed 仍失败:', e2);
      }
    }
  }
}

/** 生成一条。内部 catch 负责把生成期失败写成 failed。 */
async function runOne(job: WenlvJobRow): Promise<void> {
  // ★ 续租：**在真正开始干活之前**把 `started_at` 刷成现在。
  //
  //   ⚠️ **别把这里读成「修了队尾被误杀」** —— 那条诊断实测**不成立**：本 tick 的
  //   `reclaimStale` 与在途生成**不可能并发**（本 tick 未 resolve 前下一个 tick 整个被
  //   `running` 守卫挡掉）。完整证据链写在 `claim.ts` 的 `renewLease` 文档注释里，改这里
  //   之前先读那一段。本调用是**前置于多副本 / 多入口形态**的补强；单实例下它近乎 no-op。
  //
  //   放在「这一刻」仍然是对的：它声明的是「这条 job 此刻还活着」，而 `claimNextJobs`
  //   写的 `started_at` 是**整批领取那一刻**的时间戳（一条 UPDATE 给整批同一时刻）。
  //
  //   **best-effort**：心跳写失败不能连坐任务本身 —— 为一次 DB 抖动把一条本来
  //   能跑完的生成判 failed，代价远大于一次心跳的收益。故只记日志、继续。
  //   ⚠️ 这一坨必须在**外层 `try` 之外**：放进外层 `try` 里，一次心跳失败会被下方那句
  //   `catch (e) { markFailed(job, e) }` 判成**任务失败**。
  try {
    await renewLease(job.id);
  } catch (e) {
    console.error('[wenlv-asset-gen] job', job.id, '续租失败（继续执行）:', e);
  }
  try {
    // ⚠️ `resolveBible` **只在非 narration 分支**调用。
    //    旁白只需要 `sourceText`（buildTtsText 根本不读风格基线），
    //    把它一起卡在基线前置校验上，会让「基线缺失」这一个原因把**旁白**也判 failed
    //    （且重试到 MAX_ATTEMPT 后永久失败），error_message 里写着
    //    「该任务没有风格基线」—— 一条与旁白毫不相干的诊断。
    if (job.assetType === 'narration') await generateNarrationJob(job);
    else if (job.assetType === 'ar') await generateArJob(job);
    else await generateImageJob(job, await resolveBible(job));
  } catch (e: any) {
    // ★ 原始业务原因**必须先落日志**，再尝试写库（Task 17 清单 A-3）。
    //   若 `markFailed` 自己抛（DB 抖动 / 连接池耗尽），异常会带着**它自己的**错误
    //   冒泡到 `runJobs` 的循环层兜底，那一层写进 error_message 的是 DB 错误，
    //   而**本条**业务原因从 DB 与日志**双双消失** —— 事后只能看到「DB 抖动」，
    //   永远查不出这行当初为什么失败。
    console.error('[wenlv-asset-gen] job', job.id, '生成失败:', e);
    await markFailed(job, e);
  }
}

/**
 * 资产生成总闸。**两把闸都判，任一为真即暂停。**
 *
 *   - env `WENLV_ASSET_GEN_PAUSED=1`：**每个 tick 现读**，不在模块顶冻结取值。
 *     收益是两条，别记错：
 *       1. **可测** —— `vi.stubEnv` 能直接驱动开关，不必为测试重新 import 模块；
 *       2. 模块顶 `const` 会把取值钉死在 import 那一刻，「进程活着但配置该变」这件事
 *          届时无解（只能重启）。
 *     （**不是**「缓存会让『改了 env 但没重启』与『重启了但 env 没生效』长得一样」——
 *      容器 env 不改就不变，缓存与现读在这两种故障下同样分不开。行为对，理由当时写错了。）
 *   - 内存开关：由 `POST /api/admin/wenlv-asset-gen/pause|resume` 控制。
 *     ⚠️ 路径是 `/api/admin/wenlv-asset-gen/...`（index.ts:288）；`/api/admin/wenlv`
 *     （index.ts:285）是**另一个** router，敲错就是 404 —— 而这三个端点全仓库零调用方，
 *     本注释是它们唯一的说明书。
 *
 * 内存开关**有意不做持久化**：持久化一个「暂停」会让下次重启后的调度器静默不干活，
 * 而「为什么不出图」届时没有任何线索 —— 那比不持久化危险得多。
 * 重启回到「未暂停」，此时以 env 为准。
 *
 * ⚠️ **单实例假设**：`pausedByAdmin` 是**各进程一份内存**。今天 compose 里 pms-server
 *   没有 `deploy.replicas`（单实例），所以不咬人；但那是「当前部署恰好单实例」，
 *   不是代码保证。多副本时 `/pause` 只停掉收到请求的那一个进程，其余照常烧钱 ——
 *   届时同样要走 DB claim（与 `acquire`/`hold` 的既有单实例假设同源，见
 *   routes/admin/wenlv-asset-gen.ts 文件头的「多副本部署下…」一段）。
 *
 * ⚠️ **这不是「急停」**：闸只在 `runAssetGenOnce` **开头**判一次，已经越过闸的那一 tick
 *   **会跑完**。锚图领取循环的墙钟预算是 `ANCHOR_BUDGET_MS = 5 分钟`（本文件 :58），
 *   所以最坏情况下「发完 /pause」到「真正不再花钱」之间有**分钟级**延迟。
 *   要立刻止血只有停容器 —— 本闸的定位是「不用停容器就能让下一 tick 起不再开工」，
 *   不是「按下即断」。对正在烧钱的人这个差别是要命信息，故写在这里。
 *
 * 为什么需要一个总闸：本调度器**没有别人能停**。`startWenlvAssetGenScheduler` 被
 * `server.ts` 无条件调用，唯一的重入守卫是 `running`（防同一 tick 叠加，不防「要不要跑」）。
 * 一旦它开始烧钱或卡住，此前唯一的手段是停容器 —— 那会连带停掉整个 pms-server。
 *
 * 生效面：`runAssetGenOnce` 的整个函数体（含 reclaimStale），以及
 * routes/admin/wenlv-asset-gen.ts 的**四个花钱端点**（/batch、/retry、/iterate、
 * /style-bible/bootstrap）各自的前置闸 —— 端点侧是**另一道**独立判闸，不经这里。
 */
let pausedByAdmin = false;

export function isAssetGenPaused(): boolean {
  if (pausedByAdmin) return true;
  return (process.env.WENLV_ASSET_GEN_PAUSED ?? '').trim() === '1';
}

export function setAssetGenPaused(paused: boolean): void {
  pausedByAdmin = paused;
}

/** 单次 tick。导出供测试直接驱动，不必等 60s。 */
export async function runAssetGenOnce(): Promise<void> {
  // 总闸放在最前，**必须早于 reclaimStale**：先 reclaim 会把超时任务打回队列，
  // 暂停期间反复 reclaim 只是无意义的写放大，而且会让「暂停了但库还在动」这件事
  // 在日志里长得像「调度器还在工作」。
  if (isAssetGenPaused()) return;

  // 1. 超时收口（必须在领取之前）
  const reclaimed = await reclaimStale(STALE_MINUTES);
  // 返回值原先被丢弃：上游故障让一批行静默超时时，日志里零信号（tick 照常）。
  if (reclaimed) console.warn('[wenlv-asset-gen] 超时收口', reclaimed, '条');

  // 2. **先领锚图**：它是同批其余素材的参考图，必须先就绪（spec §4.7）。
  //
  //    必须是**循环领到空**，不能只领一轮：一轮只拿走 CLAIM_LIMIT(3) 条锚图，
  //    第 4 个及以后的锚图留在 pending；第 3 步的无类型过滤领取按 created_at 排序
  //    （整批 INSERT 时间戳相同 → PG 行序不确定）可能先拿到那个产品的 image job，
  //    而它的锚图还没回写 → 抛「该剧本还没有风格锚图」→ **落 failed**。
  //    而领取只认 pending，failed 不会被自动重领 —— 需人工逐条重试，
  //    讽刺的是同一 tick 稍后它的锚图就成功了。
  //    防空靠墙钟预算 ANCHOR_BUDGET_MS（理由见常量注释）+ 轮数兜底 MAX_ANCHOR_ROUNDS。
  //
  //    ⚠️ **两种到界都必须 `return`，绝不能 `break`。** `break` 只是跳到第 3 步，
  //    而此刻**本轮尚未回写锚图**的产品的 image job 仍在 pending —— 第 3 步（无类型过滤）
  //    会立刻把它们领走 → 抛「该剧本还没有风格锚图」→ 落 failed，
  //    而领取只认 pending，failed 不会被自动重领 ⇒ 这些产品的图被**永久判死**。
  //    真实的后果**不是**「剩余锚图推迟一 tick、等一等就好」，而是这些图从此再也出不来。
  //    `return` 才是把第 3 步一并推迟到下一 tick 的正确姿势。
  const anchorStartedAt = Date.now();
  for (let round = 0; ; round++) {
    if (round >= MAX_ANCHOR_ROUNDS) {
      console.warn('[wenlv-asset-gen] 锚图领取达到', MAX_ANCHOR_ROUNDS,
        '轮兜底上界，本轮到此为止（第 3 步一并推迟；若在此再领其余图，其锚图未就绪会被永久判死）');
      return;
    }
    if (Date.now() - anchorStartedAt >= ANCHOR_BUDGET_MS) {
      console.warn('[wenlv-asset-gen] 锚图领取用满', ANCHOR_BUDGET_MS,
        'ms 墙钟预算，本轮到此为止（第 3 步一并推迟；若在此再领其余图，其锚图未就绪会被永久判死）');
      return;
    }
    const anchors = await claimNextJobs(CLAIM_LIMIT, { assetTypes: ['anchor'] }) as unknown as WenlvJobRow[];
    if (anchors.length === 0) break;
    await runJobs(anchors);
  }

  // 3. 再领其余。走到这里锚图已经回写，图类任务才拿得到参考图。
  //
  //    ⚠️ **`requireAnchorReady` 是这一步的必需前置条件，不是可选的优化。**
  //    上面那个 `break` 把两种情况混为一谈：
  //      ① 锚图全部 succeeded 并回写（安全 —— 正是要等的那一刻）；
  //      ② 某个产品的锚图**已经 failed**（不是「还没回写」，是**永远不会回写**）。
  //    情况 ② 下第 2 步同样立刻空转退出（`anchors.length === 0`），第 3 步照常执行 ——
  //    没有任何上界拦得住它，于是那个产品尚未生成的图类 job 被领走 →
  //    `generateImageJob` 抛「该剧本还没有风格锚图」→ 也变 failed，而领取只认 `pending`
  //    ⇒ 那些素材被**永久判死**，只能人工 /retry。
  //    触发条件是**任何**一次锚图失败（LLM/文生图/OSS 报错，或停机后被我上面的
  //    `reclaimStale` 收回）—— 这是真实故障，不是测试构造。见 claim.ts 上该参数的注释。
  await runJobs(await claimNextJobs(CLAIM_LIMIT, { requireAnchorReady: true }) as unknown as WenlvJobRow[]);
}

/** 启动轮询器（server.ts 调用一次）。 */
export function startWenlvAssetGenScheduler(): void {
  let running = false;   // 重入守卫：上一次未跑完则跳过本次 tick
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runAssetGenOnce();
    } catch (err) {
      console.error('[wenlv-asset-gen] 扫描失败:', err);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL_MS);
  console.log('[wenlv-asset-gen] 已启动（每 60s 推进素材生成任务）');
}
