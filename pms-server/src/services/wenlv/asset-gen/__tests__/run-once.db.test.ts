import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
// ⚠️ 路径深度：`db` 在 `src/db/`，从本文件回到 `src/` 要**四层**
// （__tests__ → asset-gen → wenlv → services → src）。
// 写成三层会解析到 `src/services/db/index.js` —— **那个目录不存在**，整个文件加载失败。
// 可对照同目录既有的 `prompt-builder.test.ts:3`（同样四层）。
import { db } from '../../../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvProducts, pmsBuiWenlvScenes, pmsBuiWenlvChapters,
  pmsBuiWenlvScriptRooms, pmsBuiWenlvDesignAssets,
  pmsBuiWenlvVenuePoints, pmsBuiWenlvCollectibles, pmsBuiWenlvCharacters,
} from '../../../../db/schema/index.js';
// 下面两条**只有三层**是对的 —— 目标是 `src/services/` 下的文件
// （__tests__ → asset-gen → wenlv → services）。**别照抄成四层**。
// `'../../../wenlv-asset-gen-scheduler.js'` → `src/services/wenlv-asset-gen-scheduler.js`。
// 同文件里的 `vi.mock('../../../aliyun/oss.js')` 也是三层，指向 `src/services/aliyun/oss.ts`，
// 与实现侧 import 的是同一个模块（mock 才会生效）。
// `bootstrapStyleBible` 不在 runAssetGenOnce 的路径上（基线为空时 resolveBible 直接抛，
// 走不到自举），所以只能直接调它来断言它喂给 LLM 的 user 消息 —— 为此它被导出。
// `generateImageJob` 同理：第 3 步的领取前置条件（`requireAnchorReady`）现在把
// 「产品无锚图」的行挡在门外 ⇒ 生成期那句守卫再也无法经 `runAssetGenOnce` 到达，
// 只能直接驱动它来钉住（见下面的守卫用例）。
import {
  runAssetGenOnce, bootstrapStyleBible, generateImageJob, setAssetGenPaused,
} from '../../../wenlv-asset-gen-scheduler.js';
// 只读引用 Task 8 的领取函数 —— 缺陷 3 的具名断言直接钉在它的**返回行**上。
import { claimNextJobs } from '../claim.js';
// 计费期望值一律**引用真实函数**，不手抄常量：手抄的数会随默认价调整而漂移，
// 而漂移后的断言仍然"绿"——正是本子项目最怕的静默错。路径是**两层**
//（__tests__ → asset-gen），与 claim.js 同层。
import { calcImageCost, calcPromptCost } from '../pricing.js';
import { ASSET_TYPES, type JobAssetType } from '../asset-types.js';

// 两个外部依赖必须打桩，否则这条「全链路」在无凭据环境里根本跑不起来：
//   · `uploadToOSS` 没有 ALIYUN_ACCESS_KEY_ID/SECRET 会**直接抛**
//   · MockImageProvider 给的是 `https://placeholder.local/...` 占位 URL，
//     `fetch` 它必然 DNS 失败（真实链路里这张图也确实要下载再转存）
// 注意：mock provider **不等于**跳过转存 —— 调度器照样会下载 + 上传，
// 所以「不设 WENLV_IMAGE_PROVIDER 就无 key 可跑」是不成立的。
vi.mock('../../../aliyun/oss.js', () => ({
  uploadToOSS: vi.fn(async (_buf: Buffer, key: string) => `https://oss.test/${key}`),
}));
vi.mock('../../../aliyun/voice.js', () => ({
  synthesizeSpeech: vi.fn(async (text: string) => Buffer.from(`audio:${text}`)),
}));

const run = !!process.env.RUN_DB;
const B = `sched-test-${Date.now()}`;
const P = `sched-prod-${Date.now()}`;
// 第二个产品：**没有风格基线**。专门用来钉「旁白不该被基线缺失连坐」（缺陷 2）。
// 必须是独立产品行 —— 改 P 的 style_bible 会污染其它用例的前置状态。
const P2 = `sched-prod-nobible-${Date.now()}`;
const N = `sched-node-${Date.now()}`;   // 真实点位行 —— 旁白要写回它
const BIBLE = { artStyle: '水墨', forbidden: ['现代物件'] };
// scenes 需要 chapterId ⇒ 为 P 建一房一章
const ROOM_P = `room-${P}`;
const CH_P = `ch-${P}`;

// ---- 独立自举风格基线（I1）用的三件套：产品 / 场地 / 场地上的点位 ----
const P3 = `sched-prod-bible-${Date.now()}`;
const V3 = `sched-venue-${Date.now()}`;
const VP3 = `sched-vp-${Date.now()}`;
const N3 = `sched-node3-${Date.now()}`;
const ROOM_P3 = `room-${P3}`;
const CH_P3 = `ch-${P3}`;
const VP3_NAME = '古井·真名';     // 权威源里的名字
// 同场地里的**另一个**点位：只在第 3 级兜底（「该场地全部点位」）里才会出现。
// 有了它，「名字来自 venuePointId 指向的那一个点位」才钉得住 —— 没有它时，把 pointIds
// 那一级整个关掉、names 落到第 3 级，也会因为包含同一个 VP3_NAME 而全绿（恒真）。
const VP3_OTHER = `sched-vp-other-${Date.now()}`;
const VP3_OTHER_NAME = '戏台·陪跑';
// ---- 锚图领取循环（I3）用：4 个产品各有锚图 + 图类 job ----
const P4 = ['a', 'b', 'c', 'd'].map(k => `sched-prod-anchor-${k}-${Date.now()}`);
// ---- 锚图**上界命中**（New-1）用：PX 挂 61 条锚图逼出轮数上界；PY 没有任何锚图，
//      它那条图类任务 created_at 最老 —— 若上界命中后只 break，第 3 步必先领到它。----
const PX = `sched-prod-ub-${Date.now()}`;   // 61 条锚图的宿主
const PY = `sched-prod-ub-noanchor-${Date.now()}`;   // 没有锚图，图任务一旦被领必然 failed

