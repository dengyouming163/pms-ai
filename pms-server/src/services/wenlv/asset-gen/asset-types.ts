/**
 * 素材**类型注册表**（子项目①）。
 *
 * ## 为什么存在
 *
 * 在此之前，「素材类型」的知识分散在 **4 个文件**里各写一份：
 *   · enqueue.ts        —— GeneratableType / JobAssetType 联合、PUBLIC_POOL_TYPES、
 *                          NODE_SCOPED_TYPES、PRODUCT_LEVEL_NAME、iterationBlockReason
 *   · prompt-builder.ts —— TYPE_LABEL
 *   · routes/admin/wenlv-asset-gen.ts —— VALID_TYPES
 *   · wenlv-asset-gen-scheduler.ts    —— 回写的 if/else 分支
 * 加一个类型要动**这 4 个文件**（共 8 处以上常量/联合），**漏一处就静默失效**。
 * （已 grep 核实：持有这几个常量的就是且仅是上面 4 个文件。别把 4 写成 5 ——
 *  `routes/admin/wenlv-design.ts:79` 那份 `assetTypes` 与 `claim.ts:67` 的
 *  `asset_type IN (...)` 是**另一类清单**，注册表不收它们。）
 *
 * ⚠️ **但 `stamp` / `icon` 曾经的「无回写键」不是「漏改第 5 处」来的。** 真实根因是
 *    **展开键归错了维度**（当年把它们按「节点」展开，而回写目标是条目/档位），
 *    导致拿不到权威的 `target_id`；scheduler 当时的处理是**有意**不写 ——
 *    「与其猜错，不如不写」。**那段注释与分支已在 Task 6 随整块一起删除**
 *    （本句原先写死 `wenlv-asset-gen-scheduler.ts:484-486`，删块后那些行号
 *    指向的是 `buildWritebackPlan` 调用 —— 注释指着空气，且照样骗过只读行号的人）。
 *    别把它读成「本该回写、只是被漏了」，那会诱使人给它们接一个**按标题猜**的回写键。
 *    **本轮的处置不是「补一个键」，而是把展开键归回正确维度**（见下面两条 `scope` 注释）——
 *    归对之后 `stamp` / `icon` 各自拿到了权威的 `target_id`，于是它们**现在真的回写**
 *    （`collectibles.stamp_meta.stampAssetId` / `reward_tiers.icon`）。
 *
 * ## 本文件持有什么
 *
 * **`JobAssetType` / `GeneratableType` 的唯一定义处。** enqueue.ts 从这里 re-export
 * （而不是反过来）—— 否则 enqueue.ts 既定义类型又要 import 本表，形成循环依赖。
 *
 * ⚠️ **本文件就是唯一定义处**（Task 3 已经把 enqueue.ts 切过来）：`enqueue.ts` 那边
 * 只剩**两句** —— 一句 `import { … } from './asset-types.js'`（带内联 `type` 修饰符引入
 * `GeneratableType` / `JobAssetType`；**它自己还要在本地用这两个类型**，所以必须 import，
 * 不能只写一句话把它转出去），外加**单独一句** `export type { GeneratableType,
 * JobAssetType };`，把名字转出去给既有的 import 点。理由与坑见 enqueue.ts 那段 `import`
 * 上方的注释 —— 两处说的是同一件事，别读成两种写法。全仓再没有第二份 `GeneratableType` /
 * `JobAssetType` 定义 —— 改这里的联合，所有消费方一起变。
 *
 * ## 本文件不持有什么
 *
 * 展开成 job 行的**具体逻辑**仍在 enqueue.ts 的 planBatch；本文件只回答
 * 「有哪些类型、各自的展开键是什么、回写去哪、能不能迭代、判据是什么」。
 */
import type { WritebackDef } from './writeback-type.js';

/** 用户**可选**的素材类型。`anchor` 不在其中 —— 它由系统自动补。 */
export type GeneratableType =
  | 'background' | 'stamp' | 'cover' | 'icon' | 'narration' | 'collectible'
  | 'ending' | 'reward' | 'npc_portrait' | 'character_avatar' | 'ar';

/** 实际落库的 job 类型 = 用户可选的 + 系统自动补的锚图 + 自举基线/评审的**合成行**。 */
export type JobAssetType = GeneratableType | 'anchor' | 'style_bible' | 'review';

