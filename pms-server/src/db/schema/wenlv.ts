import { pgTable, varchar, text, integer, timestamp, jsonb, uniqueIndex, index, boolean, numeric, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// 条件/状态机类型（引擎与表共用）
/**
 * 产品级主题（jsonb）：只存**局部覆盖**，全量 token 由 `templateId` 引用的设计模板提供。
 *
 * ⚠️ TODO / @deprecated 风险 —— `theme.colors` 死字段：
 *   本类型**没有声明** `colors` 字段，但 theme 是 jsonb，库里/AI 产出可能残留
 *   `theme.colors.{primary,accent,...}` 这类未声明键。当前**全仓零消费方**（死字段），
 *   故 `sanitizeWenlvTheme` 也只剥 `theme.primaryColor`、不校验它 —— 无消费方即无注入面，暂时安全。
 *   但若将来任一天接上 `theme.colors.*` 的消费方，它会**立刻变成无守卫的注入口**
 *   （`theme.colors.primary` 同样经 `var()` 进 `background`/`color`，全仓无任何校验）。
 *   **启用前必须先补同口径校验**（复用 `sanitizeWenlvTheme` / `isSafeCssColor` 的放行面），
 *   或先在本类型上正式声明该字段并纳入 sanitize。不要直接读它。
 */
export type WenlvTheme = {
  templateId?: string;          // 引用 design_templates.id（继承其 tokens）
  primaryColor?: string;        // 局部覆盖 tokens.colors.primary
  logo?: string;                // 产品级 Logo URL（不经 token 合并）
  bgImage?: string;             // 产品级背景图 URL
  font?: string;                // 局部覆盖 tokens.fonts.body
  mascotIp?: string;            // 产品级 IP 形象 URL
  motion?: WenlvMotionToken;    // 局部覆盖 tokens.motion（浅合并）
  soundStyle?: string;          // 局部覆盖 tokens.soundStyle
  haptic?: WenlvHapticToken;    // 局部覆盖 tokens.haptic（浅合并）
};
/**
 * 风格基线（S3）：素材生成防漂移的**唯一**机制。
 * 每次生成都把整份序列化进提示词，而不是让模型自由发挥画风 ——
 * 只把它当「参考」等于没有，第 1 轮与第 5 轮会漂成两个世界。
 * 由首次生成时自举（见 services/wenlv/asset-gen/style-bible.ts），可人工编辑。
 */
export type WenlvStyleBible = {
  artStyle?: string;        // 画风：水墨 / 赛博 / 民国月份牌 …
  palette?: string[];       // 主色序列
  era?: string;             // 时代背景
  brushwork?: string;       // 笔触/质感
  mood?: string;            // 氛围基调
  mustHave?: string[];      // 必须出现的元素
  forbidden?: string[];     // 禁止出现的元素
  notes?: string;           // 自由补充
};
/** 评价器返回的打分明细（存 design_assets.review_detail）。 */
export type WenlvReviewDetail = {
  score: number;
  dimensions: { key: string; score: number; reason: string }[];
  issues: { severity: 'high' | 'medium' | 'low'; where: string; what: string }[];
  /** **下一轮迭代要喂的那句 guidance** —— 评价层与形态④ 自动迭代的接缝。 */
  fix_guidance: string;
};
/**
 * 人工评审意见的 jsonb 原文（迁移 0035）。
 *
 * 与 `WenlvReviewDetail` **刻意不同形**：那是评价器输出的结构化明细（dimensions /
 * issues / fix_guidance），这是人写的一段话。让两者共用同一形状会逼着调用方
 * 为「人写的意见」伪造出 dimensions 之类的空壳字段 —— 那种「形状对齐」是假的对齐。
 * `comment` 是唯一承载字段；将来要加「人工也要分子项打分」时，在这里加列而不是
 * 往 `WenlvReviewDetail` 上靠。
 */
export type WenlvHumanReviewDetail = {
  comment: string;
};
/** 风格参考图集的一项。role 目前仅为元数据 —— 消费端按数组顺序 push，不做 role 排序。 */
export type WenlvStyleReference = {
  role: '人物' | '场景' | '道具' | '色彩';
  url: string;
};
// 团队剧本模式的剧本级配置（Task 10 正式落库）。
// config 是 jsonb 列 ⇒ 加字段无需迁移，存量 config 不含某键时消费侧走默认值。
// 各字段的默认值策略见消费方（routes/mini/wenlv.ts 的 teamSizeOf / allowDup 读法）。
export type WenlvProductConfig = {
  checkinRule?: string;
  collectRule?: string;
  // 是否含协作题（多人协作解谜）。
  collaborativePuzzles?: boolean;
  // 是否启用小队机制（队伍内再分组/分小队）。
  squads?: boolean;
  // 是否允许重复角色（同一角色可被多名队员选择）。
  allowDuplicateRoles?: boolean;
  // 剧本调音：'family' = 亲子安全模式，其余/缺省 = standard。jsonb 加键无迁移，存量 config 缺键时消费侧按 standard 处理。
  tuneMode?: 'standard' | 'family';
  // 导演 v1（迁移 0076）：硬锚点配置（创作台 JSON 配置，值守页只读）。惰性 tick，无调度器。
  director?: { anchors?: DirectorAnchor[] };
};

/** 导演硬锚点（跨夜运行时编排，迁移 0076）。 */
export type DirectorAnchor = {
  key: string;
  dueAt: string;
  action: 'npc-message' | 'ambient' | 'push-node';
  nodeId?: string;
  message?: string;
  fired?: boolean;
};

/** 导演每队伍运行时状态（pms_bui_wenlv_director_states.state）。 */
export type DirectorState = {
  lastActionAt: string;
  lastKey?: string;
  stallNotified?: boolean;
  staticNotified?: boolean;
  anchors?: DirectorAnchor[];
  startedAt?: string;
};

/** 导演报警（pms_bui_wenlv_director_states.alerts 元素）。 */
export type DirectorAlert = {
  id: string;
  level: 'info' | 'warn' | 'critical';
  kind: 'stall' | 'static' | 'manual';
  message: string;
  createdAt: string;
  handled?: boolean;
};
export type WenlvState = {
  visited: Record<string, boolean>;
  collected: Record<string, boolean>;
  completed: Record<string, boolean>;
  // key = `${nodeId}:${atomId}`
  atoms?: Record<string, { done: boolean; at: string }>;
};

// ===== 实景解密原子体系（迁移 0075，spec §4/§8）=====
export type WenlvAtomType =
  | 'physical-search' | 'observe' | 'ar-echo' | 'cross-place'
  | 'cipher-contact' | 'human-quest' | 'guest-social'
  | 'fragment-assembly' | 'item-combine'
  | 'ambient-soundscape' | 'night-light-person' | 'physical-surprise'
  | 'merchant-grant' | 'token-redeem' | 'paid-customization'
  | 'single' | 'multiple' | 'judge' | 'input' | 'photo' | 'meditate';

export type WenlvAtom = {
  id: string;
  type: WenlvAtomType;
  title?: string;
  config: Record<string, unknown>;
  required?: boolean;
};

export type WenlvVenueProfileSupportActions = {
  frontDesk?: boolean;   // 前台递包
  propRoom?: boolean;    // 布房/放信
  soundSystem?: boolean; // 音景配合
  exterior?: boolean;    // 可布置室外实体物
};

export type WenlvMerchantPartner = typeof pmsBuiWenlvMerchantPartners.$inferSelect;
export type WenlvProp = typeof pmsBuiWenlvProps.$inferSelect;

export type WenlvCondRef = { kind: 'visited' | 'collected' | 'completed' | 'skill'; id: string };
export type WenlvCondition =
  | { type: 'ref'; ref: WenlvCondRef }
  | { type: 'role'; characterId: string }
  | { type: 'all'; conditions: WenlvCondition[] }
  | { type: 'any'; conditions: WenlvCondition[] }
  | { type: 'nofM'; n: number; of: WenlvCondition[] };
export type WenlvInteraction =
  | { type: 'single'; question: string; options: string[]; answer: string; hint?: string; requires?: WenlvCondition; impacts?: string[]; collaborative?: boolean }
  | { type: 'input'; question: string; answer: string; hint?: string; requires?: WenlvCondition; impacts?: string[]; collaborative?: boolean }
  | { type: 'multiple'; question: string; options: string[]; answer: string[]; hint?: string; requires?: WenlvCondition; impacts?: string[]; collaborative?: boolean }
  | { type: 'judge'; question: string; answer: 'true' | 'false'; hint?: string; requires?: WenlvCondition; impacts?: string[]; collaborative?: boolean }
  | { type: 'photo'; question: string; hint?: string; requires?: WenlvCondition; impacts?: string[] }
  | { type: 'meditate'; question: string; seconds: number; hint?: string; requires?: WenlvCondition; impacts?: string[] };

// 节点谜题（单题，从原 interactions 数组改为单对象）
export type WenlvPuzzle = WenlvInteraction;

// 动效 token：缓动 / 时长 / 转场（体验层，配置驱动）
export type WenlvMotionToken = { easing?: string; duration?: number; transition?: string };
// 触觉 token：盖章 / 打卡是否震动（小程序 wx.vibrateShort，H5 降级）
export type WenlvHapticToken = { stamp?: boolean; checkin?: boolean };
// 设计 token 全集：视觉 + 动效 + 听觉 + 触觉（风格模板的 tokens 字段）
export type WenlvTokens = {
  colors?: {
    primary?: string;
    primarySoft?: string; // 主色浅底（chip/标签/禁用钮底）
    accent?: string; // 强调色 —— 仅作底色（角标），压在上面的字由 on-accent 自动推导
    accentText?: string; // 强调色的文字版 —— 浅底上的强调文字（价格）
    background?: string; // 页面底
    surface?: string; // 卡片/弹层/浮层表面色
    text?: string; // 正文/标题色，配 surface
  };
  fonts?: { heading?: string; body?: string };
  radius?: number;
  iconStyle?: string;
  stampStyle?: string;
  mood?: string;
  motion?: WenlvMotionToken;
  soundStyle?: string;
  haptic?: WenlvHapticToken;
};

export type WenlvStampMeta = {
  shape?: string; color?: string; icon?: string; pattern?: string; limited?: boolean;
  stampAssetId?: string;        // 引用 design_assets 中 type='stamp' 的资产 id
};
export type WenlvGeo = { lat?: number; lng?: number; radius?: number };
/** NPC 对话的视觉锚点：评价器打分明细里指向对话内某段原文的引用。 */
export interface WenlvVisualAnchor {
  criteriaIndex: number;
  anchor: string;
  line: string;
}
/** 触发器解锁后下发给玩家的内容（线索文本 / SAN 增减）。 */
export interface WenlvUnlockContent {
  clueText?: string;
  sanDelta?: number;
}
export type WenlvMode = 'narrative' | 'rally';
export type WenlvClaimStatus = 'claimed' | 'redeemed' | 'cancelled';

// 文旅内容产品（剧情体验本体，平台自营）
export const pmsBuiWenlvProducts = pgTable('pms_bui_wenlv_products', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  name: varchar('name', { length: 200 }).notNull(),
  subtitle: varchar('subtitle', { length: 200 }),
  coverImage: varchar('cover_image', { length: 500 }),
  // 值为普通 varchar、**不是 PG enum 也无 CHECK** ⇒ 加 'deleted' 不需要数据库迁移。
  // deleted = 软删除：只改这一个字段，子资源一行不删；列表/场地统计/详情一律当它不存在，
  // 恢复 = 一条 UPDATE 改回 draft。见 routes/admin/wenlv.ts 的 DELETE /products/:id。
  status: varchar('status', { length: 20 }).notNull().default('draft'), // draft/preview/published/archived/deleted
  theme: jsonb('theme').$type<WenlvTheme>().notNull().default({}),
  config: jsonb('config').$type<WenlvProductConfig>().notNull().default({}),
  mode: varchar('mode', { length: 20 }).notNull().default('narrative'), // narrative/rally
  // 成局形态（solo 单人 / group 多人 / both 两者皆可）。与上面的 mode 是**两根正交轴** ——
  // mode 是玩法形态（narrative 剧情 / rally 集章），playMode 是成局形态，六象限都合法（2 × 3）。
  // ⚠️ 本列只是**声明**，**不在本表上强制**：本仓既无 PG enum 也无 CHECK（与 mode 同惯例）。
  //    合法值集由**写入口的 zod enum** 守（`productHeadSchema` 那一族，位置与 `mode` 并列）。
  //    ⚠️ 该 schema 是**无 `passthrough` 的普通 `z.object`**：只剥掉**未声明的键**；`playMode` 是**已声明的键**（`z.enum(['solo', 'group', 'both'])`）⇒ 值域外的**不 strip，而是 parse 失败 ⇒ 400**（契约：`routes/admin/__tests__/wenlv-playmode.test.ts` 的 `'duo'` 用例）。
  //    场次条件同理，是**消费侧**（场次表 / 下单）的语义，不在本表兑现：**solo 不排场次、
  //    group 必须排、both 可排可不排**（带 slotId = 团队局，不带 = 单人局）；
  //    消费侧须**正列举**，写成 `!== 'group'` 会把 both 错判成单人。
  playMode: varchar('play_mode', { length: 10 }).notNull().default('solo'),
  // 免费游玩开关（免费剧本引流）。🔴 本列是**放行判定的唯一权威**：
  // `assertTicket` 命中它即放行，不查票、不跨服务。
  // 与 `mode`/`playMode` 一样，本列只是**声明**，本表上既无 PG enum 也无 CHECK。
  isFree: boolean('is_free').notNull().default(false),
  opsStartAt: timestamp('ops_start_at', { withTimezone: true }), // 运营窗口开始
  opsEndAt: timestamp('ops_end_at', { withTimezone: true }), // 运营窗口结束
  publishedVersion: integer('published_version').notNull().default(0),
  // 归属场地（可空：存量产品保持 null，创作台显示「未归属场地」；不做默认场地回填）
  venueId: varchar('venue_id', { length: 50 }),
  // AI 出稿时的输入快照（S2）：BFF 组装的 site_material 原样落库。
  // null = 非 AI 出稿 / AI 出稿时未选场地。只写一次，不做增量更新。
  aiInput: jsonb('ai_input').$type<WenlvSiteMaterial>(),
  // 风格基线（S3）：AI 出稿时不产出，由首次素材生成时自举落库。
  // 可空 = 尚未自举；生成器会在首次生成时写入。
  styleBible: jsonb('style_bible').$type<WenlvStyleBible>(),
  // 风格锚图（S3）：防漂移第二层。存 OSS URL，非空即「已有视觉锚点」。
  // **迭代时参考图恒为它，不是上一版** —— 上一版当参考会让误差逐版乘法累积。
  styleAnchorUrl: varchar('style_anchor_url', { length: 500 }),
  // 游玩有效天数（从 config 提升为列，迁移 0066）
  validDays: integer('valid_days'),
  // 队伍人数下限（从 config 提升为列，迁移 0066）
  teamSizeMin: integer('team_size_min'),
  // 队伍人数上限（从 config 提升为列，迁移 0066）
  teamSizeMax: integer('team_size_max'),
  // 风格参考图集（迁移 0033）。最多 6 张。
  // 现在 styleAnchorUrl 只发 1 张；这是把「防漂移」从单锚点升级成图集
  // —— Seedream 原生支持最多 14 张参考图，等于免费的一致性提升。
  styleReferences: jsonb('style_references').$type<WenlvStyleReference[]>(),
  // 剧本交付：只落时间戳，不建状态机（AI 生成已有自己的 CREATED→DRAFTING→DRAFT_READY/FAILED）
  // 阶段由 services/wenlv-delivery.ts 的纯函数推导
  generationStartedAt: timestamp('generation_started_at', { withTimezone: true }),
  contentReadyAt: timestamp('content_ready_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// NPC 驱动章节的对话目标类型与配置（迁移 0053）。
// P3-C Task 1：'cross-examine' = 证词交叉章节（多 NPC 各执一词，玩家需交叉比对）。
//   jsonb 字段，扩展 type 联合不需数据库迁移；存量数据无此值不影响。
export type WenlvChapterGoalType = 'puzzle' | 'choice' | 'reveal' | 'convince' | 'cross-examine';

export type WenlvChapterGoalOption = { label: string; nextNodeId: string };

export type WenlvChapterGoal = {
  type: WenlvChapterGoalType;
  description: string;
  answerCriteria: string[];
  minTurns: number;
  options?: WenlvChapterGoalOption[];
  clueIds?: string[];
  collaborative?: boolean;     // 模块 C：true = 需所有队员各发≥1条消息才能完成
  criteriaHints?: string[];    // DM 引擎：给 NPC 的条件提示（脱敏后的引导文案）
};

export type WenlvEdgeType = 'auto' | 'choice' | 'puzzle_pass' | 'puzzle_fail';

// 节点类型二元化（迁移 0074）：只存 'scene'（普通剧情）/ 'npc'（NPC 剧情）。
// puzzle 降级为节点内可选 JSON（puzzle 列）；旧 puzzle/choice/ending 枚举已由 0074 全部落为 scene。
export type WenlvBinaryNodeType = 'scene' | 'npc';

// 剧本房场景五型（迁移 0079）：narrative 旁白剧情 / npc NPC 对话 / puzzle 单题谜题 /
// atom 有序交互原子 / ending 结局（结局承载 triggerCondition/priority/rewardId）。
export type WenlvSceneType = 'narrative' | 'npc' | 'puzzle' | 'atom' | 'ending';

// AI 协作 DIY 会话（迁移 0079 / pms_bui_wenlv_ai_sessions）。
// stage = 向导七步；pms-ai-crew 经 HTTP（内部 token）读写，不直连数据库。
export type WenlvAiStage =
  | 'intent' | 'worldview' | 'characters' | 'skeleton' | 'scenes' | 'puzzles' | 'publish';
export type WenlvAiSessionStatus = 'active' | 'paused' | 'completed' | 'abandoned';

// 0079 统一模型：旧 pms_bui_wenlv_nodes / node_edges / endings 三表退役。
// 节点=scenes（type=narrative/puzzle/atom/npc），结局=scenes(type='ending')，边=flows。
// 见迁移 DROP 语句。WenlvBinaryNodeType / WenlvEdgeType 类型保留（投影层与 flows 表仍用）。

// 可收集物：线索/道具/成就
export const pmsBuiWenlvCollectibles = pgTable('pms_bui_wenlv_collectibles', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('clue'), // clue/item/achievement
  rarity: varchar('rarity', { length: 20 }).notNull().default('common'), // common/rare/epic/legendary
  image: varchar('image', { length: 500 }),
  stampMeta: jsonb('stamp_meta').$type<WenlvStampMeta>().notNull().default({}), // 盖章视觉元数据
  // 收集物对应的现场二维码 token（实体触发：扫码即收集）。迁移 0063。
  qrCode: varchar('qr_code', { length: 100 }),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_collectibles_qr_code').on(t.qrCode).where(sql`qr_code IS NOT NULL`),
]);

/** 角色技能（jsonb `skills` 的一项）。
 *  `id` 取代 pms-nimi 原硬编码数据的 `key`：既是 v-for 的 key，也是 P5「选项门控」的引用键
 *  ⇒ 必须在产品内稳定且唯一（空 id 会让两条技能在「按 id 找」的路径上互相遮蔽，后者静默胜出）。 */
export type WenlvCharacterSkill = { id: string; label: string; description: string };

/** 隐秘任务（jsonb `hidden_quest`）。
 *  ⚠️ **不含 `progress`**：进度由端面从 `progress.state.collected` 实时算
 *  （= `collectible_ids` 中已收集的数量），不落库 —— 落库就会有两个真相。
 *  `collectible_ids` 的引用可达性由发布闸的 R3 兜（P2 落地）。 */
export type WenlvHiddenQuest = { title: string; description: string; collectible_ids: string[] };

// 剧本角色。每个剧本独立一套（不是平台通用池）。
// 本表是**目标唯一权威**；products.config.characters 退化为 AI 出稿快照。⛔ **这里不写「谁在读 / 谁没读」**：那类完备性声明已反复失真（同族见 0042 头注释）。要判当前读路径，按 `pmsBuiWenlvCharacters` 全仓 grep **当场取数**。本表对外下发走显式白名单投影（`ip_prompt` / `role` 不下发）—— ⚠️ 但这**只**管本表：legacy 的 `products.config` 在公开详情里是整块原样下发的（`PUBLIC_PRODUCT_KEYS` 含 `config`），AI 出稿写进去的 `ip_prompt` / `role` 从那条路出境，Task 16 删掉 `config.characters` 才算收口（`script-panel.tsx` 至今仍读它）。
export const pmsBuiWenlvCharacters = pgTable('pms_bui_wenlv_characters', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  order: integer('order').notNull().default(0),
  name: varchar('name', { length: 50 }).notNull(),
  faction: varchar('faction', { length: 50 }).notNull(),
  factionColor: varchar('faction_color', { length: 20 }),
  // 社会身份（隐士/捕快）。与 `role`（叙事定位）**并存、不合并**：
  // AI 契约里 role 已存在，identity 是端面卡面要的新字段，语义不同。
  identity: varchar('identity', { length: 50 }).notNull(),
  identityDesc: text('identity_desc'),
  // 叙事定位（主角/NPC/伙伴）。端面**不读**本列 —— 它只服务创作台与生成引擎。
  role: varchar('role', { length: 50 }),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  // 文生图 prompt。⚠️ **是文本不是图** —— 与 `avatarUrl` 是两个字段，别合并。
  ipPrompt: text('ip_prompt'),
  // 0–100，**纯展示**，不参与任何判定（spec §2 非目标）。
  // 三个都**不给 default**：必填语义，见 0042 迁移头注。
  vitality: integer('vitality').notNull(),
  wisdom: integer('wisdom').notNull(),
  insight: integer('insight').notNull(),
  skills: jsonb('skills').$type<WenlvCharacterSkill[]>().notNull().default([]),
  hiddenQuest: jsonb('hidden_quest').$type<WenlvHiddenQuest>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // 端点级读路径都是「按产品取整组」。`id` 已是主键 ⇒ 不另建 (product_id, id) 唯一索引，
  // 理由见 0042 迁移里那条注释。
  index('idx_wenlv_characters_product').on(t.productId),
]);

// 无消费方：历史预留表，本轮显式退役（迁移 0067 删除）

// 结局 = scenes(type='ending')，见 pmsBuiWenlvScenes。

// 奖励/权益（关联现有商户核销体系）
export const pmsBuiWenlvRewards = pgTable('pms_bui_wenlv_rewards', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('coupon'), // coupon/merchandise/digital（merchant_rights 已迁移为 merchandise）
  merchantId: varchar('merchant_id', { length: 64 }),
  storeId: varchar('store_id', { length: 50 }),
  value: varchar('value', { length: 100 }),
  image: varchar('image', { length: 500 }),       // 奖品视觉（设计资产 reward URL 或直接 URL）
  description: text('description'),
  // 0071: 文创商品兑换闭环字段
  stockLimit: integer('stock_limit'),
  stockUsed: integer('stock_used').notNull().default(0),
  merchandiseSku: varchar('merchandise_sku', { length: 80 }),
  pickupEnabled: boolean('pickup_enabled').notNull().default(false),
  deliveryEnabled: boolean('delivery_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 玩家进度（每玩家每产品一条）
export const pmsBuiWenlvProgress = pgTable('pms_bui_wenlv_progress', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  // 通道（P2 团队准入）：NULL = 散客行；非 NULL = 该队伍的一员。
  // 可空是语义的一部分 —— 设 NOT NULL 会让所有散客写入炸在 23502。
  sessionId: varchar('session_id', { length: 50 }),
  state: jsonb('state').$type<WenlvState>().notNull().default({ visited: {}, collected: {}, completed: {} }),
  status: varchar('status', { length: 20 }).notNull().default('active'), // active/completed/abandoned
  // 试玩次数。每次「开始/继续游玩」+1（首次建行时为 1）。
  // ⚠️ 已通关回看**不**计数 —— 见 `routes/mini/wenlv.ts` 的 `/:id/start` 里那条契约注释。
  visitCount: integer('visit_count').notNull().default(0),
  endingId: varchar('ending_id', { length: 50 }),
  // 玩家选中的角色 id（角色机制深度1）。NULL = 未选角（老数据/未触发选角的剧本）。
  // 可空是语义的一部分：老剧本无角色体系时为 NULL，不阻塞。
  characterId: varchar('character_id', { length: 50 }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // 两条**部分**唯一索引（P2 I4 的载体）：散客与团队两条通道各管各的。
  // ⚠️ 旧的 `uq_wenlv_progress_user_product`（全表唯一）由 wenlv-team-m1.sql 显式 DROP ——
  //    留着它，同一个人第二场团队局插不进去（见 wenlv-team-m1.sql 头注）。
  // 谓词写成 `sql` 字面量而不是 isNull/isNotNull：渲染结果是**逐字**的 `session_id IS NULL`，
  // 与 wenlv-team-m1.sql 里手写的那份同形（列契约测试钉的就是这个串）。
  uniqueIndex('uq_wenlv_progress_solo').on(t.miniUserId, t.productId).where(sql`session_id IS NULL`),
  uniqueIndex('uq_wenlv_progress_team').on(t.miniUserId, t.productId, t.sessionId).where(sql`session_id IS NOT NULL`),
]);

// 事件流水（打卡/答题/收集/结局）
export const pmsBuiWenlvEvents = pgTable('pms_bui_wenlv_events', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  eventType: varchar('event_type', { length: 20 }).notNull(), // checkin/answer/collect/ending
  nodeId: varchar('node_id', { length: 50 }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 档位（集章）：condition 复用 WenlvCondition（应只引用 collected）
export const pmsBuiWenlvRewardTiers = pgTable('pms_bui_wenlv_reward_tiers', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  order: integer('order').notNull().default(0),
  condition: jsonb('condition').$type<WenlvCondition>(),
  rewardId: varchar('reward_id', { length: 50 }),
  icon: varchar('icon', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 领取台账：一次档位一条，(progress,tier) 幂等唯一；唯一核销码
export const pmsBuiWenlvClaims = pgTable('pms_bui_wenlv_claims', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  progressId: varchar('progress_id', { length: 50 }).notNull(),
  tierId: varchar('tier_id', { length: 50 }).notNull(),
  rewardId: varchar('reward_id', { length: 50 }),
  code: varchar('code', { length: 24 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('claimed'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedBy: varchar('redeemed_by', { length: 50 }),
  redeemedStoreId: varchar('redeemed_store_id', { length: 50 }),
  qrcode: varchar('qrcode', { length: 500 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_claims_progress_tier').on(t.progressId, t.tierId),
  uniqueIndex('uq_wenlv_claims_code').on(t.code),
]);

/** 文创商品兑换记录（迁移 0070）。状态机：pending → redeemed → shipped → completed。 */
export type WenlvMerchRedeemStatus = 'pending' | 'redeemed' | 'shipped' | 'completed';
export const pmsBuiWenlvMerchRedeems = pgTable('pms_bui_wenlv_merch_redeems', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  progressId: varchar('progress_id', { length: 50 }).notNull(),
  rewardId: varchar('reward_id', { length: 50 }).notNull(),
  tierId: varchar('tier_id', { length: 50 }).notNull(),
  claimCode: varchar('claim_code', { length: 24 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  receiverName: varchar('receiver_name', { length: 100 }),
  receiverPhone: varchar('receiver_phone', { length: 30 }),
  receiverAddress: text('receiver_address'),
  shipmentNo: varchar('shipment_no', { length: 80 }),
  shipmentCarrier: varchar('shipment_carrier', { length: 50 }),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  redeemedBy: varchar('redeemed_by', { length: 50 }),
  redeemedStoreId: varchar('redeemed_store_id', { length: 50 }),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_merch_redeems_code').on(t.claimCode),
  index('idx_wenlv_merch_redeems_progress').on(t.progressId),
  index('idx_wenlv_merch_redeems_product').on(t.productId),
  index('idx_wenlv_merch_redeems_status').on(t.status),
]);

// 风格模板：一组完整 Design Token + 默认资产引用（内置 + AI 产出）
export const pmsBuiWenlvDesignTemplates = pgTable('pms_bui_wenlv_design_templates', {
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  styleTag: varchar('style_tag', { length: 50 }).notNull(), // 国潮/水墨/赛博
  tokens: jsonb('tokens').$type<WenlvTokens>().notNull().default({}),
  isBuiltin: boolean('is_builtin').notNull().default(false), // 内置模板不可删
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 设计资产：11 个 type（视觉 5 + 音频 2 + 动画 4）
export const pmsBuiWenlvDesignAssets = pgTable('pms_bui_wenlv_design_assets', {
  id: varchar('id', { length: 50 }).primaryKey(),
  type: varchar('type', { length: 20 }).notNull(), // icon/stamp/background/reward/mascot/bgm/sfx/ending/cutscene/celebrate/particle
  styleTag: varchar('style_tag', { length: 50 }),   // 按模板风格筛选
  name: varchar('name', { length: 100 }).notNull(),
  url: varchar('url', { length: 500 }),            // 图片/音频/动画 URL
  // 归属场地（S3）：NULL = 公共池（风格化素材，跨场地复用）；
  // 非空 = 该场地私有（写实素材）。**只加这一列，不加 scope** ——
  // 双列会引入默认值陷阱：11 条内置资产是公共资源，默认值会把它们全划成私有。
  venueId: varchar('venue_id', { length: 50 }),
  // 产出它的**剧本**（design_assets 的真正归属）。迁移 0036 加列 + btree 索引 + 从 meta 回填。
  // 与 venueId 正交、不可互替：venueId 非空=场地私有写实素材 / NULL=公共池风格化素材，
  // 而公共池素材**也**有 productId（writeAsset 对两类都写）。
  // 保留 meta.productId 是**双写**：本列是查询的最终归属地（Task C6 切过来），
  // meta 那份留给迁移前写入的行与回滚路径识别，短期内不删。
  productId: varchar('product_id', { length: 50 }),
  // ── 坐标系（迁移 0038）────────────────────────────────────────────
  // 这一行素材**服务剧本的哪个要素**。与 `jobId` **不是同一件事**，别互替：
  //   jobId  = 产出它的那次生成动作（**一次性凭据，不是长期归属**；手工上传的行恒为 NULL）
  //   target = 它服务的那个要素（长期归属，手工上传也必须写）
  // kind 的取值域与 writeback-type.ts 的 `WritebackEntity` 一一对应
  //（node / product / collectible / ending / reward / tier / npc / character），与 asset_jobs.target_kind 同域。
  // 为什么没有第三列 `slot`：槽位 ≡ 本表的 `type`。注册表
  // `ASSET_TYPES[type].writeback` 已经给出 `(entity, column, jsonKey)`，
  // 再加 `slot` 是同一事实的第二份规格，必然漂移。
  // ⚠️ **任何往这张表 insert 的路径都必须写这两列**（今天有两条**生产**路径：
  //    `candidate-store.ts` 的 `writeCandidate`（图类）、`wenlv-asset-gen-scheduler.ts` 的
  //    `writeAsset`（旁白））。只加一处 = 「加列只加了一条写路径」那个前科的同族的又一例，
  //    且**完全静默**（同源的还有 product_id，迁移 0036）。两处的坐标取自**同一个函数**
  //    `targetFieldsOf()`（本计划 Task 3 落地），别各自抄一份。
  targetKind: varchar('target_kind', { length: 32 }),
  targetId: varchar('target_id', { length: 64 }),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  // ── 候选组（迁移 0033）────────────────────────────────────────
  // 产出这一张的 job。**它本身就是候选组** —— 不需要额外的 group id。
  jobId: varchar('job_id', { length: 64 }),
  // 组内序号，从 0 起。
  candidateIndex: integer('candidate_index').notNull().default(0),
  // 组内被采纳的那一张。其余保留可回看、不删（下一轮迭代还能选回来）。
  // DB 层有不变量索引 uq_wenlv_design_assets_selected（一个 job 至多一张 true）。
  isSelected: boolean('is_selected').notNull().default(false),
  // ── 评审（迁移 0033）──────────────────────────────────────────
  // 分数落在**这一张**而不是 job 上：**择优比的就是分**，
  // 一行一个请求表达不了「同一次请求里第 2 张比第 1 张好」。
  reviewScore: numeric('review_score', { precision: 4, scale: 2 }),
  reviewDetail: jsonb('review_detail').$type<WenlvReviewDetail>(),
  reviewSource: varchar('review_source', { length: 10 }),   // ai | human
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewModel: varchar('review_model', { length: 64 }),      // 人工评审时为空
  // ── 人工评审（迁移 0035，spec §8.5「人工审核也是评价的一路」）──────
  // ⚠️ **刻意与上面那组 AI 列分开存**（口径②）：`review_score` 一行只有一个数值，
  //    人工分若覆写它，`human - ai` 这个分差指标就永远算不出来 —— 而那个分差正是
  //    §8.5 的副产品指标（两者长期背离 ⇒ **自动评价器不可信**，不是素材差）。
  // ⚠️ `reviewSource` 的语义因此是「**最近一次评价动作**的来源，且 human **粘性**」：
  //    人工一介入就恒为 `'human'`，`reviewAssetJob` 的闸据此拒绝 AI 补评
  //    （否则 human 标签会被紧随的 AI 补评覆盖，永远存不下来）。
  humanReviewScore: numeric('human_review_score', { precision: 4, scale: 2 }),
  humanReviewDetail: jsonb('human_review_detail').$type<WenlvHumanReviewDetail>(),
  /** 人工评审时间。**不复用 `reviewedAt`** —— 那是 AI 评审的时间戳。 */
  humanReviewedAt: timestamp('human_reviewed_at', { withTimezone: true }),
  /** 人工**明确淘汰**。`isSelected = false` 表达不了淘汰（那还包括「还没人看过」）⇒
   *  正反例累积必须靠这一列把「明确否掉」与「尚未决定」分开（口径③）。 */
  isRejected: boolean('is_rejected').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 场地：物理建设的容器（我方全包，非多租户；场地是业务对象不是租户）
export const pmsBuiWenlvVenues = pgTable('pms_bui_wenlv_venues', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  name: varchar('name', { length: 100 }).notNull(),
  address: text('address'),
  city: varchar('city', { length: 50 }),
  latitude: varchar('latitude', { length: 30 }),
  longitude: varchar('longitude', { length: 30 }),
  // 物理建设状态机：lead/surveying/deploying/pilot/live/archived（合法流转见 services/wenlv-venue.ts）
  status: varchar('status', { length: 20 }).notNull().default('lead'),
  ownerStaffId: varchar('owner_staff_id', { length: 50 }), // 我方负责人（平台用户 id，不加外键）
  contactName: varchar('contact_name', { length: 50 }),
  contactPhone: varchar('contact_phone', { length: 20 }),
  remark: text('remark'),
  // 场地封面图 URL（C 端场地卡片展示）。可空=无封面，卡片走渐变占位。
  coverImage: varchar('cover_image', { length: 500 }),
  // 四个里程碑：只在为 null 时盖章（首次进入），返工不进覆盖 —— 见 spec §5.1
  surveyStartedAt: timestamp('survey_started_at', { withTimezone: true }),
  surveyedAt: timestamp('surveyed_at', { withTimezone: true }),
  deployedAt: timestamp('deployed_at', { withTimezone: true }),
  liveAt: timestamp('live_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 点位：可跨剧本共用的物理资源池。10 个点位服务 8 个剧本，物理属性只存这一份。
export const pmsBuiWenlvVenuePoints = pgTable('pms_bui_wenlv_venue_points', {
  id: varchar('id', { length: 50 }).primaryKey(),
  venueId: varchar('venue_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  // 现场二维码 / 信标里**原样编码**的字符串，触发时精确相等比对；全局唯一；可空=还没铺码
  code: varchar('code', { length: 100 }),
  triggerType: varchar('trigger_type', { length: 20 }).notNull().default('qrcode'), // qrcode/beacon
  geo: jsonb('geo').$type<WenlvGeo>(), // 复用 WenlvGeo（与旧 nodes.geo 同形状，便于字段搬家）
  address: varchar('address', { length: 200 }), // 现场文字位置描述（「古井旁·石阶上行 20 米」）
  sortOrder: integer('sort_order').notNull().default(0),
  // 现场照片 URL 数组（S2 采点 H5 上传）。jsonb 存数组；null / [] 都表示「还没拍」。
  photos: jsonb('photos').$type<string[]>(),
  remark: text('remark'),
  // ── 铺码四态（S4 块 C）───────────────────────────────────────────────
  // 四态**由时间戳派生**，不存冗余 status 列：存两份真相必然打架。
  //   未印 = printed_at IS NULL ／ 已印 = 有 printed 无 placed
  //   已铺 = 有 placed 无 verified ／ 已验 = 有 verified
  // 派生与单向流转的**唯一实现**在 services/wenlv-placement.ts（另一任务在写），
  // 此处只声明列。
  // 全可空、无默认、**不回填**：历史行 NULL = 「引入前没人记录过」，
  // 与「确实没印」是两回事，回填等于编造现场事实。与 created_by 同处理。
  // *_by 是平台用户 id，不加外键，**仅审计归属**（同 created_by）。
  printedAt: timestamp('printed_at', { withTimezone: true }),
  printedBy: varchar('printed_by', { length: 50 }),
  placedAt: timestamp('placed_at', { withTimezone: true }),
  placedBy: varchar('placed_by', { length: 50 }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: varchar('verified_by', { length: 50 }),
  // 「这个点位是网络调研落地来的」⇒ 指向 pms_bui_wenlv_venue_research.id；人工创建 = NULL。
  // 不加外键（同 created_by）：调研行会被重跑覆盖，而落地产物必须一直活着。
  researchId: varchar('research_id', { length: 50 }),
  // 采集人（平台用户 id，不加外键）。来源是 BFF 透传的 X-Platform-User-Id，**仅审计归属**。
  // 可空 = 迁移前的历史行 / 由内部服务（非平台用户）写入的行 —— 留空是诚实的未知，不回填。
  createdBy: varchar('created_by', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_venue_points_code').on(t.code),
  index('idx_wenlv_venue_points_venue').on(t.venueId),
]);

// 信标设备台账（信标运维）。
//
// **设备身份 ≠ 触发凭据**，两者不要合并：
//   - `mac` 是设备身份 —— 来自设备贴纸二维码 / 安卓 BLE 的 deviceId。
//     ⚠️ 但 iOS 侧小程序**拿不到** MAC（deviceId 是每 App 随机 UUID）⇒ 触发
//     **不能**依赖 MAC，它只服务「资产台账」与「现场认设备」。
//   - `uuid`/`major`/`minor` 是触发凭据 —— `onBeaconUpdate` 唯一的输入。
//
// `pointId` 是绑定关系的**唯一真相**。不与 `points.code` 共用（那张表的 code
// 有全局唯一索引，10 台共用 1 个 UUID 时第 2 台就撞索引）。
export const pmsBuiWenlvBeacons = pgTable('pms_bui_wenlv_beacons', {
  id: varchar('id', { length: 50 }).primaryKey(),
  mac: varchar('mac', { length: 32 }).notNull(), // 归一化：大写、去分隔符
  name: varchar('name', { length: 100 }).notNull(),
  model: varchar('model', { length: 50 }),
  // 归一化小写。可空 = 还没读过参数（现场先入账是真实顺序），不回填。
  uuid: varchar('uuid', { length: 36 }),
  major: integer('major'), // 0..65535
  minor: integer('minor'), // 0..65535
  venueId: varchar('venue_id', { length: 50 }),
  pointId: varchar('point_id', { length: 50 }), // 绑定；NULL = 在库未绑
  // stock/active/faulty/retired。触发侧用**拒绝清单**（排除 faulty/retired），
  // 不用「必须 = 'active'」—— 后者会让刚登记完就装好的设备静默不触发。
  status: varchar('status', { length: 20 }).notNull().default('stock'),
  txPower: integer('tx_power'), // 校验距离(RSSI@1m)
  // 电池备注。iBeacon 帧**不带电量**（只有 Eddystone TLM 带，而 iOS 屏蔽 Eddystone）
  // ⇒ 没有任何自动电量可读，这一列就是人工写的字，名字如实。
  batteryNote: varchar('battery_note', { length: 200 }),
  note: text('note'),
  createdBy: varchar('created_by', { length: 50 }), // 平台用户 id，不加外键，仅审计归属
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_beacons_mac').on(t.mac),
  // 同帧不可能对应两台设备；PG 对 NULL 互不相等 ⇒ 未读参数的多台不冲突。
  uniqueIndex('uq_wenlv_beacons_frame').on(t.uuid, t.major, t.minor),
  index('idx_wenlv_beacons_venue').on(t.venueId),
  index('idx_wenlv_beacons_point').on(t.pointId),
]);

// ── 场地网络调研（采风前 AI 调研）──────────────────────────────────────
// 报告的唯一属主是**本服务**：ai-crew 只经 PATCH 端点回写，它不碰数据库。
// 所以下面这些 jsonb 内部的键名由 **ai-crew** 决定（snake_case），本服务**不做**大小写转换
// —— 转换层就是分叉层（同族：`material-optimize` 的 `used_sources`）。

/** 调研锚定结果（`anchor`）。键名 snake_case，由 ai-crew 产出。 */
export type WenlvResearchAnchor = {
  name: string;
  region: string;
  one_liner: string;
  source_urls: string[];
  confidence: 'high' | 'medium' | 'low';
  why: string;
};

/** 候选快照的一项（`candidates`）。confidence 声明为 string（不是联合类型）：
 *  它是 ai-crew 写的，给个 `'很高'` 之类的值不该让**读端**整行解析失败。
 *  API 层已把非法值归一成 low（见 ai-crew 的 resolve_venue），这里是第二道。 */
export type WenlvResearchCandidate = {
  name: string;
  region: string;
  one_liner: string;
  source_urls: string[];
  confidence: string;
  why: string;
};

/** 逐节状态。**取值集固定四个**；键缺失/越界一律按 pending 处理
 *  （见 `progress` 列注释：把「键不在」读成 done 会显示「全绿而正文是空的」）。 */
export type WenlvResearchSectionState = 'pending' | 'running' | 'done' | 'failed';

/** 一节正文。`items[].sources` 是**本节 `sources` 数组的下标 +1**（编号从 1 起）。 */
export type WenlvResearchSection = {
  items: Array<{
    title: string;
    content: string;
    sources: number[];
    // 仅点位节：区位线索（**不是坐标**）。网上的坐标到现场对不上，会把人带偏。
    where?: string;
    // 仅素材节：WENLV_MATERIAL_TYPES 之一（代码侧兜底成 other）。
    kind?: string;
    // 无来源的 AI 推断（汇总步会把它移进 verify 节并标注）。
    inferred?: boolean;
    // 由汇总步附加（「AI 推断，无来源」/「单一来源，请现场核实」…）。
    note?: string;
    section?: string;
  }>;
  /** 本节检索命中的来源，**按编号顺序**。App 靠它把 sources 编号渲染成可点的链接。 */
  sources: Array<{ title: string; site_name: string; url: string }>;
  note: string;
  /** 本节「公网确实没查到」——**正当状态，不是失败**。 */
  not_found: boolean;
};

/** 报告 6 节（含 verify）。键名与 ai-crew 的 SECTION_KEYS 逐字一致。 */
export type WenlvResearchReport = Record<string, WenlvResearchSection | undefined>;

/** `search_log` 一项：每节的检索词 / 命中来源数 / 是否被 10 秒预算截断。
 *  不设用量闸，先记日志观察（设计决策 9）。 */
export type WenlvResearchSearchLogEntry = {
  section: string;
  query: string;
  source_count: number;
  truncated: boolean;
  error?: string;
};

/**
 * 场地网络调研行 —— 与场地 **1:1**。
 *
 * 1:1 由 `venue_id` 上的具名唯一索引 `uq_wenlv_venue_research_venue` 兑现，
 * 是「只留最新一份，重跑覆盖」这条决策的实现：重跑 UPDATE 同一行 ⇒
 * 不存在历史行，也就不存在「哪份最新」。**别加 version 列**。
 */
export const pmsBuiWenlvVenueResearch = pgTable('pms_bui_wenlv_venue_research', {
  id: varchar('id', { length: 50 }).primaryKey(),
  venueId: varchar('venue_id', { length: 50 }).notNull(),
  // running / ready / partial / failed
  status: varchar('status', { length: 20 }).notNull().default('running'),
  anchor: jsonb('anchor').$type<WenlvResearchAnchor>(),
  candidates: jsonb('candidates').$type<WenlvResearchCandidate[]>(),
  report: jsonb('report').$type<WenlvResearchReport>(),
  progress: jsonb('progress').$type<Record<string, WenlvResearchSectionState>>(),
  searchLog: jsonb('search_log').$type<WenlvResearchSearchLogEntry[]>(),
  error: text('error'),
  // 操作人（平台用户 id）。不加外键，**仅审计归属**，可空不回填（同 created_by）。
  startedBy: varchar('started_by', { length: 50 }),
  // 看门狗判定用：>15 分钟仍 running ⇒「疑似中断」，放行重跑。
  // 少了它，进程重启丢掉终态的那行会永远卡在 running 且被 409 挡住（死锁）。
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_venue_research_venue').on(t.venueId),
]);

// 文化素材类型白名单（S2）。改这里必须同步改 routes/admin/wenlv.ts 的 materialTypeSchema
// 与 pms-wenlv-survey/src/api.js 的 MATERIAL_TYPES。
export const WENLV_MATERIAL_TYPES = ['history', 'legend', 'craft', 'festival', 'dialect', 'other'] as const;
export type WenlvMaterialType = (typeof WENLV_MATERIAL_TYPES)[number];

export type WenlvCultureMaterial = {
  id: string;
  venueId: string;
  venuePointId: string | null;   // null = 场地级素材（不绑具体点位）
  type: WenlvMaterialType;
  title: string;
  content: string;
  source: string | null;
  photos: string[] | null;
  sortOrder: number;
};

// AI 出稿输入（S2）。BFF 组装 → 随请求传给 ai-crew → 原样落进 products.aiInput。
// 三处的字段名必须一致：本类型、BFF 的 services/wenlv-site-material.ts、ai-crew 的 run_draft。
export type WenlvSiteMaterial = {
  venue: {
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    culture: { type: string; title: string; content: string; source: string | null }[];
  };
  points: {
    id: string;
    name: string;
    address: string | null;
    remark: string | null;
    geo: WenlvGeo | null;
    photos: string[] | null;
  }[];
};

// 文化素材表（S2）：场地级 + 可选绑点位的口述/图文素材。
// 与剧本解耦 —— 一个场地的文化素材服务该场地下所有剧本，不做跨场地检索/引用。
export const pmsBuiWenlvCultureMaterials = pgTable('pms_bui_wenlv_culture_materials', {
  id: varchar('id', { length: 50 }).primaryKey(),
  venueId: varchar('venue_id', { length: 50 }).notNull(),
  // 可空 = 场地级素材。删点位时由路由把引用它的素材降级为场地级（不解引用硬删）。
  venuePointId: varchar('venue_point_id', { length: 50 }),
  type: varchar('type', { length: 30 }).notNull(),
  title: varchar('title', { length: 100 }).notNull(),
  content: text('content').notNull(),
  source: varchar('source', { length: 100 }),
  photos: jsonb('photos').$type<string[]>(),
  sortOrder: integer('sort_order').notNull().default(0),
  // 「这条素材是网络调研落地来的」⇒ 指向 pms_bui_wenlv_venue_research.id；人工创建 = NULL。
  // 不加外键（同 created_by）：调研行会被重跑覆盖，而落地产物必须一直活着。
  researchId: varchar('research_id', { length: 50 }),
  // 采集人（平台用户 id，不加外键）。同点位表：仅审计归属，可空，不回填。
  createdBy: varchar('created_by', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_culture_materials_venue').on(t.venueId),
  index('idx_wenlv_culture_materials_point').on(t.venuePointId),
]);

// 素材生成明细（S3）：一行 = 一个待生成的素材。
// **没有批次表** —— 进度 = GROUP BY batch_id 数状态，总额 = SUM(cost_amount)。
// 少一张表、少一次同步，且结构上不可能出现「批次说成功而明细里有失败」。
export const pmsBuiWenlvAssetJobs = pgTable('pms_bui_wenlv_asset_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  // 一次生成动作 = 一个批次（首轮一键生成，或某一轮对一条素材的迭代）
  batchId: varchar('batch_id', { length: 64 }).notNull(),
  venueId: varchar('venue_id', { length: 50 }),
  productId: varchar('product_id', { length: 50 }),
  // 取值域 = `asset-types.ts` 的 `JobAssetType`（**唯一真源**，别在这里再抄一份清单）。
  // ⚠️ 域内含**合成行**（`style_bible` / `review`）：它们不是素材、没有产物、不回写业务表，
  //    存在的意义只是借这张表记一笔付费（`cost_amount` 全库只此一表）。
  assetType: varchar('asset_type', { length: 20 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  // 生成时从源头取的**快照**（理由同 styleBibleSnapshot：源文本事后会被编辑）。
  // 轮询器从 claimNextJobs 领回的**整行**上读这三列 —— 缺了它们旁白任务必失败、
  // 图类会静默丢内容。
  // ⚠️ 那条领回路径是 `db.execute(sql\`... RETURNING id\`)` 再 `db.select()` 查回整行，
  //    **不是** `RETURNING *` 直接把行当 camelCase 用：db.execute 走 node-postgres 原始
  //    通道，drizzle 在那里不做列名映射，读出来是 node_id 而不是 nodeId，且因为返回
  //    `any` 而 ts-check 全绿 —— 静默全 undefined。
  nodeId: varchar('node_id', { length: 64 }),
  // 图鉴条目的写回键（第 6 类素材 `collectible` 专用；非 collectible 行恒为 null）。
  // 与 nodeId 同样只作为**权威键**使用，不用标题字符串匹配 —— 条目会被改名。
  // 回写目标：pms_bui_wenlv_collectibles.image。展开见 services/wenlv/asset-gen/
  // enqueue.ts 的 planBatch，回写见 wenlv-asset-gen-scheduler.ts 的 collectible 分支。
  // （后两者的 collectible 分支由本计划 Task 2/4 落地。）
  collectibleId: varchar('collectible_id', { length: 50 }),
  // 通用回写键对（迁移 0033）。取代 node_id / collectible_id 的「一类型一列」——
  // 本轮新增 ending / reward / tier 三类目标，照旧路子要再加三个键列。
  // ⚠️ 旧列**保留且仍可读**（回滚要用），但**新写入不再写它们**。
  // kind 取值：node / product / collectible / ending / reward / tier / npc / character
  //（与 writeback-type.ts 的 `WritebackEntity` 一一对应，勿各自扩展。
  //  注意不是 `WritebackDef['entity']` —— WritebackDef 是 `{...} | null` 的联合，不能直接索引。）
  targetKind: varchar('target_kind', { length: 32 }),
  targetId: varchar('target_id', { length: 64 }),
  // 本次**实际发出去**的参考图快照。参考图会变（风格图集可编辑），
  // 没有快照就事后无法回答「这张图当时参考了什么」。
  referenceUrls: jsonb('reference_urls').$type<string[]>(),
  // 涂鸦重绘的输入图（作为额外参考图发出，与风格参考图区分开）。
  editInputUrl: varchar('edit_input_url', { length: 500 }),
  // 请求的候选张数（**输入**）。实际张数由 design_assets 的行数得出 ——
  // 两者都要留：只留一个的话，「请求 4 张只得到 3 张」这件事就无从发现。
  // **NOT NULL DEFAULT 1**：新插入的行不可能是 null 或 0（除显式写 0，
  // 而 0 正是 `resolveCandidateCount` 该拦下的脏值）。
  candidateCount: integer('candidate_count').notNull().default(1),
  sourceText: text('source_text'),
  communityStyleTag: varchar('community_style_tag', { length: 50 }),
  // LLM 现算的提示词。落库是为了事后能回答「这张图当时是用什么词生成的」
  prompt: text('prompt'),
  // 生成时的基线快照：基线后续被编辑时，仍能解释这一版为何长这样
  styleBibleSnapshot: jsonb('style_bible_snapshot').$type<WenlvStyleBible>().notNull().default({}),
  iteration: integer('iteration').notNull().default(1),
  parentJobId: varchar('parent_job_id', { length: 64 }),
  // 本轮用户追加的反馈。**迭代时必填，重试时为空**
  guidance: text('guidance'),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending/running/succeeded/failed
  attempt: integer('attempt').notNull().default(0),
  provider: varchar('provider', { length: 30 }),
  model: varchar('model', { length: 50 }),
  providerTaskId: varchar('provider_task_id', { length: 128 }),
  // 逐次金额，**累加**：重试的重复花费必须计入，否则「花了多少钱」会少算
  costAmount: numeric('cost_amount', { precision: 10, scale: 4 }).notNull().default('0'),
  assetId: varchar('asset_id', { length: 50 }),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 游客端现场问题上报（块 E）。
// 一行 = 一个游客在一个剧本上遇到的一类问题。**无外键**（对齐本域惯例：product_id/mini_user_id 都是软引用，
// 剧本删了上报记录仍要留着 —— 它恰恰是「为什么删」的证据）。
export const pmsBuiWenlvClientReports = pgTable('pms_bui_wenlv_client_reports', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  nodeId: varchar('node_id', { length: 50 }),
  // audio / image / cert / other
  category: varchar('category', { length: 20 }).notNull(),
  // manual（游客主动点）/ auto（埋点自动报）
  source: varchar('source', { length: 20 }).notNull().default('manual'),
  platform: varchar('platform', { length: 20 }),
  note: varchar('note', { length: 500 }),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  // 处理闭环四列（0082 追加段，批 7 Task 24）：new（默认）| processing | resolved。
  // 挂行本体而非独立 handles 表：上报是单行工单，状态就是行内属性（与 director
  // 报警的「按 (progress,node) 聚合」不同构，那边才需要独立表）。
  handleStatus: varchar('handle_status', { length: 20 }).notNull().default('new'),
  handleNote: text('handle_note'),
  handledBy: varchar('handled_by', { length: 60 }),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_client_reports_product_created').on(t.productId, t.createdAt),
  index('idx_wenlv_client_reports_dedupe').on(t.miniUserId, t.productId, t.category, t.createdAt),
]);

// 队伍（P2 团队准入）。一行 = 一支队，建队时一次插入 N 行（seq = 1..N）。
//
// ⚠️ 本表**追加在文件末尾**、不插在 progress 表旁边：本文件有**大量**（>272 行）行号坐标被外层仓
//    的文档引用（⚠️ **不写计数** —— 完备性计数会被后续每次订正作废），插在中间会把它们全部推漂；追加在末尾漂移为 0。别为了「放得好看」把它挪上去。
//
// 🔴 本片**不加** actual_depart_at / deadline_at / finished_at / net_duration_ms：
//    那四列的写入口（错峰推进、结算冻结）都在后续片（I5：没有写入口的列不加）。
export const pmsBuiWenlvSessions = pgTable('pms_bui_wenlv_sessions', {
  id: varchar('id', { length: 50 }).primaryKey(),
  // **内容产品** id（不是交易侧 products.id）—— 由订单的 contentProductId 解析而来（Task 5）
  productId: varchar('product_id', { length: 50 }).notNull(),
  // 交易侧订单 / 场次。跨服务引用、**无外键**（与 slot_id 同款）
  orderId: uuid('order_id').notNull(),
  slotId: uuid('slot_id'),
  // 队伍码：8 位、字符集 23456789ABCDEFGHJKMNPQRSTUVWXYZ（见 services/wenlv-session-code.ts）
  code: varchar('code', { length: 16 }).notNull(),
  // 队序号，本片只作显示排序（出发顺序属错峰片）
  seq: integer('seq').notNull().default(1),
  name: varchar('name', { length: 50 }).notNull(),
  // 本片**只写 'forming'**；departing/playing/closed 的写入口在错峰片
  status: varchar('status', { length: 20 }).notNull().default('forming'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_sessions_code').on(t.code),
]);

// ── NPC 表（0043）──────────────────────────────────────────────────────────
// 与 characters 表的关系：characters 是剧本「角色体系」（主角/NPC/伙伴的统一池，P5
//   role/skill 条件、专属选项门控的引用目标），本表是**纯 NPC 实例化** —— 挂到具体点位、
//   带肖像/语音/台词的呈现单元。两表**不互替**：characters 没有 portraitUrl/voiceId/lines，
//   本表没有 faction/skills/hiddenQuest。character_id 是**软引用**（不加外键，同 venueId 惯例）：
//   一个 NPC 可以不挂任何 character（环境叙述型 NPC），挂了也只是引用其人设快照。
//
// lines 是 jsonb 数组（WenlvNpcLine[]）：每条带 voiceUrl，与 nodes.narrationUrl 同口径
//   （素材落资源库，这里只存引用）。default [] 而非 NULL：无台词的 NPC 是空数组，不是「未知」。
//
// ⚠️ 与 characters 的索引差异：本表**额外**建 (product_id, id) 唯一索引 —— 计划如此指定。
//    characters 表刻意不建它（id 已是主键、唯一性由主键蕴含），见 0042 头注。
//    这里保留是因为计划写明了；若后续评审认为冗余可删，删的是这条唯一索引 + 头注，不是 id 主键。
/** NPC 台词的一项（jsonb `lines` 的一项）。voiceUrl 可空 = 还没合成音频。 */
export type WenlvNpcLine = {
  id: string;
  text: string;
  voiceUrl: string | null;
  duration?: number;
};

/**
 * NPC 秘密层（演员升级①）：划定 NPC 的事实白名单与绝不可说的禁区。
 * 挂 persona jsonb（加字段零迁移），仅 prompt-builder 消费；缺省 = 不注入秘密层段。
 *
 * ⚠️ 它只是 prompt 级软约束（best-effort 防剧透）：LLM 仍可能被越狱套出，不是安全边界。
 * 真正不能下发给模型的机密不得进入 persona；出参侧硬脱敏对照 chapterGoal.criteriaHints 那一路。
 */
export type WenlvNpcSecretLayer = {
  knows: string[];        // NPC 知道什么（游戏世界事实白名单）
  never: string[];        // 绝不说什么
  loosensWhen?: string;   // 什么条件下松动
};

/** NPC 人格卡（AI 对话核心）。所有字段可选（缺省 = 不渲染对应 prompt 段）。 */
export type WenlvNpcPersona = {
  personality?: string[];   // 性格标签，如 ['寡言', '多疑']
  tone?: string;            // 语气风格，如 '短句、低沉'
  catchphrases?: string[];  // 口头禅
  backstory?: string;       // 背景故事（NPC 的秘密和动机）
  clues?: string[];         // 已知线索（NPC 知道但不主动说）
  taboos?: string[];        // 禁忌话题（NPC 拒绝谈论）
  secretLayer?: WenlvNpcSecretLayer; // 秘密层：可谈事实白名单 + 绝不可说禁区（演员升级①，jsonb 零迁移）
};

/** NPC 间关系（模块 B）。创作者在 NPC 编辑器配置，注入 LLM 让 NPC 可互相提及。 */
export type WenlvNpcRelationship = {
  targetNpcId: string;       // 目标 NPC id
  relationType: string;      // 关系类型：朋友/宿敌/师徒/亲属/同事
  description: string;       // 关系描述：'老周和陈婶是旧识，但老周怀疑她偷过祠堂钥匙'
};

/** 跨 NPC 记忆条目（运行时写入 pending_mentions 队列）。 */
export type WenlvNpcMention = {
  fromNpcId: string;         // 来源 NPC id
  fromNpcName: string;       // 来源 NPC 名（冗余，注入 prompt 用）
  context: string;           // 提及内容：'老周提到陈婶最近行为反常'
  ts: number;                // 时间戳
};

// 剧本 NPC（点位上的呈现单元）。每个剧本独立一套。
export const pmsBuiWenlvNpcs = pgTable('pms_bui_wenlv_npcs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  orderId: integer('order').notNull().default(0),
  name: varchar('name', { length: 50 }).notNull(),
  // 软引用 pms_bui_wenlv_characters.id（可空 = 环境叙述型 NPC，无 character 人设）
  characterId: varchar('character_id', { length: 50 }),
  portraitUrl: varchar('portrait_url', { length: 500 }),
  portraitPrompt: text('portrait_prompt'),
  voiceId: varchar('voice_id', { length: 50 }),
  description: text('description'),
  role: varchar('role', { length: 50 }),
  lines: jsonb('lines').$type<WenlvNpcLine[]>().notNull().default([]),
  // NPC 人格卡（AI 对话核心），迁移 0052。
  persona: jsonb('persona').$type<WenlvNpcPersona>().notNull().default({}),
  // 跨章节记忆：NPC 对玩家的印象摘要，每章完成后由 LLM 生成。迁移 0052。
  memory: text('memory'),
  // NPC 间关系网（模块 B）：创作者配置，prompt-builder 注入 LLM。迁移 0055。
  relationships: jsonb('relationships').$type<WenlvNpcRelationship[]>().notNull().default([]),
  // 跨 NPC 记忆队列（运行时写入）：mentionNpc 工具调用时入队，目标 NPC 下次出场时读取并清空。迁移 0055。
  pendingMentions: jsonb('pending_mentions').$type<WenlvNpcMention[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wenlv_npcs_product_id_id_uniq').on(t.productId, t.id),
  index('wenlv_npcs_product_id_idx').on(t.productId),
]);

/** NPC 生成/优化任务（AI 生成 NPC + AI 优化 NPC）。 */
export const pmsBuiWenlvNpcJobs = pgTable('pms_bui_wenlv_npc_jobs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  npcId: varchar('npc_id', { length: 50 }),
  nodeId: varchar('node_id', { length: 50 }),
  // 0068: 通用任务目标字段（character/npc/node/collectible/ending/reward）
  targetType: varchar('target_type', { length: 20 }),
  targetId: varchar('target_id', { length: 50 }),
  stage: varchar('stage', { length: 40 }),
  type: varchar('type', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  result: jsonb('result'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_npc_jobs_product').on(t.productId),
  index('idx_wenlv_npc_jobs_status').on(t.status),
  index('idx_wenlv_npc_jobs_target').on(t.targetType, t.targetId),
]);

export type WenlvAiJobType =
  | 'batch_generate' | 'single_optimize' | 'node_migrate'  // 老类型保留给旧 job 行读取（向后兼容）
  | 'character_optimize' | 'node_generate' | 'collectible_image'
  | 'ending_optimize' | 'reward_batch' | 'skeleton_generate'
  | 'node_refine' // 0074：节点二元化后的节点精修任务
  | 'flow_repair'; // 发布流程阻塞一键疏通（completed→visited/死锁松弛/孤儿线索 AI 派挂，自动落库）
export type WenlvAiJobTargetType = 'character' | 'npc' | 'node' | 'collectible' | 'ending' | 'reward' | 'product';

/** NPC 对话记录的一条消息。迁移 0054。 */
export type WenlvDialogueMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  ts: number;
};

// NPC 对话记录：一次章节对话 = 一行，messages 存完整对话历史。迁移 0054。
export const pmsBuiWenlvDialogues = pgTable('pms_bui_wenlv_dialogues', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  nodeId: varchar('node_id', { length: 50 }).notNull(),
  npcId: varchar('npc_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  characterId: varchar('character_id', { length: 50 }),
  // 团队模式共享对话（模块 C）。NULL = 单人模式（向后兼容）。
  teamId: varchar('team_id', { length: 64 }),
  messages: jsonb('messages').$type<WenlvDialogueMessage[]>().notNull().default([]),
  visualAnchors: jsonb('visual_anchors').$type<WenlvVisualAnchor[]>(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_dialogues_node').on(t.nodeId),
  index('idx_wenlv_dialogues_user').on(t.miniUserId),
  index('idx_wenlv_dialogues_team').on(t.teamId),
]);

// 实体触发器：节点/收集物/BLE 信标触发的实体-对话双驱动配置。迁移 0060。
export const pmsBuiWenlvTriggers = pgTable('pms_bui_wenlv_triggers', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  type: varchar('type', { length: 20 }).notNull(), // qr/beacon/ar
  nodeId: varchar('node_id', { length: 50 }),
  // 0079：到场触发器改绑剧本房场景（替代 nodeId）。nodeId 列暂留待旧 nodes 表退役批次移除。
  sceneId: varchar('scene_id', { length: 50 }),
  collectibleId: varchar('collectible_id', { length: 50 }),
  beaconUuid: varchar('beacon_uuid', { length: 36 }),
  beaconMajor: integer('beacon_major'),
  beaconMinor: integer('beacon_minor'),
  arAssetUrl: varchar('ar_asset_url', { length: 500 }),
  arDialogue: text('ar_dialogue'),
  triggerCondition: jsonb('trigger_condition').$type<WenlvCondition>(),
  unlockContent: jsonb('unlock_content').$type<WenlvUnlockContent>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_triggers_product').on(t.productId),
  index('idx_wenlv_triggers_type').on(t.type),
  index('idx_wenlv_triggers_node').on(t.nodeId),
  index('idx_wenlv_triggers_scene').on(t.sceneId),
  index('idx_wenlv_triggers_collectible').on(t.collectibleId),
]);

// 玩家实体进度：SAN 值、收集物、已解锁触发器的玩家级状态。迁移 0061。
export const pmsBuiWenlvPlayerProgress = pgTable('pms_bui_wenlv_player_progress', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  dialogueId: varchar('dialogue_id', { length: 50 }),
  san: integer('san').notNull().default(100),
  collectedCollectibles: jsonb('collected_collectibles').$type<string[]>().notNull().default([]),
  unlockedTriggers: jsonb('unlocked_triggers').$type<string[]>().notNull().default([]),
  status: varchar('status', { length: 20 }).notNull().default('active'), // active/completed/abandoned
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_player_progress_user').on(t.miniUserId),
  index('idx_wenlv_player_progress_product').on(t.productId),
  uniqueIndex('uq_wenlv_player_progress_user_product').on(t.productId, t.miniUserId),
]);

// P4：发布快照表 —— 每次发布时存一份全量 JSON 快照，支持回滚到任意已发布版本。
// snapshotData 形状 = { product, nodes, collectibles, characters, npcs, endings, rewards, tiers }。
// 回滚策略：删光当前子资源 → 按快照逐表重建（与 applyLevel 同款「先删后建」范式）。
export const pmsBuiWenlvProductSnapshots = pgTable('pms_bui_wenlv_product_snapshots', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  // 快照对应的发布版本号（= 发布时的 publishedVersion）。同 productId 下唯一。
  version: integer('version').notNull(),
  snapshotData: jsonb('snapshot_data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('wenlv_snapshots_product_version_uniq').on(t.productId, t.version),
  index('wenlv_snapshots_product_id_idx').on(t.productId),
]);

// ── 团队剧本：队伍表（Task 9）──────────────────────────────────────────────
// 与 sessions 表（P2 票随人走的「场次队」）**不互替**：sessions 是交易层驱动的场次分队，
// 本表是剧本杀「组局」模式的玩家自组队——玩家自己建队、邀请码拉人、选角、开局。
// 成员存在 jsonb `members` 数组里（不是拆成子表）：队伍生命周期短、成员数小（<10），
// 整体读写更简单；拆表的好处（按成员反查）在本场景无消费方。
//
// ⚠️ 本表追加在文件末尾，不插在中间：本文件有大量行号坐标被外层仓文档引用，
//    追加漂移为 0（同 sessions 表的处理）。
/** 队伍成员（jsonb `members` 的一项）。characterId 可空 = 尚未选角。 */
export type WenlvTeamMember = {
  userId: string;
  characterId?: string;
  squadId?: string;
  joinedAt: string; // ISO 字符串
};
/** 小队（jsonb `squads` 的一项）。Task 12 协作答题时按小队分组用；本片只建结构不接线。 */
export type WenlvTeamSquad = {
  id: string;
  name: string;
  memberIds: string[];
};
/** 队伍共享进度（Task 12）。存在 teams 表的 `progress` jsonb 列。
 *  - visited/collected/completed：全员进度的**并集**（单调累加，与 mergeStates 同语义）。
 *  - collaborativeAnswers：协作题答题状态，key = `${nodeId}:${interactionIndex}`，
 *    value = { [userId]: answer }。全员提交后由 /answer 判定并清空该 key。
 *  仅在 status='playing' 后写入；forming 阶段恒为 {}（选角不推进度）。 */
export type WenlvTeamProgress = WenlvState & {
  collaborativeAnswers?: Record<string, Record<string, unknown>>;
};

export const pmsBuiWenlvTeams = pgTable('pms_bui_wenlv_teams', {
  id: varchar('id', { length: 64 }).primaryKey(),
  productId: varchar('product_id', { length: 64 }).notNull(),
  leaderId: varchar('leader_id', { length: 64 }).notNull(),
  // 6 位邀请码（大写字母+数字，剔除歧义字符 0/O/1/I），全局唯一；join 时按它查队。
  inviteCode: varchar('invite_code', { length: 8 }).notNull().unique(),
  members: jsonb('members').$type<WenlvTeamMember[]>().notNull().default([]),
  squads: jsonb('squads').$type<WenlvTeamSquad[]>(),
  // 队伍共享进度（Task 12）：全员 visited/collected/completed 的并集 + 协作题答题状态。
  progress: jsonb('progress').$type<WenlvTeamProgress>().notNull().default({ visited: {}, collected: {}, completed: {} }),
  // forming（组队中，可加入/选角）/ playing（已开局，锁定成员与角色）/ completed（已结束）
  status: varchar('status', { length: 20 }).notNull().default('forming'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // 团队结算时间（status 变为 completed 时写入）。NULL = 未结算。
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('idx_wenlv_teams_product_id').on(t.productId),
]);

// ── 实景解密原子体系（迁移 0075，spec §4/§8）─────────────────────────────

// 场地能力档案：每个 venue 一份（1:1，venue_id 唯一索引），
// 登记配合能力 / 可部署原子白名单 / 动线半径 / 时段。发布闸据此判定原子可部署性。
export const pmsBuiWenlvVenueProfiles = pgTable('pms_bui_wenlv_venue_profiles', {
  id: varchar('id', { length: 50 }).primaryKey(),
  venueId: varchar('venue_id', { length: 50 }).notNull(),
  supportActions: jsonb('support_actions').$type<WenlvVenueProfileSupportActions>().notNull().default({}),
  deployableAtoms: jsonb('deployable_atoms').$type<string[]>().notNull().default([]),
  routeRadiusM: integer('route_radius_m'),
  timeWindows: jsonb('time_windows').$type<{ from: string; to: string }[]>().notNull().default([]),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_wenlv_venue_profiles_venue').on(t.venueId)]);

// 合作商户：暗号接头（cipher-contact）的回执码与三句培训卡载体。
export const pmsBuiWenlvMerchantPartners = pgTable('pms_bui_wenlv_merchant_partners', {
  id: varchar('id', { length: 50 }).primaryKey(),
  venueId: varchar('venue_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  role: varchar('role', { length: 20 }).notNull().default('restaurant'), // restaurant/merch/homestay
  cipherDish: varchar('cipher_dish', { length: 100 }),
  replyCode: varchar('reply_code', { length: 40 }),
  staffCard: text('staff_card'),
  timeWindows: jsonb('time_windows').$type<{ from: string; to: string }[]>().notNull().default([]),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  /** 关联平台商户主数据（pms_platform_merchants.id，BFF 库，跨库无外键）。可空：老数据未关联。 */
  platformMerchantId: varchar('platform_merchant_id', { length: 50 }),
  /** 0079：反向关联剧本房（pms_bui_wenlv_script_rooms.id）。可空：场地级商户未绑定具体剧本房。 */
  scriptRoomId: varchar('script_room_id', { length: 50 }),
  /** 0081：引用商户主数据（pms_bui_wenlv_merchants.id）。可空：Task 21 场地档案切换后才写入；
   *  目前仅被商户主数据列表/详情的关联场地计数消费（services/wenlv/merchant-master.ts）。 */
  merchantId: varchar('merchant_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_wenlv_merchant_partners_venue').on(t.venueId),
  index('idx_wenlv_merchant_partners_room').on(t.scriptRoomId),
  index('idx_wenlv_merchant_partners_master').on(t.merchantId),
]);

// 商户主数据（0081）：/merchants 模块的主表 —— 民宿/餐饮/文创等合作伙伴的名称、类型、
// 联系人与合作状态。与上面的 pms_bui_wenlv_merchant_partners 是**两个概念**：那是在场地
// 档案里的「商户×场地」合作挂接行（暗号接头载体），本表才是主数据；挂接行经 merchant_id
// 回指本表，列表/详情按它聚合关联场地数（merchant_id 由 Task 21 场地档案切换后写入）。
export const pmsBuiWenlvMerchants = pgTable('pms_bui_wenlv_merchants', {
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  // restaurant/homestay/merch/other —— 取值域对齐 merchant_partners.role，多一个 other 兜底
  type: varchar('type', { length: 20 }),
  contactName: varchar('contact_name', { length: 50 }),
  contactPhone: varchar('contact_phone', { length: 20 }),
  // active|suspended：在营=可被剧本房引用；停用=仅保留历史，不可新增引用
  status: varchar('status', { length: 20 }).notNull().default('active'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 实体道具：暗码系统生成即登记，供履约清单与布房勾表。
export const pmsBuiWenlvProps = pgTable('pms_bui_wenlv_props', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  kind: varchar('kind', { length: 20 }).notNull().default('letter'), // letter/key/card/prop
  code: varchar('code', { length: 40 }),
  placeNote: text('place_note'),
  nodeId: varchar('node_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('idx_wenlv_props_product').on(t.productId)]);

// 导演 v1 运行时编排状态（迁移 0076，spec §6.2 P1b）：每个在玩 progress 一行。
// 惰性 tick（mini 行为事件触发），无调度器；progress_id 唯一索引是 upsert 的冲突靶。
export const pmsBuiWenlvDirectorStates = pgTable('pms_bui_wenlv_director_states', {
  id: varchar('id', { length: 50 }).primaryKey(),
  productId: varchar('product_id', { length: 50 }).notNull(),
  progressId: varchar('progress_id', { length: 50 }).notNull(),
  // 行由应用层 upsert 创建（必带 state）；库级 default 仅给裸 INSERT 兜底，故 {} 强转。
  state: jsonb('state').$type<DirectorState>().notNull().default({} as DirectorState),
  alerts: jsonb('alerts').$type<DirectorAlert[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_wenlv_director_progress').on(t.progressId),
  index('idx_wenlv_director_product').on(t.productId),
]);

// 值守「标记已处理」闭环（迁移 0082，批 7 Task 23）：(progress_id, node_key) 一行，
// node_key = 导演 alerts 元素 id（stall:<key> / static:<key> / manual:…）。
// upsert 冲突靶 = uq_director_handle_progress_node；board 查询按它把 handled 三字段并回报警。
export const pmsBuiWenlvDirectorAlertHandles = pgTable('pms_bui_wenlv_director_alert_handles', {
  id: varchar('id', { length: 60 }).primaryKey(),
  productId: varchar('product_id', { length: 60 }).notNull(),
  progressId: varchar('progress_id', { length: 60 }).notNull(),
  nodeKey: varchar('node_key', { length: 120 }).notNull(),
  handledBy: varchar('handled_by', { length: 60 }).notNull(),
  handledAt: timestamp('handled_at', { withTimezone: true }).notNull().defaultNow(),
  note: text('note'),
}, (t) => [
  uniqueIndex('uq_director_handle_progress_node').on(t.progressId, t.nodeKey),
  index('idx_director_handle_product').on(t.productId),
]);

// ===== P3a 剧本房中心模型（0079 全量对等扩表）=====
export const pmsBuiWenlvScriptRooms = pgTable('pms_bui_wenlv_script_rooms', {
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  coverImage: varchar('cover_image', { length: 500 }),
  intro: text('intro'),
  // 一个内容产品（content_id）只对应一个剧本房：0079 由非唯一索引升级为唯一约束 uq_wenlv_script_rooms_content。
  contentId: varchar('content_id', { length: 50 }).notNull(),
  venueId: varchar('venue_id', { length: 50 }),
  mode: varchar('mode', { length: 20 }).notNull().default('standard'),
  difficulty: varchar('difficulty', { length: 20 }).notNull().default('normal'),
  purePlay: boolean('pure_play').notNull().default(false),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  // config 内支持 worldview（世界观锚点）、aiMode、门票/道具/导演锚点等（jsonb，无固定列）。
  config: jsonb('config').notNull().default({}),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqContent: uniqueIndex('uq_wenlv_script_rooms_content').on(t.contentId),
  idxVenue: index('idx_wenlv_script_rooms_venue').on(t.venueId),
}));

export const pmsBuiWenlvChapters = pgTable('pms_bui_wenlv_chapters', {
  id: varchar('id', { length: 50 }).primaryKey(),
  scriptRoomId: varchar('script_room_id', { length: 50 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  timeLabel: varchar('time_label', { length: 20 }),
  goal: text('goal'),
  order: integer('order').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  aiGenerated: boolean('ai_generated').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxRoom: index('idx_wenlv_chapters_room').on(t.scriptRoomId),
}));

// 场景：旧 pms_bui_wenlv_nodes 的对等承载（迁移 0079）。玩法字段与 nodes 逐一同构；
// 结局是 type='ending' 的场景（triggerCondition/priority/rewardId 仅该型使用，文案=content、图=image）。
export const pmsBuiWenlvScenes = pgTable('pms_bui_wenlv_scenes', {
  id: varchar('id', { length: 50 }).primaryKey(),
  chapterId: varchar('chapter_id', { length: 50 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('narrative').$type<WenlvSceneType>(),
  content: text('content'),
  npcId: varchar('npc_id', { length: 50 }),
  atoms: jsonb('atoms').$type<WenlvAtom[]>().notNull().default([]),
  puzzle: jsonb('puzzle').$type<WenlvPuzzle>(),
  order: integer('order').notNull().default(0),
  // —— 以下为 0079 补入的旧 nodes 对等玩法列 ——
  venuePointId: varchar('venue_point_id', { length: 50 }),
  requires: jsonb('requires').$type<WenlvCondition>(),
  geo: jsonb('geo').$type<WenlvGeo>(),
  mapX: integer('map_x'),
  mapY: integer('map_y'),
  image: varchar('image', { length: 500 }),
  narrationUrl: varchar('narration_url', { length: 500 }),
  grants: jsonb('grants').$type<string[]>().notNull().default([]),
  npcLineIds: jsonb('npc_line_ids').$type<string[]>().notNull().default([]),
  openingLine: text('opening_line'),
  chapterGoal: jsonb('chapter_goal').$type<WenlvChapterGoal>(),
  perspectiveCharacterId: varchar('perspective_character_id', { length: 50 }),
  sanDelta: integer('san_delta').notNull().default(0),
  arAssetUrl: varchar('ar_asset_url', { length: 500 }),
  arAssetUrls: jsonb('ar_asset_urls').$type<Record<string, string | null>>().notNull().default({}),
  arDialogue: text('ar_dialogue'),
  aiGenerated: boolean('ai_generated').notNull().default(false),
  // —— 结局承载（仅 type='ending'）——
  triggerCondition: jsonb('trigger_condition').$type<WenlvCondition>(),
  priority: integer('priority').notNull().default(0),
  rewardId: varchar('reward_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxChapter: index('idx_wenlv_scenes_chapter').on(t.chapterId),
  idxVenuePoint: index('idx_wenlv_scenes_venue_point').on(t.venuePointId),
  idxNpc: index('idx_wenlv_scenes_npc_id').on(t.npcId),
}));

// 流转：旧 pms_bui_wenlv_node_edges 的对等承载（迁移 0079）。condition 由 text 升级为结构化 jsonb。
export const pmsBuiWenlvFlows = pgTable('pms_bui_wenlv_flows', {
  id: varchar('id', { length: 50 }).primaryKey(),
  fromSceneId: varchar('from_scene_id', { length: 50 }).notNull(),
  toSceneId: varchar('to_scene_id', { length: 50 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('auto').$type<WenlvEdgeType>(),
  choiceText: text('choice_text'),
  condition: jsonb('condition').$type<WenlvCondition>(),
  grants: jsonb('grants').$type<string[]>().notNull().default([]),
  sanDelta: integer('san_delta').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxFrom: index('idx_wenlv_flows_from').on(t.fromSceneId),
  idxTo: index('idx_wenlv_flows_to').on(t.toSceneId),
}));

// P4 AI 协作 DIY 会话状态（迁移 0079）。pms-ai-crew 经 HTTP + X-Internal-Service-Token 读写。
export const pmsBuiWenlvAiSessions = pgTable('pms_bui_wenlv_ai_sessions', {
  id: varchar('id', { length: 50 }).primaryKey(),
  scriptRoomId: varchar('script_room_id', { length: 50 }).notNull(),
  userId: varchar('user_id', { length: 50 }).notNull(),
  stage: varchar('stage', { length: 20 }).notNull().default('intent').$type<WenlvAiStage>(),
  intent: jsonb('intent'),
  transcript: jsonb('transcript').notNull().default([]),
  draftSnapshots: jsonb('draft_snapshots').notNull().default({}),
  status: varchar('status', { length: 20 }).notNull().default('active').$type<WenlvAiSessionStatus>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxRoom: index('idx_wenlv_ai_sessions_room').on(t.scriptRoomId),
  idxUser: index('idx_wenlv_ai_sessions_user').on(t.userId),
}));