describe.skipIf(!run)('runAssetGenOnce 全链路（mock provider）', () => {
  // LLM（画面描述）与「下载占位图」都走 fetch，按 URL 分流。
  //
  // **回显 user 消息**，而不是返回常量。常量桩下 `scene` 与节点标题无关，
  // `buildImagePrompt` 的产物里根本不会出现标题 —— 「提示词里用的是真节点标题还是
  // job.name」这件事就永远断言不到（恒绿）。回显之后 `r.prompt` 里含 `素材：<标题>（…）`。
  // （`buildScenePrompt` 用 TYPE_LABEL 渲染成中文「背景」，不会渲染出英文 `background`，
  //   所以 `·background` 断言只可能被 `job.name` 触发。）
  //
  // 定为具名函数而非内联 lambda：需要定向故障注入的用例（I2）会在 `mockImplementation`
  // 里包一层，再在 finally 里还原成它。
  const echoFetch = async (url: string, init?: any) => {
    if (String(url).includes('dashscope')) {
      const body = JSON.parse(init.body);
      const user = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
      // 自举基线的调用要回一段**合法 JSON**（parseStyleBible 解析失败会抛），
      // 其余回显 user 消息 —— 这样「提示词里到底喂了哪些字」才断言得到。
      const isBible = typeof user === 'string' && user.includes('画风规范 JSON');
      // ★ 视觉（评审）调用的 user content 是 parts **数组**：把它原样回显，`content` 就成了数组，
      //   `dashscope.ts` 的字符串检查随即抛错 ⇒ 评审在本文件里**每次**都在 mock 上失败
      //   （调用点是 fire-and-forget，只打一条 warn），于是 `reviewAssetJob` 的**两条 DB 语句恒不可达**。
      //   这里必须回一段**合法**的评审 JSON：`parseReview` 对 score 非数、fix_guidance 非字符串都抛，
      //   且 `null`/`""`/`[]` 会被「先验类型」拒掉 —— 回显策略在这里不成立。
      const isVision = Array.isArray(user);
      const content = isBible ? JSON.stringify({ artStyle: '水墨', mustHave: ['古井'] })
        : isVision ? JSON.stringify({ score: 7, dimensions: [], issues: [], fix_guidance: '' })
          : user;
      // ★ `usage` 是本文件计费链路的**必要夹具**：`callLlm` 从 `data.usage` 取 token 数，
      //   缺了它就走「warn + 记 0」分支，于是「cost_amount 等于期望值」那条断言会退化成
      //   0 == 0 —— 一个永远绿的假判据。这两个数与真实 DashScope 响应同形状
      //（`prompt_tokens` / `completion_tokens`），不是随手编的占位。
      //   真实上游**一定**带这一段，所以桩带上它才是「与生产同构」。
      const payload = {
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1200, completion_tokens: 800 },
      };
      // `text()` 必须一起给：callLlm 现在先取原始文本再 parse（I2），
      // 桩上缺 `text` 会抛 TypeError，报错还长得像业务 bug。
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as any;
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) } as any;
  };
  // ⚠️ 定向故障注入**不能**用 `mockImplementationOnce`：领取是全库语义，
  //    任何一条残留的 pending 行都会先消费掉那个「一次」。
  let baseFetch: any;

  /**
   * 「生成路径的 LLM 调用」计数 —— 只数 `callLlm`（文本，`promptModel()`）。
   *
   * `reviewAssetJob`（Task 14）在生成成功后**异步**发起，是**另一次**付费调用，
   * 与「重试有没有重算 prompt」这条判据无关。若把视觉调用也算进来，计数会随
   * 异步时序抖动（评审可能在两次断言之间落地）——「重试逐字复用 prompt」用例
   * 就会随机变红。
   *
   * ⚠️ 用 `body.model` **精确比对**生成模型，**不**用「排除评审模型名」这种写法：
   *    后者依赖 `WENLV_REVIEW_MODEL ≠ WENLV_PROMPT_MODEL` 这条**隐式前提**
   *    （两者同值时计数恒 0 ⇒「重试没有再调 LLM」那条守卫**静默变绿**），
   *    且 `includes()` 是对整个 body 的**子串**匹配 —— 生成提示词正文里恰好含
   *    `qwen-vl-max` 也会被误滤（失效方向还不统一：有的用例假红、有的假绿）。
   */
  const promptModel = () => process.env.WENLV_PROMPT_MODEL || 'qwen-max';
  const llmCalls = () => baseFetch.mock.calls
    .filter((c: any) => String(c[0]).includes('dashscope'))
    .filter((c: any) => {
      try { return JSON.parse(c[1]?.body ?? '{}')?.model === promptModel(); } catch { return false; }
    }).length;

  beforeAll(async () => {
    delete process.env.WENLV_IMAGE_PROVIDER;      // 显式走 mock，无需真 key
    process.env.WENLV_IMAGE_UNIT_PRICE = '0.5';   // mock 默认不计费，这里显式定价以验证记账链路
    // ⚠️ 熔断闸门必须**与抬高的单价一起抬高**。本文件的单价是被**刻意**抬到 ¥0.5 的
    //    （mock 默认 ¥0，抬价只为让记账链路有个非零的数可验）。而 `claimNextJobs` 的
    //    批次熔断按 `SUM(cost_amount)` 判定，**无条件**生效（见 claim.ts 的 budgetFilter）——
    //    抬高的单价于是**反过来误触熔断**：New-1 在同一个批次 B 里种 61 条锚图，
    //    每张**恰好**记 ¥0.5（锚图不调 LLM —— 调度器里 `isAnchor` 走 `buildAnchorPrompt`
    //    的模板分支，`llm` 恒为 null ⇒ `calcPromptCost(0, 0) = 0`，只有图片费）；
    //    13 轮 39 张 = ¥19.5 < ¥20 ⇒ 第 14 轮照领；14 轮 42 张 = ¥21 ≥ ¥20
    //    ⇒ 第 15 轮领空退出。于是**那条「60 张成」的上界断言**只剩 42 —— 而这不是
    //    产品行为，是夹具自造的假碰撞。（同用例里的 `-ub-img` 留 pending 那条**与熔断无关**，
    //    它是被 `anchorReadyFilter` 挡下的，不受这里影响。）
    //    ⇒ 熔断本身的看守**在别处**：`batch-budget.test.ts`（纯函数 4 条）+
    //      `claim.db.test.ts` 的 DB 用例（超预算批次不领 / 对照批次照领）。
    //      **本文件不做熔断判据**，这里只需让夹具不误触闸门。1000 ≫ 本文件任何夹具的花费。
    process.env.WENLV_BATCH_BUDGET_YUAN = '1000';
    // ⚠️ 计划漏了这一条：调度器的 `callLlm` 在读不到 DASHSCOPE_API_KEY 时**直接抛**
    //    （「未配置 DASHSCOPE_API_KEY，无法生成提示词」），而 vitest 不会把 .env
    //    注进 process.env。不设的话所有图类用例都会 failed，且报错看起来像业务 bug。
    //    这里给的是**假 key** —— fetch 已被打桩，不会真的发出去。
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
    baseFetch = vi.fn(echoFetch);
    vi.stubGlobal('fetch', baseFetch);
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: '调度器测试剧本', styleBible: BIBLE, styleAnchorUrl: null,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({
      id: ROOM_P, contentId: P, name: '调度房', mode: 'narrative',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({
      id: CH_P, scriptRoomId: ROOM_P, title: '第一章', order: 0,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScenes).values({
      id: N, chapterId: CH_P, title: '古井', content: '井水很凉。', type: 'narrative',
    }).onConflictDoNothing();

    // I1 的前置：产品 + 场地 + 场地上的点位；节点挂 venuePointId 且 **location 留 NULL**
    //（正是 S2 采风产生的新节点的真实形状）。
    await db.insert(pmsBuiWenlvProducts).values({
      id: P3, name: '自举基线剧本', styleBible: null, venueId: V3,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({
      id: ROOM_P3, contentId: P3, name: '自举房', mode: 'narrative',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({
      id: CH_P3, scriptRoomId: ROOM_P3, title: '第一章', order: 0,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: VP3, venueId: V3, name: VP3_NAME,
    }).onConflictDoNothing();
    // 同一场地的第二个点位 —— 只为钉住「权威层级」而存在（见 VP3_OTHER 常量注释）
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: VP3_OTHER, venueId: V3, name: VP3_OTHER_NAME,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScenes).values({
      id: N3, chapterId: CH_P3, title: '古井节点', venuePointId: VP3, type: 'narrative',
    }).onConflictDoNothing();
    // I3 的前置：4 个产品，锚图与参考图都由测试自己种
    for (const pid of P4) {
      await db.insert(pmsBuiWenlvProducts).values({
        id: pid, name: '锚图循环剧本', styleBible: BIBLE, styleAnchorUrl: null,
      }).onConflictDoNothing();
    }
  });
  afterAll(async () => {
    delete process.env.WENLV_IMAGE_UNIT_PRICE;
    delete process.env.WENLV_BATCH_BUDGET_YUAN;   // 与 beforeAll 的抬高对称还原
    delete process.env.DASHSCOPE_API_KEY;
    vi.unstubAllGlobals();
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    // 评审记账行（Task 14）也要清：id = `review:wa-<jobId>`、batchId = `review:<productId>`，
    // 两条既有清理都匹配不到。fire-and-forget 的写入可能落在本钩子之后 ⇒ 单独一条 like
    // 前缀清理；下一次运行的 beforeEach 会把漏网的再清一次。
    await db.delete(pmsBuiWenlvAssetJobs)
      .where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-%`));
    // 落库的素材也要清 —— 调度器真的往 design_assets 写了行（id = `wa-${jobId}`）。
    // 不清的话每跑一次测试就积一批孤儿素材，而资源库列表类用例会读到它们。
    await db.delete(pmsBuiWenlvDesignAssets)
      .where(like(pmsBuiWenlvDesignAssets.id, `wa-${B}-%`));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N3));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_P));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_P3));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P3));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, VP3));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, VP3_OTHER));
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P2));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P3));
    for (const pid of P4) {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, pid));
    }
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PX));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PY));
  });

  // ★ 每个用例**从干净的 job 表开始**（只清本文件的批次 B，产品/节点等共享夹具不动）。
  //
  // 此前这里只有 `beforeAll` 清一次 —— 于是同一文件里的用例会**互相领走对方的 pending 行**，
  // 因为 `claimNextJobs` 是**全表语义**（`status='pending' … FOR UPDATE SKIP LOCKED`），
  // 不认「这行是本用例种的吗」。最干净的证据是 New-1 那条：它**故意**把 `-ub-img` 留在
  // `pending`（说好推迟到下一 tick），而下一个用例的 tick 立刻把它领走并判 failed ⇒
  // `injected` / `mine.length` 这类**计数**断言随之漂移。
  // 实测：`--sequence.shuffle --sequence.seed=9` 下 iso 用例的 tick 领到
  // `[ub-img, iso1, iso2]`（前一条用例的遗留），`expect(injected).toBe(2)` 得到 3。
  //
  // 这也是本文件历史上那些「单跑绿、连跑红」的**共同机制**：不是生产代码有病，
  // 是用例之间没有隔离。加这一条后该文件应当对执行顺序不敏感。
  beforeEach(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    // Task 14 起生成成功会 fire-and-forget 一条评审记账行：`id = review:<assetId>`、
    // `batchId = review:<productId>` —— **两条既有清理都匹配不到它**（前者按 batchId=B、
    // 后者按 design_assets 的 id）。不清就是每跑一次积一批孤儿行。
    await db.delete(pmsBuiWenlvAssetJobs)
      .where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-%`));
    await db.delete(pmsBuiWenlvDesignAssets)
      .where(like(pmsBuiWenlvDesignAssets.id, `wa-${B}-%`));
  });

  const seed = (
    id: string, assetType: string, name: string,
    extra: Record<string, unknown> = {},
  ) => {
    const scope = ASSET_TYPES[assetType as JobAssetType]?.scope;
    const productId = (extra.productId as string | undefined) ?? P;
    const targetId = scope === 'product' ? productId
      : scope === 'node' ? ((extra.nodeId as string | undefined) ?? null)
        : scope === 'collectible' ? ((extra.collectibleId as string | undefined) ?? null)
          : null;
    return db.insert(pmsBuiWenlvAssetJobs).values({
      id, batchId: B, productId, assetType, name,
      targetKind: scope ?? null, targetId,
      // `prompt` 默认 **null**：非空 prompt 意味着「这一行已经现算过」，领取时会**逐字复用**
      // 而不再调 LLM（spec §7.2 重试不改 prompt）。要断言 LLM 现算路径的用例必须让它是空的，
      // 否则断言的是种子值而不是实现产出的值（恒绿）。需要它的用例显式传入。
      prompt: null, styleBibleSnapshot: BIBLE,
      // attempt=2：领取后变 3，首次失败 3<2 假 → 直接 failed。
      // 与 P2 自动重试逻辑（attempt<2 时重试）对齐，让既有断言「首次失败→failed」仍成立。
      status: 'pending', attempt: 2, costAmount: '0', ...extra,
    });
  };

  const rowOf = async (id: string) => {
    const [r] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, id)).limit(1);
    return r;
  };

  /** 评审记账行（Task 14）：`reviewAssetJob` 写 `id = review:<assetId>`。 */
  const rowOfReview = async (assetId: string) => {
    const [r] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, `review:${assetId}`)).limit(1);
    return r;
  };

  it('锚图先出，并回写 products.style_anchor_url', async () => {
    await seed(`${B}-anchor`, 'anchor', '风格定调图');
    await runAssetGenOnce();
    const [p] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(p.styleAnchorUrl).toBeTruthy();
    expect(p.styleAnchorUrl).toContain('oss.test');   // 转存后的地址，不是上游 URL
    const r = await rowOf(`${B}-anchor`);
    expect(r.status).toBe('succeeded');
    expect(r.assetId).toBeTruthy();          // 锚图也进资源库
  });

  it('图类 job 带锚图作参考图，生成成功并记账', async () => {
    // **自足**：本用例需要的「产品 P 已有锚图」由自己写入，**不**依赖同 describe 里
    // `锚图先出，并回写 products.style_anchor_url` 那条的副作用 —— `beforeEach` 只把
    // P 的 styleAnchorUrl 置回 null，锚图是那条用例跑出来的。此前是**隐式的用例间顺序依赖**：
    // 声明序下恰好绿，`--sequence.shuffle` 打乱后若本用例先跑，就会
    // `expected 'failed' to be 'succeeded'`（约 40% 复现，见计划清单 C-1）。
    // 兄弟用例仍独立断言「锚图回写 style_anchor_url」这个行为本身，覆盖不丢。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    await seed(`${B}-bg`, 'background', '入镇·background', { sourceText: '你走进古镇。' });
    await runAssetGenOnce();
    const r = await rowOf(`${B}-bg`);
    expect(r.status).toBe('succeeded');
    expect(r.assetId).toBeTruthy();
    // 图片费（`WENLV_IMAGE_UNIT_PRICE` = 0.5 生效）**加**本次文本 LLM 的分价费。
    // 后者自 2026-09-18 起才进账（此前注释写着「不计入 cost_amount」），本用例随之把期望值
    // 从裸 0.5 改成「两张表都算」—— **不是放宽**：漏掉 LLM 那一项照样红。
    expect(Number(r.costAmount)).toBe(Number(
      (calcImageCost(1, 'mock') + calcPromptCost(1200, 800)).toFixed(4),
    ));
    expect(r.finishedAt).not.toBeNull();
    expect(r.prompt).toContain('【画面】');   // 基线确实拼进了提示词（防漂移的落点）

    // ★ 调用点接线的**正向**看守（F1-d 的另一半）：评审是 fire-and-forget（不返回 promise），
    //   只能轮询等它落地。缺了它，「调用点整段被删」/「mock 又回显成数组」都**全绿**。
    //   这一条与下面「部分成功」用例的负断言互补：正向证「该评的评了」，负向证「不该评的没评」。
    await vi.waitFor(async () => {
      expect(await rowOfReview(`wa-${B}-bg`)).toBeTruthy();
    });
  });

  it('评审失败不得完全无声：调度器调用点留一条含 `assetId=` 的 warn，且**不连坐**生成', async () => {
    // ⚠️ 这条看守 2026-09-20 从 `routes/admin/__tests__/wenlv-asset-gen.test.ts` 的 I-1
    //    **搬到这里**。原因：T13 §2 的扩闸（`reviewSource === 'human'` 也 return）之后，
    //    `/select` 的补评调用点**不可达** —— `selectCandidate` 刚把那一行写成 human，
    //    闸就在收口点返回了 ⇒ 那条用例的「视觉调用失败」这个失败面**已经不存在**。
    //    而「评审失败不得完全无声」这个**性质**没死：它只剩**一个**活着的调用点，
    //    就是本文件收尾段那次 fire-and-forget 评审。故看守随性质搬到这里。
    //    `reviewAssetJob` 内部没有 try/catch（`callLlmVision` / `parseReview` 也不自我记
    //    日志）⇒ 调用点那条 `.catch` 一旦写成 `.catch(() => {})`，
    //    「这张图**永远**没有分数」在生产上**完全无声**，没人能发现。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-revwarn`;
    await seed(id, 'background', '评审失败素材', { sourceText: '你走进古镇。' });

    // 只让**视觉（评审）**那一步失败，其余照旧走 `echoFetch`：
    // 评审调用的 user content 是 parts **数组**（这正是本文件头部那段注释的核心区分），
    // 据此精确命中它，不去破坏图片下载 / 画面描述 LLM 那两条链路。
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('dashscope')) {
        const user = JSON.parse(init.body).messages.find((m: any) => m.role === 'user')?.content;
        if (Array.isArray(user)) return { ok: false, status: 500, text: async () => 'boom' } as any;
      }
      return echoFetch(url, init);
    });
    const realWarn = console.warn;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      await runAssetGenOnce();

      // 生成本身**不受影响**（评审失败只让这张没分，刻意不连坐生成 —— 钱已经花过了）。
      const r = await rowOf(id);
      expect(r.status).toBe('succeeded');
      expect(r.assetId).toBeTruthy();

      // 评审是 fire-and-forget ⇒ warn 晚于 `runAssetGenOnce` 返回，必须等。
      await vi.waitFor(() => {
        expect(warns.some(a =>
          a.some(x => typeof x === 'string' && x.includes(`assetId=wa-${B}-revwarn`)))).toBe(true);
      });
      // 记账行**没落**（评审在第一跳就失败了）—— 顺带钉住「分数与记账是两条语句，
      // 失败面覆盖两者」，别把这条 warn 误读成「只有记账没落」。
      const revRows = await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
        .where(eq(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-revwarn`));
      expect(revRows).toHaveLength(0);
    } finally {
      console.warn = realWarn;
      baseFetch.mockImplementation(echoFetch);
    }
  });

  it('多候选：N 张落 N 行、恰好一行 selected、回写同源、按**实际张数**计费', async () => {
    // 这条是 Task 10 头号主张（N 行落库 / 按实际张数计费 / 回写同源）的**唯一**看守。
    // 变异证明（本轮实跑）：把 scheduler 的 `calcImageCost(r.urls.length, …)` 就地改成
    // `calcImageCost(1, …)` ⇒ 本用例红在 cost 那条断言（见本轮修复报告）。
    //
    // ⚠️ 关键在 `candidateCount: 3`：本文件其余用例**从不设它**，于是全走 DB 默认 1，
    //    MockImageProvider 只回 1 张 URL，多候选分支**永远走不到** —— 这正是它此前
    //    「202 行重写、零咬合力」的根因。`provider` 侧的 mock 用 `opts.candidates ?? 1`
    //    决定返回几张，所以这一步是整条路径的开关。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-multi`;
    // background 是节点级 ⇒ targetId = nodeId = N ⇒ 回写 nodes.image，正好当「同源」的落点。
    await seed(id, 'background', '多候选·background', {
      nodeId: N, sourceText: '你走进古镇。', candidateCount: 3,
    });
    await runAssetGenOnce();

    // a) N 张落 N 行，candidate_index 恰为 0/1/2。
    const rows = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.jobId, id));
    expect(rows.length).toBe(3);
    expect(rows.map(x => x.candidateIndex).sort()).toEqual([0, 1, 2]);

    // b) 恰好一行 is_selected = true（「零行 selected」也算不变量被破坏）。
    const selectedRows = rows.filter(x => x.isSelected);
    expect(selectedRows.length).toBe(1);

    // c) 业务表回写的 URL == 那行 selected 的 URL（**同源**；不同源会在
    //    「第 1 张转存失败」时指向两张不同的图）。
    const [node] = await db.select().from(pmsBuiWenlvScenes)
      .where(eq(pmsBuiWenlvScenes.id, N)).limit(1);
    expect(node.image).toBe(selectedRows[0].url);

    // d) cost == **实际张数** × 单价（+ 本次文本 LLM 分价费）。
    //    ⚠️ 单价从 pricing.ts 取，别写死数字 —— 写死会随调价腐烂。
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    expect(Number(r.costAmount)).toBe(Number(
      (calcImageCost(3, 'mock') + calcPromptCost(1200, 800)).toFixed(4),
    ));
  });

  it('部分成功：第 1 张转存失败不整批失败，且被采纳的是**实际落库的那一张**', async () => {
    // 这条守的是计划 Task 10 Step 5 第 4 点那句**不变量**：
    //   一次生成落库完成后，该 job 恰好一行 is_selected = true，且业务表那个 URL 就是它。
    //
    // 上一条多候选用例三张**全部成功**，`landed.find(index===0)` 必然命中 ⇒
    // **`?? landed[0]` 回退分支一次都没执行**（删掉它照样全绿）。本用例专打那条分支：
    // 让 index 0 的下载失败，于是 landed 只有 [1,2]，唯一能选出「被采纳的那一张」的
    // 就是回退。回退失守的后果是静默且跨子项目的（计划 :556-564）：业务表指向第 2 张、
    // 而 design_assets 里该 job **零行 is_selected=true** ⇒ 子项目④按 is_selected 取 IP
    // 资产时漏掉这张真实在用的图，全程无报错。
    //
    // 变异证明（本轮实跑）：只删掉 `?? landed[0]`，本用例**必红**。
    // ⚠️ 它红在**断言 (a)**（`r.status` 是 `failed` 而非 `succeeded`）——**不是**下面那条
    //    「恰好一行 selected」。链路是：`find` 返回 `undefined` ⇒ 读 `selected.assetId` 抛错
    //    ⇒ 整条 job 判 failed，于是根本走不到 (b)–(e)。**别把红点记成 (b)**。
    //    删掉整个部分成功分支（`catch` 直接 `throw`）同样红在 (a)。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-partial`;
    await seed(id, 'background', '部分成功·background', {
      nodeId: N, sourceText: '你走进古镇。', candidateCount: 3,
    });
    // 定向注入：**只**让第 0 张候选的下载失败。按 URL 里的 `&cand=0` 精确命中，
    // 不用「第一次调用就失败」的计数式 —— dashscope 那条 LLM 调用也会过这里，
    // 计数式会被它错位（本文件 :107 已记过同一条教训）。
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('&cand=0')) {
        return { ok: false, status: 500 } as any;
      }
      return echoFetch(url, init);
    });
    try {
      await runAssetGenOnce();
    } finally {
      baseFetch.mockImplementation(echoFetch);   // 必须还原：其余用例都依赖它
    }

    // a) job 仍算 succeeded（**不是 failed**）—— 钱已花、素材已有，整批重试会重复付费。
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');

    // b) 缺口必须可见：error_message 指出失败的 index。
    expect(r.errorMessage).toContain('部分候选转存失败');
    expect(r.errorMessage).toContain('index=0');

    // c) 落库的是第 1/2 张（index 0 没落）。
    const rows = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.jobId, id));
    expect(rows.length).toBe(2);
    expect(rows.map(x => x.candidateIndex).sort()).toEqual([1, 2]);

    // d) **恰好一行** is_selected = true，且是 index 1（回退选中的那张，不是 index 0）。
    const selectedRows = rows.filter(x => x.isSelected);
    expect(selectedRows.length).toBe(1);
    expect(selectedRows[0].candidateIndex).toBe(1);

    // e) 业务表回写的 URL == 那一行 selected 的 URL（同源）。
    const [node] = await db.select().from(pmsBuiWenlvScenes)
      .where(eq(pmsBuiWenlvScenes.id, N)).limit(1);
    expect(node.image).toBe(selectedRows[0].url);
    // job 行上的 assetId 也必须与 selected 同源（否则 /retry 或前端拿到的 id 指向另一张）。
    expect(r.assetId).toBe(selectedRows[0].id);

    // f) ★ 调用点接线的负断言（F1-d）—— 今天是**零覆盖**的那条线。
    //    本用例构造的正是回退路径：index 0 转存失败 ⇒ 采纳 index 1。
    //    `shouldReview` 收到的是 `selected.index`（= 1，非 0）⇒ **不评** ⇒ 不该有评审记账行。
    //    把调用点改回硬编码 `0`：`shouldReview({candidateIndex: 0, …})` 返回 true，
    //    会给 `wa-<id>-1` 补一条 `review:` 行 —— 这条断言立刻红。
    //    ⚠️ 故意**等一下**再断言「不存在」：fire-and-forget 的写入是异步的，不等的话
    //       即使真写错了也可能因为还没落地而**假绿**（负断言的经典坑）。
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reviewRows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${id}%`));
    expect(reviewRows.length).toBe(0);
  });

  it('落 OSS 的扩展名取自**实际字节**，不是写死的 .png（Seedream 返回的其实是 JPEG）', async () => {
    // 背景：此前这一行写死 `` `pms/wenlv/image/${job.id}.png` `` + `'image/png'`（计划原文如此），
    // 而字节 Seedream 返回的是 JPEG（2026-09-14 生产取证，魔数 ff d8 ff e0）。
    // 前端看不见这个错（浏览器/小程序都嗅探字节），测试也抓不到（provider 被 mock）——
    // 只有对生产字节取证才会发现，所以这条用例是**唯一的**判据。
    //
    // 变异验证：把 scheduler 里那两行换回硬编码 `'.png'` / `'image/png'` ⇒ 本用例红在
    // `expect(wa.url).toContain('.jpg')`；其余用例不受影响（它们的桩返回 8 字节零值，
    // sniffImageType 认不出 ⇒ 退回历史上同款的 png），红点因此精确落在本修复上。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-mime`;
    await seed(id, 'background', '字节判定素材', { sourceText: 'x' });
    // 只改**图片下载**那一步的响应：给真 JPEG 魔数 + 一份 `content-type: image/png`
    // 的**矛盾**声明 —— 用来钉住「字节优先于上游声明」，正是本 bug 的形状。
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('dashscope')) return echoFetch(url, init);
      return {
        ok: true, status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      } as any;
    });
    try {
      await runAssetGenOnce();
    } finally {
      baseFetch.mockImplementation(echoFetch);
    }
    const [wa] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, `wa-${id}`)).limit(1);
    // uploadToOSS 被 mock 成回 `https://oss.test/${key}`，故 key 的扩展名在 url 上可见。
    expect(wa.url).toContain('.jpg');
    expect(wa.url).not.toContain('.png');
  });

  it('素材行的 style_tag 与 job 行同口径：走 fitTag（trim + 空白归一）', async () => {
    // 这条是 D1 修复的**第二条写路径**：job 行的 community_style_tag 由 `POST /batch`
    // 归一，design_assets.style_tag 由调度器的 `writeAsset` 写 —— 后者此前零覆盖
    //（把它改回 `styleTag: job.communityStyleTag`，24 条相关用例全绿）。
    // ⚠️ 自足：图类 job 没锚图必 failed（`writeAsset` 压根跑不到）——必须**在本用例内**
    //    自己把锚图种上。此前依赖本 describe 首个用例的回写，单跑 `-t` 会 TypeError。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-tag`;
    await seed(id, 'background', '标签素材', { sourceText: 'x', communityStyleTag: '  ink  ' });
    await runAssetGenOnce();
    const [wa] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, `wa-${id}`)).limit(1);
    // 断言 'ink' 而不是 '  ink  '：这条路径上 `fitTag` 真正可达的差异就是 trim /
    // 空白归一（截断到 50 走不到 —— job 行的列宽本身就是 50）。
    expect(wa.styleTag).toBe('ink');
  });

  it('画面描述里的「素材」是**真节点标题**，不是带类型后缀的 job.name', async () => {
    // 缺陷 1 的 bite 全在这里。
    // `planBatch` 给 job.name 拼了类型后缀（`标题·background`），把英文素材类型也喂给 LLM，
    // 而出图提示词的画面描述正是由它转述来的 —— 假标题直接进了出图模型的输入。
    // ⚠️ 上面那条「图类 job」用例种的是 `nodeId` 为 undefined 的 `入镇·background`，
    //    修与不修都走**回落分支**，恒绿、钉不住任何东西；所以必须另起一条**带 nodeId** 的用例。
    const id = `${B}-nodetitle`;
    // 显式保证锚图存在，**不依赖上一条用例**（锚图缺失会先判 failed，
    // 把本用例真正要断言的「提示词里的标题」整个掩盖掉 —— 单跑本用例时就是这样）。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/seed-anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    await seed(id, 'background', '古井·background', { nodeId: N, sourceText: '井水很凉。' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    expect(r.prompt).toContain('古井');              // 库里 nodes.title 的真标题
    expect(r.prompt).not.toContain('·background');   // 没有把素材类型当标题拼进去
  });

  it('画面描述里的「素材」是真角色名，不是带类型后缀的 job.name（character 走 targetKind 解析）', async () => {
    // Step 6 的咬合点：character_avatar 的 job **既没有 nodeId 也没有 collectibleId**
    //（enqueue.ts 的展开循环把两者都置 null），nodeTitle 只能靠 `targetKind + targetId` 解析；
    // 修不好就回落 `job.name` = `沈砚·character_avatar`，把类型后缀喂给 LLM。
    const charId = `${B}-char`;
    await db.insert(pmsBuiWenlvCharacters).values({
      id: charId, productId: P, name: '沈砚', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    });
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/seed-anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-chartitle`;
    await seed(id, 'character_avatar', '沈砚·character_avatar', { targetId: charId, sourceText: '水墨青衫' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    expect(r.prompt).toContain('沈砚');                    // 库里 characters.name 的真名
    expect(r.prompt).not.toContain('·character_avatar');   // 没有把素材类型当标题拼进去
  });

  it('重试的花费**累加**而不是覆盖（同一行会被重试复用）', async () => {
    // 真实路径：上游成功 → 转存失败（这一笔已经记了）→ 重试成功（又记一笔）。
    // 覆盖式写入只留最后 0.5，而实际花了 1.0 —— 「花了多少钱」正是本子项目的交付判据。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-retry`;
    await seed(id, 'background', '重试', { sourceText: 'x', costAmount: '0.5' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    // 0.5（前一次）+ 本次的「0.5 图片费 + 文本 LLM 分价费」。
    // 本用例的 bite 在**累加 vs 覆盖**：覆盖式写入只留 0.5 那一半，必红。
    expect(Number(r.costAmount)).toBe(Number((1.0 + calcPromptCost(1200, 800)).toFixed(4)));
  });

  // ===== 块 B2：LLM token 用量进账（2026-09-18）=====
  it('图类 job 的 cost_amount 含 LLM 分价费（= 图片费 + calcPromptCost(1200, 800)）', async () => {
    // 背景：`callLlm` 此前**只回文本**，一批 50 张图 ≈ 50 次 qwen-max 调用在账面上是 ¥0
    //（代码里的注释原文这么写着）。本用例钉的就是「那笔钱现在记进来了」。
    //
    // 期望值**引用 pricing 的真实函数**，不手抄 0.5106：手抄的数会随 PROMPT_DEFAULT /
    // IMAGE_DEFAULT / env 调整而漂移，而漂移后的断言仍然绿 —— 静默错。
    // token 数来自 `echoFetch` 桩回的 `usage`（prompt_tokens 1200 / completion_tokens 800）。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-llmcost`;
    // `prompt` 留 null（seed 的默认）⇒ 走 `!isAnchor && !reusePrompt` 那唯一一支，
    // 真的调 LLM、真的拿到 usage。传了 prompt 就在复用分支上恒为 0（另一个断言对象）。
    await seed(id, 'background', '计费·background', { sourceText: '井水很凉。' });

    const imageCost = calcImageCost(1, 'mock');   // beforeAll 设了 WENLV_IMAGE_UNIT_PRICE=0.5
    const llmCost = calcPromptCost(1200, 800);
    // ★ 自证：分价费那一项**必须非 0**。它若为 0，下面那条断言在「usage 压根没接线」时
    //   同样成立（两边一起退化成图片费）—— 那正是本仓记录过的「恒绿假判据」。
    expect(llmCost).toBeGreaterThan(0);

    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    // 列是 numeric(10,4)：先按 4 位小数收敛再比，避免浮点尾巴（0.5 + 0.0106 的双精度残差）
    // 造成与 PG 十进制取值间的 1 ulp 差异 —— 那会是一条随机红的伪判据。
    expect(Number(r.costAmount)).toBe(Number((imageCost + llmCost).toFixed(4)));
  });

  it('LLM 响应缺 usage 时：不抛错、cost_amount 只含图片费', async () => {
    // `readUsage` 的失败口径：拿不到用量**不能抛** —— 那会让一次已经付过钱的调用
    // 连图和文本一起丢掉，比少记一条账糟得多（与 pricing.ts 同一条口径）。
    // 但也不能静默：实现里必须留一条 console.warn（本用例不钉它，钉的是「账仍记图片费、
    // 任务仍成功」这条可观测结果）。
    //
    // ⚠️ 本用例是上面那条的**对照**：它证明 `cost_amount` 里那一项确实**来自 usage**，
    //    而不是某种恒定的加价。把 `readUsage` 改成从别处取数，这条会红。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-nousage`;
    const marker = `缺usage${Date.now()}`;
    await seed(id, 'background', `${marker}·background`, { sourceText: '井水很凉。' });
    // 定向注入（按 user 消息里的哨兵，避免全库领取顺序把注入吃掉 —— 与
    // 「网关错误页」那条同款手法）：只对本用例这条 job 回**不带 usage** 的 payload。
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('dashscope')) {
        const user = JSON.parse(init.body).messages.find((m: any) => m.role === 'user')?.content ?? '';
        if (String(user).includes(marker)) {
          const content = String(user);
          const payload = { choices: [{ message: { content } }] };   // 刻意不带 usage
          return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as any;
        }
      }
      return echoFetch(url, init);
    });
    try {
      await runAssetGenOnce();
    } finally {
      baseFetch.mockImplementation(echoFetch);   // 必须还原：其余用例都依赖带 usage 的桩
    }
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');          // 缺 usage 不构成业务失败
    expect(r.assetId).toBeTruthy();
    // 只含图片费 —— 写成 `toBe(0)` 的话，本用例在「图片费也漏记」时同样绿（没有区分力）
    expect(Number(r.costAmount)).toBe(Number(calcImageCost(1, 'mock').toFixed(4)));
  });

  it('旁白：合成 → 转存 → 按 node_id 精确写回 nodes.narration_url', async () => {
    const id = `${B}-nar`;
    // 故意让标题不匹配任何节点 —— 若实现退回按标题匹配，这条会写不中而失败。
    await seed(id, 'narration', '改名后的节点·旁白', { nodeId: N, sourceText: '井水很凉。' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    expect(Number(r.costAmount)).toBeGreaterThan(0);
    const [n] = await db.select().from(pmsBuiWenlvScenes)
      .where(eq(pmsBuiWenlvScenes.id, N)).limit(1);
    expect(n.narrationUrl).toBeTruthy();
    expect(n.narrationUrl).toContain('oss.test');
  });

  it('背景图：生成成功后按 node_id 精确写回 nodes.image', async () => {
    // 自给自足：本用例不依赖前序用例留下的状态
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    await db.update(pmsBuiWenlvScenes)
      .set({ image: null })
      .where(eq(pmsBuiWenlvScenes.id, N));
    const id = `${B}-bg-writeback`;
    await seed(id, 'background', '古井·background', { nodeId: N, sourceText: '井水很凉。' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    const [n] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N)).limit(1);
    expect(n.image).toBeTruthy();
    expect(n.image).toContain('oss.test');
    // 反向锁：**没有 WHERE 的「无差别更新」也会让上面两条变绿**（它把所有节点都写上）。
    // N3 属另一个产品、且全仓没有任何路径会写它的 image —— 它被写 = 越界。
    // 少了这条，「WHERE 条件写错/漏写」这个最危险的失败模式测不到。
    const [other] = await db.select().from(pmsBuiWenlvScenes)
      .where(eq(pmsBuiWenlvScenes.id, N3)).limit(1);
    expect(other.image).toBeNull();
  });

  it('封面图：产品级 job（nodeId 为 null）成功后写回 products.cover_image', async () => {
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png', coverImage: null })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-cover-writeback`;
    // nodeId / sourceText 均为 null —— 生产上 cover 是产品级 job（enqueue.ts 的
    // `mk('cover', '剧本封面', null, null)`）。这里显式钉住 null，钉的是**回写不依赖 nodeId**：
    // 若哪天有人把回写改成「按 nodeId 找产品」，这条会红。
    //
    // ⚠️ 用例名原先写的是「用 `job.productId`，不用 nodeId」—— **Task 6 起不准确了**：
    //    实现已改走 `job.targetId`，而夹具按注册表 `scope` 反推 targetId
    //    ⇒ 产品级类型下 `targetId === productId` **恒等**，本条再也分不清这两个键。
    //    今天的咬合点是：① nodeId 为 null 不影响回写；② 写的是 `coverImage` 这一列
    //    （写错列会让下面两条断言红）。「拿哪个键」由 writeback.test.ts 的手写表钉。
    await seed(id, 'cover', '剧本封面', { nodeId: null, sourceText: null });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    const [p] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(p.coverImage).toBeTruthy();
    expect(p.coverImage).toContain('oss.test');
    // 消费端契约：scheduler 在 nodeId 为空时回落 `String(job.name)` 当 nodeTitle，
    // 它逐字进 prompt-builder 的 `素材：${nodeTitle}（…）` 一行。改掉那个回落，
    // 这里必须红 —— 否则「产品级封面用中文名」这个约定只在纯函数侧成立。
    //
    // ⚠️ 断言写成 `素材：剧本封面（` 而**不是**裸 `toContain('剧本封面')`：
    // TYPE_LABEL.cover 本身就是「剧本封面海报（竖版，用于门票产品与分享）」，以
    // 「剧本封面」开头 —— 裸串断言**恒真**，无论 nodeTitle 是什么都绿。
    // 2026-09-15 变异实测：把 seed 名改成 `封面·cover`、甚至把回落掐成空串，
    // 裸断言都不红。带上 `素材：` 前缀与全角括号才有咬合。
    //
    // 本用例 seed 的是自己的名字字面量，所以改坏**注册表里 cover 的展开键**
    //（`asset-types.ts` 的 `ASSET_TYPES.cover.scope`）**不会**让这里红 ——
    // 那条规则的真源在注册表，由纯函数侧的用例钉住；**这里钉的是 scheduler 的消费端**。
    expect(r.prompt).toContain('素材：剧本封面（');
    expect(r.prompt).not.toContain('·cover');
  });

  it('印章任务在**没有条目归属**时（targetId 为空）不回写任何业务列 —— 缺键静默跳过', async () => {
    // 负向用例：证明回写**按注册表给出的目标走**，不是「凡是成功就写 nodes.image」。
    // 若实现写成无差别回写，本条会红 —— 那是远程刷虚拟印章的入口。
    //
    // ⚠️ 用例名原先写的是「（stamp 没有可用的键）」—— **那是 Task 6 之前的事实，现在是错的**：
    //    stamp 的回写目标是 `collectibles.stamp_meta.stampAssetId`（见 asset-types.ts 的
    //    stamp 条），它**有**键。本条之所以仍绿，是因为这里 seed 的行**没有 collectibleId**
    //    ⇒ `targetId` 为空 ⇒ 走「缺键跳过」。
    //    正向对照见 «图鉴条目素材» 那个 describe 里的 stamp 用例 —— 缺了它，本条的绿
    //    既可能来自「缺键跳过」，也可能来自「stamp 压根不会回写」，两者分不开。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png', coverImage: null })
      .where(eq(pmsBuiWenlvProducts.id, P));
    await db.update(pmsBuiWenlvScenes)
      .set({ image: null })
      .where(eq(pmsBuiWenlvScenes.id, N));
    const id = `${B}-stamp-nowrite`;
    await seed(id, 'stamp', '印章', { nodeId: N });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');   // 任务本身照常成功
    const [n] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N)).limit(1);
    expect(n.image).toBeNull();          // 但业务列没被碰
    const [p] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(p.coverImage).toBeNull();
  });

  it('background 的 nodeId 为空时不写、且不抛（任务仍成功）', async () => {
    // 现场可能造出没有节点归属的背景图（如整场宣传图）。缺键必须静默跳过，不能让任务失败。
    //
    // ⚠️ **本用例锁定的是「缺键不构成任务失败」，不是「`if (job.nodeId)` 这道守卫存在」。**
    //    2026-09-15 变异实测：把守卫整个删掉、改成无条件 `.where(eq(id, job.nodeId))`，
    //    本用例**仍然绿**。根因是 `eq(col, null)` 生成的是 `id = NULL`，在 SQL 三值逻辑下
    //    匹配 0 行 —— 有守卫与没守卫在数据库层**没有任何可观测差异**。
    //    守卫本身是 spec §4.1 明文要求的（「与旁白回写一样，代码仍要判空」），保留；
    //    但**别以为这条用例在验它**。要验它只能靠断言 UPDATE 语句条数（需 mock db，成本不划算）。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-bg-nonode`;
    await seed(id, 'background', '无节点背景', { nodeId: null, sourceText: '空镜。' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
  });

  it('旁白：转存 OSS 失败时，TTS 那笔钱**照样记下**（上游已合成 = 已计费）', async () => {
    // 终审发现 1（2026-09-14）：`uploadToOSS` 藏在 `synthesizeNarration` **内部**，
    // 而记账写在它**返回之后** ⇒ 转存一抛，那句 update 永不执行，账面停在 0，
    // 而钱已经花掉了 —— 直接违背交付判据「知道花了多少钱」。
    // 图路径是反过来的（provider 一返回就记，转存失败也不抹掉），旁白此前**没有**对齐。
    // 判据：status=failed（转存确实失败了）**且** costAmount > 0（账仍然记得住）。
    const id = `${B}-nar-ossfail`;
    await seed(id, 'narration', '旁白·转存失败', { nodeId: N, sourceText: '井水很凉。' });
    const oss = await import('../../../aliyun/oss.js');
    const upload = oss.uploadToOSS as unknown as { getMockImplementation: () => any; mockImplementation: (f: any) => void };
    const real = upload.getMockImplementation();
    upload.mockImplementation(async () => { throw new Error('注入的 OSS 故障'); });
    try {
      await runAssetGenOnce();
    } finally {
      upload.mockImplementation(real);   // 必须还原：本文件其余用例都依赖它成功
    }
    const r = await rowOf(id);
    expect(r.status).toBe('failed');
    expect(String(r.errorMessage ?? '')).toContain('OSS');   // 失败原因确实是转存那一步
    // 默认 TTS 单价 ¥0.20/千字符，'井水很凉。' 的旁白文本远小于千字符但**不为 0**
    // ⇒ round4 后仍是正数。写成 `> 0` 而不是具体值：本用例钉的是「记没记」，
    // 不是单价口径（那是 pricing.test.ts 的活）。
    expect(Number(r.costAmount) > 0).toBe(true);
  });

  it('generate() 抛错时，已产出的张数仍要进账（判别力：不记账则停在种子值 ¥0.5 而红；覆盖式写入则只剩 ¥1.5）', async () => {
    // 代码里自陈的「已知账面缺口 T-I」：`generate()` 自身抛错时（网络失败 / 非 2xx /
    // URL 形态非法），成本自增那段不会执行，而 `markFailed` 不写成本 ⇒ 上游**可能
    // 已产出并真计了费**（尤其「两张合法 + 一张非法」这种：上游出了图，只是我们按
    // `malformed > 0` 整条拒收），账上却纹丝不动。
    // 修法是结构性的：provider 把「上游实际产出的张数」挂在 `ImageGenError` 上
    //（image-provider.ts），调度器的 catch 拿到就补记一笔。
    //
    // ⚠️ 本用例走**真实 Ark provider + 桩 fetch**（不是 mock 一个 provider）：
    //    这样「错误对象上到底挂了几张」与「调度器把几笔记进账」是同一条真实链路上的两端，
    //    中间没有替身可以各自漂移。
    //    夹具让 producedCount(3) ≠ rejectedCount(1)：上游真产出了 3 张、真计了 3 张的钱，
    //    我们只拒收 1 张 —— 按 0 记（不记账）或按 1 记（拿被拒收的张数计费）都会红。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-genfail`;
    // 种一行**已经带账**的 job（¥0.5），模拟「重试复用同一行、上一次已记过一笔」。
    // ⚠️ 这一笔不是装饰：从 0 开始记时 `+=` 与 `=` 结果相同，分辨不出覆盖式写入 ——
    //    而覆盖会丢掉前一次的账，正是「花了多少钱」这个交付判据最怕的形态。
    await seed(id, 'background', '生成抛错也要记账·background', {
      sourceText: '井水很凉。', costAmount: '0.5',
    });

    process.env.WENLV_IMAGE_PROVIDER = 'ark';
    process.env.ARK_API_KEY = 'test-key';
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/images/generations')) {
        const payload = {
          data: [
            { url: 'https://ark.example.com/a.png' },
            { url: 'https://ark.example.com/b.png' },
            { url: 'null' },                          // 形态非法 ⇒ 整条拒收
          ],
        };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as any;
      }
      return echoFetch(url, init);
    });
    try {
      await runAssetGenOnce();
    } finally {
      baseFetch.mockImplementation(echoFetch);   // 必须还原：其余用例都依赖带 usage 的桩
      delete process.env.WENLV_IMAGE_PROVIDER;   // 及 mock provider（本文件其余用例的前提）
      delete process.env.ARK_API_KEY;
    }

    const r = await rowOf(id);
    expect(r.status).toBe('failed');                  // 任务照常判失败（上游产物不可用）
    // 期望值引用**真实函数**、单价取 provider 名：本文件把单价抬到 ¥0.5
    // ⇒ 3 张 = ¥1.5。判据 = ¥0.5（原有账，覆盖式写入会把它抹掉）+ ¥1.5（本次产出 3 张）
    //   + 本次文本 LLM 的分价费 `calcPromptCost(1200, 800)`（LLM 已成功返回 ⇒ 这笔钱
    //   已经花了；2026-09-20 起由 catch 的 `promptCost` 一并记入 —— 此前这条路径只记图片费）。
    //   · 整段不记账 → ¥0.5（红）
    //   · `=` 覆盖式写入 → ¥1.5（红）
    //   · 拿被拒收的 1 张计费 → ¥1.0（红）
    //   · 只记图片费、漏掉提示词费 → ¥2.0（红）
    expect(Number(r.costAmount)).toBe(
      Number((0.5 + calcImageCost(3, 'seedream') + calcPromptCost(1200, 800)).toFixed(4)),
    );
  });

  it('generate() 抛错但**一张图都没产出**时，本次文本 LLM 的提示词费仍要进账（判别力：只按 produced>0 记账则停在种子值 ¥0.25 而红）', async () => {
    // 上面那条用例覆盖不到本用例：它是**LLM 成功 + 图片全失败**。
    // 上游一张图都没出（`produced === 0`），但提示词那一步的 token 费**已经花了**
    // —— `calcPromptCost` 与图片成败无关。只把提示词费塞进 `if (produced > 0)`
    // 等于把这条路径继续漏掉（本次修法的核心：守卫放宽为「图片费**或**提示词费任一非零」）。
    //
    // 走**真实 Ark provider + 桩 fetch**（与上条同款）：非 2xx ⇒ provider 内部
    // `produced = 0`（image-provider.ts 的 ① 状态码优先于形态），抛的是带
    // `producedCount=0` 的 ImageGenError —— 与生产「上游 5xx / 限流」同构。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-genfail-noimg`;
    // 种一行**已带账**的 job（¥0.25）：这条路径上 `+=` 与 `=` 才分得开
    //（从 0 起记时两者结果相同，而覆盖式写入会抹掉前一次的账）。
    await seed(id, 'background', '无图产出也要记账·background', {
      sourceText: '井水很凉。', costAmount: '0.25',
    });

    const llmCost = calcPromptCost(1200, 800);
    // ★ 自证：这一项**必须非 0**。它若为 0，本用例在「提示词费压根没接线」时同样成立
    //   （两边一起塌成 0）—— 那正是本仓记录过的「恒绿假判据」。
    expect(llmCost).toBeGreaterThan(0);

    process.env.WENLV_IMAGE_PROVIDER = 'ark';
    process.env.ARK_API_KEY = 'test-key';
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('/images/generations')) {
        // 非 2xx：上游请求被拒，**一张图都没产出** ⇒ producedCount = 0。
        // `text()` 要给：provider 先取原始文本再解析（诊断用 body 摘录）。
        const raw = JSON.stringify({ error: { message: 'upstream 500' } });
        return { ok: false, status: 500, text: async () => raw, json: async () => JSON.parse(raw) } as any;
      }
      return echoFetch(url, init);
    });
    try {
      await runAssetGenOnce();
    } finally {
      baseFetch.mockImplementation(echoFetch);   // 必须还原：其余用例都依赖带 usage 的桩
      delete process.env.WENLV_IMAGE_PROVIDER;   // 及 mock provider（本文件其余用例的前提）
      delete process.env.ARK_API_KEY;
    }

    const r = await rowOf(id);
    expect(r.status).toBe('failed');                  // 上游产物不可用 ⇒ 任务判失败
    // 期望值引用**真实函数**、不手抄常量：
    //   ¥0.25（原有账，覆盖式写入会把它抹掉）+ ¥0（本次一张图都没产出 ⇒ 图片费为 0）
    //   + calcPromptCost(1200, 800)（LLM 已成功返回 ⇒ 这笔钱已经花了）
    // 判据：只按 `produced > 0` 记账 → 停在 ¥0.25（红）；记为 `=` → 只剩 ¥0.0106（红）。
    expect(Number(r.costAmount)).toBe(Number((0.25 + llmCost).toFixed(4)));
  });

  it('失败原因落库前消毒：drizzle 的 SQL 与参数**不得**进 error_message（它会被 /batch 原样回给前端）', async () => {
    // 2026-09-14 终审 Minor：`markFailed` 此前写的是 `String(e.message)`，而
    // `GET /admin/wenlv-asset-gen/batch/:batchId`（创作台轮询进度用）把该列**原样**
    // 放进响应体 —— drizzle 的 message 是 `Failed query: <完整SQL>\nparams: <参数>`，
    // 于是 SQL 与参数**绕过 serverError**（它只管响应侧那一半）直达浏览器。
    // 修法见 src/lib/http-error.ts 的 `diagnosableErrorText`。
    //
    // ⚠️ 本用例钉的是 **markFailed 的契约**（凡经它落库的异常都必须消毒）。
    //    借 OSS mock 注入只是「造一个会被 runOne 捕获并交给 markFailed 的抛出」的**手段**
    //    —— 与线上同构之处在于：真正出错的很可能就是 `db.insert`/`db.update` 抛的
    //    DrizzleQueryError，它走的是**同一条** markFailed 路径。
    //    本用例证明不了的是「线上确实会产生 DrizzleQueryError」（那是 drizzle 的事）。
    const id = `${B}-sanitize`;
    await seed(id, 'narration', '旁白·消毒', { nodeId: N, sourceText: '井水很凉。' });
    const drizzleLike: any = new Error(
      'Failed query: insert into "pms_bui_wenlv_design_assets" ("id") values ($1)\n'
      + 'params: wa-x, 13800000000',
    );
    // SQLSTATE 在 **cause** 上：drizzle 包了一层，外层 e.code 恒 undefined
    drizzleLike.cause = { code: '23505', constraint: 'design_assets_pkey' };
    const oss = await import('../../../aliyun/oss.js');
    const upload = oss.uploadToOSS as unknown as { getMockImplementation: () => any; mockImplementation: (f: any) => void };
    const real = upload.getMockImplementation();
    upload.mockImplementation(async () => { throw drizzleLike; });
    try {
      await runAssetGenOnce();
    } finally {
      upload.mockImplementation(real);   // 必须还原：本文件其余用例都依赖它成功
    }
    const r = await rowOf(id);
    expect(r.status).toBe('failed');
    const msg = String(r.errorMessage ?? '');
    // 泄露面**逐项**断：只断一个 'Failed query' 会被「换个前缀」的改法绕过去
    expect(msg).not.toContain('Failed query');
    expect(msg).not.toContain('pms_bui_wenlv_design_assets');
    expect(msg).not.toContain('insert into');
    expect(msg).not.toContain('13800000000');
    // 反向半边：**不能**一刀切成「服务器错误」——error_message 是运维诊断的唯一线索，
    // 把 SQLSTATE / 约束名一起抹掉就等于用「不泄露」换「查不出」。若有人改成
    // 「凡 Error 一律回兜底文案」，下面两条红。
    expect(msg).toContain('23505');
    expect(msg).toContain('design_assets_pkey');
  });

  it('旁白不需要风格基线：基线缺失不该把旁白一起判 failed（缺陷 2）', async () => {
    // 旁白只要 `sourceText`（buildTtsText 根本不读风格基线）。若 runOne 对**所有**类型
    // 都先 `resolveBible`，「基线缺失」这一个原因就会把旁白判 failed（且重试到
    // MAX_ATTEMPT 后永久失败），error_message 写着「该任务没有风格基线」——
    // 一条与旁白毫不相干的诊断。
    // 用**独立产品** P2（style_bible 为 null）+ 空快照，把这条路走到底：
    // 若 resolveBible 仍被前置，这里必然 failed。
    await db.insert(pmsBuiWenlvProducts).values({
      id: P2, name: '无基线剧本', styleBible: null, styleAnchorUrl: null,
    }).onConflictDoNothing();
    const id = `${B}-nar-nobible`;
    await seed(id, 'narration', '无基线旁白·旁白', {
      productId: P2, styleBibleSnapshot: {}, nodeId: N, sourceText: '井水很凉。',
    });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    expect(r.assetId).toBeTruthy();       // 真的产出了，不是「静默放过」
  });

  it('缺锚图的产品，其图类 job 压根不会被领取（不降级为无参考图生成）', async () => {
    // ⚠️ 本用例的**断言对象在 2026-09-14 变了**（不是被削弱）：
    //    修「锚图 failed 后图类素材被永久判死」时，第 3 步的领取加了
    //    `requireAnchorReady` 前置条件 —— 「产品没有锚图」的行**根本不会被领走**，
    //    于是这条路径不再走到 `generateImageJob` 的那句守卫。
    //    旧写法断的是 `status === 'failed'`（生成期被拒），新机制下它会**留在 pending**
    //    —— 而「留在 pending 等下一 tick / 等人工」正是我们要的行为（failed 不可自动重领）。
    //    用户可见的保证没变，且更强：不产图、不花钱、不留一条要人工清理的 failed。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: null })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-noanchor`;
    await seed(id, 'background', '无锚图', { sourceText: 'x' });
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('pending');     // 推迟，不是判死
    expect(r.attempt).toBe(0);            // 连领都没领过
    expect(r.assetId).toBeNull();         // 没有产出
    expect(Number(r.costAmount)).toBe(0); // 没调上游就没花钱
    expect(String(r.errorMessage ?? '')).not.toContain('锚图');   // 没有那条误杀诊断
    // 没往资源库写东西（`writeAsset` 的 id 口径 = `wa-${jobId}`）。
    // 断行数而不是 `toBeUndefined()`：该 matcher 确实仍不在桩内，换写法即可；
    // 且行数断言在「压根没查」时同样会红。
    // ⚠️ 2026-09-19 更正：原注释里的「仓内规矩是**换写法**而不是扩桩」不成立 ——
    //    桩头部第 2 行写的是**用时补桩**，Task 8（d5a65359）即按此追加了
    //    toThrow / toBeLessThan。这里换写法只是「不值得改桩」，不是「不许改桩」。
    const assets = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, `wa-${id}`));
    expect(assets.length).toBe(0);
  });

  it('生成期守卫仍承重：无锚图时拒绝生成，且**不调用 provider**、不写资源库', async () => {
    // 为什么不能只靠上面那条：领取 SQL 是**一道**门，不是唯一一道。
    // `claimNextJobs()` 是导出的，不带 `requireAnchorReady` 时照样会把这类行领走
    // （既有用例 `claim.db.test.ts` 就是这么用的）。这里**自己领**再直接驱动生成，
    // 复现「任何绕过领取过滤的调用路径」—— 守卫若被删掉，本条必红。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: null })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-guard`;
    await seed(id, 'background', '守卫·background', { sourceText: 'x' });
    const [claimed] = await claimNextJobs(50) as any[];
    // 全库语义：本文件靠 beforeEach 排干批次 B，但**别的** pending 残留可能抢先。
    // 抢先了就**报错**而不是静默跳过 —— 后者会让本条变成恒绿（要防的正是这个）。
    expect(claimed?.id).toBe(id);
    const callsBefore = baseFetch.mock.calls.length;
    await expect(generateImageJob(claimed, BIBLE as any)).rejects.toThrow('锚图');
    // 守卫在上游调用**之前** ⇒ 一次网络都没发、一分钱没花（没有「白花钱」）
    expect(baseFetch.mock.calls.length).toBe(callsBefore);
    const r = await rowOf(id);
    expect(r.assetId).toBeNull();
    expect(Number(r.costAmount)).toBe(0);
  });

  it('markFailed 自己抛错时不中断本轮其余已领行（隔离在循环层，不是 runOne 内部）', async () => {
    // 真实路径：本轮领了 N 条，第 1 条生成失败 → markFailed 的 UPDATE 撞上 DB 抖动（连接池耗尽）
    // → 从 runOne 的 catch **穿出**。没有循环层的隔离，for 中断，
    // 第 2..N 条已置 running 却从未被处理，要等下一 tick 的 reclaimStale（≥15 分钟）才置 failed，
    // 而 error_message 写「超时未返回」—— 把「根本没跑」误诊成「上游超时」。
    // 注入点：只对「因缺风格基线而 markFailed」的那一次 UPDATE 抛错（reclaimStale 的
    // status:'failed' 也走 db.update，按 error_message 区分开）。
    //
    // ⚠️ 失败原因在 2026-09-14 从「缺锚图」换成「缺风格基线」：第 3 步的领取加了
    //    `requireAnchorReady` 之后，无锚图的行**再也领不到**，根本走不到 markFailed。
    //    换掉有两个好处：① `resolveBible` 是在 `generateImageJob` **之外**抛的
    //    （runOne:427），每行只经过 runOne 的那**一次** markFailed —— 与旧写法同构，
    //    循环层兜底那次拿到的是**注入错误本身**（消息不含「风格基线」）⇒ 不会再注入，
    //    `injected` 仍是 2 而不是翻倍；② 它天然不会撞上 `reclaimStale` 的「超时未返回」。
    //    jobs 与产品都用 **P2**：它的 `styleBible` 本就是 null（为此而生的夹具），
    //    只需补一个锚图让它通过领取过滤 —— 不影响任何既有用例。
    await db.update(pmsBuiWenlvProducts)
      .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P2));
    const ids = [`${B}-iso1`, `${B}-iso2`];
    for (const id of ids) {
      // `styleBibleSnapshot` 是 `jsonb NOT NULL DEFAULT '{}'`（schema:441），传不了 null；
      // 空对象正是 `resolveBible` 认定的「无基线」（它判的是 `Object.keys(snap).length > 0`）。
      await seed(id, 'background', '隔离·background', {
        productId: P2, sourceText: 'x', styleBibleSnapshot: {},
      });
    }
    const realUpdate = (db as any).update.bind(db);
    let injected = 0;   // 注入次数的自证：0 次说明补丁根本没生效，用例会变成恒绿
    (db as any).update = (table: any) => {
      const builder = realUpdate(table) as any;
      if (table !== pmsBuiWenlvAssetJobs) return builder;
      const realSet = builder.set.bind(builder);
      builder.set = (values: any) => {
        if (values?.status === 'failed' && String(values?.errorMessage ?? '').includes('风格基线')) {
          injected++;
          throw new Error('注入的 DB 抖动');
        }
        return realSet(values);
      };
      return builder;
    };
    const errCalls: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { errCalls.push(a.map(String).join(' ')); };
    let rejected: unknown = null;
    try {
      // 判据：runAssetGenOnce 不许 reject —— 重抛就等于循环被中断
      await runAssetGenOnce();
    } catch (e) {
      rejected = e;
    } finally {
      (db as any).update = realUpdate;
      console.error = realErr;
    }
    expect(rejected).toBeNull();
    expect(injected).toBe(2);   // 两条都走到了 markFailed，且都被注入抛错
    // 两条都真的被处理过（claim 时置 attempt=1，与是否被中断无关，仅作地基断言）
    for (const id of ids) expect((await rowOf(id)).attempt).toBe(1);

    // ★ 循环层兜底 markFailed **真的写了库**（Task 17 清单 A-2）。
    //   只断 attempt 的话，把 :409-413 那段兜底整个删掉仍然 19 passed —— 因为
    //   attempt 在 claim 时就置 1 了，与兜底无关。而这两行的 status 恰恰是**唯一**
    //   能区分「兜底写了」与「兜底没写」的观测：不写就停在 running，
    //   下一 tick 被 reclaimStale 误诊成「超时未返回」。
    for (const id of ids) expect((await rowOf(id)).status).toBe('failed');

    // ★ 原始业务原因**必须留下**（Task 17 清单 A-3）。
    //   此处 runOne 的 markFailed 抛了 ⇒ 循环层兜底写库的是 **DB 抖动**，
    //   原始原因（缺风格基线）若不先在 runOne 的 catch 里落日志，就会从 DB 与日志
    //   双双消失。谓词认「生成失败」这个只属于 runOne catch 的措辞，
    //   不认 job.id —— 两条都会打同样的前缀，只有措辞能把它们分开。
    expect(errCalls.filter(s => s.includes('生成失败')).length).toBe(2);
    expect(errCalls.some(s => s.includes('风格基线'))).toBe(true);
  });

  it('超时收口不是静默的：收回超时的 running 行会留一条 warn', async () => {
    // `reclaimStale` 刻意 `return rows.length`，原实现**丢弃**了它 ——
    // 上游故障让一批行静默超时时 tick 照常、日志里零信号。
    const id = `${B}-stale`;
    await seed(id, 'background', '超时行·background', {
      sourceText: 'x', status: 'running',
      startedAt: new Date(Date.now() - 20 * 60 * 1000),   // 超过 STALE_MINUTES(15)
    });
    const realWarn = console.warn;
    const warns: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      await runAssetGenOnce();
      const r = await rowOf(id);
      expect(r.status).toBe('failed');
      expect(r.errorMessage).toContain('超时未返回');
      expect(warns.some(a => String(a[0]).includes('超时收口'))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  it('已完成的任务不会被再次领取', async () => {
    // **自足**：以前依赖上一条用例种的 `${B}-bg`，单跑本用例时 rowOf 返回 undefined 直接抛。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/seed-anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-done`;
    await seed(id, 'background', '已完成·background', { sourceText: 'x' });
    await runAssetGenOnce();
    expect((await rowOf(id)).attempt).toBe(1);
    await runAssetGenOnce();   // 已 succeeded，不该被再次领取
    expect((await rowOf(id)).attempt).toBe(1);
  });

  it('自举风格基线：点位名走 venue_points（权威源），不是已废弃的 nodes.location', async () => {
    // `nodes.location` 在 schema/wenlv.ts 已标 @deprecated，S2 采风产生的新节点只写
    // `venuePointId`（本用例种的 N3 正是这个形状：venuePointId 有值、location 为 NULL）。
    // 只读 location 时 `venuePointNames` 恒为 []，buildStyleBiblePrompt 里「真实场地点位」
    // 整段消失 —— 而 mustHave 的定义就是「场地标志物」，模型只能凭空编。
    // 断言落点：喂给 LLM 的 user 消息里必须出现点位表里的真名。
    await bootstrapStyleBible(P3, V3);
    const calls = baseFetch.mock.calls.filter((c: any) => String(c[0]).includes('dashscope'));
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[calls.length - 1][1].body);
    const user = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
    expect(user).toContain(VP3_NAME);
    // 钉住**权威层级**，而不只是「不再只读 location」：
    // 名字必须来自 `nodes.venuePointId` 指向的**那一个**点位，不能来自第 3 级
    //「该场地全部点位名」。把 pointIds 那一级关掉后，names 会落到第 3 级 ——
    // 它同样含 VP3_NAME，于是旧断言照绿（恒真）；只有这条负向断言有 bite：
    // 第 3 级会把同场地的 VP3_OTHER_NAME 一并带进来。
    expect(user).not.toContain(VP3_OTHER_NAME);
  });

  // ===== 自举的账落在**合成 job 行**上（任务 5 / 块 B3）=====
  //
  // 背景（已核实）：`cost_amount` 只存在于 `pms_bui_wenlv_asset_jobs` ——
  // **没有批次表**（schema/wenlv.ts 里那张表的注释自己写着「没有批次表：进度 = GROUP BY
  // batch_id，总额 = SUM(cost_amount)」），而 `bootstrapStyleBible` 此前不写任何 job 行
  // ⇒ 这一路打过的付费 LLM 一笔都不进账（Spec §6 的分期缺口）。
  //   ⇒ 账落在 `batchId='stylebible:<productId>'` 的**合成行**上，固定前缀让同一产品的
  //      多次自举汇到同一个批次，「基线调了三次花了多少钱」才是一个查得到的问题。
  //
  // ⚠️ 本块**自带一个产品**（PSB），不复用外层夹具 P3：合成行的 batchId 不属于外层批次 `B`，
  //    外层那套「按 batchId B 清 job 行」的 beforeEach/afterAll **罩不到它们**；
  //    借用 P3 还会让「重复自举要翻倍」那条被别的用例留下的行污染（假红）。
  describe('自举的账：合成 job 行', () => {
    const PSB = `sched-prod-synth-${Date.now()}`;
    const SB_BATCH = `stylebible:${PSB}`;
    const sbRows = () => db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, SB_BATCH));

    beforeAll(async () => {
      // `venueId` 留 null：顺带钉住「没有场地的剧本也写得进这一行」
      //（`venue_id` 列可空 —— schema 里那行没有 `.notNull()`）。
      //
      // ⚠️ `styleAnchorUrl` 必须**非空** —— 这不是摆设：第 3 步的领取带
      //    `requireAnchorReady`，它会放行 anchor/narration/product_id IS NULL，
      //    但**不**豁免 style_bible。锚图为空时，一条 pending 的合成行压根不会被领取，
      //    于是「合成行不该被领取」那条用例的 `attempt` 断言会**恒绿**
      //   （把 status 改成 pending 也测不出来），那是给后来者看的假护栏。
      //    锚图就绪 = 这行**真的会被领走建图**的危险场景，断言才咬得住。
      await db.insert(pmsBuiWenlvProducts)
        .values({
          id: PSB, name: '合成行剧本', styleBible: null, venueId: null,
          styleAnchorUrl: 'https://oss.test/synth-anchor.png',
        })
        .onConflictDoNothing();
    });
    afterAll(async () => {
      await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, SB_BATCH));
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PSB));
    });
    beforeEach(async () => {
      await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, SB_BATCH));
    });

    it('自举后账落在 batchId=stylebible:<pid> 的合成行上，且金额 = calcPromptCost(桩的 usage)', async () => {
      await bootstrapStyleBible(PSB, null);
      // 断言打在 **DB 行**上，不看响应体回显（响应体那半边由 wenlv-style-bible.test.ts 钉）。
      const rows = await sbRows();
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('succeeded');
      expect(rows[0].assetType).toBe('style_bible');
      expect(rows[0].iteration).toBe(1);
      // 金额引用**真实函数**，不手抄常量：手抄的数会随默认价调整而漂移，
      // 而漂移后的断言仍然「绿」—— 正是本子项目最怕的静默错。
      expect(Number(rows[0].costAmount)).toBe(calcPromptCost(1200, 800));
      // 留痕：这一版基线是用什么问出来的（prompt 列 = 喂给 LLM 的 user 消息）
      expect(String(rows[0].prompt)).toContain('合成行剧本');
      expect(String(rows[0].name)).toContain('风格基线自举');
      expect(rows[0].finishedAt).not.toBeNull();
    });

    it('重复自举 → **新起一行**（不覆盖），两笔各记一次 —— 「调了几次花了多少钱」是 SUM', async () => {
      await bootstrapStyleBible(PSB, null);
      await bootstrapStyleBible(PSB, null);
      const rows = await sbRows();
      // 两次 = 两行。若实现改成 UPDATE 累加到同一行，SUM 同样的数、但「调了几次」查不出来 ——
      // 而控制台拿 batchId 看的就是这个批次的行与总额。
      expect(rows.length).toBe(2);
      for (const r of rows) expect(Number(r.costAmount)).toBe(calcPromptCost(1200, 800));
      const sum = rows.reduce((a, r) => a + Number(r.costAmount), 0);
      expect(Number(sum.toFixed(4))).toBe(Number((2 * calcPromptCost(1200, 800)).toFixed(4)));
      // 主键互不相同：`length === 2` 在「同一行被查回来两次」的实现下也成立，
      // 而真实语义是「两次自举各写了一条新行」。
      expect(new Set(rows.map(r => r.id)).size).toBe(2);
    });

    it('合成行**不会**被调度器领取（写的是 succeeded，不是 pending ⇒ 不会被误建成图）', async () => {
      // 这是本设计里代价最大的一条：调度器第 3 步的领取**没有类型过滤**，一条 pending 的
      // style_bible 行会被领走丢给 `generateImageJob` —— 那是一次**真实付费**的、
      // 语义完全错误的文生图调用（把实现里的 succeeded 改成 pending 做变异，本用例即红）。
      await bootstrapStyleBible(PSB, null);
      const rows = await sbRows();
      const synthId = rows[0].id;

      // ★ 反证探针：本轮必须**真的跑起来**了。缺了它，「没被领取」在「调度器压根没动 /
      //   领取没生效」时同样成立 —— 一条恒真的假断言（本仓栽过多次的形状）。
      await db.update(pmsBuiWenlvProducts)
        .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
        .where(eq(pmsBuiWenlvProducts.id, P));
      const probeId = `${B}-synth-probe`;
      await seed(probeId, 'background', '探针图·background', { sourceText: 'x' });

      await runAssetGenOnce();

      expect((await rowOf(probeId)).status).toBe('succeeded');   // 探针活着 ⇒ tick 确实在推进
      expect((await sbRows()).length).toBe(1);                   // 没有新行被建出来
      const row = await rowOf(synthId);
      // ★ 承重断言放最前：`claimNextJobs` 领取时会置 `attempt = attempt + 1`。
      //   本块夹具的 PSB **有锚图** ⇒ 这条行若写成 pending，第 3 步**真的会领走它**
      //   （`requireAnchorReady` 不豁免 style_bible），于是 attempt 变 1、并顺手出图
      //   （一次真实付费的、语义完全错误的调用）。把实现里的 succeeded 改成 pending
      //   做变异，红的就是这一行 —— 这也是唯一能把「压根没被碰过」与「被领走」分开的观测：
      //   只看 status 的话，「被领走 → 跑成功」的形态同样还是 succeeded。
      expect(row.attempt).toBe(0);
      expect(row.status).toBe('succeeded');                      // 没被改判 running / failed
      expect(row.errorMessage).toBeNull();
    });

    it('parseStyleBible 失败时：已花的 token 费落一行 **status=failed** 的 job（判别力：不写则 0 行而红；写成 pending 亦红）', async () => {
      // 第二条异常路径（NEW-07 的另一半）：`parseStyleBible` 抛错时，这次 LLM 调用
      // **已经花了 token 费**，但此前一行都不写 ⇒ 账上永远查不到这笔钱。
      //
      // ⚠️ 状态必须是 `failed`（或 succeeded），**绝不能是 pending**：调度器第 3 步的
      //    领取**没有类型过滤**，本块夹具的 PSB 又**有锚图**（见 beforeAll 的注释）
      //    ⇒ 一条 pending 的 style_bible 行会被领走丢给 `generateImageJob`，
      //    那是一次**真实付费**的、语义完全错误的文生图调用。
      //    本用例只断言 status（不跑调度器）：写成 pending 时这一条直接红。
      baseFetch.mockImplementation(async (url: string, init?: any) => {
        if (String(url).includes('dashscope')) {
          // 回一段**解析不出 JSON** 的 content（连花括号都没有 ⇒ parseStyleBible 的
          // 「取最外层花括号」兜底也救不回来）。usage 照常给：判据要的是「这笔钱记下了」，
          // 桩里缺 usage 会让期望值 `calcPromptCost(1200, 800)` 与真实记账一起塌成 0。
          const payload = {
            choices: [{ message: { content: '这不是 JSON，没有任何花括号' } }],
            usage: { prompt_tokens: 1200, completion_tokens: 800 },
          };
          return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload } as any;
        }
        return echoFetch(url, init);
      });
      try {
        // 解析失败**照旧抛**（不静默降级用空基线 —— 空基线等于放弃防漂移）。
        await expect(bootstrapStyleBible(PSB, null)).rejects.toThrow();
      } finally {
        baseFetch.mockImplementation(echoFetch);   // 必须还原：本块其余用例依赖合法 JSON 桩
      }
      const rows = await sbRows();
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('failed');       // ★ 不是 pending（pending 会被领去真建图）
      expect(rows[0].assetType).toBe('style_bible');
      // 金额引用**真实函数**：这笔账的语义就是「这一次调用花了多少 token 费」。
      expect(Number(rows[0].costAmount)).toBe(calcPromptCost(1200, 800));
      // 失败原因要留痕（诊断唯一线索），否则这行只剩一个金额、看不出为什么失败
      expect(String(rows[0].errorMessage ?? '')).toContain('JSON');
    });
  });

  it('LLM 返回 200 + 非 JSON（网关错误页）时，error_message 能诊断，不坍缩成「失败：200」', async () => {
    // 原实现 `res.json().catch(() => ({}))` 把「200 + 网关 HTML 错误页」与「200 + content 为空」
    // 一起坍缩成「LLM 调用失败：200」—— 运维分不清限流 / 审核 / 配额 / 反代 / 结构变更。
    // 定向注入：只对该用例这条 job 的 user 消息生效，避免全库领取顺序把注入吃掉。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-badllm`;
    await seed(id, 'background', '网关错误页·background', { sourceText: 'x' });
    baseFetch.mockImplementation(async (url: string, init?: any) => {
      if (String(url).includes('dashscope')) {
        const user = JSON.parse(init.body).messages.find((m: any) => m.role === 'user')?.content ?? '';
        if (String(user).includes('网关错误页')) {
          return { ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' };
        }
      }
      return echoFetch(url, init);
    });
    try {
      await runAssetGenOnce();
    } finally {
      baseFetch.mockImplementation(echoFetch);
    }
    const r = await rowOf(id);
    expect(r.status).toBe('failed');
    expect(r.errorMessage).toContain('非 JSON');           // 与「HTTP 失败」可区分的标记
    expect(r.errorMessage).toContain('502 Bad Gateway');   // 原始 body 片段（≤200 字）
  });

  it('重试逐字复用已有 prompt，不再调 LLM（spec §7.2 重试不改 prompt）', async () => {
    // 真实路径：上游返回后、OSS 转存**之前** prompt 就写进了行上 →
    // 「生成成功但转存失败 → 人工重试」时它已存在，必须复用；否则 temperature 0.3
    // 会给出另一段画面描述 —— 用户点「重试」却得到另一张图。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-reuse`;
    await seed(id, 'background', '复用·background', { sourceText: 'x' });   // prompt=null → 首次现算
    const before = llmCalls();
    await runAssetGenOnce();
    const first = await rowOf(id);
    expect(first.status).toBe('succeeded');
    expect(first.prompt).toContain('【画面】');
    expect(llmCalls()).toBe(before + 1);

    // 把这一行退回 pending 模拟重试，并把 prompt 换成一个**回显桩复现不出来的哨兵**：
    // 桩是确定性的，若沿用第一次的真实 prompt，「重算」也会得到逐字相同的字符串 ——
    // 那样「逐字相同」这条断言在本环境里恒真、钉不住东西。哨兵让它有 bite。
    const sentinel = `${first.prompt}\n【哨兵：重试必须原样保留】`;
    await db.update(pmsBuiWenlvAssetJobs)
      .set({ status: 'pending', attempt: 0, prompt: sentinel })
      .where(eq(pmsBuiWenlvAssetJobs.id, id));
    await runAssetGenOnce();
    const second = await rowOf(id);
    expect(second.status).toBe('succeeded');
    expect(second.prompt).toBe(sentinel);   // 逐字保留，没有被 LLM 覆盖
    expect(llmCalls()).toBe(before + 1);    // 第二次没有再调 LLM
  });

  it('迭代行的**重试**也逐字复用已有 prompt（parentJobId 非空不得触发重算，spec §7.2）', async () => {
    // 真实路径：用户对一条素材点「迭代」→ `enqueueIteration` 建的新行
    //（prompt=null、parentJobId 非空、guidance 非空）→ 首次现算 prompt 并落库 →
    // OSS 转存失败 → failed → 用户点**重试**（Task 10 端点按 §7.2 保留 prompt、仅置回
    // pending）。此时 parentJobId 仍然非空。若复用判定里带着 `!job.parentJobId`，
    // 这一行会去**重调 LLM**（temperature 0.3）→ 另一段画面描述 → 用户点「重试」
    // 拿到的是**另一张图**，外加一次不进账的调用。
    // 本用例把「已算过一次 prompt 的迭代行」原样种下，断言不再发生 LLM 调用且逐字保留。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const parentId = `${B}-iter-parent`;
    // 父行建成 succeeded：迭代行的 parentJobId 指过来，与真库形状一致，且不会被本轮领取。
    await seed(parentId, 'background', '迭代父图·background', {
      sourceText: '井水很凉。', status: 'succeeded', prompt: '上一版的画面描述',
    });
    const id = `${B}-iter-retry`;
    // 哨兵：回显桩复现不出来的一段字，保证「逐字相同」这条断言在本环境里有 bite
    //（否则重算也会得到同一个字符串，断言恒真）。
    const sentinel = '迭代首算的画面描述【哨兵：重试必须原样保留，不得重算】';
    await seed(id, 'background', '迭代图·background', {
      sourceText: '井水很凉。', parentJobId: parentId, guidance: '把光线调暖一点',
      prompt: sentinel,
    });
    const before = llmCalls();
    await runAssetGenOnce();
    const r = await rowOf(id);
    expect(r.status).toBe('succeeded');
    expect(r.prompt).toBe(sentinel);     // 逐字复用，没有被 LLM 覆盖
    expect(llmCalls()).toBe(before);     // 关键：**没有**再发生一次 LLM 调用
  });

  it('图类 job 的参考图真的透传给了 provider（mock 把非空白参考图编成 &ref=1）', async () => {
    // spec 合规审查的缺口：原用例名写着「带锚图作参考图」，断言里却没有一处碰参考图 ——
    // 把 generate() 的 referenceUrls 整个删掉，它照样绿。
    // 判据：MockImageProvider 在 referenceUrls 非空白时把 `&ref=1` 编进返回 url，
    // 调度器随后会 fetch 那个 url 去转存 —— 于是它出现在 fetch 的入参里。
    // （落地到 design_assets.url 的是**转存后的 OSS 地址**，不含 ref=1，别在那儿找。）
    // 边界（如实标注）：这只能证明「传了某个非空参考图」，**不能**区分传的是锚图还是别的 URL
    // —— mock 不编码参考图的值。本任务范围内 referenceUrls 只有锚图一个来源。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-ref`;
    await seed(id, 'background', '参考图·background', { sourceText: 'x' });
    const before = baseFetch.mock.calls.length;
    await runAssetGenOnce();
    expect((await rowOf(id)).status).toBe('succeeded');
    const urls = baseFetch.mock.calls.slice(before).map((c: any) => String(c[0]));
    expect(urls.some((u: string) => u.includes('placeholder.local/background') && u.includes('ref=1')))
      .toBe(true);
  });

  it('素材名按码点截断：含 emoji 的名字不会落成 U+FFFD', async () => {
    // `fitName` 按码点算长度，含 emoji 时产出的 100 码点名 UTF-16 长度 > 100；
    // `String(name).slice(0, 100)` 会从代理对中间切开 → 落库被编码成 U+FFFD（静默脏值）。
    await db.update(pmsBuiWenlvProducts).set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
      .where(eq(pmsBuiWenlvProducts.id, P));
    const id = `${B}-emoji`;
    const name = `${'甲'.repeat(99)}🎨`;   // 100 码点 / UTF-16 长度 101
    await seed(id, 'background', name, { sourceText: 'x' });
    await runAssetGenOnce();
    expect((await rowOf(id)).status).toBe('succeeded');
    // 从库里读回来 —— 断言必须过真实编码往返（内存串上的 U+FFFD 检查是恒真的）。
    const [a] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, `wa-${id}`)).limit(1);
    expect(a.name).toBe(name);
    expect(a.name).not.toContain('�');
  });

  it('锚图先就绪的保证覆盖**全部**同批锚图，不是前 CLAIM_LIMIT 条', async () => {
    // ≥4 个产品的锚图同 tick 待领（批量触发 / 停机后积压）时：单轮领取只拿走 3 条锚图，
    // 第 4 个及以后的锚图留在 pending；紧接着「无类型过滤」那一轮按 created_at 领，
    // 可能先拿到那个产品的 image job → 抛「该剧本还没有风格锚图」→ **永久 failed**
    //（领取只认 pending，failed 不会被自动重领）。
    // created_at 显式赋值，把 PG 在同时间戳下不确定的行序**变成确定**：
    // 4 张图全部早于 4 条锚图，且 D 的图排在最早 —— 于是旧实现的第二轮一定先领到 D 的图，
    // 而 D 的锚图此刻还没回写。
    const imgOrder = [3, 0, 1, 2];   // 最老 → 最新：D, A, B, C
    const t0 = Date.now() - 600_000;
    for (let i = 0; i < 4; i++) {
      await seed(`${B}-p4img-${i}`, 'background', `锚图循环图${i}·background`, {
        productId: P4[imgOrder[i]], sourceText: 'x', createdAt: new Date(t0 + i * 1000),
      });
    }
    for (let i = 0; i < 4; i++) {
      await seed(`${B}-p4anchor-${i}`, 'anchor', `锚图循环锚${i}`, {
        productId: P4[i], createdAt: new Date(t0 + 10_000 + i * 1000),
      });
    }
    await runAssetGenOnce();
    await runAssetGenOnce();   // 每 tick 的「其余」只领 CLAIM_LIMIT 条，两次才排干
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    const mine = rows.filter(r => r.id.includes('-p4'));
    expect(mine.length).toBe(8);
    // 具名诊断先行：只有这一条会把「锚图未就绪」的误杀指出来
    expect(mine.filter(r => String(r.errorMessage ?? '').includes('风格锚图'))
      .map(r => `${r.id}:${r.errorMessage}`)).toEqual([]);
    expect(mine.filter(r => r.status !== 'succeeded')
      .map(r => `${r.id}:${r.status}:${r.errorMessage}`)).toEqual([]);
    // 4 个产品都拿到了锚图（回写生效），这是后续素材能生成的先决条件
    for (const pid of P4) {
      const [p] = await db.select().from(pmsBuiWenlvProducts)
        .where(eq(pmsBuiWenlvProducts.id, pid)).limit(1);
      expect(p.styleAnchorUrl).toBeTruthy();
    }
  });

  it('领取返回行上四个**多词列**都读得到（db.execute 不做列名映射的静默陷阱）', async () => {
    // 缺陷 3：claimNextJobs 内部是 `db.execute(sql...)`，那条通道 drizzle **不做列名映射**。
    // 若实现图省事把 `RETURNING *` 的行直接当 camelCase 用，这四列会读成 undefined：
    // 不抛异常、ts-check 也过（返回类型 any），但每一行都判错类型、读不到基线、锚图全灭。
    // 前三个字段本文件的其它用例能**间接**罩到（nodeId/sourceText/styleBibleSnapshot），
    // 只有 `parentJobId` 罩不住 —— 实现里是 `if (job.parentJobId)`，null 与 undefined
    // 同为假值、行为完全一致，读错也静默通过。所以必须**具名断言**，不能靠「跑绿了」反推。
    const id = `${B}-cols`;
    const parentId = `${B}-cols-parent`;
    await seed(id, 'background', '列名断言', {
      nodeId: N, parentJobId: parentId, sourceText: '井水很凉。',
    });
    const got = await claimNextJobs(1) as any[];
    // 全库语义：库里若有**别的** pending 残留会先被领走（本文件靠 runAssetGenOnce 把每批排干，
    // 且本地库基线为 0 行）。万一真被外星行抢先，这里必须**报错**而不是 `if (!mine) return`
    // 静默跳过 —— 后者会让这条用例变成恒绿，正是要防的事。
    expect(got.length).toBe(1);
    expect(got[0].id).toBe(id);
    const job = got[0];
    expect(job.nodeId).toBe(N);
    expect(job.parentJobId).toBe(parentId);
    expect(job.sourceText).toBe('井水很凉。');
    expect(job.styleBibleSnapshot).toEqual(BIBLE);
  });

  // ⚠️ 与 New-1 **不是**重复用例，钉的是两条不同的路径：
  //    New-1：上界**命中**时不许进第 3 步（「本轮到此为止」的健康推迟）。
  //    本条：第 3 步**本身必须带前置条件**。锚图已 failed（不是「还没回写」，是**永远不会回写**）
  //         时，第 2 步的领取循环会正常空转退出（`anchors.length === 0` → break），
  //         第 3 步照常执行 —— 没有任何上界拦得住它。历史那 7 次 flake 的红正是这个形状。
  describe('第 3 步的前置条件（锚图已判死时不得领它的图类 job）', () => {
    // PF：锚图 `status='failed'`（上游报错，或 running 停机后被我 reclaimStale 收回）。
    //     它的图类 job 若在第 3 步被领走 → `generateImageJob` 抛「该剧本还没有风格锚图」
    //     → 也变 failed ⇒ `claimNextJobs` 只认 pending，**没有任何自动路径把它变回 pending**
    //     ⇒ 永久判死，只能人工 /retry（钱没白花：抛在上游调用之前）。
    // PA：**对照组**，锚图已就绪，它的图类 job 必须成功。这条断言让整个用例无法空真 ——
    //     没有它，「PF 的 job 仍是 pending」在「第 3 步压根没跑 / 没领到」时同样成立（恒绿）。
    const PF = `sched-prod-doomed-${Date.now()}`;
    const PA = `sched-prod-anchored-${Date.now()}`;
    const T_OLD = new Date(Date.now() - 7_200_000);

    beforeEach(async () => {
      await db.insert(pmsBuiWenlvProducts).values([
        { id: PF, name: '锚图已判死剧本', styleBible: BIBLE, styleAnchorUrl: null },
        { id: PA, name: '锚图就绪剧本', styleBible: BIBLE, styleAnchorUrl: 'https://oss.test/anchor.png' },
      ]).onConflictDoNothing();
      // `prompt` 全部**非空**：走「逐字复用」分支，不调 LLM —— 让本例只依赖锚图这一件事，
      // 不掺进画面描述生成的成败（锚图守卫在复用分支**之前**，仍然管得住）。
      await db.insert(pmsBuiWenlvAssetJobs).values([
        {
          id: `${B}-pc-anchor`, batchId: B, productId: PF, assetType: 'anchor', name: '风格定调图',
          prompt: null, styleBibleSnapshot: BIBLE, status: 'failed', attempt: 1,
          errorMessage: '模拟：锚图生成失败', costAmount: '0', createdAt: T_OLD,
        },
        // 被钉住的行：created_at **最老** ⇒ 旧实现里第 3 步必然第一条就领到它（不靠行序运气）
        {
          id: `${B}-pc-img`, batchId: B, productId: PF, assetType: 'background', name: '待判死图·background',
          prompt: '上一版已经算好的画面描述', styleBibleSnapshot: BIBLE, sourceText: 'x',
          status: 'pending', attempt: 0, costAmount: '0', createdAt: T_OLD,
        },
        // 对照行：晚 1 秒，紧随其后被领到
        {
          id: `${B}-pc-ctl`, batchId: B, productId: PA, assetType: 'background', name: '对照图·background',
          prompt: '上一版已经算好的画面描述', styleBibleSnapshot: BIBLE, sourceText: 'x',
          status: 'pending', attempt: 0, costAmount: '0',
          createdAt: new Date(T_OLD.getTime() + 1000),
        },
      ]);
    });
    afterAll(async () => {
      await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, [PF, PA]));
    });

    it('锚图 failed 的产品，其图类 job 留 pending 等人工处置；同 tick 里有锚图的图正常出', async () => {
      // 多跑几 tick：第 3 步每轮只领 CLAIM_LIMIT(3) 条，库里若有别的 pending 残留
      // 会被先领走（全表语义）。对照行很老，正常 1-2 轮就到手。
      for (let i = 0; i < 5; i++) await runAssetGenOnce();
      const ctl = await rowOf(`${B}-pc-ctl`);
      const img = await rowOf(`${B}-pc-img`);
      // ★ 对照先断：它证明第 3 步**真的执行过**。缺了它，下面的 pending 断言在
      //   「第 3 步没跑 / 没领到」时同样成立 —— 那正是本用例要防的假绿。
      expect(ctl.status).toBe('succeeded');
      expect(img.status).toBe('pending');
      expect(img.attempt).toBe(0);                                     // 连领都没领过
      expect(String(img.errorMessage ?? '')).not.toContain('风格锚图');   // 没被那句误杀
    });
  });

  // ⚠️ 放在**最后**：它跑完会故意留 1 条锚图 + 1 条图类任务在 pending（这正是被断言的行为），
  //    后面的用例若还会 `claimNextJobs` 会被它们抢戏。afterAll 按 batchId 清掉。
  it('锚图上界命中时**不领**其余任务：锚图未回写的图留在 pending 而非被判死（New-1）', async () => {
    // 病态积压：单 tick 的锚图数超过 MAX_ANCHOR_ROUNDS(20) × CLAIM_LIMIT(3) = 60。
    // 上界命中时若只是 `break`，第 3 步（无类型过滤）会立刻领走**锚图尚未回写**的产品的
    // image job → 抛「该剧本还没有风格锚图」→ failed，而 failed 不会被自动重领 ⇒ 永久判死。
    // 断言落点：那一条图必须**仍留在 pending**（推迟到下一 tick），且没有任何一条
    // 带「风格锚图」错误的 job。把实现改回 `break`，本用例必红 —— 无需任何运行期开关。
    await db.insert(pmsBuiWenlvProducts).values({
      id: PX, name: '上界锚图剧本', styleBible: BIBLE, styleAnchorUrl: null,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({
      id: PY, name: '无锚图剧本', styleBible: BIBLE, styleAnchorUrl: null,
    }).onConflictDoNothing();
    // 61 条锚图（都挂 PX）：第 20 轮检查命中时仍有 1 条 pending —— 上界真的「命中」了。
    const t0 = Date.now() - 3_600_000;
    await db.insert(pmsBuiWenlvAssetJobs).values(
      Array.from({ length: 61 }, (_, i) => ({
        id: `${B}-ub-anchor-${i}`, batchId: B, productId: PX, assetType: 'anchor',
        name: `上界锚${i}`, prompt: null, styleBibleSnapshot: BIBLE,
        status: 'pending', attempt: 0, costAmount: '0',
        createdAt: new Date(t0 + 1000 + i * 100),
      })),
    ).onConflictDoNothing();
    // 图类任务属于**另一个没有任何锚图**的产品，且 created_at 最老 ——
    // 只要第 3 步执行，它一定是第一条被领走的，且必然 failed。
    await seed(`${B}-ub-img`, 'background', '上界图·background', {
      productId: PY, sourceText: 'x', createdAt: new Date(t0),
    });

    await runAssetGenOnce();

    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    const mine = rows.filter(r => r.id.includes('-ub-'));
    expect(mine.length).toBe(62);
    // ★ 本用例此前**只**断言「上界命中时不领其余」，**没**断言「这 60 条锚图真的成了」。
    //   实测：把 `buildAnchorPrompt` 整段改成抛错，本用例**照样全绿** —— 即「看着绿、实际恒绿」。
    //   60 = MAX_ANCHOR_ROUNDS(20) × CLAIM_LIMIT(3)；第 61 条留到下一 tick，故仍 pending。
    expect(mine.filter(r => r.id.includes('-ub-anchor-') && r.status === 'succeeded').length).toBe(60);
    expect(mine.filter(r => r.id.includes('-ub-anchor-') && r.status === 'pending').length).toBe(1);
    // 具名诊断先行：只有这一条会把「锚图未就绪」的误杀指出来
    expect(mine.filter(r => String(r.errorMessage ?? '').includes('风格锚图'))
      .map(r => `${r.id}:${r.errorMessage}`)).toEqual([]);
    // 真正被断言的行为：那条图**留在 pending**（下一 tick 锚图就绪后自然能跑），不是 failed
    expect((await rowOf(`${B}-ub-img`)).status).toBe('pending');
  });

  // ===== 图鉴条目素材（第 6 类 collectible）：真名反查 + 回写 collectibles.image =====
  //
  // 钉两件事，合在一个用例里是因为它们共用同一批夹具：拆开只会让「job 压根没被领取」
  // 这类失败在两处重复出现，诊断反而更难读。
  describe('图鉴条目素材（collectible）', () => {
    // **独立**产品/节点/条目 —— 不复用 P、N：
    //   · P 的 styleAnchorUrl 被多条用例来回置空/种上；
    //   · N 的 image 被 background 回写用例改写、narration 用例写 narrationUrl。
    // 复用会让本用例断言的**初值**取决于执行顺序（单跑与全量跑不一样），
    // 正是本文件开头那段「用例之间没有隔离」的同一个病。
    const PC = `sched-prod-col-${Date.now()}`;
    // PC 下的真实场景：给「不得写 scenes.image」那条负向断言一个**非空集合**。
    // 空集合上 `.every()` 恒真 —— 那是一条零信号的假判据。
    const NC = `${B}-col-node`;
    const ROOM_PC = `room-${PC}`;
    const CH_PC = `ch-${PC}`;
    const COL = `${B}-col-1`;         // 图鉴条目 id（回写键）
    const COL_NAME = '半枚残破铜钱';   // 权威源（collectibles.name）里的真名

    beforeAll(async () => {
      await db.insert(pmsBuiWenlvProducts).values({
        id: PC, name: '图鉴剧本', styleBible: BIBLE, styleAnchorUrl: null,
      }).onConflictDoNothing();
      await db.insert(pmsBuiWenlvScriptRooms).values({
        id: ROOM_PC, contentId: PC, name: '图鉴房', mode: 'narrative',
      }).onConflictDoNothing();
      await db.insert(pmsBuiWenlvChapters).values({
        id: CH_PC, scriptRoomId: ROOM_PC, title: '第一章', order: 0,
      }).onConflictDoNothing();
      await db.insert(pmsBuiWenlvScenes).values({
        id: NC, chapterId: CH_PC, title: '图鉴陪跑节点', image: null, type: 'narrative',
      }).onConflictDoNothing();
      await db.insert(pmsBuiWenlvCollectibles).values({
        id: COL, productId: PC, name: COL_NAME,
        description: '半枚铜钱，边缘残破，字迹模糊。', image: null,
      }).onConflictDoNothing();
    });
    afterAll(async () => {
      await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, COL));
      await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, NC));
      await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_PC));
      await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PC));
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PC));
    });

    it('印章任务**有**条目归属时：资产 id 合并进 collectibles.stamp_meta.stampAssetId，且不抹掉既有子键', async () => {
      // 这是外层 «印章任务在没有条目归属时不回写» 那条的**正向对照** ——
      // 「期望 0」必须配一条「期望 ≥1」，否则它可能在任何实现下都绿。
      //
      // 它还补上一条此前**没有任何用例证明过**的链路：**scheduler 真的把 stamp 的
      // `targetId` 交给了回写器**。stamp 的纯函数单测（writeback.test.ts 的手写表）只钉
      // `buildWritebackPlan`，writeback.db.test.ts 直接调 `applyWriteback` 绕过了 scheduler
      // —— 中间那一跳今天是无人看守的。
      // 下面那条「`shape` 还在」是**集成层**的重述 —— 合并语义本身已由
      // writeback.db.test.ts 的 «stamp → stamp_meta.stampAssetId，且**不抹掉**既有子键»
      // 在 DB 层钉住。这里再断一次，是为了让「整列覆盖」这个回归在这一跳上也可见
      //（它若发生，两端会同时红，而这一端的报错更贴近症状）。
      //
      // ⚠️ 本用例与同一 describe 里的 collectible 用例**共用 COL**（本文件靠 `it` 的执行顺序，
      //    没有事务隔离）。这里只写 `stampMeta`、那边只写 `image`，互不干扰；
      //    但若将来给任一方加了「断言整行」，这个共享就会变成隐式耦合。
      await db.update(pmsBuiWenlvProducts)
        .set({ styleAnchorUrl: 'https://oss.test/col-anchor.png' })
        .where(eq(pmsBuiWenlvProducts.id, PC));
      // 种一个**已存在的**子键：实现若退化成整列覆盖，下面 `shape` 那条会红。
      await db.update(pmsBuiWenlvCollectibles)
        .set({ stampMeta: { shape: 'round' } })
        .where(eq(pmsBuiWenlvCollectibles.id, COL));
      const id = `${B}-stamp-writeback`;
      await seed(id, 'stamp', `${COL_NAME}·stamp`, {
        productId: PC, collectibleId: COL, nodeId: null,
        sourceText: '半枚铜钱，边缘残破，字迹模糊。',
      });

      await runAssetGenOnce();

      const r = await rowOf(id);
      expect(r.status).toBe('succeeded');
      const [after] = await db.select().from(pmsBuiWenlvCollectibles)
        .where(eq(pmsBuiWenlvCollectibles.id, COL)).limit(1);
      // 写进去的是 **design_assets 的 id**，不是 URL —— 注册表里 stamp 的
      // `writeback.value === 'assetId'` 是它与其余图类唯一的差别，这里把它钉住。
      const written = after.stampMeta?.stampAssetId;
      // 这两条**必须都在**，且顺序无关：`toBe` 在「两边同为 undefined」时也是绿的，
      // 只留下面那条的话，「压根没写」与「写对了」分不开。
      // `?? undefined` 是为了两侧同型（`toBe` 的入参类型由 actual 推断：`string | undefined`
      // vs `r.assetId` 的 `string | null` 不兼容，ts-check 会红）。
      expect(r.assetId).toBeTruthy();
      expect(written).toBe(r.assetId ?? undefined);
      expect(written).toBeTruthy();
      // 既有子键必须还在 —— 整列覆盖会让它变 undefined，且不报任何错。
      expect(after.stampMeta?.shape).toBe('round');
      // 反向：印章是**条目级**的，不得写节点图（「一个字段名两种语义」的越界）。
      // 先断集合非空 —— `[].every()` 恒真，是零信号的假判据（NC 就是为此存在）。
      const nodesAfter = await db.select().from(pmsBuiWenlvScenes)
        .where(eq(pmsBuiWenlvScenes.chapterId, CH_PC));
      expect(nodesAfter.length).toBeGreaterThan(0);
      expect(nodesAfter.every((n) => n.image === null)).toBe(true);
    });

    it('回写 collectibles.image（nodeId 恒为 null ⇒ 绝不写 nodes.image），且喂给 LLM 的是真名', async () => {
      // ⚠️ `styleAnchorUrl` 必须在**本用例内**种上，不能靠 beforeAll 默认值：
      //    第 3 步的领取带 `requireAnchorReady`，它只豁免 anchor/narration，
      //    collectible 属图类 —— 锚图为空时这条 job **压根不会被领取**，
      //    下面所有断言都会以「任务停在 pending」的形式失真。
      await db.update(pmsBuiWenlvProducts)
        .set({ styleAnchorUrl: 'https://oss.test/col-anchor.png' })
        .where(eq(pmsBuiWenlvProducts.id, PC));
      // 夹具形状与 enqueue.ts 的 collectibles 展开循环**同构**：
      //   name 带 `·collectible` 后缀（planBatch 的 fitName 拼的）、nodeId **恒为 null**、
      //   collectibleId 是回写键、sourceText 是条目 description 的快照、prompt 为 null（现算）。
      const id = `${B}-collectible`;
      await seed(id, 'collectible', `${COL_NAME}·collectible`, {
        productId: PC, collectibleId: COL, nodeId: null,
        sourceText: '半枚铜钱，边缘残破，字迹模糊。',
      });

      const callsBefore = baseFetch.mock.calls.length;
      await runAssetGenOnce();

      const r = await rowOf(id);
      expect(r.status).toBe('succeeded');

      // 1) 图鉴条目 job 成功后，collectibles.image 被回写成 OSS URL —— 断言打在**库里的行**上。
      const [after] = await db.select().from(pmsBuiWenlvCollectibles)
        .where(eq(pmsBuiWenlvCollectibles.id, COL)).limit(1);
      // 形状 = `uploadToOSS` 桩的 `https://oss.test/${key}`，key = `pms/wenlv/image/<jobId>-<i>.<ext>`。
      // 多候选后 key 带了组内序号（scheduler 的 `-${i}`，Task 10）—— 本用例是单候选，故 `-0`。
      // ext 由**实际字节**判定（image-type.ts）：本文件的下载桩只给 8 个零字节、且没有
      // content-type ⇒ 认不出格式，走历史兜底 `png`（与「落 OSS 的扩展名」那条用例同口径）。
      expect(after.image).toBe(`https://oss.test/pms/wenlv/image/${id}-0.png`);
      expect(after.image).not.toContain('placeholder.local');   // 是转存后的地址，不是上游 URL

      // 2) 负向：本产品下**没有任何** nodes 行被写。
      //    一条 nodeId 为 null 的 collectible job 绝不能回写到 nodes.image ——
      //    「一个字段名两种语义」造成的越界正是这个形状。
      //    ★ 先断集合**非空**：`[].every()` 恒为 true，是一条零信号的假判据；
      //      NC 就是为这条对照而存在的。
      const nodesAfter = await db.select().from(pmsBuiWenlvScenes)
        .where(eq(pmsBuiWenlvScenes.chapterId, CH_PC));
      expect(nodesAfter.length).toBeGreaterThan(0);
      expect(nodesAfter.every((n) => n.image === null)).toBe(true);
      expect(after.image).not.toBeNull();   // ←「期望 ≥1」的对照，缺了它就是恒绿死断言

      // 3) 喂给 LLM 的提示词里不得出现类型后缀。
      //    本文件的 LLM 是在 `fetch` 层被假掉的（`baseFetch = vi.fn(echoFetch)`），
      //    要断言的是 **baseFetch 收到的请求体**，不是 job.prompt —— 断言请求体更直接：
      //    job.prompt 要先经 echoFetch 的回显夹具才带上素材名，绕了一层。
      //    ⚠️ 必须 `slice(callsBefore)`：`mock.calls` **跨用例累积**（baseFetch 在
      //       beforeAll 建、从不 clear）。裸 `find` 命中的会是前面某条用例的调用，
      //       那种提示词既不含 `·collectible` 也不含 COL_NAME ⇒ **两条负向断言恒绿**，
      //       而第一条正向断言会红得莫名其妙（红的理由与真名反查无关）⇒ 退化成误诊。
      const llmCall = baseFetch.mock.calls.slice(callsBefore)
        .find(([url]: any[]) => typeof url === 'string' && url.includes('dashscope'));
      expect(llmCall).toBeTruthy();   // 缺了这条，下面三条断言会以「没跑」的形式全部通过
      const sent = JSON.stringify(llmCall?.[1]?.body ?? '');
      expect(sent).toContain(COL_NAME);
      expect(sent).not.toContain('·collectible');     // 真名反查生效（else-if 分支）
      expect(sent).not.toContain('（collectible）');   // Task 3 的 TYPE_LABEL 生效
    });
  });

  // ===== 总闸（Task 2）=====
  // 放在 New-1 **之后**：New-1 有意留下 pending 残留，而本块每个用例都靠外层 `beforeEach`
  // 按 batchId 清干净（两个 it 的 `runAssetGenOnce` 因此不会领到上一条用例的行）。
  describe('总闸（env WENLV_ASSET_GEN_PAUSED / 内存开关）', () => {
    afterEach(() => {
      setAssetGenPaused(false);
      delete process.env.WENLV_ASSET_GEN_PAUSED;
    });

    it('暂停时：不领取、不调用上游、也**不 reclaimStale**', async () => {
      // 造一条 running 且 startedAt 老于 STALE_MINUTES(15min) 的行 —— 若闸的位置晚于
      // reclaimStale，这条会被打回（判成 failed/「超时未返回」）。用「它仍是 running」
      // 来钉住闸的顺序，比断言「fetch 没被调」有区分力得多：把闸挪到 reclaimStale 之后，
      // fetch 计数那条**照样绿**（reclaimStale 只写库、一次网络都不发）。
      const staleId = `${B}-pause-stale`;
      await seed(staleId, 'background', '暂停期超时行·background', {
        sourceText: 'x', status: 'running',
        startedAt: new Date(Date.now() - 20 * 60 * 1000),
      });
      // 再种一条**本可被领取**的 pending 行（产品已配锚图 ⇒ 领取过滤放行）：
      // 闸若没生效或位置偏后，它会被领走 —— `attempt` 由 claim 置 1，这是「领没领过」
      // 最直接的观测（只看 status 会被「领走后立刻失败」混淆成 failed，也是红的，
      // 但红在同一处、说不出是「没领」还是「领了但失败」）。
      await db.update(pmsBuiWenlvProducts)
        .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
        .where(eq(pmsBuiWenlvProducts.id, P));
      const pendingId = `${B}-pause-pending`;
      await seed(pendingId, 'background', '暂停期待领行·background', { sourceText: 'x' });

      setAssetGenPaused(true);
      const fetchCallsBefore = baseFetch.mock.calls.length;
      await runAssetGenOnce();

      expect((await rowOf(staleId)).status).toBe('running');       // 未被 reclaim
      const pending = await rowOf(pendingId);
      expect(pending.status).toBe('pending');                      // 未被领取
      expect(pending.attempt).toBe(0);                             // 连领都没领过
      expect(baseFetch.mock.calls.length).toBe(fetchCallsBefore);  // 未发上游请求
    });

    it('关掉开关后能正常推进（证明闸是可逆的，不是单向死锁）', async () => {
      await db.update(pmsBuiWenlvProducts)
        .set({ styleAnchorUrl: 'https://oss.test/anchor.png' })
        .where(eq(pmsBuiWenlvProducts.id, P));
      const id = `${B}-pause-resume`;
      await seed(id, 'background', '恢复后·background', { sourceText: 'x' });

      setAssetGenPaused(true);
      await runAssetGenOnce();
      // 暂停期间确实一趟都没跑 —— 没有这句，「恢复后成功」在「闸压根没生效」时同样绿（恒真）
      expect((await rowOf(id)).status).toBe('pending');

      setAssetGenPaused(false);
      await runAssetGenOnce();
      const r = await rowOf(id);
      expect(r.status).toBe('succeeded');
      expect(r.assetId).toBeTruthy();      // 真的产出了，不是「静默放过」
    });
  });
});