/**
 * 素材类型的**展开键** —— 一批 job 按什么维度乘开。
 *
 * **互不重叠**：
 *   product     每批 1 条（一个剧本一份）
 *   node        每个节点 1 条
 *   collectible 每个图鉴条目 1 条
 *   ending      每个结局 1 条
 *   reward      每个奖励 1 条
 *   tier        每个奖励档位 1 条
 *   npc         每个 NPC 1 条（T18：立绘，spec §5.4 S2 stage）
 *   character   每个角色 1 条（T11：头像，spec §11）
 *
 * ⚠️ 别按「不是 product 就是 node」去推断新类型 —— `collectible` 当年就是被这样归错的，
 *    导致每个节点各产一条图鉴 job（N 节点 = N 条语义错误的 job、N 次白计费）。
 */
export type AssetScope = 'product' | 'node' | 'collectible' | 'ending' | 'reward' | 'tier' | 'npc' | 'character';

export type AssetTypeDef = {
  type: JobAssetType;
  /** 短名。用于 job 名、UI 列表、评审上下文。**不要**拿它当 prompt 文案。 */
  label: string;
  /**
   * 喂给 LLM 的**完整中文说明**（`buildScenePrompt` 的「素材：」那一行）。
   *
   * ⚠️ 与 `label` **刻意分开**：它们的取值域不同，且本字段有**逐字节不得变**的约束
   *    （见 `__tests__/prompt-builder-label.test.ts`）。五类既有类型的值是从
   *    `prompt-builder.ts` 原样搬过来的，**改一个字就是改所有图的提示词**。
   */
  promptLabel: string;
  /** 展开键。取代 enqueue.ts 的 NODE_SCOPED_TYPES / PRODUCT_LEVEL_NAME 两个常量。 */
  scope: AssetScope;
  /**
   * 回写目标。`null` = **不经 `applyWriteback` 回写**。
   *
   * ⚠️ 别把 `null` 读成「不回写业务表」—— 旁白（`narration`）就回写 `nodes.narrationUrl`，
   *    只是由 `writeNarrationUrl` 单点承担。判据是「走不走 `applyWriteback`」，不是「写不写库」。
   *
   * **取代了** `pms-server/src/services/wenlv-asset-gen-scheduler.ts` 里原先的两段硬编码回写：
   *   · `if (isAnchor) { … products.styleAnchorUrl }`
   *   · `if (background) … else if (cover) … else if (collectible) …`（三个分支）
   * 两段都已删除，锚图与其余图类现在走同一条查表路径。
   *
   * ⚠️ **本注释不写行号。** 上面那句曾写成「`scheduler.ts:487-513` 的三个硬编码分支」
   *    「锚图 `:471`」—— Task 6 删块之后那些行号**一个都不存在了**，
   *    而注释照样留在文件里指着空气（同时骗过所有只读 grep 行号的人）。
   *    要定位请 grep 函数名 / 语句，别 grep 行号。
   */
  writeback: WritebackDef;
  /**
   * 能不能「迭代一版」。
   *
   * ⛔ **本字段*不*取代 `enqueue.ts:387-398` 的 `iterationBlockReason()`** ——
   * 那个函数返回的是**面向用户的整句文案**（「旁白不支持迭代：文案没变，重出只会得到
   * 一段一模一样的音频（白花一次语音合成费）」），本字段是**给开发者看的短理由**。
   * 两者**并存、口径不同**，别把函数的返回值换成 `def.iterationBlockReason ?? null`
   * —— 那等于把用户可见文案改写成开发口径，而**漂移守卫抓不到**（它只比非空性）。
   * 详见 Task 3 Step 4 第 5 条。
   */
  iterable: boolean;
  /** `iterable: false` 时必填 —— 理由要能给人看。 */
  iterationBlockReason?: string;
  /**
   * 这个类型的参考图**意图**。
   *
   * ⚠️ **本字段目前是纯声明式的，本轮没有任何代码读它**（已 grep 全计划核实）。
   *    「本次实际发哪几张参考图」由 **Task 10** 从 `products.styleReferences`（风格图集）
   *    + 锚图现场装配，落进 job 行的 `reference_urls`，再传给
   *    `imageProvider.generate(prompt, { referenceUrls })`。
   *    **别拿它去写分支**（例如「`self` 就跳过取参考图」）—— 那条路径根本不经过注册表，
   *    写了也不会生效，只会留下一个永远走不到、也永远测不到的分支。
   *    它的用途是**给人和后续子项目②③④看**：这类素材在设计上应当以什么为参考基准。
   *
   *    另：`'anchor-only'` 目前**没有任何条目在用**（本表条目里只有 `style-set` 与 `self`），
   *    是为后续子项目留的取值。若下一轮仍无人用，应连同本字段一起删掉，别让它烂在类型里。
   */
  references: 'style-set' | 'anchor-only' | 'self';
  /** 类型专属评审判据（第 4 层）。留空则只用通用项与基线派生项。 */
  criteria?: string[];
};

/** 无需参考图的两种情形共用一个理由：它们是参考图的**产出者**，或与视觉无关。 */
const SELF_REF = 'self' as const;

export const ASSET_TYPES: Record<JobAssetType, AssetTypeDef> = {
  anchor: {
    type: 'anchor', label: '风格定调图', scope: 'product',
    promptLabel: '风格定调图（画风样张，只表现世界观氛围，不描绘具体情节）',
    writeback: { entity: 'product', column: 'styleAnchorUrl', value: 'url' },
    iterable: false,
    iterationBlockReason: '锚图是其余素材的参考基准，改它等于给整批换一个世界',
    references: SELF_REF,
  },
  background: {
    type: 'background', label: '场景插画', scope: 'node',
    promptLabel: '点位背景插画（横幅，供游客在点位阅读剧情时作背景）',
    writeback: { entity: 'node', column: 'image', value: 'url' },
    iterable: true, references: 'style-set',
  },
  cover: {
    type: 'cover', label: '剧本封面', scope: 'product',
    promptLabel: '剧本封面海报（竖版，用于门票产品与分享）',
    writeback: { entity: 'product', column: 'coverImage', value: 'url' },
    iterable: true, references: 'style-set',
    criteria: ['有清晰的标题留白区，主体居中不顶边'],
  },
  // 角色头像。**方图优先**（端面 .card-avatar-wrap 是 96rpx 圆形容器 + aspectFit，
  // 构图要居中、留足圆形裁切余量）。主体是**人物本身**，不是它所在的场景 ——
  // 与 background 的差别就在这里。
  character_avatar: {
    type: 'character_avatar', label: '角色头像', scope: 'character',
    promptLabel: '角色头像（半身或头像特写，主体居中、占画面主体部分，圆形裁切下仍完整可辨）',
    writeback: { entity: 'character', column: 'avatarUrl', value: 'url' },
    iterable: true, references: 'style-set',
    criteria: ['单一人物、背景干净、面部清晰、圆形裁切不切掉头部关键部分'],
  },
  // 图鉴物件：主体是那件东西本身，不是它所在的场景 —— 与 background 的差别就在这里。
  // 方图更贴合 42px 缩略图为主的档案列表，但当前 provider 硬编码 size:'2K'（见 image-provider.ts），
  // 实际产出的不是方图，前端将用 aspectFill 方裁（图鉴区见本计划 Task 8/9）。**这里不承诺方形**，
  // 只要求构图居中、主体占画面主体部分，让方裁不切掉关键内容。
  // （原注释在 prompt-builder.ts 的 TYPE_LABEL 上，Task 4 取值迁到本表后随值搬来。）
  collectible: {
    type: 'collectible', label: '图鉴插画', scope: 'collectible',
    promptLabel: '图鉴物件插画（单件证物特写，主体居中、占画面主体部分，小尺寸缩略图下仍清晰可辨）',
    writeback: { entity: 'collectible', column: 'image', value: 'url' },
    iterable: true, references: 'style-set',
    criteria: ['单一物件、背景干净、可抠图（边缘清晰、无复杂投影）'],
  },
  narration: {
    type: 'narration', label: '点位旁白', scope: 'node',
    promptLabel: '点位旁白（音频素材，无画面）',
    // ⚠️ `writeback: null` 在这里**不等于「不回写业务表」** —— 旁白确实回写 `nodes.narrationUrl`，
    //    只是由 `writeback.ts` 的 `writeNarrationUrl` 单点承担，**不走 `applyWriteback`**。
    //    曾经这里声明的是 `{ entity:'node', column:'narrationUrl' }`（非空），但 `applyWriteback`
    //    的 `node` 分支根本不看 `column`：真喂进去会把旁白 URL 写进 `nodes.image`（覆盖背景图），
    //    **静默写错列**。改成 null 是把这把枪拆掉，不是承认旁白不回写。
    writeback: null,
    iterable: false,
    iterationBlockReason: '旁白由旁白文本直接合成，没有「迭代一版」的语义',
    references: SELF_REF,
  },
  // ⚠️ 展开键由「节点」**有意修正**为「条目」（迁移前它在 NODE_SCOPED_TYPES 里）。
  //    原先按节点展开，但回写目标是 collectibles.stamp_meta，而一个节点可以有多个章 ——
  //    按标题猜归属是定时炸弹。改成随条目展开后键才是权威的。
  stamp: {
    type: 'stamp', label: '集章印章', scope: 'collectible',
    promptLabel: '集章印章图案（圆形/方形章面，单色线条为主，便于印刷与叠印）',
    writeback: {
      entity: 'collectible', column: 'stampMeta', jsonKey: 'stampAssetId',
      // ⚠️ 与其余类型不同：写的是 **design_assets 的 id**，不是 URL。
      //    collectibles.stamp_meta 是 jsonb，stampAssetId 的语义就是资产 id。
      value: 'assetId',
    },
    iterable: true, references: 'style-set',
  },
  // ⚠️ 展开键由「节点」**有意修正**为「档位」。档位图标是每个 tier 一个，与节点无关。
  icon: {
    type: 'icon', label: '档位图标', scope: 'tier',
    promptLabel: '小图标（简洁单色，小尺寸可辨识）',
    writeback: { entity: 'tier', column: 'icon', value: 'url' },
    iterable: true, references: 'style-set',
  },
  ending: {
    type: 'ending', label: '结局插画', scope: 'ending',
    promptLabel: '结局插画（结局揭晓时的整幅画面，要有情绪收束感）',
    writeback: { entity: 'ending', column: 'image', value: 'url' },
    iterable: true, references: 'style-set',
    criteria: ['有情绪收束感（不是场景插画的平铺描述），与结局文本的基调一致'],
  },
  reward: {
    type: 'reward', label: '奖励视觉', scope: 'reward',
    promptLabel: '奖励视觉（作为奖品的物件或画面，要体现获得感和价值感）',
    writeback: { entity: 'reward', column: 'image', value: 'url' },
    iterable: true, references: 'style-set',
    criteria: ['作为奖品有明确的获得感与价值感；不出现真实品牌与货币符号'],
  },
  // NPC 立绘（T18，spec §5.4 S2 stage）：每个 NPC 一条 job，回写 `npcs.portrait_url`。
  // 与 collectible 同型——按**自身实体**展开，不与节点做笛卡尔积；`target_id` = NPC id。
  // **S2 不直接 UPDATE portrait_url**：本路由只入队 job，回写由素材流水线的
  // `applyWriteback` 在候选被采纳时单点承担（spec §5.4「选定后回写 npc.portrait_url」）。
  // promptLabel 含「单一形象，非多形态」—— NPC 立绘是**单一人**的半身像，
  // 与 ending/cover 的「整幅画面」语义不同，喂给 LLM 时不能混。
  npc_portrait: {
    type: 'npc_portrait', label: 'NPC 立绘', scope: 'npc',
    promptLabel: 'NPC 半身立绘（单一形象，非多形态；供对话气泡头图与立绘展示）',
    writeback: { entity: 'npc', column: 'portraitUrl', value: 'url' },
    iterable: true, references: 'style-set',
    criteria: ['半身像、单一形象、构图居中'],
  },
  // AR 显影灵体视频（P2-C）：每个节点一条 job，回写 `nodes.ar_asset_url`。
  // 与 background 同为 node 级展开，但走 video-provider（文生视频）而非 image-provider。
  // 视频必须纯黑背景（前端 screen 混合模式变透明），故 promptLabel 强调黑底约束，
  // 调度器 generateArJob 会在生成后跑 checkBlackBackground 质检。
  // iterable: false —— 视频生成成本高（Seedance 单条数元），且黑底质检规则固定，
  // 用户反馈无法改变黑底比例，重出只会白花钱。
  ar: {
    type: 'ar', label: 'AR 灵体视频', scope: 'node',
    promptLabel: 'AR 显影灵体视频（纯黑背景，主体居中，供前端 screen 混合模式叠加实现透明效果）',
    writeback: { entity: 'node', column: 'arAssetUrl', value: 'url' },
    iterable: false,
    iterationBlockReason: 'AR 灵体视频不支持迭代：视频生成成本高，且黑底质检规则固定，用户反馈不会改变黑底比例，重出只会白花钱。',
    references: SELF_REF,
  },
  style_bible: {
    type: 'style_bible', label: '（合成行）', scope: 'product',
    promptLabel: '（合成行，不产生画面）',
    writeback: null,
    iterable: false,
    iterationBlockReason: '基线不是素材，它由 bootstrapStyleBible 生成',
    references: SELF_REF,
  },
  // 评价任务（合成行）。**不是素材类型** —— 它没有产物、不回写业务表，
  // 存在的意义是让一次评审的 token 花费落在 asset_jobs 上（cost_amount 全库只此一表）。
  // 与 style_bible 同为「合成行」：直接以 succeeded 落库，绝不经过 pending
  //（一条 pending 的 review 行会被无类型过滤的领取领走、丢给 generateImageJob，
  //  那是一次真实付费的、语义完全错误的出图调用）。
  review: {
    type: 'review', label: '（评审）', scope: 'product',
    // ⚠️ 必填字段。用 style_bible 同款「合成行」说明：本类型**没有画面**，
    //    故不存在「这版提示词更像不像它」的问题，取值只需与短 label 不同。
    promptLabel: '（合成行，不产生画面）',
    writeback: null,
    iterable: false,
    // 短理由（给开发者）。面向用户的整句在 enqueue.ts 的 `iterationBlockReason()`
    // —— 两者**并存、口径不同**，别合并（见本文件 `iterable` 字段的注释）。
    iterationBlockReason: '评审不是素材，重评走重新入队',
    references: SELF_REF,
  },
};

/** 遍历用。顺序即 UI 展示顺序。 */
export const ALL_ASSET_TYPES: JobAssetType[] = Object.keys(ASSET_TYPES) as JobAssetType[];

/**
 * 用户可选（= 不在 anchor / style_bible / review 三类合成/系统行之内）。
 *
 * ⛔ 必须显式排掉 `'review'`。`ALL_ASSET_TYPES` 的**运行时**取值是 `Object.keys(ASSET_TYPES)`
 *    —— 注册表加了 `review` 它就会含 `review`，而这里那行 `(t): t is GeneratableType`
 *    是**类型断言**（TS 不校验 `t !== ...` 的完备性），TS 拦不住。
 *    混进去的后果不是「多一个按钮」：调用方（Task 15 的 `VALID_TYPES = GENERATABLE_TYPES`）
 *    会把 `types: ['review']` 当成合法批次请求，`planBatch` 随即给这条**合成行**排一个
 *    **真实付费的文生图 job**（`review` 根本没有画面）。
 */
export const GENERATABLE_TYPES: GeneratableType[] = ALL_ASSET_TYPES.filter(
  (t): t is GeneratableType => t !== 'anchor' && t !== 'style_bible' && t !== 'review',
);

/**
 * 公共池类型：产出的 design_assets 进公共素材库（venue_id 落 null），可跨剧本复用。
 *
 * **导出**：轮询器 writeAsset 要用同一条规则写 design_assets.venue_id（见
 * wenlv-asset-gen-scheduler.ts 的 import）。它领回的行上没有 assetIsPublic 这列
 * （库里没这列），只能按 assetType 再判一次 —— 两处各写一份清单的话，改了一处另一处不会红。
 *
 * ⚠️ `stamp` **本轮移出**（子项目①）：它的展开键已从「节点」修正为「图鉴条目」，
 *    绑定到具体条目的印章不是公共素材。移出同时改变了它的 `venue_id` 落库行为
 *    —— 这是有意的，见 spec §5.3。
 */
export const PUBLIC_POOL_TYPES = new Set<JobAssetType>(['icon', 'anchor']);
