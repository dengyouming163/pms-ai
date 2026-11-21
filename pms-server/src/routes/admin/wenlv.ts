// 文旅内容层 admin API（创作台经 pms-platform wenlv-studio 代理调用，浏览器不直连）
// 鉴权：X-Internal-Service-Token === INTERNAL_SERVICE_TOKEN（同 /api/admin/mp-config）。
// 读取返回含谜题答案/触发凭证（供编辑），与 C 端脱敏严格区分。
import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, desc, inArray, isNull, ne, count, sum, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';
// 统一错误出口：HttpError 子类透传业务文案，其余异常服务端记完整对象、响应只回通用文案
// （drizzle 的 `Failed query: <SQL> params` 不得直返客户端，见 no-raw-error-leak 闸）。
import { serverError } from '../../lib/http-error.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvCollectibles,
  pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers,
  pmsBuiWenlvClaims, pmsBuiWenlvProgress, pmsBuiWenlvEvents,
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints, pmsBuiWenlvCultureMaterials,
  pmsBuiWenlvClientReports, pmsBuiWenlvBeacons,
  pmsBuiWenlvDesignAssets,
  pmsBuiWenlvDesignTemplates,
  pmsBuiWenlvCharacters,
  pmsBuiWenlvNpcs,
  pmsBuiWenlvNpcJobs,
  pmsBuiWenlvProductSnapshots,
  pmsBuiWenlvTriggers,
  pmsBuiWenlvVenueProfiles,
  pmsBuiWenlvMerchantPartners,
  pmsBuiWenlvMerchants,
  pmsBuiWenlvProps,
  pmsBuiWenlvDirectorStates,
  pmsBuiWenlvDirectorAlertHandles,
  pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes, pmsBuiWenlvFlows,
} from '../../db/schema/index.js';
// P3a 剧本房 CRUD：纯函数投影 + 读写 service（Task 3 落地，本文件只挂路由）。
import { listScriptRooms, getScriptRoom, getScriptRoomChapters, getChapterScenes,
  createChapter, updateChapter, deleteChapter,
  createScene, updateScene, deleteScene,
  createFlow, updateFlow, deleteFlow,
  listRoomEndings, chapterBelongsToRoom, createEndingScene,
  updateScriptRoom, getScriptRoomFlows, loadRuntimeGraph, countScenesByContent } from '../../services/wenlv/script-room.js';
// 商户主数据（0081）：/merchants 模块的列表与详情聚合（区别于场地级合作商户）。
import { listMerchantMaster, getMerchantDetail } from '../../services/wenlv/merchant-master.js';
import type { WenlvState, WenlvCharacterSkill, WenlvHiddenQuest, WenlvNpcLine, WenlvChapterGoal, WenlvAtom, WenlvCondition, DirectorAlert } from '../../db/schema/wenlv.js';
// 解绑用的 kind 取值域。**故意不是 `string`** —— 五个调用点各写一个字面量，敲错
// （`'collectibles'` / `'endnig'`）在 `string` 下会编译通过且**静默不解绑**；窄类型让
// 那三个没有用例覆盖的端点也有编译期保护。同域先例：`services/wenlv/asset-gen/enqueue.ts`
// 的 `targetKind` 形参注释对同一个域写过同样的理由。本域与 `design_assets.target_kind`
// （迁移 0038）同域，见 `db/schema/wenlv.ts` 该列的注释。
import type { WritebackEntity } from '../../services/wenlv/asset-gen/writeback-type.js';
// T18：NPC 立绘生成走素材流水线（planBatch + enqueueBatch），与 wenlv-asset-gen.ts 的 /batch 同源。
// 不直接 UPDATE portrait_url —— 回写由 applyWriteback 在候选被采纳时单点承担（spec §5.4）。
import { planBatch, enqueueBatch, fitTag } from '../../services/wenlv/asset-gen/enqueue.js';
// 场地封面图：直接调 Seedream 同步生成（场地是独立实体，不需要 product 级风格基线）。
import { ArkImageProvider } from '../../services/wenlv/asset-gen/image-provider.js';
// T25：NPC 旁白 TTS —— AI crew S3 stage 返回 base64 音频，本路由转存 OSS 后回写 lines[].voiceUrl。
// uploadToOSS 与 tts-provider 的 synthesizeNarration 同源（services/aliyun/oss.ts）；sniffAudioType
// 按实际字节决定扩展名/MIME（与 tts-provider 的 narration 转存逐字同款，不写死 mp3）。
import { uploadToOSS } from '../../services/aliyun/oss.js';
import { sniffAudioType } from '../../services/wenlv/asset-gen/audio-type.js';
import type { WenlvStyleBible } from '../../db/schema/wenlv.js';
import {
  isVenueStage, canTransitionVenueStage, computeStagePatch, generatePointCode,
  POINT_CODE_MAX_LENGTH, POINT_CODE_RE,
} from '../../services/wenlv-venue.js';
import type { VenueStage } from '../../services/wenlv-venue.js';
import { deliveryStageFor, scriptDeliveryDays, firstScriptDeliveryDays, pickFirstScript } from '../../services/wenlv-delivery.js';
import { derivePlacement, canAdvance, patchForAdvance, clearedByReset } from '../../services/wenlv-placement.js';
import type { PlacementState, PlacementTarget } from '../../services/wenlv-placement.js';
import { validateWenlvIntegrity } from '../../services/wenlv-integrity.js';
import { validateGraphIntegrity } from '../../services/wenlv/node-graph/integrity.js';
import { buildPublishTodos } from '../../services/wenlv/publish-todos.js';
import { buildPublishChecklist } from '../../services/wenlv/publish-check.js';
import { buildProjectBoard } from '../../services/wenlv/project-board.js';
import { buildFulfillmentPack } from '../../services/wenlv/fulfillment-pack.js';
import { buildFunnel } from '../../services/wenlv/funnel.js';
import { simulateWenlv } from '../../services/wenlv-simulate.js';
import { loadDesignTokensForProduct } from '../../services/wenlv-design-load.js';
import { nodeRequiresCredential, nodeDisplayLocation } from '../../services/wenlv-engine.js';
import { sanitizeWenlvTheme } from './wenlv-theme-sanitize.js';
// 节点精修采纳：组装勾选字段为 scene patch（0079 统一模型后仍按 scene.type 做类型耦合）。
import { buildRefinePatch } from '../../services/wenlv/node-refiner/apply.js';
import { summarizeReports } from '../../services/wenlv-report.js';
import { normalizeMac, normalizeUuid, isValidBeaconNumber } from '../../services/wenlv-beacon.js';
// P2.2 PC 创作台测试对话：复用 mini 端同一 LLM 客户端（streamNpcReply），不入库、不鉴 mini JWT。
// 创作者在 NPC 编辑器内临时构造章节目标，验证人格一致性 / 目标达成。
import { streamNpcReply } from '../../services/wenlv/npc-dialogue/llm-client.js';
// P2 Task 2.1：角色 AI 一键优化异步入队代理（Task 1.14 创建）。
import { optimizeCharacter, batchGenerateRewards, generateCollectibleImage, generateSkeleton } from '../../services/wenlv/ai-content-gen.js';
// 导演 v1（Task 16）：skip 干预复用 /answer 同一份节点完成链路；message 走 NPC 对话 hint 同通道。
import { applyNodeCompletion, syncPlayerCollectibles } from '../../services/wenlv/node-graph/complete-node.js';
import { appendNpcMessage, appendDirectorAlert } from '../../services/wenlv/director.js';

const route = new Hono();

route.use('*', async (c, next) => {
  if (c.req.header('X-Internal-Service-Token') !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: '禁止访问：内部服务认证失败' }, 403);
  }
  return next();
});

/** 读取采风采集人（平台用户 id）。
 *
 *  ⚠️ **仅用于归属审计，绝不是权限边界。** 这个头由 pms-platform-server 从**已验签的 JWT**
 *  现场构造（见 wenlv-studio.ts 的 proxyContent），但本服务同时接受 X-Internal-Service-Token 直连
 *  ——「头存在」不等于「来自某个真实平台用户」。任何按 created_by 做鉴权的写法都是错的：
 *  伪造一个 id 就能把归属推给别人。归属数据的用途只有「事后追责/统计」。
 *
 *  值按列宽 50 截断；空串 / 非字符串一律 null（= 未知采集人，与历史行的 NULL 同义）。
 *
 *  值同时用于 created_by 与铺码的 *_by —— 都是同一个「平台用户 id，仅审计归属」的语义。 */
function platformUserIdFrom(c: any): string | null {
  const raw = c.req.header('X-Platform-User-Id');
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v ? v.slice(0, 50) : null;
}

// 导出仅为单测可达（schema 层是 DB-free 的 transform 接线点，见 wenlv-theme-sanitize.test.ts）
// 剧本 config（jsonb）的 zod 校验。
// 🔴 用 .passthrough()：config 是 jsonb，AI 出稿 / 历史数据可能带未声明的键，
//    严格 object 会把它们 strip 掉 ⇒ 一次「只改名字」的 PATCH 会把存量 config 里的
//    其它键悄悄抹掉。passthrough 让未声明键原样透传，只对声明过的键做校验。
// 现有字段（checkinRule / collectRule / validDays）保留校验；团队配置字段是 Task 10 新增。
const productConfigSchema = z.object({
  checkinRule: z.string().optional(),
  collectRule: z.string().optional(),
  validDays: z.number().int().optional(),
  // 队伍人数范围：min/max 均 ≥ 1，且 min ≤ max（否则人数范围无意义）。
  teamSize: z.object({
    min: z.number().int().min(1),
    max: z.number().int().min(1),
  }).refine((t) => t.min <= t.max, { message: 'teamSize.min 不能大于 max' }).optional(),
  collaborativePuzzles: z.boolean().optional(),
  exclusiveClues: z.record(z.string(), z.array(z.string())).optional(),
  squads: z.boolean().optional(),
  allowDuplicateRoles: z.boolean().optional(),
}).passthrough().optional();

export const productHeadSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(200),
  subtitle: z.string().max(200).optional().nullable(),
  coverImage: z.string().max(500).optional().nullable(),
  // theme.primaryColor 落库前剥离非法色值（AI 建档/精修绕过创作台表单，这是两条路径唯一的共同兜底）。
  // transform 挂在 optional **内层**：PATCH 不传 theme 时 ZodOptional 短路、transform 不执行，
  // 该键保持 undefined —— 不会凭空造出 {} 把库里已有的 theme 覆盖掉。
  theme: z.any().optional().transform((v) => sanitizeWenlvTheme(v)),
  config: productConfigSchema,
  // 产品 mode（narrative 剧情 / rally 集章）与运营窗口（opsStartAt/opsEndAt）。
  // 用 z.coerce.date 而非 string：PATCH 直接 set({...parsed.data})，避免 string→Date TS 冲突；
  // 空串会 Invalid Date 致 parse 失败 400，清空请传 null。
  mode: z.enum(['narrative', 'rally']).optional(),
  // 成局形态：solo 单人 / group 多人 / both 两者皆可。与上面的 mode 正交。
  //
  // 🔴 三个值的**语义**（与时序无关，这是值的定义）：
  //      须带场次 ⟺ 'group'；禁带场次 ⟺ 'solo'；`both` **两个方向都放行**
  //      （带 slotId = 团队局，不带 = 单人局）。
  //    ⇒ 消费侧（场次排期 / 下单契约）**不得**写成 `!== 'group'` —— 那会把 both
  //      错判成单人：排不了场次，带了 slotId 反被拒。
  //    值的权威在**本行**（写入口 zod）；库上**没有 CHECK** ⇒ 加第三个值**不需要迁移**。
  //
  // ⚠️ 必须 `.optional()` 而**不加 `.default()`**：productHeadPatchSchema 是
  // productHeadSchema.partial() 派生出来的，而 `.partial()` **不会**去掉 default。
  // 一旦带上默认值，任何不传该键的 PATCH 都会被注入 'solo'，
  // 而 PATCH 是 set({ ...parsed.data }) 直接展开 ⇒ 改个标题就把多人剧本降级成单人。
  // 现有 `mode` 字段同样是 optional 无默认，保持一致。
  playMode: z.enum(['solo', 'group', 'both']).optional(),
  // 免费游玩（免费剧本引流）。🔴 本字段是**放行判定的唯一权威**，见 `routes/mini/wenlv.ts` 的 assertTicket。
  //
  // ⚠️ 必须 `.optional()` 而**绝不加 `.default()`** —— 与紧挨着的 `playMode` 同一个坑：
  //    productHeadPatchSchema 是 productHeadSchema.partial() 派生的，而 `.partial()`
  //    **不会**去掉 default。一旦带默认值，任何不传该键的 PATCH 都会被注入 false，
  //    而 PATCH 是 set({ ...parsed.data }) 直接展开 ⇒ 改个标题就把免费剧本关成付费。
  isFree: z.boolean().optional(),
  opsStartAt: z.coerce.date().optional().nullable(),
  opsEndAt: z.coerce.date().optional().nullable(),
  // 归属场地。**必填** —— 建了剧本却不绑场地，节点就没法绑点位（扫码触发链路断在这里），
  // 而 AI 创作也点不出参考点位与文化素材。空串与 null 一视同仁地 400：产品不允许存在
  // 「无场地」的剧本，所以既没有「未归属」这个态，也没有「解绑」这个操作。
  //
  // 与下面的 `venuePointId`（nodes 表）**刻意不同款**：那个是可选的引用，节点不绑点位是
  // 合法态，「空串 ⇒ 归 NULL = 解绑」在那里仍是正确答法。别为了「风格统一」把两者改齐。
  venueId: z.string().max(50).transform((v) => v.trim())
    .refine((v) => v.length > 0, { message: '必须选择场地' }),
  // AI 出稿输入快照（S2）。只由 pms-agent 落库时写一次，创作台表单不编辑它。
  // ⚠️ 语义自 2026-09-24 起是「**本次选中的子集**」，不再是「该场地全量」——
  //    一个 12 点位的场地里只有 3 个点位的快照是**正常的**，不是 bug。
  // 不设 .default()：PATCH 的 .partial() 才不会给它注入默认值把既有快照抹掉。
  aiInput: z.any().optional().nullable(),
  // 风格基线（S3）。**不要写成 z.any().default({})** —— .partial() 对带 default 的字段
  // 在省略时仍会注入默认值，一次「只改名字」的 PATCH 会把基线清空。
  //
  // 照抄**紧挨着上面的 `aiInput`**：那是同一个需求（「只写一次、不被无关 PATCH 抹掉」）
  // 的既有实现，S2 已上线生产、其行为已被验证。它与本字段逐字同形，不是巧合。
  styleBible: z.any().optional().nullable(),
});

/** 免费剧本模式约束（已废弃 2026-10-01）。
 *
 *  原约束：免费 + group/both 拒，理由是「队伍围绕订单建，免费剧本不产生订单 ⇒ 建不了队」。
 *  但 `pms_bui_wenlv_teams` 表已不依赖订单（leaderId 直接是 mini_user_id），且测试剧本
 *  需要免费 + 多人。故约束已放宽：本函数永远放行（返回 null）。
 *
 *  保留函数签名以兼容现有调用点（POST/PATCH 处的 `if (freeReject) return 400` 分支）与单测，
 *  但该分支永不进入。新代码不要依赖它的判定结果。
 *
 *  @deprecated 约束已放宽，本函数将永久返回 null。 */
export function freeModeReject(
  _isFreeFinal: boolean | undefined | null,
  _playModeFinal: string | undefined | null,
): string | null {
  return null;
}

/** PATCH 专用。venueId 不是「可选字段」而是「要么不改、要么改成另一个真实场地」，
 *  所以既不是 required 也不是 nullable，而是 **optional + 拒绝一切空值**。
 *
 *  ⚠️ 为什么必须独立、不能用 `productHeadSchema.partial()`：`partial()` 只把 required
 *  摘成 optional，**不阻止传值** —— 空串仍会跑完 transform 再被 refine 拒。也就是说
 *  partial() 现在「碰巧」也拒空值，但那是 `productHeadSchema.venueId` 的**副作用**，
 *  不是这里的保证。哪天有人把 venueId 放宽回 `optional().nullable()`（例如为了支持
 *  「先建后绑」的导入流程），PATCH 会在**同一个提交里**静默恢复解绑能力 —— 那正是
 *  本设计最想避免的静默失败。独立 schema 把这条语义钉在 PATCH 自己身上。
 *
 *  ⚠️ `.optional()` 必须在**最外层**（写在 .transform()/.refine() 之后）。写成
 *  `z.string().optional().transform(v => v.trim())` 的话，undefined 会先进入 transform
 *  对 undefined 调 .trim() 直接抛异常 —— 那是 500，不是 400。 */
export const productHeadPatchSchema = productHeadSchema
  .omit({ venueId: true })
  .partial()
  .extend({
    venueId: z.string().max(50).transform((v) => v.trim())
      .refine((v) => v.length > 0, { message: '必须选择场地' })
      .optional(),
  });

// P3a 剧本房创建 schema。字段语义对齐 pms_bui_wenlv_script_rooms 列：
//   name/contentId 必填（业务最小集）；venueId 可选（先建后绑，与 products 的必填款**刻意不同**——
//   剧本房可独立于场地存在，章节/场景/流向都不依赖场地点位）；
//   mode/difficulty/purePlay/config 可选，落库走 DB 默认值；
//   status/publishedAt/createdAt/updatedAt 由 DB 默认兜底，不接收客户端传入。
export const scriptRoomCreateSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(200),
  contentId: z.string().min(1, 'contentId 不能为空').max(50),
  venueId: z.string().max(50).optional().nullable(),
  coverImage: z.string().max(500).optional().nullable(),
  intro: z.string().optional().nullable(),
  mode: z.string().max(20).optional(),
  difficulty: z.string().max(20).optional(),
  purePlay: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

// deliveryStageFor 已上移到 services/wenlv-delivery.ts（度量口径的唯一 owner）并导出。
// 本文件的每个渲染点都从那里 import —— 优先级不再是「记得别用裸函数」的约定，
// 而是模块边界上的保证。

// 校验某产品是否归属（productId 必须命中，防跨产品子资源写入）
//
// **已软删（status='deleted'）的产品一并视为不存在**：这里是所有「**路径里带 productId**」的
// 端点的唯一入口，挡在这一处即可覆盖 详情 / 产品作用域的子资源增删改 / 素材生成 / 精修。
//
// ⚠️ **不覆盖「按要素 id 直连」的端点**（`PATCH|DELETE /nodes/:id`、`/collectibles/:id`、
//    `/endings/:id`、`/rewards/:id`、`/tiers/:id`）—— 它们压根不查产品，故已软删产品的
//    子行仍能被这些端点改到（改到的是看不见的数据）。要堵得在各自端点里反查产品，代价大、
//    收益低，本轮**有意不堵**（见计划「已知残留」）。
//
// 副作用是 `DELETE /products/:id` 自己也走这里 —— 对已删产品再删一次得到 404，正是想要的幂等语义。
async function getProductOr404(c: any, productId: string) {
  const [row] = await db.select().from(pmsBuiWenlvProducts)
    .where(and(eq(pmsBuiWenlvProducts.id, productId), ne(pmsBuiWenlvProducts.status, 'deleted'))).limit(1);
  if (!row) return c.json({ success: false, error: '内容产品不存在' }, 404);
  return row;
}

// ===== 场地（物理建设的容器）=====

const venueSchema = z.object({
  name: z.string().min(1, '场地名称不能为空').max(100),
  address: z.string().optional().nullable(),
  city: z.string().max(50).optional().nullable(),
  latitude: z.string().max(30).optional().nullable(),
  longitude: z.string().max(30).optional().nullable(),
  ownerStaffId: z.string().max(50).optional().nullable(),
  contactName: z.string().max(50).optional().nullable(),
  contactPhone: z.string().max(20).optional().nullable(),
  remark: z.string().optional().nullable(),
  coverImage: z.string().max(500).optional().nullable(),
});

/** 场地不存在 → Response(404)；存在 → 行。调用点用 `instanceof Response` 分辨。 */
async function getVenueOr404(c: any, id: string) {
  const [row] = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id)).limit(1);
  if (!row) return c.json({ success: false, error: '场地不存在' }, 404);
  return row;
}

route.get('/venues', async (c) => {
  const rows = await db.select().from(pmsBuiWenlvVenues).orderBy(desc(pmsBuiWenlvVenues.createdAt));
  if (rows.length === 0) return c.json({ success: true, data: { list: [], total: 0 } });
  const ids = rows.map((r) => r.id);
  const [pointRows, beaconRows, productRows] = await Promise.all([
    db.select({ venueId: pmsBuiWenlvVenuePoints.venueId, id: pmsBuiWenlvVenuePoints.id })
      .from(pmsBuiWenlvVenuePoints).where(inArray(pmsBuiWenlvVenuePoints.venueId, ids)),
    // 信标按场地计数（T19 列表卡「信标数」）。**口径：不筛 status**——在库/在役/故障/退役
    // 全部计入，反映这块场地累计铺过多少台设备；触发侧的拒绝清单（faulty/retired）是另一回事。
    db.select({ venueId: pmsBuiWenlvBeacons.venueId, id: pmsBuiWenlvBeacons.id })
      .from(pmsBuiWenlvBeacons).where(inArray(pmsBuiWenlvBeacons.venueId, ids)),
    // 多选 contentReadyAt/createdAt：首剧本（§5.3）要按「谁先定稿」选，不能只查计数。
    // 一次查全场地剧本（而不是每个场地再查一次），列表页因此没有 N+1。
    // 已软删的剧本不计入 scriptCount / 首剧本交付 —— 否则场地列表会「删了还在」
    db.select({
      venueId: pmsBuiWenlvProducts.venueId, id: pmsBuiWenlvProducts.id,
      contentReadyAt: pmsBuiWenlvProducts.contentReadyAt, createdAt: pmsBuiWenlvProducts.createdAt,
    })
      .from(pmsBuiWenlvProducts)
      .where(and(inArray(pmsBuiWenlvProducts.venueId, ids), ne(pmsBuiWenlvProducts.status, 'deleted'))),
  ]);
  const tally = (arr: { venueId: string | null }[]) => {
    const m = new Map<string, number>();
    for (const r of arr) if (r.venueId) m.set(r.venueId, (m.get(r.venueId) || 0) + 1);
    return m;
  };
  const pMap = tally(pointRows), bMap = tally(beaconRows), sMap = tally(productRows);
  const byVenue = new Map<string, typeof productRows>();
  for (const r of productRows) {
    if (!r.venueId) continue;
    const arr = byVenue.get(r.venueId);
    if (arr) arr.push(r); else byVenue.set(r.venueId, [r]);
  }
  const list = rows.map((r) => ({
    ...r,
    pointCount: pMap.get(r.id) || 0,
    beaconCount: bMap.get(r.id) || 0,
    scriptCount: sMap.get(r.id) || 0,
    // 首剧本交付时长（含场地建设，§5.3）。没有剧本 / 没有已定稿的剧本 / 场地缺采风章
    // 时 pickFirstScript 或度量函数返回 null —— **必须原样透出 null**，不能用 0 顶替：
    // 列表页把 null 渲染成「-」，而 0 会被读成「当天就交付了」，是个彻头彻尾的假数字。
    firstScriptDeliveryDays: firstScriptDeliveryDays(r, pickFirstScript(byVenue.get(r.id) ?? []) ?? {}),
  }));
  return c.json({ success: true, data: { list, total: list.length } });
});

route.get('/venues/:id', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const [points, products] = await Promise.all([
    db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.venueId, venueId)).orderBy(pmsBuiWenlvVenuePoints.sortOrder),
    // 已软删的剧本不出现在场地详情里
    db.select().from(pmsBuiWenlvProducts)
      .where(and(eq(pmsBuiWenlvProducts.venueId, venueId), ne(pmsBuiWenlvProducts.status, 'deleted')))
      .orderBy(desc(pmsBuiWenlvProducts.createdAt)),
  ]);
  // 剧本交付阶段与时长由纯函数推导（不落库、不复制 AI run 状态）。
  // 阶段走 deliveryStageFor 而非裸 deriveDeliveryStage：这里 `...p` 会带上 status，
  // 正是「status 与推导值并排渲染」的那个界面，优先级必须收在一处（见 deliveryStageFor）。
  //
  // 两个时长口径**并存、互不替代**（§5.3）：deliveryDays = 纯内容（起稿→定稿），每一行都有；
  // firstScriptDeliveryDays = 含场地建设（采风开始→首次交付），只落在首剧本那一行，其余行 null。
  const firstScript = pickFirstScript(products);
  const scripts = products.map((p) => ({
    ...p,
    deliveryStage: deliveryStageFor(p),
    deliveryDays: scriptDeliveryDays(p),
    // 只给首剧本算这一个数：其余剧本的「首剧本时长」没有意义（场地建设只摊一次），
    // 留 null 而不是重复首剧本的数字，界面才对得上「哪一行才是首剧本」。
    firstScriptDeliveryDays: p.id === firstScript?.id ? firstScriptDeliveryDays(venue, p) : null,
  }));
  return c.json({
    success: true,
    data: {
      ...venue, points, scripts,
      missingCodeCount: points.filter((p) => !p.code).length,
    },
  });
});

route.post('/venues', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const parsed = venueSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const [exist] = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入
  const d = parsed.data;
  const [row] = await db.insert(pmsBuiWenlvVenues).values({
    id, name: d.name,
    address: d.address ?? null, city: d.city ?? null,
    latitude: d.latitude ?? null, longitude: d.longitude ?? null,
    ownerStaffId: d.ownerStaffId ?? null,
    contactName: d.contactName ?? null, contactPhone: d.contactPhone ?? null,
    remark: d.remark ?? null,
    coverImage: d.coverImage ?? null,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/venues/:id', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const parsed = venueSchema.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const [row] = await db.update(pmsBuiWenlvVenues).set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvVenues.id, venueId)).returning();
  return c.json({ success: true, data: row });
});

// 阶段流转：合法相邻态校验在纯函数里，这里只接线 + 盖章
route.post('/venues/:id/stage', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const body = await c.req.json().catch(() => ({}));
  const to = body.to;
  if (!isVenueStage(to)) return c.json({ success: false, error: '阶段值非法' }, 400);
  const from = venue.status as VenueStage;
  if (!isVenueStage(from)) return c.json({ success: false, error: `场地当前阶段「${venue.status}」非法` }, 500);
  if (!canTransitionVenueStage(from, to)) {
    return c.json({ success: false, error: `不能从「${from}」直接流转到「${to}」` }, 409);
  }
  const patch = computeStagePatch(venue, to, new Date());
  // 不要加 `as any` —— `patch` 的返回类型是精确的 Partial<Record<VenueStampKey, Date>>，
  // Drizzle 行可直接赋值。加了 cast 会让「章名拼错」这类错误从编译期消失，
  // 变成生产里一个静默写不进去的字段（本项目唯一的类型检查就在这条链路上）。
  const [row] = await db.update(pmsBuiWenlvVenues)
    .set({ ...patch, status: to, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvVenues.id, venueId)).returning();
  return c.json({ success: true, data: row });
});

route.delete('/venues/:id', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  // 双层解构：drizzle 的 select().limit(1) 仍解析为**数组**，只解一层拿到的是 `[]`（恒真），
  // 会让 `pt || prod || mat` 无条件成立 —— 空场地也被拒 409，删除 100% 失效。
  // 与同文件 `DELETE /points/:id` 的 `const [used] = ...` 同款形状。
  //
  // 第三个查询是文化素材：S2 的 `pms_bui_wenlv_culture_materials` **没有外键**，
  // 不放进守卫的话，「0 点位 + 0 剧本 + 有场地级素材」的场地会被删掉，
  // 剩下的素材行按 venueId 过滤后任何界面/接口都查不到 —— 一条全链路不可见的孤儿。
  const [[pt], [prod], [mat]] = await Promise.all([
    db.select({ id: pmsBuiWenlvVenuePoints.id }).from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.venueId, venueId)).limit(1),
    // 已软删的剧本不算「场地下还有剧本」—— 否则场地会被一个看不见的剧本永久堵住
    db.select({ id: pmsBuiWenlvProducts.id }).from(pmsBuiWenlvProducts)
      .where(and(eq(pmsBuiWenlvProducts.venueId, venueId), ne(pmsBuiWenlvProducts.status, 'deleted'))).limit(1),
    db.select({ id: pmsBuiWenlvCultureMaterials.id }).from(pmsBuiWenlvCultureMaterials)
      .where(eq(pmsBuiWenlvCultureMaterials.venueId, venueId)).limit(1),
  ]);
  if (pt || prod || mat) return c.json({ success: false, error: '场地下仍有点位、素材或剧本，不能删除' }, 409);
  await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, venueId));
  return c.json({ success: true, data: { id: venueId } });
});

// AI 一键生成场地封面图：用场地名+城市+地址构造 prompt，直接调 Seedream（同步，30s 超时）。
// 生成成功后回写 venues.cover_image，返回图片 URL。PC 端轮询/直接拿结果。
route.post('/venues/:id/cover', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  if (!venue.name) return c.json({ success: false, error: '场地名称为空，无法生成封面' }, 400);

  // 构造 prompt：文旅实景场地封面，突出场地名+地域特色
  const locationParts = [venue.city, venue.address].filter(Boolean).join('，');
  const prompt = `文旅实景探秘场地「${venue.name}」封面图，${locationParts ? '位于' + locationParts + '，' : ''}写实风景摄影风格，暖色调，电影级构图，高清画质，无文字`;

  try {
    const provider = new ArkImageProvider();
    const result = await provider.generate(prompt, {
      assetType: 'venue_cover',
      candidates: 1,
    });
    const url = result.urls?.[0];
    if (!url) return c.json({ success: false, error: '生成失败，未返回图片' }, 502);

    // 回写 cover_image
    await db.update(pmsBuiWenlvVenues)
      .set({ coverImage: url, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvVenues.id, venueId));
    return c.json({ success: true, data: { coverImage: url } });
  } catch (e) {
    // 不回 e.message：上游（Ark/Seedream）错误原文可能含密钥片段/内部地址，统一服务端日志 + 通用文案。
    return serverError(c, e, '封面生成失败，请稍后重试', 500);
  }
});

// ===== 点位（可跨剧本共用的物理资源池）=====

// 短码：人可读、可手输、可印。空串归一为 null —— `''` 是「填过又清空」，
// 语义等于「没有码」；留着它会让 `if (p.code)` 的读路径当它没值、
// 而 `code !== null` 的读路径当它有值，两种读法都「看着对」，于是没人发现。
const pointCodeSchema = z.string()
  .max(POINT_CODE_MAX_LENGTH, `短码不超过 ${POINT_CODE_MAX_LENGTH} 位`)
  .regex(POINT_CODE_RE, '短码只能用字母、数字、下划线、连字符')
  .nullable().optional()
  .transform((v) => (v === '' ? null : v));

// 建点位用：triggerType 有默认值
const pointSchema = z.object({
  name: z.string().min(1, '点位名称不能为空').max(100),
  code: pointCodeSchema,
  triggerType: z.enum(['qrcode', 'beacon']).default('qrcode'),
  geo: z.any().optional().nullable(),
  address: z.string().max(200).optional().nullable(),
  sortOrder: z.number().int().optional(),
  photos: z.array(z.string().max(500)).max(9).optional().nullable(),
  remark: z.string().optional().nullable(),
  // 调研落地来源（`pms_bui_wenlv_venue_research.id`）：这条点位是从哪一轮场地网络调研
  // 一键落地来的。可空 = 人工创建。
  // **不加空串归一 transform** —— 这里的 `''` 没有「未选中」的表单语义（不是 Select 控件），
  // 落成 `''` 是调用方的错；而且 `''` 与 NULL 在「是调研来的吗」这个问题上同义（都不是有效 id）。
  researchId: z.string().max(50).optional().nullable(),
});

// 改点位用：**必须与 pointSchema 分开**。
// zod 的 .partial() 对带 .default() 的字段仍会注入默认值 —— 用 pointSchema.partial() 做 PATCH，
// 会让「只改个名字」的请求把 triggerType 静默重置成 qrcode（信标点位被悄悄改成二维码）。
// 所以更新 schema 里所有字段都不带 .default()。
//
// **有意不含 createdBy**：采集人是既成事实，允许改等于让归属失去意义（谁都能把别人的采集改成自己的）。
// 别因为「新加了列就顺手补进 update schema」而把它加回来。
//
// **同样有意不含 researchId**（同 createdBy）：它表达「这条是**怎么来的**」，是创建时的事实；
// 事后可改等于让它撒谎。需要调整的关系由素材自身的 venuePointId 表达。
const pointUpdateSchema = z.object({
  name: z.string().min(1, '点位名称不能为空').max(100).optional(),
  code: pointCodeSchema,
  triggerType: z.enum(['qrcode', 'beacon']).optional(),
  // 「给这个点位补一个码」（2026-09-23 新增）。POST 用「`code` 省略」表达同一件事；
  // 而 PATCH 里「省略」=「不改」，所以**必须**另给一个显式信号才表达得出「补码」——
  // 否则「先建了纯信标点位、后来想补个二维码」这条路上服务端根本不会调生成器，
  // 表单勾上二维码、保存返回 200、库里**仍然没有码**，是静默失败。
  // ⚠️ 它是**有意**与 `code` 分开的，不要合并成一个四态字段：`code` 的三态
  // （省略=不改 / null=清空 / string=设值）已经用满，再塞「生成」进去就再也分不清
  // 「用户清空了码」与「用户要一个码」。
  generateCode: z.boolean().optional(),
  geo: z.any().optional().nullable(),
  address: z.string().max(200).optional().nullable(),
  sortOrder: z.number().int().optional(),
  photos: z.array(z.string().max(500)).max(9).optional().nullable(),
  remark: z.string().optional().nullable(),
});

route.get('/venues/:id/points', async (c) => {
  const venueId = c.req.param('id');
  // 与同组场地端一致：不存在的场地一律 404，而不是 200 + []（空数组会被读成「这个场地没有点位」）
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const rows = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.venueId, venueId))
    .orderBy(pmsBuiWenlvVenuePoints.sortOrder);
  return c.json({ success: true, data: rows });
});

/** 从「同码的其他场地行」构造 otherVenue。
 *
 *  **导出是为可单测**：`uq_wenlv_venue_points_code`（schema/wenlv.ts:409）是真实唯一索引、
 *  只约束 `code` 一列 ⇒ 一个码最多只属于一个场地 ⇒ **`others` 至多 1 条**。
 *  而本函数真正要处理的、也是唯一会暴露缺口的情形，是 `others` 跨**多个**场地时的归属收窄 ——
 *  那种输入受该索引保护、走真实 DB 造不出夹具，故只能在此对纯函数断言。
 *
 *  ⚠️ **「`others` 至多 1 条」不等于「本分支不可达」**：码属于**另一个**场地时
 *  `others.length === 1`，调用点照常走这里 —— 既有 route 测试
 *  （`wenlv-field-lookup.test.ts` 的「命中另一个场地的点位」用例）已覆盖那一路。
 *  唯一不可达的只是**能暴露本缺口的那种输入**。
 *
 *  契约是「**某一个**其他场地 + **它自己的**点位名」。此前 `pointNames` 跨了**全部**其他场地
 *  而 `id`/`name` 取自 `others[0]` ⇒ 不自洽，消费方（`pms-platform/pms-wenlv-survey/src/api.js:168`）
 *  会渲染出「贴错场地了：该码属于「A」的点位「b1、c1」」这种错误归属。
 *  ⚠️ 计划原文把该路径写成 `pms-wenlv-survey/src/api.js`，实地核对为
 *  `pms-platform/pms-wenlv-survey/src/api.js`（少写了 `pms-platform/` 前缀）。
 *  码一旦不再全局唯一就会真的输出错误文案。 */
export function buildOtherVenue(
  others: { venueId: string; name: string }[],
  nameById: Map<string, string>,
): { id: string; name: string; pointNames: string[] } | null {
  if (others.length === 0) return null;
  const ownerId = others[0].venueId;
  const mine = others.filter((r) => r.venueId === ownerId);
  return {
    id: ownerId,
    name: nameById.get(ownerId) ?? ownerId,
    pointNames: mine.map((r) => r.name),
  };
}

/** 走场验码：这个码是不是这个场地的这个点位？
 *  **断言式**（不是过滤式）：命中别的场地要**说出来**，否则「贴错场地」与「码不存在」
 *  会被压成同一个空结果，现场人员无从分辨该去改哪里。
 *  返回**数组**：`code` 目前由 `uq_wenlv_venue_points_code` 保证全局唯一（至多 1 条），
 *  但这里**不依赖**该前提 —— 只报告查到什么。将来索引若被去掉，也不会静默取第一条。 */
route.get('/venues/:id/points/lookup', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;

  const code = (c.req.query('c') || '').trim();
  if (!code) return c.json({ success: false, error: '缺少参数 c（要查的码）' }, 400);

  const rows = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.code, code));

  const matches = rows.filter((r) => r.venueId === venueId);
  const others = rows.filter((r) => r.venueId !== venueId);

  let otherVenue: { id: string; name: string; pointNames: string[] } | null = null;
  if (others.length > 0) {
    const ids = [...new Set(others.map((r) => r.venueId))];
    const vs = await db.select({ id: pmsBuiWenlvVenues.id, name: pmsBuiWenlvVenues.name })
      .from(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, ids));
    const nameById = new Map(vs.map((x) => [x.id, x.name]));
    otherVenue = buildOtherVenue(others, nameById);
  }

  return c.json({
    success: true,
    data: {
      code,
      scope: matches.length > 0 ? 'venue' : others.length > 0 ? 'otherVenue' : 'none',
      // 铺码三态时间戳一并透出：`data.matches` 是**点位形状**，与
      // `GET /venues/:id/points/qrcodes`（同文件 `printable.map`）**共同一批列**，但两处投影
      // **并不等价**（2026-09-22 逐列核对）：qrcodes 有 `sortOrder`、这里没有；这里多 `venueId`。
      // ⚠️ 本行原写的是「保持同一形状」—— **不实**，别照着它去复用同一份客户端类型：
      //    那会让 `sortOrder` 在类型上「可能在」而运行期恒 `undefined`
      //    （本仓「漏投影静默丢字段」那一族的入口）。
      // ⚠️ 这三列**不是新增数据**：上面 `db.select()` 整行读取，值本来就在手上，
      //    此前**只是投影时没取**（零增益，非缺陷）。漏投影不报错、只是静默变 null。
      // 未印/未铺/未验必须是**显式的 null** 而不是缺键：`placementLabel`
      // （pms-wenlv-survey/src/api.js）拿 undefined 今天也走 falsy 分支，
      // 但契约要明确，将来有人写 `x ?? 默认值` 就会出差别。
      matches: matches.map((r) => ({
        id: r.id, name: r.name, code: r.code, venueId: r.venueId,
        printedAt: r.printedAt, placedAt: r.placedAt, verifiedAt: r.verifiedAt,
      })),
      otherVenue,
    },
  });
});

route.post('/venues/:id/points', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const body = await c.req.json().catch(() => ({}));
  const parsed = pointSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;
  // pointCodeSchema 已把空串归一成 null，于是 `d.code` 三态泾渭分明：
  //   undefined = 没填（走生成器）／null = 明确没有码／string = 手填码。
  // ⚠️ 早先这里写着「真实表单里新建发 undefined、编辑发 null 且编辑走 PATCH，
  // 所以 POST 收到 null 只可能来自直连 API」—— **这半句已不成立**：2026-09-23 起点位表单
  // 支持「只装信标、不贴二维码」，新建时取消二维码勾选发出来的就是 `null`。那是**正常路径**。
  // 落库处**不能**写 `explicit ?? generatePointCode()` —— 那会把 null（明确的「没有码」）
  // 也当成「没填」再生成一个，于是「空串归一为 null」永远落不到库上。
  // 旧写法还带 `.trim()`：正则已禁空白，任何含空白的串在上一步就 400，trim 不再有意义。
  //
  // 【2026-09-23 删除】此处原有 `if (d.triggerType === 'beacon' && !explicit) → 400
  // '信标点位的 code（信标 ID）必须手填'`。那是**旧模型**的数据质量守卫：当时 `code` 里存的
  // 就是信标 ID，所以「beacon 必有 code」是条真不变量。新模型下信标的凭证换成了**广播帧**
  // （见 `src/routes/mini/wenlv.ts` 的 `beaconMatchesPoint`，它只认 `beacons.point_id` 与帧三件套），
  // `code` 与信标再无关系 ⇒「纯信标点位没有码」是**合法**形态，留着这条闸会把正常操作拒掉。
  //
  // 🔴 安全性：删它**不放松任何触发门**。`/trigger` 的凭证判定**全在 `mini/wenlv.ts`**
  // （`nodeRequiresCredential` + 「点位的 code 精确相等 **或** 广播帧命中该点位绑定的在役设备」），
  // 与这两条 400 无关。这两条闸只影响**写入**，从不影响写入之后能不能被触发。
  const explicit = typeof d.code === 'string' ? d.code : null;
  // 至少一种触发方式：code 或 geo
  const hasCode = explicit !== null;
  const hasGeo = d.geo != null;
  if (!hasCode && !hasGeo) {
    return c.json({ success: false, error: '点位至少配置一种触发方式：二维码内容/信标ID 或 经纬度' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入
  // 默认 sortOrder = 当前最大 + 1
  const existing = await db.select({ sortOrder: pmsBuiWenlvVenuePoints.sortOrder })
    .from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, venueId));
  const nextOrder = d.sortOrder ?? (existing.length ? Math.max(...existing.map((r) => r.sortOrder || 0)) + 1 : 1);
  const base = {
    id, venueId, name: d.name, triggerType: d.triggerType,
    geo: d.geo ?? null, address: d.address ?? null, sortOrder: nextOrder,
    photos: d.photos ?? null,
    remark: d.remark ?? null,
    researchId: d.researchId ?? null,
    // 采集人取自请求头而非 body：pointSchema 非 strict，接 body 字段等于让调用方自填归属。
    // （幂等重入分支在上方已 return，不会覆盖原采集人。）
    createdBy: platformUserIdFrom(c),
  };
  // 落库：手填 code（信标 ID / 已印物料）与自动生成 code 走**同一段**冲突处理。
  // 两者都会撞 uq_wenlv_venue_points_code，所以手填分支不能像旧写法那样待在 try 外 ——
  // 否则「换 id 复用已存在的 code」会 23505 冒泡成全局 500，而不是 409。
  //
  // 读 SQLSTATE 必须穿透 drizzle 的包装层：drizzle-orm 0.45.2 的 queryWithCache 会
  // `throw new DrizzleQueryError(qs, params, e)`，而 DrizzleQueryError 只有 message/query/params/cause，
  // **没有 code / constraint**。旧写法 `e?.code !== '23505'` 因此恒为 true（每次冲突都 rethrow），
  // 3 次重试循环体实际只执行一次，末尾那句 500 永远不可达 —— 一个装样子且完全失效的兜底。
  // 真正的 pg 错误在 `cause` 上，SQLSTATE 与约束名都从那里读。
  //
  // 按 constraint 精确匹配而非只看 23505：本表有两个唯一约束（id 主键 + code 唯一索引），
  // 不分约束会把主键冲突误报成「点位码被占用」，掩盖真实故障。
  // 主键冲突（并发下 id 预检通过后又撞车）此处不接，照旧抛出让其暴露为 500。
  // 同理：pms-server/src/routes/mini/wenlv.ts 的 claim 插入是同一包装层问题，原先也用 `e?.code` 读法（恒不命中），
  // 该路径已按同一形状修正：穿透 `cause` 读 SQLSTATE，并按 constraint 区分
  // uq_wenlv_claims_progress_tier（同档并发双击 → 读回既有 claim 幂等返回）与 uq_wenlv_claims_code（撞码 → 换码重试）。
  try {
    const [row] = await db.insert(pmsBuiWenlvVenuePoints)
      .values({ ...base, code: d.code === undefined ? generatePointCode() : explicit }).returning();
    return c.json({ success: true, data: row });
  } catch (e: unknown) {
    const pgErr = ((e as any)?.cause ?? e) as { code?: string; constraint?: string } | undefined;
    if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_venue_points_code') {
      // 生成码取自 32^12=2^60 空间，这里几乎不可达；即使命中也不是「未知 500」，而是可重试的冲突。
      return c.json({
        success: false,
        error: explicit ? '该点位码已被占用' : '点位码生成冲突，请重试',
      }, 409);
    }
    throw e;
  }
});

route.patch('/points/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '点位不存在' }, 404);
  // 用 pointUpdateSchema（无 .default()）而非 pointSchema.partial()：
  // 后者会注入 triggerType 默认值，把「只改名」变成「同时重置触发方式」。
  const parsed = pointUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;
  // 逐字段显式赋值，不用动态键循环 + `as any`。
  // 循环写法里 `as const` 已让**读侧**受保护（`d[k]` 键名写错会编译报错），
  // 但它把**写入侧**丢给了 `Record<string, unknown>`，且必须靠 `.set(patch as any)` 才过编译 ——
  // 那个 cast 与 Task 4 场地段定下的「不要加 as any」原则直接冲突。
  // 显式写法则两侧都受检（`d.x` 与 `patch.x` 都不许拼错），全程零 cast。
  //
  // 更正：早先这里写的是「键名写错照常编译、静默不写入」—— **那是错的**，
  // 读侧的 `d[k]` 会拦住拼写错误。别把这条不成立的理由当成改这段代码的依据。
  const patch: Partial<typeof pmsBuiWenlvVenuePoints.$inferInsert> = { updatedAt: new Date() };
  if (d.name !== undefined) patch.name = d.name;
  if (d.code !== undefined) patch.code = d.code;
  if (d.triggerType !== undefined) patch.triggerType = d.triggerType;
  if (d.geo !== undefined) patch.geo = d.geo;
  if (d.address !== undefined) patch.address = d.address;
  if (d.sortOrder !== undefined) patch.sortOrder = d.sortOrder;
  if (d.photos !== undefined) patch.photos = d.photos;
  if (d.remark !== undefined) patch.remark = d.remark;
  // 纵深防御：pointCodeSchema 已把空串归一为 null，正常路径走不到这里。
  // 留着是为了万一上游换掉 schema 时不会把空串写进库。
  if (typeof patch.code === 'string' && !patch.code.trim()) patch.code = null;
  // 补码（2026-09-23 新增）。三条约束，各有理由：
  //   ① 只在 `patch.code === undefined` 时动手 —— 客户端显式给了 `code`（设值 or 清空）时，
  //      **显式值优先于这个开关**。`generateCode: true` 配 `code: null` 是自相矛盾的输入
  //      （界面上两个勾选互斥，正常路径发不出来），此时按「用户明说的算」落成清空。
  //   ② 只在**当前没有码**时生成 —— 已有码时不覆盖：那会把一张已印出去的物料变成查无此码。
  //   ③ 生成出来的码同样可能撞 uq_wenlv_venue_points_code（空间 32^12，几乎不可达），
  //      所以下面把 update 包进与 POST 同形状的冲突处理，不给「未知 500」留口子。
  //
  // 【2026-09-23 删除】此处原有 `const nextType = …; const nextCode = …;
  // if (nextType === 'beacon' && !nextCode) → 400`，理由同 POST 那一条
  // （旧模型的守卫；新模型下「纯信标点位没有码」是合法形态）。
  // 删掉守卫后 `nextType` / `nextCode` 再无任何用处，**随之删掉** —— 别把它们留成装饰，
  // 那会让下一个读这段的人以为「beacon 必有 code」还是条在执行的规则。
  // ⚠️ 这个标志是**必需**的，不能靠事后 `typeof patch.code === 'string'` 反推 ——
  // 生成器跑完之后 `patch.code` 也是个字符串，两者长得一样，反推会把
  // 「生成冲突」误报成「该点位码已被占用」，把真实故障指错方向。
  let generated = false;
  if (d.generateCode && patch.code === undefined && !exist.code) {
    patch.code = generatePointCode();
    generated = true;
  }
  // 至少一种触发方式：code 或 geo（PATCH 需合并现有值：未传的字段取现有点位的值）
  const finalCode = patch.code !== undefined ? patch.code : exist.code;
  const finalGeo = patch.geo !== undefined ? patch.geo : exist.geo;
  const hasCode = finalCode !== null;
  const hasGeo = finalGeo != null;
  if (!hasCode && !hasGeo) {
    return c.json({ success: false, error: '点位至少配置一种触发方式：二维码内容/信标ID 或 经纬度' }, 400);
  }
  try {
    const [row] = await db.update(pmsBuiWenlvVenuePoints).set(patch)
      .where(eq(pmsBuiWenlvVenuePoints.id, id)).returning();
    return c.json({ success: true, data: row });
  } catch (e: unknown) {
    // 读 SQLSTATE 必须穿透 drizzle 的包装层（真正的 pg 错误在 `cause` 上）——
    // 理由与 POST 那处同一段（`DrizzleQueryError` 没有 code/constraint，`e?.code` 恒不命中）。
    const pgErr = ((e as any)?.cause ?? e) as { code?: string; constraint?: string } | undefined;
    if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_venue_points_code') {
      return c.json({
        success: false,
        error: generated ? '点位码生成冲突，请重试' : '该点位码已被占用',
      }, 409);
    }
    throw e;
  }
});

// ===== 信标设备台账 =====
// 门禁：BFF 侧挂 'field'（现场作业）。本服务只认 X-Internal-Service-Token。

route.get('/venues/:id/beacons', async (c) => {
  const venueId = c.req.param('id');
  // 与同组场地端一致：不存在的场地一律 404，而不是 200 + []（空数组会被读成「这个场地没有设备」）
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const rows = await db.select().from(pmsBuiWenlvBeacons)
    .where(eq(pmsBuiWenlvBeacons.venueId, venueId))
    .orderBy(pmsBuiWenlvBeacons.name, pmsBuiWenlvBeacons.createdAt);
  return c.json({ success: true, data: rows });
});

/** 设备四态。**唯一副本** —— 下面两个 zod schema 与 `GET /beacons` 的过滤都用它。
 *  拆成多份的历史形态是「过滤收了一个某个 schema 不认的值」。 */
const BEACON_STATUSES = ['stock', 'active', 'faulty', 'retired'] as const;

/** 全量设备台账（跨场地）。**只读**。门禁由 BFF 侧挂 'field'，本服务只认 X-Internal-Service-Token。
 *
 *  为什么需要它：`GET /venues/:id/beacons` 是**场地内**视角，回答不了现场最常问的两个问题
 *  ——「全公司还有几台在库的没装」「哪几台报故障了」。资产总表与故障一览必须跨场地。
 *
 *  ⚠️ `venueId` 是**三态**，判 `undefined` 而不是判假值：
 *    不传 = 不过滤；空串 = 只查 `venue_id IS NULL`；具体值 = 该场地。
 *    写成 `if (venueId)` 会把「未归属」静默吞成「不过滤」（本仓既有前科，BFF 同款注释在
 *    `wenlv-studio.ts:160`）。
 *  ⚠️ 「未归属」这一态**经 API 造得出来**：`POST /beacons`（未归属登记端点）。此处订正原文
 *    「经 API 造不出来」—— 那句只对当时的 `POST /venues/:id/beacons`（总是落路径里的
 *    venueId）成立，2026-09-24 加了未归属端点之后不再成立。
 *    **测试仍然有意自己插一行 venueId=null 的夹具**（见 `wenlv-beacon.test.ts` 的 B_ORPHAN）：
 *    拿被测端点给别条用例做夹具，会把「那一个端点坏了」放大成一片红，
 *    夹具与被测面要能各自独立地红。
 *  ⚠️ `status` 的空串按「不过滤」处理，与 `?venueId=` 的三态**有意不同形**：
 *    `status` 没有「未设置」这个业务态（四态都是真值），而 venueId 的 NULL 是一个真实态。 */
route.get('/beacons', async (c) => {
  const status = c.req.query('status');
  const venueId = c.req.query('venueId');

  const conds = [];
  if (status !== undefined && status !== '') {
    const parsed = z.enum(BEACON_STATUSES).safeParse(status);
    if (!parsed.success) {
      // 文案从常量派生，不手抄四态 —— 手抄会造出 BEACON_STATUSES 的第二份副本
      // （常量注释自称「唯一副本」）。逐字同值，无行为变化。
      return c.json({ success: false, error: `status 必须是 ${BEACON_STATUSES.join(' / ')} 之一` }, 400);
    }
    conds.push(eq(pmsBuiWenlvBeacons.status, parsed.data));
  }
  if (venueId !== undefined) {
    if (venueId === '') conds.push(isNull(pmsBuiWenlvBeacons.venueId));
    else conds.push(eq(pmsBuiWenlvBeacons.venueId, venueId));
  }

  const rows = await db.select().from(pmsBuiWenlvBeacons)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(pmsBuiWenlvBeacons.venueId, pmsBuiWenlvBeacons.name, pmsBuiWenlvBeacons.createdAt);

  // 场地名与点位名随行带出：台账列表要显示「这台在哪、绑在哪条点位上」，
  // 而 App 侧没有全量场地/点位索引可比对（`GET /venues` 的列表端点**不含** points）。
  const venueIds = [...new Set(rows.map((r) => r.venueId).filter((v): v is string => !!v))];
  const venues = venueIds.length
    ? await db.select({ id: pmsBuiWenlvVenues.id, name: pmsBuiWenlvVenues.name })
        .from(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, venueIds))
    : [];
  const venueNameOf = new Map(venues.map((v) => [v.id, v.name]));

  const pointIds = [...new Set(rows.map((r) => r.pointId).filter((v): v is string => !!v))];
  const points = pointIds.length
    ? await db.select({ id: pmsBuiWenlvVenuePoints.id, name: pmsBuiWenlvVenuePoints.name })
        .from(pmsBuiWenlvVenuePoints).where(inArray(pmsBuiWenlvVenuePoints.id, pointIds))
    : [];
  const pointNameOf = new Map(points.map((p) => [p.id, p.name]));

  const list = rows.map((r) => ({
    ...r,
    venueName: r.venueId ? venueNameOf.get(r.venueId) ?? null : null,
    pointName: r.pointId ? pointNameOf.get(r.pointId) ?? null : null,
  }));
  return c.json({ success: true, data: { list, total: list.length } });
});

/** 工作台「今日现场」的四组计数。**只读**、无 join、无分页。
 *
 *  🔴 点位四态**在 JS 里按 derivePlacement 数**，不在 SQL 里重写判据 ——
 *    唯一权威是 services/wenlv-placement.ts；SQL 副本漂移了不会红。
 *    点位总量小（一个场地 10–30 个），全取三列回来数即可。
 *
 *  ⚠️ 口径是**全局**的，不做「我的场地」过滤：App 没有「我负责的场地」这个概念
 *    （`venues.ownerStaffId` 有列，但没有按它过滤的端点）。这是已知限制，见 spec §5.4。
 *
 *  `unprinted` 取 `state === 'none'`。
 *  ⚠️ **这个口径不是 `printedAt IS NULL`**：`state === 'none'` ⇒ `printedAt IS NULL` 恒真，
 *    但**反向不成立** —— 「有 `placedAt`、无 `printedAt`」的行（**跳级推进**的产物：
 *    `canAdvance('none','placed')` 为真，而 `patchForAdvance('placed')` 只写 placedAt）
 *    同时落在 `printedAt IS NULL` 里、又被 derivePlacement 归成 `'placed'`。
 *  ⇒ **因为 derivePlacement 是唯一权威、且它的四态互斥，不是因为两者等价。**
 *  ⚠️ 别把「四态合计 === 总数」当成这条口径的守卫：本实现的分桶是 `if / else-if` 链，
 *    每行**按构造**恰落一桶 ⇒ 那条和不变量对**链内任何条件写法都恒真**。它守的是
 *    「后人把链拆成四个各自独立的 `if`」这种**结构退化**，不是口径正确性。 */
route.get('/ops/today', async (c) => {
  const [venueRows, pointRows, beaconRows] = await Promise.all([
    db.select({ status: pmsBuiWenlvVenues.status }).from(pmsBuiWenlvVenues),
    db.select({
      printedAt: pmsBuiWenlvVenuePoints.printedAt,
      placedAt: pmsBuiWenlvVenuePoints.placedAt,
      verifiedAt: pmsBuiWenlvVenuePoints.verifiedAt,
    }).from(pmsBuiWenlvVenuePoints),
    db.select({ status: pmsBuiWenlvBeacons.status }).from(pmsBuiWenlvBeacons),
  ]);

  const points = { total: pointRows.length, unprinted: 0, printed: 0, placed: 0, verified: 0 };
  for (const row of pointRows) {
    const state = derivePlacement(row);
    if (state === 'none') points.unprinted += 1;
    else if (state === 'printed') points.printed += 1;
    else if (state === 'placed') points.placed += 1;
    else points.verified += 1;
  }

  // `lead`（未采风）与 `surveying`（采风中）这两态算「还没进入铺码」，正是工作台要催的那批。
  // ⚠️ 措辞**不依赖 VENUE_STAGES 的顺序**：别写成「六态里的前两态」—— 那个常量一旦重排，
  //    位置序措辞就当场失真（`lead || surveying` 这两个字面量才是 spec §5.4 钉死的口径）。
  const venues = {
    total: venueRows.length,
    surveying: venueRows.filter((v) => v.status === 'lead' || v.status === 'surveying').length,
  };

  // 分桶**从 BEACON_STATUSES 派生，不手抄四态**：手抄会造出那个常量的**第二份副本**
  // （它自己的注释自称「唯一副本」）。前科：加第五态时 zod 放行、`total` 也照数，
  // 而这里**无桶** ⇒ 四个数加起来小于总数，且**不红**。
  // 用 `includes(BEACON_STATUSES)` 而不是 `in beacons`：后者会把键 `total` 也算成
  // 「已知 status」（值恰为 'total' 的脏行会去加总数），且会命中 Object.prototype。
  // 未知 status 一律不分类、也不凭空加键（仍只进 `total`，与改动前一致）。
  // 响应形状逐字不变：{total, stock, active, faulty, retired}（spec §6.2 要求）。
  const beacons: Record<string, number> = { total: beaconRows.length };
  for (const s of BEACON_STATUSES) beacons[s] = 0;
  for (const row of beaconRows) {
    if ((BEACON_STATUSES as readonly string[]).includes(row.status)) beacons[row.status] += 1;
  }

  return c.json({ success: true, data: { venues, points, beacons } });
});

/** MAC 归一化 + 非法即拒。**不要**用 `.transform` 把非法值折成 null 落库 ——
 *  那会把「现场写错了设备身份」变成一条静默的脏行，与 zod 空串脏引用是同一个坑。 */
const beaconMacField = z.string().min(1, 'MAC 不能为空').max(32)
  .refine((v) => normalizeMac(v) !== null, 'MAC 必须是 12 位十六进制（可含 : 或 - 分隔）')
  .transform((v) => normalizeMac(v)!);

/** 广播参数三件套。`uuid` 同理：非法拒绝，不折成 null。
 *
 *  ⚠️ `.optional()` 必须在**最外层**（`.nullable()` 之后），与下面的 major/minor 同形。
 *  写成 `.nullable().optional().refine(...).transform(...)`（optional 夹在中间）时，
 *  refine 与 transform 对 **undefined 也会执行**，`v == null ? null : …` 遂把「未传」
 *  折成 null —— 等价于给 uuid 加了个 `.default(null)`，也就是本列表反复要消灭的那类
 *  静默注入。登记（POST）靠 `uuid: d.uuid ?? null` 兜住了这个差异，所以当时没暴露；
 *  改动（PATCH）逐字段按 `!== undefined` 赋值，于是每次 PATCH 都会把三件套清成空，
 *  再被「全有或全无」判据拒成 400。 */
const beaconFrameFields = {
  uuid: z.string().max(36)
    .refine((v) => normalizeUuid(v) !== null, 'UUID 必须是 8-4-4-4-12 的十六进制')
    .transform((v) => normalizeUuid(v)!)
    .nullable().optional(),
  // 域判据复用 Task 3 的 isValidBeaconNumber：**登记闸（本处）与触发闸（Task 8 的
  // beaconMatchesPoint）必须是同一份规则**。各写一遍的话，日后若只放宽一侧（例如为
  // 那条未定案的帧线格式放宽触发侧），就会造出「登记得进去、却永远触发不了」的信标
  // —— 而那正是本层最要消灭的失败静默形态。`.int()` 保留：它给非整数的报错更准确。
  major: z.number().int().refine(isValidBeaconNumber, 'Major 范围是 0-65535').nullable().optional(),
  minor: z.number().int().refine(isValidBeaconNumber, 'Minor 范围是 0-65535').nullable().optional(),
};

/** 建设备用。`status` 不给默认值 —— 由路由显式落 'stock'（同 pointSchema 与
 *  pointUpdateSchema 分开的理由：.partial() 对带 default 的字段仍会注入默认值）。 */
const beaconSchema = z.object({
  name: z.string().min(1, '设备名不能为空').max(100),
  mac: beaconMacField,
  model: z.string().max(50).nullable().optional(),
  ...beaconFrameFields,
  status: z.enum(BEACON_STATUSES).optional(),
  txPower: z.number().int().min(-127).max(0).nullable().optional(),
  batteryNote: z.string().max(200).nullable().optional(),
  note: z.string().nullable().optional(),
});

/** 帧三件套的「全有或全无」判据。半帧在库里无法比对，且是「登记到一半」的典型形态 ——
 *  拒掉比存下来好（存下来会让触发端永远不命中，且看不出为什么）。 */
function frameFieldCount(uuid: unknown, major: unknown, minor: unknown): number {
  return [uuid, major, minor].filter((v) => v != null).length;
}

/** 登记一台设备。**只有这一份实现**，两个端点共用：
 *  · `POST /venues/:id/beacons` —— 已知装哪儿（现场就地登记）
 *  · `POST /beacons`            —— **未归属**（设备/台账先入库，装好再指定场地）
 *
 *  🔴 为什么必须共用：这两条路径在 App 上是**同一个按钮**，校验与库约束也完全是同一批
 *  （幂等重入、MAC 唯一 409、帧唯一 409、三件套全有或全无 400、采集人取自请求头）。
 *  各写一遍的形态是「一边补了守卫/改了文案、另一边没补」——第二个端点上线那天就分叉了。
 *
 *  ⚠️ `venueId` 传 `null` = 未归属。该列**可空且无外键**（`db/schema/wenlv.ts` 的
 *  `pmsBuiWenlvBeacons`）⇒ 是否存在的校验在**调用方**（已归属那条路径用 `getVenueOr404`），
 *  本函数不做（也不该做：未归属是合法态）。
 *
 *  返回值**一律**是 Response（成功、400、409 都在内），调用方直接 `return` 即可
 *  —— 与 `getVenueOr404` 同一种用法，不需要再包一层结果类型。 */
async function registerBeacon(c: any, venueId: string | null): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  const parsed = beaconSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;
  const filled = frameFieldCount(d.uuid, d.major, d.minor);
  if (filled !== 0 && filled !== 3) {
    return c.json({ success: false, error: '信标广播参数（UUID/Major/Minor）要么全填，要么全不填' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入，不覆盖
  try {
    const [row] = await db.insert(pmsBuiWenlvBeacons).values({
      id, venueId, name: d.name, mac: d.mac, model: d.model ?? null,
      uuid: d.uuid ?? null, major: d.major ?? null, minor: d.minor ?? null,
      status: d.status ?? 'stock',
      txPower: d.txPower ?? null, batteryNote: d.batteryNote ?? null, note: d.note ?? null,
      // 采集人取自请求头而非 body：beaconSchema 非 strict，接 body 字段等于让调用方自填归属。
      // （幂等重入分支在上方已 return，不会覆盖原登记人。）
      createdBy: platformUserIdFrom(c),
    }).returning();
    return c.json({ success: true, data: row });
  } catch (e: unknown) {
    // ⚠️ 读 SQLSTATE 必须穿透 drizzle 的包装层。drizzle-orm 0.45.2 的 queryWithCache 会
    //    `throw new DrizzleQueryError(qs, params, e)`，而它只有 message/query/params/cause，
    //    **没有 code / constraint** ⇒ 写成 `e?.code === '23505'` 恒为 false，是个完全失效的兜底。
    //    真正的 pg 错误在 `cause` 上。（同 `uq_wenlv_venue_points_code` 冲突处读 `cause` 的既有做法。）
    // 按 constraint 精确匹配：本表有两个唯一索引，不分约束会把撞 MAC 误报成撞广播参数。
    const pgErr = ((e as any)?.cause ?? e) as { code?: string; constraint?: string } | undefined;
    if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_beacons_mac') {
      return c.json({ success: false, error: '这台设备（MAC）已经登记过了' }, 409);
    }
    if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_beacons_frame') {
      return c.json({ success: false, error: '这组广播参数已被另一台设备占用' }, 409);
    }
    // 主键冲突（并发下 id 预检通过后又撞车）与其它非 23505 错误此处不接，
    // 照旧抛出让其暴露为 500 —— 与点位码冲突处同形，**有意为之，不是漏了一类**。
    throw e;
  }
}

route.post('/venues/:id/beacons', async (c) => {
  const venueId = c.req.param('id');
  // 场地必须存在：本表 venue_id **无外键**，缺这道校验会静默落一条指向不存在场地的行
  // 并回 200（本文件「登记：场地不存在返 404」那条用例的注释里有实测记录）。
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  return registerBeacon(c, venueId);
});

/** 未归属登记：设备先入库，装到现场再指定场地。
 *
 *  为什么需要它：现场的真实顺序常是「一批设备到货先录台账」，此刻**还不知道**装哪个场地；
 *  在此之前只有 `POST /venues/:id/beacons`（必须给场地）⇒ 要么随便编一个场地记上，
 *  要么干脆不入账（台账与现场就此分叉）。本端点把「未归属」这一态**造出来**
 *  —— 此前它经 API 造不出来（见 `GET /beacons` 上方那条注释的订正）。
 *
 *  ⚠️ 桌面上的 `venueId` 有意**不接受**：`beaconSchema` 非 strict，body 里的未知键会被
 *  静默剥离 ⇒ 「调用方以为指定了场地、实际落成 null」是一种静默分叉。
 *  由新增用例「未归属登记：body 里塞 venueId 被静默剥离」钉住。 */
route.post('/beacons', async (c) => registerBeacon(c, null));

/** 改设备用。**必须与 beaconSchema 分开**：zod 的 `.partial()` 对带 `.default()` 的字段
 *  仍会注入默认值（同 pointSchema/pointUpdateSchema 分开的既有理由）。
 *
 *  ⚠️ 不要用「本对象里没有 `.default()`」来论证它安全 —— 字段里的 `...beaconFrameFields`
 *  是**展开**进来的，展开进来的字段带不带默认值、带不带夹在中间 `.optional()`，在这处
 *  看不出来。2026-09-21 就栽在这上面：uuid 的 `.optional()` 夹在 refine/transform 内层，
 *  等价于 `.default(null)`，PATCH 遂把每次改设备都变成「清空帧」再被「全有或全无」拒成 400。
 *  判据只能实测：`beaconUpdateSchema.safeParse({})` 的输出**不应**出现任何键。 */
const beaconUpdateSchema = z.object({
  name: z.string().min(1, '设备名不能为空').max(100).optional(),
  mac: beaconMacField.optional(),
  model: z.string().max(50).nullable().optional(),
  ...beaconFrameFields,
  // 绑定/解绑：undefined = 不改；null = 解绑；string = 绑到该点位。
  pointId: z.string().max(50).nullable().optional(),
  status: z.enum(BEACON_STATUSES).optional(),
  txPower: z.number().int().min(-127).max(0).nullable().optional(),
  batteryNote: z.string().max(200).nullable().optional(),
  note: z.string().nullable().optional(),
});

route.patch('/beacons/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '设备不存在' }, 404);
  // ⚠️ 这里**有意**与同文件其它同形写法不同（`POST /venues/:id/beacons` 登记、
  //    `PATCH /points/:id/placement` 与 `POST /points/:id/placement/reset` 铺码两处、
  //    `POST /venues/:id/materials` 素材 —— 那几处都是 `await c.req.json().catch(() => ({}))`）。
  //    差别在于本端点的 schema `beaconUpdateSchema` **全字段可选**：解析失败被折成 `{}`
  //    后**恰好合法** ⇒ 畸形体（或请求体被代理/客户端截断）会静默返回 200
  //    `{success:true}`，前端显示「已保存」而库里什么都没改 —— 正是本层最忌讳的静默失效。
  //    （POST 那份免疫：`name`/`mac` 必填 ⇒ 折成 `{}` 也是 400，所以缺口只在 PATCH。）
  //    故此处**只在 body 非空白且解析失败时**才走这个 400 分支（实测 `{oops` ⇒ 400）。
  //    空体与纯空白体则折成 `{}` 放行 ⇒ 200（实测五种形态都回 200：无 body、空串、纯空格、
  //    单个换行、「制表符+回车+换行+两空格」）。
  //    ⚠️ 但**别把这几种形态叫「no-op」**：实测它们都会刷新 `updatedAt`（`patch` 的初值
  //    就是 `{ updatedAt: new Date() }`），准确说法是「**无业务字段变更**」。
  //    是否把全文件其余同形写法一并收口，**留待 Task 10 回归时决定** ——
  //    别把这一处当成漏改，也别只改这一处就以为全仓收口了。
  const rawBody = await c.req.text();
  let body: unknown = {};
  if (rawBody.trim() !== '') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ success: false, error: '请求体不是合法 JSON' }, 400);
    }
  }
  const parsed = beaconUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;

  // 绑定目标必须与设备**同场地**。否则可以把 A 场地的设备绑到 B 场地的点位上，
  // 而触发查询走的是 (point_id, 帧) —— 游客在 A 场地走，却给 B 场地的节点记账。
  if (d.pointId !== undefined && d.pointId !== null) {
    const [pt] = await db.select({ venueId: pmsBuiWenlvVenuePoints.venueId })
      .from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, d.pointId)).limit(1);
    if (!pt) return c.json({ success: false, error: '点位不存在' }, 400);
    if (pt.venueId !== exist.venueId) {
      return c.json({ success: false, error: '只能绑定到同一场地的点位' }, 400);
    }
  }

  const patch: Partial<typeof pmsBuiWenlvBeacons.$inferInsert> = { updatedAt: new Date() };
  if (d.name !== undefined) patch.name = d.name;
  if (d.mac !== undefined) patch.mac = d.mac;
  if (d.model !== undefined) patch.model = d.model;
  if (d.uuid !== undefined) patch.uuid = d.uuid;
  if (d.major !== undefined) patch.major = d.major;
  if (d.minor !== undefined) patch.minor = d.minor;
  if (d.pointId !== undefined) patch.pointId = d.pointId;
  if (d.status !== undefined) patch.status = d.status;
  if (d.txPower !== undefined) patch.txPower = d.txPower;
  if (d.batteryNote !== undefined) patch.batteryNote = d.batteryNote;
  if (d.note !== undefined) patch.note = d.note;

  // 改完仍须满足「三件套全有或全无」——只改一个字段就可能把齐全的帧改成半帧。
  const nextUuid = patch.uuid !== undefined ? patch.uuid : exist.uuid;
  const nextMajor = patch.major !== undefined ? patch.major : exist.major;
  const nextMinor = patch.minor !== undefined ? patch.minor : exist.minor;
  const filled = frameFieldCount(nextUuid, nextMajor, nextMinor);
  if (filled !== 0 && filled !== 3) {
    return c.json({ success: false, error: '信标广播参数（UUID/Major/Minor）要么全填，要么全不填' }, 400);
  }

  try {
    const [row] = await db.update(pmsBuiWenlvBeacons).set(patch)
      .where(eq(pmsBuiWenlvBeacons.id, id)).returning();
    return c.json({ success: true, data: row });
  } catch (e: unknown) {
    // 读 SQLSTATE 为什么要穿透 `cause`，见同文件 POST 登记端点 catch 块里那段 ⚠️
    // （drizzle 0.45.2 的 DrizzleQueryError 只有 message/query/params/cause，
    // 写成 `e?.code` 恒为 false）。本副本此前既没有那段说明、也没有任何断言守它 ——
    // 现在由本文件末尾两条「改：… ⇒ 409」用例守着，别只改注释不改判据。
    const pgErr = ((e as any)?.cause ?? e) as { code?: string; constraint?: string } | undefined;
    if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_beacons_mac') {
      return c.json({ success: false, error: '这台设备（MAC）已经登记过了' }, 409);
    }
    if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_beacons_frame') {
      return c.json({ success: false, error: '这组广播参数已被另一台设备占用' }, 409);
    }
    throw e;
  }
});

// 删设备。**有意不拦「已绑定」** —— 现场拆机的真实顺序未必先解绑，
// 拦下来只会逼人去多点两下。App 侧负责在删除前弹确认（要告知「删了这台，
// 对应点位就没有信标触发了」）。
route.delete('/beacons/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '设备不存在' }, 404);
  await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, id));
  return c.json({ success: true, data: { id } });
});

// ===== 铺码四态（未印 → 已印 → 已铺 → 已验）=====
// 四态与流转规则的**唯一实现**在 services/wenlv-placement.ts（纯函数、可单测穷尽）；
// 这里只做鉴权 + 落库 + 文案。

/** 四态中文标签。**唯一副本**：端点文案用它，前端另有一份（跨语言无法共享）。 */
const PLACEMENT_LABEL: Record<PlacementState, string> = {
  none: '未印', printed: '已印', placed: '已铺', verified: '已验',
};

/** patchForAdvance 的返回类型把 `*At` 也标成了 `string | Date | null`（服务层与具体列类型解耦），
 *  而 timestamp 列只接受 Date。这里收窄成点位表的 insert 形状 —— 纯类型收窄，运行时不变。 */
const placementPatch = (to: PlacementTarget, by: string | null, now: Date) =>
  patchForAdvance(to, by, now) as Partial<typeof pmsBuiWenlvVenuePoints.$inferInsert>;

/** 铺码四态推进。**只前进**（倒退 400，引导走 reset）。
 *  四态与流转规则的唯一实现在 services/wenlv-placement.ts，这里只做鉴权 + 落库 + 文案。 */
route.patch('/points/:id/placement', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '点位不存在' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const to: unknown = body?.to;
  if (to !== 'printed' && to !== 'placed' && to !== 'verified') {
    return c.json({ success: false, error: 'to 必须是 printed / placed / verified 之一' }, 400);
  }

  const from = derivePlacement(exist);
  if (!canAdvance(from, to)) {
    // 倒退**明确拒绝**，不静默忽略 —— 静默会让操作者以为点成功了。
    return c.json({
      success: false,
      error: `当前已是「${PLACEMENT_LABEL[from]}」，不能退回「${PLACEMENT_LABEL[to]}」。如需重来，请先用重置。`,
    }, 400);
  }

  // 同阶段：幂等成功，**不写库**（canAdvance 对同阶段返回 true）。
  // 若照样落 patchForAdvance，会把 printed_at 刷成「现在」—— 第一次印刷的时间被静默丢弃，
  // 「幂等」退化成「每点一次就改一次历史」。
  if (from === to) return c.json({ success: true, data: exist });

  const patch = placementPatch(to, platformUserIdFrom(c), new Date());
  const [row] = await db.update(pmsBuiWenlvVenuePoints)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvVenuePoints.id, id)).returning();
  return c.json({ success: true, data: row });
});

/** 重置：清空该阶段**及其之后**的全部时间戳（见 clearedByReset 的注释）。
 *  与 PATCH 分开是**有意**的：把「手滑点错」与「真的要重来」分成两个动作，
 *  否则前者会被当成正常倒退而放行，单向流转就形同虚设。 */
route.post('/points/:id/placement/reset', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '点位不存在' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const stage: unknown = body?.stage;
  if (stage !== 'printed' && stage !== 'placed' && stage !== 'verified') {
    return c.json({ success: false, error: 'stage 必须是 printed / placed / verified 之一' }, 400);
  }

  const [row] = await db.update(pmsBuiWenlvVenuePoints)
    .set({ ...clearedByReset(stage), updatedAt: new Date() })
    .where(eq(pmsBuiWenlvVenuePoints.id, id)).returning();
  return c.json({ success: true, data: row });
});

/** 批量标记已打印。印刷是**批量**动作，逐个点位点「已印」不现实。
 *  只处理**有 code** 的点位（没码的印不出来）。
 *  **已印的点位跳过，不覆盖** 原 printed_at/printed_by —— 覆盖会丢掉第一次印刷的
 *  记录，而可追溯性正是这六列存在的理由。 */
route.post('/venues/:id/points/mark-printed', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;

  const body = await c.req.json().catch(() => ({}));
  const all = body?.all === true;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: unknown) => typeof x === 'string') : null;
  if (!all && !ids) {
    return c.json({ success: false, error: '需要 all:true 或 ids:[...]' }, 400);
  }

  const points = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.venueId, venueId));
  const targets = points.filter((p) => {
    if (!p.code) return false;                       // 没码印不出来
    if (derivePlacement(p) !== 'none') return false; // 已印的不覆盖
    return all ? true : ids!.includes(p.id);
  });

  const by = platformUserIdFrom(c);
  const now = new Date();
  for (const p of targets) {
    await db.update(pmsBuiWenlvVenuePoints)
      .set({ ...placementPatch('printed', by, now), updatedAt: now })
      .where(eq(pmsBuiWenlvVenuePoints.id, p.id));
  }
  return c.json({ success: true, data: { marked: targets.length, skipped: points.filter((p) => !!p.code).length - targets.length } });
});

route.delete('/points/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '点位不存在' }, 404);
  // 0079 统一模型：剧情节点即 scenes，点位引用检查改查 scenes.venuePointId。
  const [used] = await db.select({ id: pmsBuiWenlvScenes.id }).from(pmsBuiWenlvScenes)
    .where(eq(pmsBuiWenlvScenes.venuePointId, id)).limit(1);
  if (used) return c.json({ success: false, error: '该点位已被剧本场景引用，不能删除' }, 409);
  // 事务保证：素材降级/信标解绑/删点位要么全成要么全回滚，避免部分失败留脏态
  // （例如素材已降级但信标没解绑，或信标已解绑但点位没删成）。
  await db.transaction(async (tx) => {
    // S2：点位被删时，绑在它上面的文化素材**降级为场地级**（venuePointId 置 NULL），而不是跟着删。
    // 素材是采风时人工采集的一手内容，删一个点位不该连带销毁它 —— 降级后它仍然是这个场地的素材，
    // 只是不再指向具体位置。顺序必须在删点位之前：先删点位会留下指向空气的 venuePointId。
    await tx.update(pmsBuiWenlvCultureMaterials)
      .set({ venuePointId: null, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvCultureMaterials.venuePointId, id));
    // 信标无外键约束（pointId 只是普通 varchar），删点位前不解绑会留下指向空气的绑定：
    // 点位表里再查不到这一行，设备却仍显示「绑在某点位」。设备本身保留、回到未绑定态，
    // 现场可重新绑到新点位 —— 与上面素材降级同一位置、同一风格、同一理由（先解绑再删点）。
    await tx.update(pmsBuiWenlvBeacons)
      .set({ pointId: null, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvBeacons.pointId, id));
    await tx.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id));
  });
  return c.json({ success: true, data: { id } });
});

// ===== 文化素材（S2：场地级口述/图文素材，可选绑点位）=====

// 六类白名单。与 db/schema/wenlv.ts 的 WENLV_MATERIAL_TYPES 必须一致。
const materialTypeSchema = z.enum(['history', 'legend', 'craft', 'festival', 'dialect', 'other']);

// 建素材用：type 必填无默认、sortOrder 有默认 → 与改素材分开（同 pointSchema 的理由：
// zod 的 .partial() 对带 .default() 的字段仍会注入默认值）
const materialSchema = z.object({
  type: materialTypeSchema,
  title: z.string().min(1, '标题不能为空').max(100),
  content: z.string().min(1, '内容不能为空'),
  source: z.string().max(100).optional().nullable(),
  // 空串归一为 null：Radix Select 未选中时送的就是 ''，语义就是「不绑点位」。
  // 不归一的话会落成一条对所有读路径都不可见的脏引用（既非 NULL 也非任何真实点位 id）。
  venuePointId: z.string().max(50).optional().nullable()
    .transform((v) => (typeof v === 'string' && v.trim() === '' ? null : v)),
  photos: z.array(z.string().max(500)).max(9).optional().nullable(),
  sortOrder: z.number().int().optional(),
  // 调研落地来源（`pms_bui_wenlv_venue_research.id`）；可空 = 人工创建。
  // 归一规则同 pointSchema.researchId —— 有意不接空串。
  researchId: z.string().max(50).optional().nullable(),
});

// 改素材用：所有字段都不带 .default()
// **有意不含 createdBy / researchId** —— 理由同 pointUpdateSchema（创建时的事实，事后不可改）。
const materialUpdateSchema = z.object({
  type: materialTypeSchema.optional(),
  title: z.string().min(1, '标题不能为空').max(100).optional(),
  content: z.string().min(1, '内容不能为空').optional(),
  source: z.string().max(100).optional().nullable(),
  venuePointId: z.string().max(50).optional().nullable()
    .transform((v) => (typeof v === 'string' && v.trim() === '' ? null : v)),
  photos: z.array(z.string().max(500)).max(9).optional().nullable(),
  sortOrder: z.number().int().optional(),
});

/** 校验点位属于本场地；跨场地引用直接 400，不留脏引用。venuePointId 为 null 时跳过。 */
async function assertPointInVenue(c: any, venueId: string, pointId: string | null | undefined): Promise<Response | null> {
  if (!pointId) return null;
  const [pt] = await db.select({ id: pmsBuiWenlvVenuePoints.id }).from(pmsBuiWenlvVenuePoints)
    .where(and(eq(pmsBuiWenlvVenuePoints.id, pointId), eq(pmsBuiWenlvVenuePoints.venueId, venueId))).limit(1);
  if (!pt) return c.json({ success: false, error: '点位不存在或不属于该场地' }, 400);
  return null;
}

route.get('/venues/:id/materials', async (c) => {
  const venueId = c.req.param('id');
  // 与同组其它场地端点一致：不存在的场地一律 404，而不是 200 + []
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const rows = await db.select().from(pmsBuiWenlvCultureMaterials)
    .where(eq(pmsBuiWenlvCultureMaterials.venueId, venueId))
    .orderBy(pmsBuiWenlvCultureMaterials.sortOrder, pmsBuiWenlvCultureMaterials.createdAt);
  return c.json({ success: true, data: rows });
});

route.post('/venues/:id/materials', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const body = await c.req.json().catch(() => ({}));
  const parsed = materialSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;
  const badPoint = await assertPointInVenue(c, venueId, d.venuePointId);
  if (badPoint) return badPoint;
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvCultureMaterials)
    .where(eq(pmsBuiWenlvCultureMaterials.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入
  const existing = await db.select({ sortOrder: pmsBuiWenlvCultureMaterials.sortOrder })
    .from(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, venueId));
  const nextOrder = d.sortOrder ?? (existing.length ? Math.max(...existing.map((r) => r.sortOrder || 0)) + 1 : 1);
  const [row] = await db.insert(pmsBuiWenlvCultureMaterials).values({
    id, venueId, type: d.type, title: d.title, content: d.content,
    source: d.source ?? null, venuePointId: d.venuePointId ?? null,
    photos: d.photos ?? null, sortOrder: nextOrder,
    researchId: d.researchId ?? null,
    createdBy: platformUserIdFrom(c), // 同点位：取自请求头，幂等重入分支已在上方 return
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/materials/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvCultureMaterials)
    .where(eq(pmsBuiWenlvCultureMaterials.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '素材不存在' }, 404);
  const parsed = materialUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;
  // 改绑点位时同样校验归属（场地取素材自身的 venueId，不允许跨场地改绑）
  if (d.venuePointId !== undefined) {
    const badPoint = await assertPointInVenue(c, exist.venueId, d.venuePointId);
    if (badPoint) return badPoint;
  }
  const patchRow: Partial<typeof pmsBuiWenlvCultureMaterials.$inferInsert> = { updatedAt: new Date() };
  if (d.type !== undefined) patchRow.type = d.type;
  if (d.title !== undefined) patchRow.title = d.title;
  if (d.content !== undefined) patchRow.content = d.content;
  if (d.source !== undefined) patchRow.source = d.source;
  if (d.venuePointId !== undefined) patchRow.venuePointId = d.venuePointId;
  if (d.photos !== undefined) patchRow.photos = d.photos;
  if (d.sortOrder !== undefined) patchRow.sortOrder = d.sortOrder;
  const [row] = await db.update(pmsBuiWenlvCultureMaterials).set(patchRow)
    .where(eq(pmsBuiWenlvCultureMaterials.id, id)).returning();
  return c.json({ success: true, data: row });
});

route.delete('/materials/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvCultureMaterials)
    .where(eq(pmsBuiWenlvCultureMaterials.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '素材不存在' }, 404);
  await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.id, id));
  return c.json({ success: true, data: { id } });
});

// 物料导出：给前端打印页用的纯数据清单（二维码图像在浏览器侧渲染）
route.get('/venues/:id/points/qrcodes', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const points = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.venueId, venueId))
    .orderBy(pmsBuiWenlvVenuePoints.sortOrder);
  const printable = points.filter((p) => !!p.code);
  return c.json({
    success: true,
    data: {
      venue: { id: venue.id, name: venue.name },
      // 铺码四态：前端按这三个时间戳渲染徽标（pms-wenlv-web/src/lib/placement.ts）。
      // 这里漏字段不报错、只是静默丢 ⇒ 每张物料卡片恒显「未印」（两端各自看都对）。
      // 未印的点位必须是**显式的 null**而不是缺键：`placementOf` 拿 undefined 今天也走
      // falsy 分支，但契约要明确，将来有人写 `x ?? 默认值` 就会出差别。
      points: printable.map((p) => ({
        id: p.id, name: p.name, code: p.code, sortOrder: p.sortOrder,
        printedAt: p.printedAt, placedAt: p.placedAt, verifiedAt: p.verifiedAt,
      })),
      missing: points.length - printable.length,
    },
  });
});

// GET /products?status=&venueId= → 列表 + 各子资源计数
route.get('/products', async (c) => {
  const status = c.req.query('status');
  // venueId 三态：不传=不过滤；空串=只查未归属；具体值=该场地。
  // Hono 的 query() 对 `?venueId=` 返回空串、键不存在返回 undefined（见 hono/dist/utils/url.js
  // 的 _getQueryParam：trailingKeyCode===61 时取 '=' 之后到 '&'/末尾的子串），三态可区分。
  const venueIdRaw = c.req.query('venueId');
  const conds = [];
  // 不传 status = 全部状态，但**不含已软删** —— 软删的语义就是「它不在了」。
  // 显式传 ?status=deleted 仍能查到，保留库层可核验性；前端筛选器不提供该选项。
  if (status) conds.push(eq(pmsBuiWenlvProducts.status, status));
  else conds.push(ne(pmsBuiWenlvProducts.status, 'deleted'));
  if (venueIdRaw !== undefined) {
    if (venueIdRaw === '') conds.push(isNull(pmsBuiWenlvProducts.venueId));
    else conds.push(eq(pmsBuiWenlvProducts.venueId, venueIdRaw));
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(pmsBuiWenlvProducts).where(where).orderBy(desc(pmsBuiWenlvProducts.updatedAt));
  if (rows.length === 0) return c.json({ success: true, data: { list: [], total: 0 } });
  const ids = rows.map((r) => r.id);
  const [cols, tiers, sceneCounts] = await Promise.all([
    db.select({ productId: pmsBuiWenlvCollectibles.productId, id: pmsBuiWenlvCollectibles.id }).from(pmsBuiWenlvCollectibles).where(inArray(pmsBuiWenlvCollectibles.productId, ids)),
    db.select({ productId: pmsBuiWenlvRewardTiers.productId, id: pmsBuiWenlvRewardTiers.id }).from(pmsBuiWenlvRewardTiers).where(inArray(pmsBuiWenlvRewardTiers.productId, ids)),
    // 0079 统一模型：场景/结局计数经 room→chapters→scenes 关联回 contentId（结局=type='ending' 的 scene）。
    countScenesByContent(ids),
  ]);
  const count = (arr: { productId: string }[]) => {
    const m = new Map<string, number>();
    for (const r of arr) m.set(r.productId, (m.get(r.productId) || 0) + 1);
    return m;
  };
  const cMap = count(cols), tMap = count(tiers);
  const list = rows.map((r) => ({
    ...r,
    nodeCount: sceneCounts.get(r.id)?.nodes ?? 0,
    collectibleCount: cMap.get(r.id) || 0,
    endingCount: sceneCounts.get(r.id)?.endings ?? 0,
    tierCount: tMap.get(r.id) || 0,
  }));
  return c.json({ success: true, data: { list, total: list.length } });
});

// GET /products/:id/full → 产品 + nodes(order 排序) + collectibles + endings + rewards + tiers + characters（unsanitized，编辑器载入）
route.get('/products/:id/full', async (c) => {
  const productId = c.req.param('id');
  // 内联查询、不经 getProductOr404 ⇒ 已软删的必须在这里单独挡一次
  const [product] = await db.select().from(pmsBuiWenlvProducts)
    .where(and(eq(pmsBuiWenlvProducts.id, productId), ne(pmsBuiWenlvProducts.status, 'deleted'))).limit(1);
  if (!product) return c.json({ success: false, error: '内容产品不存在' }, 404);
  // 0079 统一模型：nodes/endings 只从规范图投影装配（nodeId 即 scene.id；结局=type='ending' 的 scene），
  // 不再直查旧表。collectibles/rewards/tiers/characters/npcs/triggers 是不挂章节的独立实体，仍按 productId 直查。
  const runtime = loadRuntimeGraph(productId);
  const [graph, collectibles, rewards, tiers, characters, npcs, triggers] = await Promise.all([
    runtime,
    db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, productId)).orderBy(pmsBuiWenlvCollectibles.createdAt),
    db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, productId)),
    db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, productId)).orderBy(pmsBuiWenlvRewardTiers.order),
    db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId))
      .orderBy(pmsBuiWenlvCharacters.order, pmsBuiWenlvCharacters.createdAt),
    db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, productId))
      .orderBy(pmsBuiWenlvNpcs.orderId, pmsBuiWenlvNpcs.createdAt),
    db.select().from(pmsBuiWenlvTriggers).where(eq(pmsBuiWenlvTriggers.productId, productId)).orderBy(desc(pmsBuiWenlvTriggers.createdAt)),
  ]);
  const nodes = graph.nodes;
  const endings = graph.endings;
  // 设计 token：供创作台 WYSIWYG 手机框即时应用（与 C 端同一解析结果）
  const designTokens = await loadDesignTokensForProduct(product);
  // 点位名投影：与 mini `GET /:id`（routes/mini/wenlv.ts）**逐字同款**——
  // 按 **nodes 自己带的 venuePointId** 集合查，不是按 product.venueId 查
  // （节点可绑别场地的点位；按产品场地查会漏、预览会退回文本地名，正是本次要修的 bug）。
  // 只投影 name：code 是到场凭证，创作台同样不需要、不下发。
  const pointIds = [...new Set(nodes.map((n) => n.venuePointId).filter((v): v is string => !!v))];
  const pointRows = pointIds.length
    ? await db.select({ id: pmsBuiWenlvVenuePoints.id, name: pmsBuiWenlvVenuePoints.name })
        .from(pmsBuiWenlvVenuePoints).where(inArray(pmsBuiWenlvVenuePoints.id, pointIds))
    : [];
  const pointNameMap = new Map(pointRows.map((p) => [p.id, p.name]));
  // 交付信息随详情一起下发（与 GET /venues/:id 的 scripts 同口径），
  // 阶段走 deliveryStageFor：status 与时间戳打架时以 status 为准，理由见该函数注释。
  return c.json({
    success: true,
    data: {
      ...product, designTokens,
      deliveryStage: deliveryStageFor(product), deliveryDays: scriptDeliveryDays(product),
      // requiresCredential：派生自 nodeRequiresCredential()——与 /trigger 的凭证门、
      // /answer 的到场门、mini DTO **同一份谓词**（wenlv-engine.ts 注释自称唯一真相）。
      // admin 侧此前没有这个派生字段，而它是**派生值不是列**，所以只能在读端点这里算。
      // 创作台的实时预览用它决定节点标签；让前端按 triggerType 自己推断会错
      // （挂点位的节点 triggerType 可能仍是 schema 默认的 'manual'）。
      //
      // location 与 displayLocation **语义不同，不要合并**（这是本端点曾经踩过的坑）：
      //   · `location` —— **原始文本列**（`@deprecated`），随上方 `...n` 原样流出。
      //     它可**回写**：`refine-panel.tsx` 的 `applyLevel` 是「删光重建」，
      //     `mapNode` 的 `location: n.location ?? old?.location ?? null` 里的 `old`
      //     就取自本端点。把它换成展示投影 ⇒ AI 漏产 location 时会把**点位名**灌进
      //     文本列；节点日后解绑点位、展示回退到文本列时就印错地名（2026-09-19 的回归）。
      //   · `displayLocation` —— 派生自引擎 `nodeDisplayLocation()`，与 mini 公开 DTO
      //     **同一份谓词**：绑了点位 → 点位名；没绑 → 回退原始文本列。
      //     仅供**只读展示**（`preview-config.ts` → 创作台手机框预览）。
      //   消费点（grep 复核）：preview-config.ts 读 displayLocation；refine-panel.tsx 读写 location。
      //   本文件的写端点（PATCH /nodes/:id 等）走的是裸行，未受本投影影响 —— 投影只在本 return 处生效。
      nodes: nodes.map((n) => ({
        ...n,
        requiresCredential: nodeRequiresCredential(n),
        displayLocation: nodeDisplayLocation(n, pointNameMap),
      })),
      collectibles, endings, rewards, tiers, characters, npcs, triggers,
    },
  });
});

// POST /products → 建产品头（body 可带固定 id 便于合成样例幂等；缺省 randomUUID）
route.post('/products', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const parsed = productHeadSchema.omit({}).safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  // 新建路径同样受约束：schema 里 playMode 是 optional，落库值由 DB 列默认兜底（'solo'），
  // 但 body 可以显式传 group/both ⇒ 这里判的是**将要落库的值**。
  const freeRejectNew = freeModeReject(parsed.data.isFree, parsed.data.playMode ?? 'solo');
  if (freeRejectNew) return c.json({ success: false, error: freeRejectNew }, 400);
  // id 冲突（幂等重入）：已存在同名 id 直接返回现有行
  const [exist] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  // venueId 存在性校验：不存在直接 400，不留脏引用。
  //
  // 刻意排在上面那条 id 幂等早返回**之后**：若提到前面，一个合法的幂等 AI 重 POST
  // 会在「首次创建之后、这次重试之前，它引用的场地被删掉了」时报 400 —— 本次调用根本不会
  // 写入任何东西（行已存在），却因为一个过时的引用把一次本来安全的重试打成硬失败。
  // 对「重试天然安全」的端点来说，那是比「返回既有的旧行」更糟的失败模式。
  //
  // 「空串/纯空白」这一态已不存在：productHeadSchema.venueId 现在是必填 + 拒绝空值，
  // 且那个 transform 只剩 `.trim()`、**不再把空值归一成 null** —— 所以这里既不需要归一，
  // 也不会把空串落进列（空串在 schema 层就被 400 掉了，压根走不到这里）。
  if (parsed.data.venueId) {
    const [v] = await db.select({ id: pmsBuiWenlvVenues.id }).from(pmsBuiWenlvVenues)
      .where(eq(pmsBuiWenlvVenues.id, parsed.data.venueId)).limit(1);
    if (!v) return c.json({ success: false, error: '场地不存在' }, 400);
  }
  const [row] = await db.insert(pmsBuiWenlvProducts).values({
    id,
    venueId: parsed.data.venueId ?? null,
    // 统一走 parsed.data：body 是原始值，走 body 会绕过 schema 的 transform
    //（theme 的色值剥离，以及将来可能加的清洗）。
    name: parsed.data.name, subtitle: parsed.data.subtitle ?? null, coverImage: parsed.data.coverImage ?? null,
    theme: parsed.data.theme ?? {}, config: parsed.data.config ?? {}, status: 'draft',
    mode: parsed.data.mode ?? 'narrative',
    // 新建默认 solo：存量/新建的剧本绝大多数是「随到随玩」的单人模型，
    // 放开成多人（group / both）是运营的明确动作，不该由默认值替他做。
    // ⚠️ 默认值**不能**改成 'both'：both 是「声明本产品支持团队局」，替未声明的产品
    //    做这个声明 = 凭空放开（会被追认成可排场次、可组队）。要放开由运营显式传值。
    playMode: parsed.data.playMode ?? 'solo',
    isFree: parsed.data.isFree ?? false,
    opsStartAt: parsed.data.opsStartAt ?? null, opsEndAt: parsed.data.opsEndAt ?? null,
    aiInput: parsed.data.aiInput ?? null,
  }).returning();
  return c.json({ success: true, data: row });
});

// PATCH /products/:id → 就地保存产品头（不改 status/publishedVersion）
route.patch('/products/:id', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const parsed = productHeadPatchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  // 免费剧本的 solo 约束：拿「合并后的终态」判，不是拿 body 判。见 freeModeReject 的注释。
  const freeReject = freeModeReject(
    parsed.data.isFree ?? product.isFree,
    parsed.data.playMode ?? product.playMode,
  );
  if (freeReject) return c.json({ success: false, error: freeReject }, 400);
  // venueId 存在性校验（不传该键 = 不改，跳过；null/空串已在 productHeadPatchSchema 层 400）
  if (parsed.data.venueId) {
    const [v] = await db.select({ id: pmsBuiWenlvVenues.id }).from(pmsBuiWenlvVenues)
      .where(eq(pmsBuiWenlvVenues.id, parsed.data.venueId)).limit(1);
    if (!v) return c.json({ success: false, error: '场地不存在' }, 400);
  }
  const [row] = await db.update(pmsBuiWenlvProducts).set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, productId)).returning();
  return c.json({ success: true, data: row });
});

// AI 一键生成剧本封面图：走素材流水线（planBatch + enqueueBatch）异步入队，与 NPC 立绘 / 角色头像同款。
// 不再同步直连 Seedream（30-120s 阻塞 + 无追踪 = 超时即丢）。
// cover 资产类型已在 ASSET_TYPES 注册（scope=product，writeback=products.coverImage），
// 调度器出图后 applyWriteback 自动回写 products.cover_image；本端点返回 { batchId } 供前端任务中心追踪。
//
// 前置：剧本必须有风格基线（spec §8），否则风格漂移 —— 用 loadNpcPortraitContext 复用 product 级
// （bible/venueId/styleTag）上下文装载，与 enqueueCharacterAvatar 同一条路径。
route.post('/products/:id/cover', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  if (!product.name) return c.json({ success: false, error: '产品名称为空，无法生成封面' }, 400);

  const ctx = await loadNpcPortraitContext(productId);
  if (!ctx.ok) {
    if (ctx.reason === 'no_product') return c.json({ success: false, error: '内容产品不存在' }, 404);
    return c.json({
      success: false,
      error: '该剧本还没有风格基线，请先自举（素材 → 自举风格基线）再生成封面',
    }, 409);
  }

  const batchId = randomUUID();
  const jobs = planBatch({
    batchId, venueId: ctx.venueId, productId, bible: ctx.bible,
    types: ['cover'],
    nodes: [], collectibles: [], endings: [], rewards: [], tiers: [], npcs: [], characters: [],
    candidateCount: 3,
    communityStyleTag: ctx.styleTag,
    skipAnchorInsert: true,
  });
  await enqueueBatch(jobs);
  return c.json({ success: true, data: { batchId, jobId: jobs[0]?.id ?? null, count: jobs.length } });
});

// ===== P3a 剧本房 CRUD =====
// 路由组位置：紧随 products 基础 CRUD 之后、publish 相关路由之前。
// service 由 Task 3 落地（services/wenlv/script-room.ts）；本文件只挂路由 + zod 校验。

// GET /script-rooms → 剧本房列表（不含已软删，按 updatedAt 倒序）
route.get('/script-rooms', async (c) => {
  const rooms = await listScriptRooms();
  return c.json({ success: true, data: { rooms } });
});

// GET /script-rooms/:id → 剧本房详情 + 章节 + 各章节下的场景 + 全量 flows（编辑器首屏一次取全图）
route.get('/script-rooms/:id', async (c) => {
  const id = c.req.param('id');
  const room = await getScriptRoom(id);
  if (!room) return c.json({ success: false, error: '剧本房不存在' }, 404);
  const chapters = await getScriptRoomChapters(id);
  const scenesByChapter: Record<string, unknown[]> = {};
  for (const ch of chapters) {
    scenesByChapter[ch.id] = await getChapterScenes(ch.id);
  }
  const flows = await getScriptRoomFlows(id);
  return c.json({ success: true, data: { room, chapters, scenesByChapter, flows } });
});

// POST /script-rooms → 建剧本房（id 用 randomUUID，不接收 status/时间戳等 DB 默认字段）
route.post('/script-rooms', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = scriptRoomCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const id = randomUUID();
  try {
    const [row] = await db.insert(pmsBuiWenlvScriptRooms).values({
      id,
      name: parsed.data.name,
      contentId: parsed.data.contentId,
      venueId: parsed.data.venueId ?? null,
      coverImage: parsed.data.coverImage ?? null,
      intro: parsed.data.intro ?? null,
      mode: parsed.data.mode ?? 'standard',
      difficulty: parsed.data.difficulty ?? 'normal',
      purePlay: parsed.data.purePlay ?? false,
      config: parsed.data.config ?? {},
    }).returning();
    return c.json({ success: true, data: { id: row.id } });
  } catch (e) {
    // db 失败（如 contentId 唯一约束）走通用文案，不泄 e.message
    return serverError(c, e, '创建剧本房失败', 400);
  }
});

// ===== P3b: Chapter / Scene / Flow CRUD 路由 =====

// 结构化触发条件（WenlvCondition 判别联合，递归）：引擎 evalCondition 的唯一合法形状。
// 用 z.lazy 承载 all/any/nofM 的自引用；非法 type、ref 缺 id、nofM 非整数等一律 400（TR-9.1）。
const condRefSchema = z.object({
  kind: z.enum(['visited', 'collected', 'completed', 'skill']),
  id: z.string().min(1, '条件引用 id 不能为空').max(100),
});
const conditionSchema: z.ZodType<WenlvCondition> = z.lazy(() => z.union([
  z.object({ type: z.literal('ref'), ref: condRefSchema }),
  z.object({ type: z.literal('role'), characterId: z.string().min(1).max(50) }),
  z.object({ type: z.literal('all'), conditions: z.array(conditionSchema) }),
  z.object({ type: z.literal('any'), conditions: z.array(conditionSchema) }),
  z.object({ type: z.literal('nofM'), n: z.number().int().nonnegative(), of: z.array(conditionSchema) }),
]));

const chapterCreateSchema = z.object({
  title: z.string().min(1, '章节标题不能为空').max(200),
  timeLabel: z.string().max(20).optional().nullable(),
  goal: z.string().optional().nullable(),
  order: z.number().int().optional(),
});
const chapterPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  timeLabel: z.string().max(20).optional().nullable(),
  goal: z.string().optional().nullable(),
  order: z.number().int().optional(),
  status: z.string().max(20).optional(),
});

route.post('/script-rooms/:id/chapters', async (c) => {
  const scriptRoomId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = chapterCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const chapter = await createChapter(scriptRoomId, parsed.data);
  return c.json({ success: true, data: { chapter } });
});

route.patch('/chapters/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = chapterPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const chapter = await updateChapter(id, parsed.data);
  if (!chapter) return c.json({ success: false, error: '章节不存在' }, 404);
  return c.json({ success: true, data: { chapter } });
});

route.delete('/chapters/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await deleteChapter(id);
  if (!ok) return c.json({ success: false, error: '章节不存在' }, 404);
  return c.json({ success: true, data: { id } });
});

const sceneCreateSchema = z.object({
  title: z.string().min(1, '场景标题不能为空').max(200),
  type: z.enum(['narrative', 'npc', 'puzzle', 'atom', 'ending']).optional(),
  content: z.string().optional().nullable(),
  npcId: z.string().max(50).optional().nullable(),
  atoms: z.any().optional(),
  puzzle: z.any().optional().nullable(),
  order: z.number().int().optional(),
  // 0079 全量对等玩法列
  venuePointId: z.string().max(50).optional().nullable(),
  requires: conditionSchema.optional().nullable(),
  geo: z.any().optional().nullable(),
  mapX: z.number().optional().nullable(),
  mapY: z.number().optional().nullable(),
  image: z.string().optional().nullable(),
  narrationUrl: z.string().optional().nullable(),
  grants: z.array(z.string()).optional().nullable(),
  npcLineIds: z.array(z.string()).optional().nullable(),
  openingLine: z.string().optional().nullable(),
  chapterGoal: z.any().optional().nullable(),
  perspectiveCharacterId: z.string().max(50).optional().nullable(),
  sanDelta: z.number().int().optional().nullable(),
  arAssetUrl: z.string().optional().nullable(),
  arAssetUrls: z.record(z.string(), z.string().nullable()).optional().nullable(),
  arDialogue: z.string().optional().nullable(),
  triggerCondition: conditionSchema.optional().nullable(),
  priority: z.number().int().optional().nullable(),
  rewardId: z.string().max(50).optional().nullable(),
});
const scenePatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  type: z.enum(['narrative', 'npc', 'puzzle', 'atom', 'ending']).optional(),
  content: z.string().optional().nullable(),
  npcId: z.string().max(50).optional().nullable(),
  atoms: z.any().optional(),
  puzzle: z.any().optional().nullable(),
  order: z.number().int().optional(),
  venuePointId: z.string().max(50).optional().nullable(),
  requires: conditionSchema.optional().nullable(),
  geo: z.any().optional().nullable(),
  mapX: z.number().optional().nullable(),
  mapY: z.number().optional().nullable(),
  image: z.string().optional().nullable(),
  narrationUrl: z.string().optional().nullable(),
  grants: z.array(z.string()).optional().nullable(),
  npcLineIds: z.array(z.string()).optional().nullable(),
  openingLine: z.string().optional().nullable(),
  chapterGoal: z.any().optional().nullable(),
  perspectiveCharacterId: z.string().max(50).optional().nullable(),
  sanDelta: z.number().int().optional().nullable(),
  arAssetUrl: z.string().optional().nullable(),
  arAssetUrls: z.record(z.string(), z.string().nullable()).optional().nullable(),
  arDialogue: z.string().optional().nullable(),
  triggerCondition: conditionSchema.optional().nullable(),
  priority: z.number().int().optional().nullable(),
  rewardId: z.string().max(50).optional().nullable(),
});

route.post('/chapters/:id/scenes', async (c) => {
  const chapterId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = sceneCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const scene = await createScene(chapterId, parsed.data);
  return c.json({ success: true, data: { scene } });
});

route.patch('/scenes/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = scenePatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const scene = await updateScene(id, parsed.data);
  if (!scene) return c.json({ success: false, error: '场景不存在' }, 404);
  return c.json({ success: true, data: { scene } });
});

route.delete('/scenes/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await deleteScene(id);
  if (!ok) return c.json({ success: false, error: '场景不存在' }, 404);
  return c.json({ success: true, data: { id } });
});

// ===== 场景精修 Scene Refine（0079：nodeId 即 scene.id，旧 /products/:id/nodes/:nodeId/refine 迁移）=====
// 入队：创建 type='node_refine' 的 npc_job，scheduler 调 refineNode 生成草稿；
// 采纳：事务内按勾选字段 patch scene（类型转换强制耦合字段），可选新建 NPC + 登记 props。
const refineTargetType = z.enum(['keep', 'scene', 'npc']).optional().default('keep');

// 通过 sceneId 反查 productId（scene→chapter→scriptRoom→product）。
async function getProductIdBySceneId(sceneId: string): Promise<string | null> {
  const rows = await db.select({ productId: pmsBuiWenlvProducts.id })
    .from(pmsBuiWenlvScenes)
    .innerJoin(pmsBuiWenlvChapters, eq(pmsBuiWenlvScenes.chapterId, pmsBuiWenlvChapters.id))
    .innerJoin(pmsBuiWenlvScriptRooms, eq(pmsBuiWenlvChapters.scriptRoomId, pmsBuiWenlvScriptRooms.id))
    .innerJoin(pmsBuiWenlvProducts, eq(pmsBuiWenlvScriptRooms.contentId, pmsBuiWenlvProducts.id))
    .where(eq(pmsBuiWenlvScenes.id, sceneId))
    .limit(1);
  return rows[0]?.productId ?? null;
}

route.post('/scenes/:id/refine', async (c) => {
  const sceneId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const targetType = refineTargetType.safeParse(body.targetType);
  if (!targetType.success) return c.json({ success: false, error: 'targetType 必须是 keep/scene/npc' }, 400);

  const productId = await getProductIdBySceneId(sceneId);
  if (!productId) return c.json({ success: false, error: '节点不存在' }, 404);

  const linkNpcId: string | null = typeof body.linkNpcId === 'string' ? body.linkNpcId : null;
  if (linkNpcId) {
    const [npc] = await db.select({ id: pmsBuiWenlvNpcs.id }).from(pmsBuiWenlvNpcs)
      .where(and(eq(pmsBuiWenlvNpcs.id, linkNpcId), eq(pmsBuiWenlvNpcs.productId, productId)))
      .limit(1);
    if (!npc) return c.json({ success: false, error: 'NPC 不存在或不属于本产品' }, 400);
  }

  const taskId = `job_${randomUUID()}`;
  await db.insert(pmsBuiWenlvNpcJobs).values({
    id: taskId, productId, nodeId: sceneId,
    targetType: 'node', targetId: sceneId,
    type: 'node_refine', status: 'pending',
    result: { targetType: targetType.data, linkNpcId },
  });
  return c.json({ success: true, data: { taskId } });
});

route.post('/scenes/:id/refine-apply', async (c) => {
  const sceneId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  if (!taskId) return c.json({ success: false, error: '缺少 taskId' }, 400);

  const [job] = await db.select().from(pmsBuiWenlvNpcJobs).where(eq(pmsBuiWenlvNpcJobs.id, taskId)).limit(1);
  if (!job || job.nodeId !== sceneId) return c.json({ success: false, error: '任务不存在' }, 404);
  if (job.status !== 'succeeded') return c.json({ success: false, error: '任务未完成' }, 409);

  const result = job.result as Record<string, unknown> | null;
  const draft = result?.refine as any;
  if (!draft) return c.json({ success: false, error: '任务无草稿' }, 409);
  if (result?.applied) return c.json({ success: false, error: '任务已采纳' }, 409);

  // NPC 草稿必须有 npcId 或 newNpc（否则采纳后 scene 挂空 NPC）。
  if (draft.targetType === 'npc' && !draft.npcId && !draft.newNpc) {
    return c.json({ success: false, error: '缺少绑定 NPC' }, 409);
  }

  // 采纳前二次校验场景存在（并发删除兜底）。
  const [scene] = await db.select({ id: pmsBuiWenlvScenes.id, type: pmsBuiWenlvScenes.type })
    .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, sceneId)).limit(1);
  if (!scene) return c.json({ success: false, error: '节点不存在' }, 404);

  const selectedFields: string[] = Array.isArray(body.fields) ? body.fields : [];

  await db.transaction(async (tx) => {
    let newNpcId: string | null = null;
    if (draft.targetType === 'npc' && draft.newNpc) {
      // orderId = MAX(order) + 1
      const maxRows = await tx.select({ m: sql<number>`max(${pmsBuiWenlvNpcs.orderId})` })
        .from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, job.productId));
      const maxOrder = Number(maxRows[0]?.m ?? 0);
      newNpcId = `npc_${randomUUID()}`;
      await tx.insert(pmsBuiWenlvNpcs).values({
        id: newNpcId, productId: job.productId,
        name: draft.newNpc.name, persona: draft.newNpc.persona,
        orderId: maxOrder + 1,
      });
    }

    // buildRefinePatch 仍以 nodeType 语义工作：scene.type 映射为 currentNodeType，
    // draft.targetType 即新 nodeType；storyText 字段在新模型对应 scene.content。
    const patch = buildRefinePatch(draft, selectedFields, newNpcId, scene.type);
    // storyText → content（新模型列名）。
    if ('storyText' in patch) {
      (patch as any).content = (patch as any).storyText;
      delete (patch as any).storyText;
    }
    if ('nodeType' in patch) {
      (patch as any).type = (patch as any).nodeType;
      delete (patch as any).nodeType;
    }
    const [updated] = await tx.update(pmsBuiWenlvScenes).set(patch as any)
      .where(eq(pmsBuiWenlvScenes.id, sceneId)).returning();
    if (!updated) throw new Error('场景更新失败');

    // props 幂等登记（按 name+nodeId+productId 查重）。
    if (Array.isArray(draft.props)) {
      for (const p of draft.props) {
        if (!p || typeof p.name !== 'string' || !p.name) continue;
        const kind = (p.kind === 'key' || p.kind === 'letter' || p.kind === 'card') ? p.kind : 'letter';
        const placeNote = typeof p.placeNote === 'string' ? p.placeNote : null;
        const [exist] = await tx.select({ id: pmsBuiWenlvProps.id }).from(pmsBuiWenlvProps)
          .where(and(
            eq(pmsBuiWenlvProps.productId, job.productId),
            eq(pmsBuiWenlvProps.nodeId, sceneId),
            eq(pmsBuiWenlvProps.name, p.name),
          )).limit(1);
        if (!exist) {
          await tx.insert(pmsBuiWenlvProps).values({
            id: `prop_${randomUUID()}`, productId: job.productId, nodeId: sceneId,
            name: p.name, kind, code: null, placeNote,
          });
        }
      }
    }

    await tx.update(pmsBuiWenlvNpcJobs).set({
      result: { ...(result ?? {}), applied: true } as any,
      updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvNpcJobs.id, taskId));
  });

  return c.json({ success: true });
});

// ===== 结局 Ending（0079：结局即 type='ending' 的 scene，不再写独立 endings 表）=====
// 列表/创建走房间语义；改/删复用 PATCH|DELETE /scenes/:id（同一行，级联删 flows 同规则）。
const endingCreateSchema = z.object({
  chapterId: z.string().min(1, 'chapterId 不能为空').max(50),
  title: z.string().min(1, '结局标题不能为空').max(200),
  content: z.string().optional().nullable(),        // 结局正文，投影映射为 ending.text
  image: z.string().optional().nullable(),
  triggerCondition: conditionSchema.optional().nullable(),
  priority: z.number().int().optional().nullable(),
  rewardId: z.string().max(50).optional().nullable(),
  order: z.number().int().optional().nullable(),
});

route.get('/script-rooms/:id/endings', async (c) => {
  const endings = await listRoomEndings(c.req.param('id'));
  return c.json({ success: true, data: { endings } });
});

route.post('/script-rooms/:id/endings', async (c) => {
  const roomId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = endingCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  // 章节必须挂在该房间下，防把结局跨房挂章。
  const belongs = await chapterBelongsToRoom(roomId, parsed.data.chapterId);
  if (!belongs) return c.json({ success: false, error: '章节不存在或不属于该剧本房' }, 400);
  const ending = await createEndingScene(parsed.data);
  return c.json({ success: true, data: { ending } });
});

const flowCreateSchema = z.object({
  fromSceneId: z.string().min(1, 'fromSceneId 不能为空').max(50),
  toSceneId: z.string().min(1, 'toSceneId 不能为空').max(50),
  type: z.enum(['auto', 'choice', 'puzzle_pass', 'puzzle_fail']).optional(),
  choiceText: z.string().optional().nullable(),
  // condition 为结构化 jsonb 条件对象（0079 由 text 转 jsonb），服务端 evalCondition 消费。
  condition: conditionSchema.optional().nullable(),
  grants: z.array(z.string()).optional().nullable(),
  sanDelta: z.number().int().optional().nullable(),
  sortOrder: z.number().int().optional(),
});
const flowPatchSchema = z.object({
  type: z.enum(['auto', 'choice', 'puzzle_pass', 'puzzle_fail']).optional(),
  choiceText: z.string().optional().nullable(),
  condition: conditionSchema.optional().nullable(),
  grants: z.array(z.string()).optional().nullable(),
  sanDelta: z.number().int().optional().nullable(),
  sortOrder: z.number().int().optional(),
});

route.post('/flows', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = flowCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const flow = await createFlow(parsed.data);
  return c.json({ success: true, data: { flow } });
});

route.patch('/flows/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = flowPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const flow = await updateFlow(id, parsed.data);
  if (!flow) return c.json({ success: false, error: '流转不存在' }, 404);
  return c.json({ success: true, data: { flow } });
});

route.delete('/flows/:id', async (c) => {
  const id = c.req.param('id');
  const ok = await deleteFlow(id);
  if (!ok) return c.json({ success: false, error: '流转不存在' }, 404);
  return c.json({ success: true, data: { id } });
});

const scriptRoomPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  coverImage: z.string().max(500).optional().nullable(),
  intro: z.string().optional().nullable(),
  venueId: z.string().max(50).optional().nullable(),
  mode: z.string().max(20).optional(),
  difficulty: z.string().max(20).optional(),
  purePlay: z.boolean().optional(),
  status: z.string().max(20).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

route.patch('/script-rooms/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const parsed = scriptRoomPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const room = await updateScriptRoom(id, parsed.data);
  if (!room) return c.json({ success: false, error: '剧本房不存在' }, 404);
  return c.json({ success: true, data: { room } });
});

// DELETE /script-rooms/:id → 事务级联删除剧本房（仅 draft/offline 可删，spec §3.1「不可恢复」语义）
// 级联路径：triggers(按 productId) → flows(按 sceneIds) → scenes(按 chapterIds) → chapters(按 scriptRoomId) → script_rooms。
// content 本体与 npcs/characters/rewards 保留（可复用素材），仅房间维度删除。
route.delete('/script-rooms/:id', async (c) => {
  const id = c.req.param('id');
  const [room] = await db.select().from(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.id, id)).limit(1);
  if (!room) return c.json({ success: false, error: '剧本房不存在' }, 404);
  // 在营或预检中的剧本房可能已有售票，要求先下架再删除（spec §3.1）。
  if (room.status !== 'draft' && room.status !== 'offline') {
    return c.json({ success: false, error: '在营或预检中的剧本房可能已有售票，请先下架再删除' }, 409);
  }
  await db.transaction(async (tx) => {
    // 触发器按 productId 删（该内容下所有触发器，不依赖场景外键）
    await tx.delete(pmsBuiWenlvTriggers).where(eq(pmsBuiWenlvTriggers.productId, room.contentId));
    // 查该房间的章节 → 场景，再按数组删 flows/scenes（与 wenlv-narrative-fixture.ts 同款两级查询范式）
    const chapters = await tx.select({ id: pmsBuiWenlvChapters.id }).from(pmsBuiWenlvChapters)
      .where(eq(pmsBuiWenlvChapters.scriptRoomId, room.id));
    const chapterIds = chapters.map((ch) => ch.id);
    if (chapterIds.length) {
      const scenes = await tx.select({ id: pmsBuiWenlvScenes.id }).from(pmsBuiWenlvScenes)
        .where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
      const sceneIds = scenes.map((s) => s.id);
      if (sceneIds.length) {
        await tx.delete(pmsBuiWenlvFlows).where(or(
          inArray(pmsBuiWenlvFlows.fromSceneId, sceneIds),
          inArray(pmsBuiWenlvFlows.toSceneId, sceneIds),
        ));
      }
      await tx.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
      await tx.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, room.id));
    }
    await tx.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.id, room.id));
  });
  return c.json({ success: true, data: null });
});

// GET /script-rooms/:id/flows → 取剧本房全部 flows（编辑器 Tab 2 用）
route.get('/script-rooms/:id/flows', async (c) => {
  const id = c.req.param('id');
  const room = await getScriptRoom(id);
  if (!room) return c.json({ success: false, error: '剧本房不存在' }, 404);
  const flows = await getScriptRoomFlows(id);
  return c.json({ success: true, data: { flows } });
});

// POST /products/:id/publish → 完整性校验通过后 status=published、publishedVersion++
// 产品内容全量加载（publish 与 publish-todos 共用，保证「清单清空 ⇔ 发布必过」零漂移）。
// 0079：剧情图（nodes/edges/endings）只从规范图投影 loadRuntimeGraph 装配（scenes/flows/chapters/room）；
// collectibles/rewards/tiers/npcs/characters/points 是不挂章节的独立实体表，仍按 productId/venueId 直查。
// roomGraph 附带原始四表行仅供发布快照原样存档，校验器只消费投影三族。
async function loadProductIntegrityInput(productId: string, product: { id: string; name: string; mode?: string; status?: string; venueId?: string | null }) {
  const [runtime, collectibles, rewards, tiers, npcs, characters] = await Promise.all([
    loadRuntimeGraph(productId),
    db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, productId)),
    db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, productId)),
    db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, productId)).orderBy(pmsBuiWenlvRewardTiers.order),
    db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, productId)),
    db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId)),
  ]);
  // 场地全部点位：用于校验节点引用的点位存在 / 有码 / 属于本场地。
  // 产品未归属场地时为空数组 —— 空数组是**有意义的**（truthy，等价于「这个场地一个点位都没有」），
  // 与 `undefined`（不校验）语义严格区分：传了空数组却引用点位，必被拦下。
  // 此时校验器**先判 `!product.venueId`**，所以报的是「产品未归属场地」，
  // 而不是误导性的「点位不存在」——点位其实好好地待在场地里，只是产品没挂到那个场地。
  const points = product.venueId
    ? await db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, product.venueId))
    : [];
  return {
    product,
    nodes: runtime.nodes,
    edges: runtime.edges,
    endings: runtime.endings,
    roomGraph: runtime.graph,
    collectibles, rewards, tiers, points, npcs, characters,
  };
}

// GET /products/:id/publish-todos → 发布待办清单（结构化阻塞项 + AI 修复路由）。
// 与发布闸同一套校验器、同一份入参 —— 清单清空即发布必过。
route.get('/products/:id/publish-todos', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const input = await loadProductIntegrityInput(productId, product);
  const todos = await buildPublishTodos(input as any);
  return c.json({ success: true, data: { todos, total: todos.length, aiFixable: todos.filter((t) => t.fixBy === 'ai').length } });
});

// GET /products/:id/publish-check → 发布闸预检（只读、不阻断）：与发布闸同参同校验，
// 追加「原子-场地能力匹配」（ATOM_NOT_DEPLOYABLE，仅预检提示、不进发布闸）。P2 驾驶舱④/编辑器横幅消费。
route.get('/products/:id/publish-check', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const input = await loadProductIntegrityInput(productId, product);
  const [profile] = product.venueId
    ? await db.select().from(pmsBuiWenlvVenueProfiles)
      .where(eq(pmsBuiWenlvVenueProfiles.venueId, product.venueId)).limit(1)
    : [];
  const todos = await buildPublishChecklist(input as any, profile?.deployableAtoms ?? null);
  return c.json({ success: true, data: { todos, total: todos.length } });
});

// GET /studio/project-board → 驾驶舱六步进度（P2 驾驶舱首页，逐产品聚合）。
// publish ④ 的 todoCount 在路由层注入：loadProductIntegrityInput + buildPublishChecklist 的清单长度，
// 服务层（services/wenlv/project-board.ts）不反向依赖本文件。
route.get('/studio/project-board', async (c) => {
  const rows = await buildProjectBoard({
    publishTodoCount: async (productId) => {
      const product = await getProductOr404(c, productId);
      if (product instanceof Response) return 0;
      const input = await loadProductIntegrityInput(productId, product);
      const [profile] = product.venueId
        ? await db.select().from(pmsBuiWenlvVenueProfiles)
          .where(eq(pmsBuiWenlvVenueProfiles.venueId, product.venueId)).limit(1)
        : [];
      return (await buildPublishChecklist(input as any, profile?.deployableAtoms ?? null)).length;
    },
  });
  return c.json({ success: true, data: { products: rows } });
});

// GET /studio/products/:id/fulfillment-pack → 履约包聚合（P2 内容编辑器履约包面板消费）。
route.get('/studio/products/:id/fulfillment-pack', async (c) => {
  const product = await getProductOr404(c, c.req.param('id'));
  if (product instanceof Response) return product;
  return c.json({ success: true, data: await buildFulfillmentPack(product.id) });
});

// GET /studio/funnel?productId=&days= → 漏斗聚合（P2 /funnel 看板：商户维度透视 + 剧本开局/完本/分享）。
route.get('/studio/funnel', async (c) => {
  const productId = c.req.query('productId');
  if (!productId) return c.json({ success: false, error: '缺少 productId' }, 400);
  const funnel = await buildFunnel(productId, Number(c.req.query('days')));
  return c.json({ success: true, data: funnel });
});

route.post('/products/:id/publish', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  if (product.status === 'published') return c.json({ success: false, error: '产品已发布' }, 409);

  // 与 publish-todos 端点共用同一份加载/校验（清单清空 ⇔ 发布必过）。
  const input = await loadProductIntegrityInput(productId, product);
  const { collectibles, rewards, tiers, npcs, characters, roomGraph } = input;
  // T13：传 npcs + characters 进 R-N1~R-N4。npcs 为空数组时 R-N1/R-N2 全 continue、R-N3/R-N4 遍历空集无操作，
  // 既有 publish 409 用例（wenlv.test.ts L49-51）由 narrative 的「至少 1 个剧情节点（scene/npc）」拦下
  // （空气包零节点 ⇒ 必红）；纯 NPC 节点剧本合法放行。
  const errs = validateWenlvIntegrity(input as any);
  // 图结构完整性（R1/R3-R10，R2 已随二元节点模型移除）：与内容完整性（wenlv-integrity.ts）并列发布闸，
  // 两类错误合并后统一以 409 返回。0079 起图从规范图投影装配（scenes/flows），narrative / rally 同闸。
  const graphErrs = await validateGraphIntegrity(productId);
  const allErrs = [...errs, ...graphErrs];
  if (allErrs.length > 0) {
    // 409 附带结构化待办清单（新增字段，旧客户端只看 errors 不受影响）——
    // 前端发布失败时直接弹清单，无需再调一次 publish-todos。
    const todos = await buildPublishTodos(input as any);
    return c.json({ success: false, error: '完整性校验未通过', errors: allErrs, todos }, 409);
  }

  const newVersion = (product.publishedVersion || 0) + 1;
  // 首次上架才盖章（??= 语义），重复上下架不刷新交付度量；room 与 product 共用同一时刻。
  const publishedAt = product.publishedAt ?? new Date();
  // P4：发布时拍快照（best-effort：快照失败不阻塞发布）。
  // 0079：剧情内容快照存规范四表原始行（room/chapters/scenes/flows；结局是 type='ending' 的 scene，
  // 已在 scenes 内，不再单列旧 nodes/endings），回滚时「删光当前 → 按快照逐表重建（保留原 id）」。
  try {
    const snapshotId = `SNAP_${productId}_${newVersion}`;
    await db.insert(pmsBuiWenlvProductSnapshots).values({
      id: snapshotId, productId, version: newVersion,
      snapshotData: {
        product: { ...product, status: 'published', publishedVersion: newVersion },
        scriptGraph: roomGraph
          ? { room: roomGraph.room, chapters: roomGraph.chapters, scenes: roomGraph.scenes, flows: roomGraph.flows }
          : null,
        collectibles, characters, npcs, rewards, tiers,
      },
    }).onConflictDoNothing();
  } catch (e) {
    // 快照表未迁移等异常：记日志但不影响发布主流程
    console.warn('[publish] snapshot failed (non-fatal):', e);
  }

  const [row] = await db.update(pmsBuiWenlvProducts).set({
    status: 'published', publishedVersion: newVersion,
    publishedAt,
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvProducts.id, productId)).returning();

  // 0079 状态机主从：剧本内容以 script_rooms 为主状态，product 仍承担 C 端门票门控，
  // 发布双侧推进（room.status/publishedAt 与 product 对齐）。room 同步失败不回滚已完成的发布，
  // 仅告警——不影响 C 端（C 端门控 product.status），编辑器侧可人工重试发布补齐 room 挂牌。
  if (roomGraph?.room) {
    try {
      await db.update(pmsBuiWenlvScriptRooms).set({
        status: 'published',
        publishedAt: roomGraph.room.publishedAt ?? publishedAt,
        updatedAt: new Date(),
      }).where(eq(pmsBuiWenlvScriptRooms.id, roomGraph.room.id));
    } catch (e) {
      console.warn('[publish] script_room status sync failed (non-fatal):', e);
    }
  }
  return c.json({ success: true, data: row });
});

// 剧本交付的两个人工落章点。都在为 null 时盖章（不覆盖），与场地状态机同口径。
//
// 顺序不变量是**双向**的：ready 侧拦「无起稿就定稿」（见下），start 侧也必须对称地拦
// 「已有定稿章却没有有效起稿章」。二者缺一，不变量就是半守的 —— 这条脏行走 start 会被
// 补出一个晚于定稿的起稿章，等于**伪造**了一个起稿时间，随后 ceilDays 把倒挂对兜成「1 天」，
// 异常又被那个好看的数字吃掉（本 Task 存在的意义就是不让它被吃掉）。
// 该行状态 API 自身走不出来（ready 要先 start，两侧都不清章），只有存量/带外写入才有。
// 与 ready 侧同口径 409 拒绝，**不做 clamp** —— clamp 照样是造一个假的起稿时间。
route.post('/products/:id/delivery/start', async (c) => {
  const product = await getProductOr404(c, c.req.param('id'));
  if (product instanceof Response) return product;
  const startedAt = product.generationStartedAt;
  const hasValidStart = !!startedAt && !Number.isNaN(startedAt.getTime());
  if (product.contentReadyAt && !hasValidStart) {
    return c.json({
      success: false,
      error: '交付时间戳矛盾：已有定稿时间却无起稿时间，请人工核对后再起稿',
    }, 409);
  }
  const [row] = await db.update(pmsBuiWenlvProducts)
    .set({ generationStartedAt: product.generationStartedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, product.id)).returning();
  return c.json({ success: true, data: row });
});

// 顺序不变量：contentReadyAt 不得早于 generationStartedAt。
// 本 Task 是这两个章的**唯一写入入口**，所以必须在这里收口 —— 下游只有纯度量函数，
// 它兜不住：`ceilDays` 会把倒挂对兜成「1 天」那个好看的数字，正好把异常抹平
// （Task 3 复评点名的问题；该模块注释也写着「异常该在数据层被看见」）。
//
// 选解法 (a) 拒绝式 409，不选 (b)「允许纯手工定稿 + scriptDeliveryDays 返回 null」：
//   1) 本文件所有状态推进（场地跳级、重复 publish）都以 409 收口，这里保持同一口径；
//   2) (b) 要改的是度量函数，而「没起稿就定稿」恰恰是本 Task 要暴露的数据异常 ——
//      用 null（或 1 天）去表达它，等于又用一个「无害的值」把异常吞掉，与要求背道而驰。
// 三种情形：
//   没有起稿章        → 409 提示先起稿（不留半个对）；
//   已有定稿章且有序  → 幂等 200 原样返回（不覆盖）；
//   已有定稿章但倒挂  → 409，绝不用 200 让一个倒挂对继续留在库里。
route.post('/products/:id/delivery/ready', async (c) => {
  const product = await getProductOr404(c, c.req.param('id'));
  if (product instanceof Response) return product;
  const startedAt = product.generationStartedAt;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    return c.json({ success: false, error: '尚未起稿，请先调用 /delivery/start' }, 409);
  }
  if (product.contentReadyAt) {
    if (product.contentReadyAt.getTime() >= startedAt.getTime()) {
      return c.json({ success: true, data: product });
    }
    return c.json({
      success: false,
      error: '交付时间戳倒挂：定稿早于起稿，请人工核对后再定稿',
    }, 409);
  }
  // 取 max(now, startedAt)：即便两请求间发生时钟回拨，也保证落库的定稿章不早于起稿章
  // —— 不变量由写入侧构造保证，而不是靠调用方「按顺序盖章」。
  const now = new Date();
  const readyAt = now.getTime() >= startedAt.getTime() ? now : startedAt;
  const [row] = await db.update(pmsBuiWenlvProducts)
    .set({ contentReadyAt: readyAt, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, product.id)).returning();
  return c.json({ success: true, data: row });
});

// POST /products/:id/unpublish → published → preview（撤回线上）
route.post('/products/:id/unpublish', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  if (product.status !== 'published') return c.json({ success: false, error: '产品未发布' }, 400);
  const [row] = await db.update(pmsBuiWenlvProducts).set({ status: 'preview', updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, productId)).returning();
  return c.json({ success: true, data: row });
});

// P4：GET /products/:id/snapshots → 列出所有发布快照（含版本号+时间）
route.get('/products/:id/snapshots', async (c) => {
  const productId = c.req.param('id');
  const snaps = await db.select({
    id: pmsBuiWenlvProductSnapshots.id,
    version: pmsBuiWenlvProductSnapshots.version,
    createdAt: pmsBuiWenlvProductSnapshots.createdAt,
  }).from(pmsBuiWenlvProductSnapshots)
    .where(eq(pmsBuiWenlvProductSnapshots.productId, productId))
    .orderBy(desc(pmsBuiWenlvProductSnapshots.version));
  return c.json({ success: true, data: snaps });
});

// P4：POST /products/:id/snapshots/:version/rollback → 回滚到指定版本
// 策略：事务内删光当前子资源（含规范四表 room 下的 chapters/scenes/flows）→ 按快照逐表重建
// （chapters/scenes/flows 保留原 id；room 不物理删，只回头部；结局随 type='ending' 的 scene 一并还原）
// → 产品头回退到快照版本 → product=preview / room=draft，需重新发布。
route.post('/products/:id/snapshots/:version/rollback', async (c) => {
  const productId = c.req.param('id');
  const version = parseInt(c.req.param('version'), 10);
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;

  const [snap] = await db.select().from(pmsBuiWenlvProductSnapshots)
    .where(and(
      eq(pmsBuiWenlvProductSnapshots.productId, productId),
      eq(pmsBuiWenlvProductSnapshots.version, version),
    ));
  if (!snap) return c.json({ success: false, error: '快照不存在' }, 404);

  const data = snap.snapshotData as any;
  // 0079：规范图快照 { room, chapters, scenes, flows }（结局在 scenes 内）；独立实体仍平铺。
  const sg = data.scriptGraph as { room: any; chapters: any[]; scenes: any[]; flows: any[] } | null;
  const strip = (r: any) => {
    const { createdAt, updatedAt, ...rest } = r;
    return rest;
  };
  await db.transaction(async (tx) => {
    // 1a. 玩家运行数据先清（内容回滚后旧进度/事件/核销无意义）。
    await tx.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, productId));
    await tx.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, productId));
    await tx.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, productId));
    // 1b. 不挂章节的独立实体。
    await tx.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, productId));
    await tx.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, productId));
    await tx.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, productId));
    await tx.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId));
    await tx.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, productId));

    // 1c. 规范图：删光当前 room 下 flows → scenes → chapters。
    // room 是 contentId 唯一锚点且被 ai_sessions 引用，**不物理删**，只在第 3 步回头部。
    const [curRoom] = await tx.select({ id: pmsBuiWenlvScriptRooms.id })
      .from(pmsBuiWenlvScriptRooms)
      .where(eq(pmsBuiWenlvScriptRooms.contentId, productId)).limit(1);
    if (curRoom) {
      const curChapters = await tx.select({ id: pmsBuiWenlvChapters.id })
        .from(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, curRoom.id));
      const chapterIds = curChapters.map((c) => c.id);
      if (chapterIds.length > 0) {
        const curScenes = await tx.select({ id: pmsBuiWenlvScenes.id })
          .from(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
        const sceneIds = curScenes.map((s) => s.id);
        if (sceneIds.length > 0) {
          await tx.delete(pmsBuiWenlvFlows)
            .where(or(inArray(pmsBuiWenlvFlows.fromSceneId, sceneIds), inArray(pmsBuiWenlvFlows.toSceneId, sceneIds)));
          await tx.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.id, sceneIds));
        }
      }
      await tx.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, curRoom.id));
    }

    // 2. 重建独立实体（strip 时间戳让 DB 默认值生效；保留原 id）。
    if (data.collectibles?.length) await tx.insert(pmsBuiWenlvCollectibles).values(data.collectibles.map(strip));
    if (data.characters?.length) await tx.insert(pmsBuiWenlvCharacters).values(data.characters.map(strip));
    if (data.npcs?.length) await tx.insert(pmsBuiWenlvNpcs).values(data.npcs.map(strip));
    if (data.rewards?.length) await tx.insert(pmsBuiWenlvRewards).values(data.rewards.map(strip));
    if (data.tiers?.length) await tx.insert(pmsBuiWenlvRewardTiers).values(data.tiers.map(strip));

    // 3. 还原规范四表：room 回头部（回编辑态、撤发布章），chapters/scenes/flows 按快照整表重建。
    if (sg) {
      if (curRoom) {
        const r = sg.room ?? {};
        await tx.update(pmsBuiWenlvScriptRooms).set({
          name: r.name, coverImage: r.coverImage ?? null, intro: r.intro ?? null,
          venueId: r.venueId ?? null, mode: r.mode ?? 'standard', difficulty: r.difficulty ?? 'normal',
          purePlay: r.purePlay ?? false, config: r.config ?? {},
          status: 'draft', publishedAt: null, updatedAt: new Date(),
        }).where(eq(pmsBuiWenlvScriptRooms.id, curRoom.id));
      } else if (sg.room) {
        // 异常兜底：room 已不在（contentId 唯一，正常不会发生）→ 按快照重建并置回编辑态。
        await tx.insert(pmsBuiWenlvScriptRooms).values({ ...strip(sg.room), status: 'draft', publishedAt: null });
      }
      if (sg.chapters?.length) await tx.insert(pmsBuiWenlvChapters).values(sg.chapters.map(strip));
      if (sg.scenes?.length) await tx.insert(pmsBuiWenlvScenes).values(sg.scenes.map(strip));
      if (sg.flows?.length) await tx.insert(pmsBuiWenlvFlows).values(sg.flows.map(strip));
    }

    // 4. 产品头回退（status 设为 preview：回滚后需重新发布）
    const p = data.product || {};
    await tx.update(pmsBuiWenlvProducts).set({
      name: p.name, mode: p.mode, theme: p.theme, config: p.config,
      status: 'preview', publishedVersion: version, updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvProducts.id, productId));
  });

  return c.json({ success: true, data: { productId, version } });
});

// POST /products/:id/archive → 软下线任意非 archived 状态 → archived
route.post('/products/:id/archive', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const [row] = await db.update(pmsBuiWenlvProducts).set({ status: 'archived', updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, productId)).returning();
  return c.json({ success: true, data: row });
});

// DELETE /products/:id → 软删除：只改 status='deleted'，子资源一行不删。
// （无外键 ⇒ 物理删要手工级联 4 张子表；软删把「恢复」变成一条 UPDATE。）
// 守卫：**已发布的不许删** —— 它正被 C 端游客使用（mini/wenlv.ts 每条产品查询都写死
// status='published'），软删会让它当场从游客端消失。要求先下线或归档。
route.delete('/products/:id', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  if (product.status === 'published') {
    return c.json({ success: false, error: '产品已发布，不能删除，请先下线或归档' }, 409);
  }
  const [row] = await db.update(pmsBuiWenlvProducts).set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProducts.id, productId)).returning();
  return c.json({ success: true, data: row });
});

/**
 * 删要素前先**解绑**它的素材坐标（设计文档 §4.5）。
 *
 * 为什么解绑而不是删素材：素材是**已付费的产物**，删要素不代表那张图没用了；
 * 而且它可能已被别处引用。解绑后它留在资源库、在全景页显示为「已无归属」一态，
 * 由人决定复用还是清理（决策 2）。
 *
 * 为什么必须做：不解绑的话，`target_id` 会**当场**指向一个不存在的行 ——
 * 全景页把这种行算作孤儿，于是每删一个要素就凭空多一条脏数据。
 *
 * ⚠️ **失败必须可见**：这里刻意不 catch。删要素本身已经成功（调用方的 db.delete 已提交），
 *    解绑失败意味着库里留下一条指向死 id 的素材 —— 那是需要人知道的中间态，
 *    不能吞掉伪装成「删除成功」。调用方因此用 500 + 明确措辞回，而不是 200。
 *
 * ⚠️ `kind` 取 `WritebackEntity` 而非 `string`：本函数被多个端点调用，各写一个字面量，
 *    窄类型让写错的那几处编译不过（详见文件顶部该 import 的注释）。
 * ⚠️ 只解绑 `(kind, id)` **同时**相等的行：`kind` 掉了会跨全库解绑同类素材，
 *    `id` 掉了会解绑所有指向同一要素的素材 —— 两个条件都有用例钉着。
 */
async function unbindAssetsOf(kind: WritebackEntity, id: string): Promise<void> {
  await db.update(pmsBuiWenlvDesignAssets)
    .set({ targetKind: null, targetId: null, updatedAt: new Date() })
    .where(and(
      eq(pmsBuiWenlvDesignAssets.targetKind, kind),
      eq(pmsBuiWenlvDesignAssets.targetId, id),
    ));
}

// ===== 子资源：collectibles =====

route.get('/products/:id/collectibles', async (c) => {
  const rows = await db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, c.req.param('id')));
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/collectibles', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ success: false, error: '线索名称不能为空' }, 400);
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  const [row] = await db.insert(pmsBuiWenlvCollectibles).values({
    id, productId,
    name: body.name, type: body.type || 'clue', rarity: body.rarity || 'common',
    image: body.image ?? null, description: body.description ?? null,
    stampMeta: body.stampMeta ?? {},
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/collectibles/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const allow = ['name', 'type', 'rarity', 'image', 'stampMeta', 'description'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  patch.updatedAt = new Date();
  const [row] = await db.update(pmsBuiWenlvCollectibles).set(patch).where(eq(pmsBuiWenlvCollectibles.id, id)).returning();
  if (!row) return c.json({ success: false, error: '线索不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/collectibles/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, id)).returning();
  if (!row) return c.json({ success: false, error: '线索不存在' }, 404);
  // 解绑在**确认删除成功之后**（理由与失败可见性见 `unbindAssetsOf` 的注释）
  try {
    await unbindAssetsOf('collectible', id);
  } catch (e) {
    console.error('[wenlv] 删线索后解绑素材失败', id, e);
    return c.json({ success: false, error: '线索已删除，但其素材解绑失败，请报运维处理' }, 500);
  }
  return c.json({ success: true, data: row });
});

// POST /collectibles/:id/generate-image — AI 生成线索图鉴图（异步 collectible_image 任务）
// productId 从线索行自身取（同 /npcs/:id/optimize 模式），无需 body 传参。
route.post('/collectibles/:id/generate-image', async (c) => {
  const id = c.req.param('id');
  const [col] = await db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, id)).limit(1);
  if (!col) return c.json({ success: false, error: '线索不存在' }, 404);
  const taskId = await generateCollectibleImage(col.productId, id);
  return c.json({ success: true, data: { taskId, status: 'pending' } });
});

// ===== 子资源：characters（剧本角色体系）=====

/** 数值列的**输入形态**闸：接受 number、或「trim 后非空且能解析成有限数的字符串」，其余视为非法输入。
 *  ⚠️ 「非法」必须按**输入形态**判，不能按 `Number(v)` 的结果判 ——
 *  `Number(null)` / `Number('')` / `Number([])` / `Number(false)` 全是 **0**，
 *  会让显式非法值伪装成合法整数 0（实测：PATCH 的 `{"order": null}` 曾把 order 从 7 静默改成 0）。 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 三维属性的形态闸：**整数、0–100**。
 *  为什么在这里夹、而不是只靠端面：这三个值直接驱动端面属性条的宽度，
 *  越界值在端面表现为**溢出卡面**。「端面兜住」属于代码层兜底，不该替代产品层的形态约束。
 *  非数（缺字段 / 非数字字符串 / null / 数组 / NaN）落 **50**（中立值）——**刻意不报 400**：
 *  这是纯展示字段，为一个不影响玩法的数字把整份 AI 出稿打成硬失败，代价大于收益。 */
function clampAttr(v: unknown): number {
  const n = toFiniteNumber(v);
  if (n === null) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** `order` 的形态闸：**整数、且在 int4 范围内**（该列是 integer。实测：`1.7` ⇒ PG `22P02`、
 *  `1e20` ⇒ `22003`；两者都会变成 500，把「客户端传错了」掩盖成服务端故障。⚠️ `Number.isInteger(1e20)` 为真 ⇒ 越界是被**范围**判断拦下的）。
 *  `dflt` = 值非法时落什么，**两个调用点故意不同**：
 *   · POST 传 `0` —— 创建面宽松，与 `clampAttr` 的非数落 50 同一取向：
 *     为一个排序号把整份出稿打成硬失败，代价大于收益；
 *   · PATCH 传 `null` —— 人肉编辑面**拒绝**：显式给了非法值就该报错，
 *     静默改写排序会把卡面顺序挪走而不告诉任何人。
 *  形态判据走 `toFiniteNumber`（**按输入形态**判，不按 `Number(v)` 的结果判）⇒
 *  `null` / `''` / `[]` / `false` 这类显式非法输入不再被 `Number()` 伪装成合法的 0。
 *  为什么用重载而不是 `as` 断言：`dflt` 非 null 时返回类型就是 `number`，
 *  `调用点` 那个 `?? 0` 是**死分支**（dflt=0 时构造上不返回 null）——用重载把它消掉，
 *  而不是靠断言把类型压平（断言会把「这里真的可能为 null」这类将来改动一并压掉）。 */
function normalizeOrder(v: unknown, dflt: number): number;
function normalizeOrder(v: unknown, dflt: null): number | null;
function normalizeOrder(v: unknown, dflt: number | null): number | null {
  const n = toFiniteNumber(v);
  if (n === null || !Number.isInteger(n) || n < -2147483648 || n > 2147483647) return dflt;
  return n;
}

/** 短文本列：trim 后为空落 `null`。**POST 与 PATCH 共用同一条口径** ——
 *  PATCH 若裸透 `body[k]`，同一份输入经两个端点会落成两种形态
 *  （POST 把 `'   '` 变成 null、`'  沈砚  '` 变成 `'沈砚'`，PATCH 原样存），
 *  于是「清空一个字段」在两条路径上结果不同（`''` vs NULL），端面按真值判断时会分叉。 */
function normalizeTxt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

/** 长文本列：只判空、**不 trim**（`identityDesc` / `ipPrompt` 可能含换行与缩进，
 *  trim 会把作者的排版吃掉）；纯空白落 `null`。同样是 POST / PATCH 共用口径。 */
function normalizeLongTxt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.trim() ? v : null;
}

/** skills 的形态闸：只保留 `{id,label,description}` 三键、**丢掉 id 非字符串或为空的项**。
 *  ⚠️ **不是「全部转字符串」**：`label` / `description` 的非字符串值落**空串**（不转换），
 *  `id` 非字符串或 trim 后为空的项**整个丢弃**（也不转换）。
 *  为什么丢空 id 而不报错：`skill.id` 是选项门控的引用键，空 id 会让两条技能在
 *  「按 id 找技能」的路径上互相遮蔽（后者静默胜出）。宁可少一条技能。 */
function normalizeSkills(v: unknown): WenlvCharacterSkill[] {
  if (!Array.isArray(v)) return [];
  const out: WenlvCharacterSkill[] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object') continue;
    const s = it as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) continue;
    out.push({
      id,
      label: typeof s.label === 'string' ? s.label : '',
      description: typeof s.description === 'string' ? s.description : '',
    });
  }
  return out;
}

/** hidden_quest 的形态闸：`collectible_ids` 只留非空字符串并去重。
 *  ⚠️ **这里不校验引用可达性** —— 那是发布闸 R3 的职责。这里只保证**形状**，
 *  因为草稿期允许「角色引用一个还没建好的线索」（先建角色后建线索是正常顺序，
 *  在这里拦会挡住合法的编辑过程）。
 *  ⚠️ 本函数只负责**洗形**，不负责**形状合法性** —— 关于 hiddenQuest 的两条闸**分工**如下，
 *  它们是**并存**的两条，不要合并：
 *   · **形状非法**（键存在、非 `null`、且不是「非数组对象」）⇒ **路由层**的闸回 400，
 *     本函数根本看不到这种输入（见 POST / PATCH 里那段形状闸）；
 *   · **内容为空**（洗形后三个字段都没有实质内容）⇒ **本函数**落 `null`，即「空壳 = 没有隐秘任务」。
 *     本列**可选**，`null` 的语义就是「没有」，端面据此不渲染卡 —— 落一张
 *     `{title:'',description:'',collectible_ids:[]}` 的**真值空对象**会让端面渲染一张空卡，
 *     与「没有隐秘任务」区分不开（这正是本判定要治的形态，换任何空壳入口都算）。
 *     ⚠️ 判空**只在这一处** trim：`title` / `description` 各自 `trim()` 后为空算空、
 *     `collectible_ids` 洗形后长度为 0 算空；三者**皆**空 ⇒ `null`（只要有一样有内容就正常落库）。
 *     ⚠️ **落库形态不变**：`title` / `description` 仍**不 trim**（只有**判空**时才 trim，
 *     落库用的是原值），`collectible_ids` 的洗形逻辑也不变。 */
function normalizeHiddenQuest(v: unknown): WenlvHiddenQuest | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as Record<string, unknown>;
  const raw = Array.isArray(q.collectible_ids) ? q.collectible_ids : [];
  const ids = [...new Set(
    raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()),
  )];
  const title = typeof q.title === 'string' ? q.title : '';
  const description = typeof q.description === 'string' ? q.description : '';
  // 空壳 = 没有隐秘任务。⚠️ 这个判空用的 trim **不得**渗进落库值（下面 return 的是未 trim 的原值）。
  if (!title.trim() && !description.trim() && ids.length === 0) return null;
  return { title, description, collectible_ids: ids };
}

/** NPC 台词的形态闸：只保留 `{id, text, voiceUrl, duration}` 四键、**丢掉 id/text 非字符串或 trim 后为空的项**。
 *  ⚠️ **不是「全部转字符串」**：`voiceUrl` 非字符串落 **null**（不转换），`duration` 非数字落 **undefined**（也不转换）；
 *  `id` / `text` 非字符串或 trim 后为空的项**整个丢弃**（也不转换）。
 *  为什么丢空 id 而不报错：与 `normalizeSkills` 同款理由 —— `line.id` 是端面按 id 找台词的引用键，
 *  空 id 会让两条台词在「按 id 找台词」的路径上互相遮蔽（后者静默胜出）。宁可少一条台词。
 *  ⚠️ 本函数只负责**洗形**，不负责「至少 1 条」与「id 唯一」—— 这两条是 R-N4 的两条规则，
 *  在 route 层做（route 层有更具体的错误文案需求，且洗形后空数组与「全丢」是同一态，单测各断一次更清晰）。 */
function normalizeNpcLines(v: unknown): WenlvNpcLine[] {
  if (!Array.isArray(v)) return [];
  const out: WenlvNpcLine[] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object') continue;
    const s = it as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) continue;
    const text = typeof s.text === 'string' ? s.text : '';
    if (!text.trim()) continue;
    out.push({
      id,
      text,
      voiceUrl: typeof s.voiceUrl === 'string' ? s.voiceUrl : null,
      duration: typeof s.duration === 'number' ? s.duration : undefined,
    });
  }
  return out;
}

/** 三个 `NOT NULL` 且直接上卡面的列 —— POST / PATCH 共用，空值一律 400。 */
const CHARACTER_REQUIRED_LABEL: Record<'name' | 'faction' | 'identity', string> = {
  name: '角色名称', faction: '角色阵营', identity: '角色身份',
};

/** 六个**有宽度上限**的文本列 —— 上限数字**逐字抄自**建表迁移 `drizzle/0042_wenlv_characters.sql:30-36`
 *  的列宽（`name/faction/identity/role varchar(50)`、`faction_color varchar(20)`、`avatar_url varchar(500)`）。
 *  ⚠️ 这张表是**一处真相**，改之前先回去核那几行 SQL —— 与 SQL 列宽脱钩就等于没有闸。
 *  为什么要有这道闸：超宽 ⇒ PG `22001` ⇒ 冒泡到 `app.onError` ⇒ **500**，
 *  正是 `normalizeOrder` 那段注释自己说的「不能把客户端传错掩盖成服务端故障」——同一条价值观。
 *  **不截断**：静默截断会吃掉作者原文（与 `normalizeSkills` 丢空 id 不同 —— 那里有「宁可少一条」
 *  的正当性，这里没有任何理由替作者删字）。
 *  （`id` 也是 `varchar(50)`，但它是 PK、由客户端传入且**单独**在 POST 里判，故不在这张表内。） */
const CHARACTER_TEXT_MAX: Record<
  'name' | 'faction' | 'identity' | 'role' | 'factionColor' | 'avatarUrl', number> = {
  name: 50, faction: 50, identity: 50, role: 50, factionColor: 20, avatarUrl: 500,
};

/** 上表各列的中文名（错误文案用）。name/faction/identity 用 spread 取自 `CHARACTER_REQUIRED_LABEL`，
 *  免得同一列名在两处各写一份而漂移。 */
const CHARACTER_TEXT_LABEL: Record<keyof typeof CHARACTER_TEXT_MAX, string> = {
  ...CHARACTER_REQUIRED_LABEL,
  role: '角色定位', factionColor: '阵营色', avatarUrl: '头像地址',
};

/** 超宽闸：返回错误文案（点名「哪一列 + 上限多少」），合法则 `null`。
 *  ⚠️ 量的是**最终落库值**、不是原始入参：POST 的 `name/faction/identity` 会 `.trim()`、
 *  `normalizeTxt` 那一族也会归一 ⇒ 必须传**写进 insert / patch 的那个值**（`null` 跳过 —— 可空列的清空）。
 *  ⚠️ 按**码点**计数，用 `[...s].length` 而**不是** `s.length`：PG 的 `varchar(N)` 数**字符**
 *  （UTF-8 下即**码点**），而 JS 的 `.length` 数 **UTF-16 码元**（一个 emoji 算 2）⇒
 *  用 `.length` 会把「20 个 emoji」这种实际能落库的值误判成超宽（也等于把边界值砍掉一半）。 */
function charTextTooLong(col: keyof typeof CHARACTER_TEXT_MAX, v: string | null): string | null {
  if (v === null) return null;
  const max = CHARACTER_TEXT_MAX[col];
  return [...v].length > max ? `${CHARACTER_TEXT_LABEL[col]}超长（最多 ${max} 字符）` : null;
}

/** NPC 四个**有宽度上限**的文本列 —— 上限数字**逐字抄自**建表迁移 `drizzle/0043_wenlv_npcs.sql:25-34`
 *  的列宽（`name/role/voice_id varchar(50)`、`portrait_url varchar(500)`）。
 *  ⚠️ 与 `CHARACTER_TEXT_MAX` 同款：这张表是**一处真相**，改之前先回去核那几行 SQL。
 *  为什么 NPC 也需要这道闸（与 characters 同一条价值观）：超宽 ⇒ PG `22001` ⇒ 500，
 *  把客户端传错掩盖成服务端故障。**不截断**（同 characters）。
 *  （`id` 也是 `varchar(50)`，但它是 PK、由客户端传入且**单独**在 POST 里判，故不在这张表内。
 *   `characterId` 同是 `varchar(50)`，但它是软引用键、由 `assertCharacterInProduct` 跨产品校验
 *   兜住，故也不进这张表 —— 与 characters 的 `id` 同款。） */
const NPC_TEXT_MAX: Record<'name' | 'role' | 'portraitUrl' | 'voiceId', number> = {
  name: 50, role: 50, portraitUrl: 500, voiceId: 50,
};

/** 上表各列的中文名（错误文案用）。 */
const NPC_TEXT_LABEL: Record<keyof typeof NPC_TEXT_MAX, string> = {
  name: 'NPC 名称', role: 'NPC 定位', portraitUrl: '立绘地址', voiceId: '音色 ID',
};

/** NPC 超宽闸：与 `charTextTooLong` 逐字同款（按码点计数、量归一后落库值、null 跳过）。 */
function npcTextTooLong(col: keyof typeof NPC_TEXT_MAX, v: string | null): string | null {
  if (v === null) return null;
  const max = NPC_TEXT_MAX[col];
  return [...v].length > max ? `${NPC_TEXT_LABEL[col]}超长（最多 ${max} 字符）` : null;
}

route.get('/products/:id/characters', async (c) => {
  // 按 order 排：卡面顺序是产品语义（与 collectibles 的 createdAt 不同）。
  // 平手用 createdAt 兜稳 —— 同一 order 的两行不能因查询计划不同而换位。
  const rows = await db.select().from(pmsBuiWenlvCharacters)
    .where(eq(pmsBuiWenlvCharacters.productId, c.req.param('id')))
    .orderBy(pmsBuiWenlvCharacters.order, pmsBuiWenlvCharacters.createdAt);
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/characters', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  for (const k of ['name', 'faction', 'identity'] as const) {
    if (typeof body[k] !== 'string' || !body[k].trim()) {
      return c.json({ success: false, error: `${CHARACTER_REQUIRED_LABEL[k]}不能为空` }, 400);
    }
  }
  // 两个 jsonb 列的**形状闸**：键存在且值非 `null` 时，形状错 ⇒ 400。
  // 为什么这里**不**沿用 `order` 的宽松理由（「为一个纯展示数字把整份出稿打成硬失败」）：
  //   · jsonb 列**不会 500** —— 那条理由的前提是「避免把客户端传错掩盖成服务端故障」，在这里不成立；
  //   · 「形状错就静默替换成空集」是**内容丢失**，不是「兜个默认值」：
  //     实测 `PATCH {"skills":"oops"}` 会把该角色**原有技能整批清成 `[]`**（`hiddenQuest` 同型）。
  // 形状定义：`skills` = `null` 或**数组**；`hiddenQuest` = `null` 或**非数组对象**。
  //   ⚠️ `hiddenQuest` 必须显式排掉**数组**：本列的合法形状是「对象」，`Array.isArray` 为真属**形状非法**。
  //   这一条与「内容为空 ⇒ 落 null」是**并存的两条闸**（后者在 `normalizeHiddenQuest` 里，见其注释）——
  //   不能靠「反正空壳会落 null」把形状非法一并吞掉：那会把客户端的形状错误静默成一次清空。
  //   `null` 一律放行 = **清空**（skills 落 `[]`、hiddenQuest 落 null）。
  // **POST 与 PATCH 同一条口径**（下面 PATCH 里那道闸与本段共用这套形状定义）。
  if ('skills' in body && body.skills !== null && !Array.isArray(body.skills)) {
    return c.json({ success: false, error: '技能格式不正确' }, 400);
  }
  if ('hiddenQuest' in body && body.hiddenQuest !== null
      && (typeof body.hiddenQuest !== 'object' || Array.isArray(body.hiddenQuest))) {
    return c.json({ success: false, error: '隐秘任务格式不正确' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  // `id` 是 PK、`varchar(50)`（0042.sql:27），且这里**原样采信客户端传的 id** ⇒ 超宽会 22001 ⇒ 500，
  // 故单独判一次长度。（`productId` 不判：它来自路由参数、且 `getProductOr404` 已证明它在库里存在，
  // 加检查是死分支。）
  if ([...id].length > 50) {
    return c.json({ success: false, error: '角色 id 超长（最多 50 字符）' }, 400);
  }
  // 文本列先归一（口径与 PATCH 一致），**再对归一后的值**判宽度 —— 见 `charTextTooLong` 的注释。
  const name = body.name.trim();
  const faction = body.faction.trim();
  const identity = body.identity.trim();
  const factionColor = normalizeTxt(body.factionColor);
  const role = normalizeTxt(body.role);
  const avatarUrl = normalizeTxt(body.avatarUrl);
  const widthChecks: Array<[keyof typeof CHARACTER_TEXT_MAX, string | null]> = [
    ['name', name], ['faction', faction], ['identity', identity],
    ['role', role], ['factionColor', factionColor], ['avatarUrl', avatarUrl],
  ];
  for (const [col, v] of widthChecks) {
    const err = charTextTooLong(col, v);
    if (err) return c.json({ success: false, error: err }, 400);
  }
  // 幂等重入：id 已存在直接返回既有行（**不**用新 body 覆盖）——
  // 与 collectibles 同款，也为将来 AI 出稿的重试预留了安全边际。
  const [exist] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
  // 跨产品 id 冲突防护：查到行但不属于本产品 ⇒ 视为不存在，正常 insert
  if (exist && exist.productId === productId) return c.json({ success: true, data: exist });
  const [row] = await db.insert(pmsBuiWenlvCharacters).values({
    id, productId,
    order: normalizeOrder(body.order, 0),
    name,
    faction,
    factionColor,
    identity,
    identityDesc: normalizeLongTxt(body.identityDesc),
    role,
    avatarUrl,
    ipPrompt: normalizeLongTxt(body.ipPrompt),
    vitality: clampAttr(body.vitality), wisdom: clampAttr(body.wisdom), insight: clampAttr(body.insight),
    skills: normalizeSkills(body.skills),
    hiddenQuest: normalizeHiddenQuest(body.hiddenQuest),
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/characters/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  // 三个必填列：**可以省，但不能清空**（与 POST 同一条口径）
  for (const k of ['name', 'faction', 'identity'] as const) {
    if (k in body && (typeof body[k] !== 'string' || !body[k].trim())) {
      return c.json({ success: false, error: `${CHARACTER_REQUIRED_LABEL[k]}不能为空` }, 400);
    }
  }
  // 两个 jsonb 列的形状闸：**与 POST 逐字同一条口径**（形状定义与「为什么不宽松」的理由见 POST 那段）。
  // 这是 I5 的数据丢失路径的正面拦截点：不拦就会把该角色**原有技能整批清空**。
  if ('skills' in body && body.skills !== null && !Array.isArray(body.skills)) {
    return c.json({ success: false, error: '技能格式不正确' }, 400);
  }
  if ('hiddenQuest' in body && body.hiddenQuest !== null
      && (typeof body.hiddenQuest !== 'object' || Array.isArray(body.hiddenQuest))) {
    return c.json({ success: false, error: '隐秘任务格式不正确' }, 400);
  }
  const patch: Record<string, unknown> = {};
  // 文本列：**与 POST 同一条口径**（trim / 纯空白落 null），不能裸透 —— 否则同一份输入
  // 经两个端点会落成两种形态（见 normalizeTxt 的注释）。
  // 宽度闸在这里一并做（**与 POST 同一条口径**）：量的是**归一后**、即真正写进 `patch` 的那个值；
  // 超宽 ⇒ 400 且不截断、也不写库（不判就会 22001 ⇒ 500）。
  for (const k of ['name', 'faction', 'factionColor', 'identity', 'role', 'avatarUrl'] as const) {
    if (!(k in body)) continue;
    const v = normalizeTxt(body[k]);
    const err = charTextTooLong(k, v);
    if (err) return c.json({ success: false, error: err }, 400);
    patch[k] = v;
  }
  // 长文本列：只判空、不 trim（同上，口径与 POST 一致）
  for (const k of ['identityDesc', 'ipPrompt'] as const) {
    if (k in body) patch[k] = normalizeLongTxt(body[k]);
  }
  // 排序号：**显式非法值一律 400**（不能 500，也不能静默改写）
  if ('order' in body) {
    const o = normalizeOrder(body.order, null);
    if (o === null) return c.json({ success: false, error: '排序号必须是整数' }, 400);
    patch.order = o;
  }
  // 形态列：**必须过闸**，不能原样透传（三维要夹、两个 jsonb 要洗形状）
  if ('vitality' in body) patch.vitality = clampAttr(body.vitality);
  if ('wisdom' in body) patch.wisdom = clampAttr(body.wisdom);
  if ('insight' in body) patch.insight = clampAttr(body.insight);
  if ('skills' in body) patch.skills = normalizeSkills(body.skills);
  if ('hiddenQuest' in body) patch.hiddenQuest = normalizeHiddenQuest(body.hiddenQuest);
  patch.updatedAt = new Date();
  const [row] = await db.update(pmsBuiWenlvCharacters).set(patch).where(eq(pmsBuiWenlvCharacters.id, id)).returning();
  if (!row) return c.json({ success: false, error: '角色不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/characters/:id', async (c) => {
  const id = c.req.param('id');
  // 先读行：既为了拿 productId 数同族，也为了把「id 不存在」与「最后一个」两种情况分开报
  const [found] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
  if (!found) return c.json({ success: false, error: '角色不存在' }, 404);
  // 「不允许删到 0」（spec §9 产品层：空角色体系是坏状态）。
  // ⚠️ 这是**尽力而为**的检查：两个并发 DELETE 可能都读到 2 再各删一个 ⇒ 仍会落到 0。
  //    真正权威的那道闸是发布前的完整性校验 R1（characters 为空 ⇒ 拒发）——**它在 P5 落地**
  //    （spec §11 把 R1/R2/R4 放在 P5，只有 R3 随 P2）。⇒ **在 P5 之前，本守卫是唯一一道**，
  //    且它挡不住「新建产品从未建过角色就直接发布」这条路径（见 §7 登记项）。
  //    本检查只负责把「手滑删最后一个」这个最常见的路径当场拦住，并给一句人话。
  const siblings = await db.select({ id: pmsBuiWenlvCharacters.id })
    .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, found.productId));
  if (siblings.length <= 1) {
    return c.json({ success: false, error: '至少保留 1 个角色：本剧本的角色体系不能为空' }, 400);
  }
  const [row] = await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).returning();
  if (!row) return c.json({ success: false, error: '角色不存在' }, 404);
  // 删要素后解绑其素材坐标（不删素材行）—— 与 collectibles 同款。
  // 失败要出声：此时行**已经删了**，素材却仍指向一个不存在的 target，
  // 静默返回 200 会让「已删除」与「素材还挂着」并存而无人知道。
  try {
    await unbindAssetsOf('character', id);
  } catch (e) {
    console.error('[wenlv] 删角色后解绑素材失败', id, e);
    return c.json({ success: false, error: '角色已删除，但其素材解绑失败，请报运维处理' }, 500);
  }
  return c.json({ success: true, data: row });
});

// ===== 角色 AI 头像生成（character_avatar）=====
// POST /characters/:id/avatar —— 取角色的 `ip_prompt`，调素材流水线生成 3 张候选，
// 选定后由 applyWriteback 回写 `characters.avatar_url`（与 NPC portrait 同款走 buildWritebackPlan）。
//
// **与 NPC /npcs/:id/portrait 完全对齐**：
//   · 只入队一条 character_avatar job（一次 INSERT），立刻返回 batchId；
//   · 实际文生图由 wenlv-asset-gen-scheduler 异步轮询完成；
//   · 候选数固定 3 张（spec §5.4 同口径）；
//   · 不直接 UPDATE avatar_url —— 回写由 applyWriteback 单点承担。
//
// **上下文复用**：loadNpcPortraitContext 是 product 级（bible/venueId/styleTag），
// 角色与 NPC 同属一个 product，直接复用不另起函数。
route.post('/characters/:id/avatar', async (c) => {
  const id = c.req.param('id');
  const [ch] = await db.select().from(pmsBuiWenlvCharacters)
    .where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
  if (!ch) return c.json({ success: false, error: '角色不存在' }, 404);

  const ipPrompt = (ch.ipPrompt ?? '').trim();
  if (!ipPrompt) {
    return c.json({ success: false, error: '角色没有 IP 形象描述（ip_prompt），无法生成头像' }, 400);
  }

  const ctx = await loadNpcPortraitContext(ch.productId);
  if (!ctx.ok) {
    if (ctx.reason === 'no_product') {
      return c.json({ success: false, error: '角色所属剧本不存在' }, 404);
    }
    return c.json({
      success: false,
      error: '该剧本还没有风格基线，请先自举（POST /asset-gen/style-bible/bootstrap）再生成',
    }, 409);
  }

  const data = await enqueueCharacterAvatar({
    characterId: ch.id, characterName: ch.name, ipPrompt,
    productId: ch.productId, bible: ctx.bible, venueId: ctx.venueId, styleTag: ctx.styleTag,
  });
  return c.json({ success: true, data });
});

// ===== 子资源：npcs（剧本 NPC：点位上的呈现单元）=====
// 与 characters 的关系见 schema/wenlv.ts 的表头注。NPC 没有「至少 1 个」守卫
// （characters 那条守卫是「空角色体系是坏状态」的产品语义，NPC 没有这条 spec），DELETE 直接删即可。
// ⚠️ 位置：plan 写「末尾追加」，实际插在 characters 之后、endings 之前 —— **刻意如此**：
//    NPCs 与 characters 同属「人设/角色」子资源 grouping，结构同款（GET/POST 父级 productId、
//    PATCH/DELETE 子级 id）、共用 normalizeTxt/normalizeOrder/normalizeNpcLines 等同族 helper，
//    放在一起便于读者横向对比；放末尾会让两份同款路由被 endings/rewards/tiers 隔开。
//    这一行注释点明与 plan 的偏差是有意的，不要「为了对齐 plan」把它挪走。

/** 校验角色属于本剧本；跨剧本引用直接 400，不留脏引用。characterId 为 null/空串时跳过。
 *  R-N3 落地：与 `assertPointInVenue` 同款 —— 软引用不存在/不属于本剧本都按 400 拒掉，
 *  不留「指向别家角色」的脏行。 */
async function assertCharacterInProduct(c: any, productId: string, characterId: string | null | undefined): Promise<Response | null> {
  if (!characterId || (typeof characterId === 'string' && !characterId.trim())) return null;
  const [char] = await db.select({ id: pmsBuiWenlvCharacters.id }).from(pmsBuiWenlvCharacters)
    .where(and(eq(pmsBuiWenlvCharacters.id, characterId), eq(pmsBuiWenlvCharacters.productId, productId))).limit(1);
  if (!char) return c.json({ success: false, error: '角色不存在或不属于该剧本' }, 400);
  return null;
}

route.get('/products/:id/npcs', async (c) => {
  // 按 order 排：与 characters 同款（卡面顺序是产品语义，平手用 createdAt 兜稳）。
  const rows = await db.select().from(pmsBuiWenlvNpcs)
    .where(eq(pmsBuiWenlvNpcs.productId, c.req.param('id')))
    .orderBy(pmsBuiWenlvNpcs.orderId, pmsBuiWenlvNpcs.createdAt);
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/npcs', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  // 必填列：name 非空（POST / PATCH 同一条口径）
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ success: false, error: 'NPC 名称不能为空' }, 400);
  }
  // lines 形状闸：键存在且非 null 时，必须是数组（与 characters 的 skills 形状闸同款 ——
  // 防止「形状错就静默替换成空集」的内容丢失路径；`null` 不是形状错，必须放行 = 清空）。
  if ('lines' in body && body.lines !== null && !Array.isArray(body.lines)) {
    return c.json({ success: false, error: 'NPC 台词格式不正确' }, 400);
  }
  // R-N4 落地①：洗形后至少 1 条 —— 洗形会把「id/text 非字符串或 trim 后为空的项」整个丢弃，
  // 所以 `lines: []` 与「全脏项被丢光」是同一态（洗形后 length 0），都在这里 400。
  const lines = normalizeNpcLines(body.lines);
  if (lines.length === 0) {
    return c.json({ success: false, error: 'NPC 至少要有 1 条台词' }, 400);
  }
  // R-N4 落地②：lines[].id 唯一 —— 端面按 id 找台词，重复 id 会让后一条遮蔽前一条。
  const seenIds = new Set<string>();
  for (const l of lines) {
    if (seenIds.has(l.id)) {
      return c.json({ success: false, error: 'NPC 台词 id 不能重复' }, 400);
    }
    seenIds.add(l.id);
  }
  // 「lines[].text 非空」这一条已由 normalizeNpcLines 的洗形兜住（trim 后为空的项整个丢弃），
  // 故这里不再单独判 —— 洗形后数组里不可能有 text 为空的项。
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  // `id` 是 PK、`varchar(50)`（0043.sql），原样采信客户端传的 id ⇒ 超宽会 22001 ⇒ 500，故单独判一次。
  if ([...id].length > 50) {
    return c.json({ success: false, error: 'NPC id 超长（最多 50 字符）' }, 400);
  }
  // 文本列先归一（口径与 PATCH 一致），**再对归一后的值**判宽度 —— 与 `charTextTooLong` 同款。
  // 量的是**最终落库值**：`name` 在下面会 `.trim()`、`normalizeTxt` 那一族也会归一，
  // 必须传**写进 insert 的那个值**（`null` 跳过 —— 可空列的清空，不判宽）。
  const name = body.name.trim();
  const role = normalizeTxt(body.role);
  const portraitUrl = normalizeTxt(body.portraitUrl);
  const voiceId = normalizeTxt(body.voiceId);
  const widthChecks: Array<[keyof typeof NPC_TEXT_MAX, string | null]> = [
    ['name', name], ['role', role], ['portraitUrl', portraitUrl], ['voiceId', voiceId],
  ];
  for (const [col, v] of widthChecks) {
    const err = npcTextTooLong(col, v);
    if (err) return c.json({ success: false, error: err }, 400);
  }
  // R-N3 落地：character_id 若存在 → 校验属于该 product。刻意排在 idempotent 早返回**之后**：
  // 与 venueId 那条同款 —— 若提到 idempotent 之前，一个合法的幂等 AI 重 POST 会在
  // 「首次创建之后、这次重试之前，它引用的 character 被删掉了」时报 400 —— 本次调用根本不会
  // 写入任何东西（行已存在），却因为一个过时的引用把一次本来安全的重试打成硬失败。
  const [exist] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  // 跨产品 id 冲突防护：查到行但不属于本产品 ⇒ 视为不存在，正常 insert
  if (exist && exist.productId === productId) return c.json({ success: true, data: exist });
  if (body.characterId) {
    const err = await assertCharacterInProduct(c, productId, body.characterId);
    if (err) return err;
  }
  // persona 形状闸（与 PATCH 对称）：必须是非数组对象。
  // null/undefined ⇒ 跳过（POST 走 DB default '{}'）；非对象 ⇒ 400。
  if (body.persona !== undefined && body.persona !== null) {
    if (typeof body.persona !== 'object' || Array.isArray(body.persona)) {
      return c.json({ success: false, error: 'persona 必须是对象' }, 400);
    }
  }
  const [row] = await db.insert(pmsBuiWenlvNpcs).values({
    id, productId,
    orderId: normalizeOrder(body.order, 0),
    name,
    characterId: typeof body.characterId === 'string' && body.characterId.trim() ? body.characterId : null,
    portraitUrl,
    portraitPrompt: normalizeLongTxt(body.portraitPrompt),
    voiceId,
    description: normalizeLongTxt(body.description),
    role,
    lines,
    // 人格卡（迁移 0052）：透传前端传入的对象；形状已在上方闸过（非数组对象或 null/undefined）。
    // 老剧本不传 / 传 null ⇒ undefined ⇒ DB default '{}'。
    persona: body.persona ?? undefined,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/npcs/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  // 必填列：**可以省，但不能清空**（与 POST 同一条口径）
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) {
    return c.json({ success: false, error: 'NPC 名称不能为空' }, 400);
  }
  // lines 形状闸：**与 POST 逐字同一条口径**（形状定义与「为什么不宽松」的理由见 POST 那段）。
  if ('lines' in body && body.lines !== null && !Array.isArray(body.lines)) {
    return c.json({ success: false, error: 'NPC 台词格式不正确' }, 400);
  }
  // 先读行：既为了拿 productId 做 R-N3 cross-ref 校验，也为了把「id 不存在」与「校验失败」分开报。
  // 注意：PATCH 路径里**没有 productId**，所以 cross-ref 校验必须先读出行拿到 productId。
  const [found] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  if (!found) return c.json({ success: false, error: 'NPC 不存在' }, 404);
  // R-N3 落地（PATCH 侧）：characterId 若存在 → 校验属于该 NPC 的 product。
  // `null` 是清空、不是形状错（normalizeTxt 在下面会把空串/纯空白也落 null）。
  if ('characterId' in body && body.characterId) {
    const err = await assertCharacterInProduct(c, found.productId, body.characterId);
    if (err) return err;
  }
  // R-N4 落地（PATCH 侧）：lines 洗形后至少 1 条 + id 唯一。
  // ⚠️ PATCH 与 POST 同口径 —— 不允许把 lines 清成空数组（spec 没说 NPC 可以「无台词」，
  // R-N4 在两侧都生效；若要支持「无台词 NPC」，应改 spec 而不是在这里放行）。
  // 🔴 **null 也必须走 R-N4 校验**：早期实现把 `null` 当清空放行（`body.lines !== null` 才进校验），
  //   导致 `PATCH {lines: null}` 落到 `patch.lines = []`、返回 200，**绕过 R-N4**。
  //   这与 POST 不同：POST 的 `lines: null` 会进 `normalizeNpcLines(null) → []` → 同样被 R-N4 拦掉。
  //   两侧必须**对称**：只要 'lines' 键出现（无论 `null` 还是数组），洗形后都得满足「至少 1 条」。
  let normalizedLines: WenlvNpcLine[] | undefined;
  if ('lines' in body) {
    normalizedLines = body.lines === null ? [] : normalizeNpcLines(body.lines);
    if (normalizedLines.length === 0) {
      return c.json({ success: false, error: 'NPC 至少要有 1 条台词' }, 400);
    }
    const seenIds = new Set<string>();
    for (const l of normalizedLines) {
      if (seenIds.has(l.id)) {
        return c.json({ success: false, error: 'NPC 台词 id 不能重复' }, 400);
      }
      seenIds.add(l.id);
    }
  }
  // 文本列：**与 POST 同一条口径**（trim / 纯空白落 null），不能裸透 —— 否则同一份输入
  // 经两个端点会落成两种形态（见 normalizeTxt 的注释）。宽度闸在这里一并做（**与 POST
  // 同一条口径**）：量的是**归一后**、即真正写进 `patch` 的那个值；超宽 ⇒ 400 且不截断、
  // 也不写库（不判就会 22001 ⇒ 500）。
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'role', 'portraitUrl', 'voiceId'] as const) {
    if (!(k in body)) continue;
    const v = normalizeTxt(body[k]);
    const err = npcTextTooLong(k, v);
    if (err) return c.json({ success: false, error: err }, 400);
    patch[k] = v;
  }
  if ('characterId' in body) {
    patch.characterId = typeof body.characterId === 'string' && body.characterId.trim() ? body.characterId : null;
  }
  if ('portraitPrompt' in body) patch.portraitPrompt = normalizeLongTxt(body.portraitPrompt);
  if ('description' in body) patch.description = normalizeLongTxt(body.description);
  if (normalizedLines !== undefined) patch.lines = normalizedLines;
  // 人格卡（迁移 0052）：只在 body 显式带 persona 键时更新。
  // null = 不允许清空人格卡，返回 400（与 lines 不允许清空同款）；
  // 非对象（含数组）= 形状错，返回 400（与 POST 对称）。
  if ('persona' in body) {
    if (body.persona === null) {
      return c.json({ success: false, error: 'persona 不能为 null' }, 400);
    }
    if (typeof body.persona !== 'object' || Array.isArray(body.persona)) {
      return c.json({ success: false, error: 'persona 必须是对象' }, 400);
    }
    patch.persona = body.persona;
  }
  if ('order' in body) {
    const o = normalizeOrder(body.order, null);
    if (o === null) return c.json({ success: false, error: '排序号必须是整数' }, 400);
    patch.orderId = o;
  }
  patch.updatedAt = new Date();
  const [row] = await db.update(pmsBuiWenlvNpcs).set(patch).where(eq(pmsBuiWenlvNpcs.id, id)).returning();
  if (!row) return c.json({ success: false, error: 'NPC 不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/npcs/:id', async (c) => {
  const id = c.req.param('id');
  // 先读行：把「id 不存在」与「删除成功」两种情况分开报（与 characters 同款）。
  // ⚠️ NPC 没有 characters 那条「至少保留 1 个」守卫 —— spec 没要求 NPC 至少 1 个，
  // 删到 0 也允许（环境叙述型 NPC 可以删完）。该守卫是 characters 表独有的产品语义。
  const [found] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  if (!found) return c.json({ success: false, error: 'NPC 不存在' }, 404);
  // 级联清空引用此 NPC 的节点的 npcId / npcLineIds（T33 落地，spec §4.3 软引用约束）。
  //
  // 判序：**先解绑节点，再删 NPC** —— 与 `unbindAssetsOf` 同口径的「解绑在删除成功之前」
  // 不同：那里素材是「核心删除已成功后再解绑素材」，是**容许解绑失败时素材留下悬空引用**
  // （素材可被别处复用）；这里 NPC 是被引用方，节点是引用方 —— 必须保证**删除成功之后**节点
  // 上没有任何悬空引用，故反过来「先解绑后删」。如果反过来「先删后解绑」，删 NPC 成功但解绑
  // 失败 ⇒ 留下 `npcId = (已删 id)` 的悬空引用（spec §8.10 端面兜底会按「无 NPC」处理，但
  // 管理端 full 接口仍会下发 npcId 字段，让前端表单以为该 NPC 还活着 ⇒ 误导）。
  //
  // 不用事务：解绑和删除都是单条 UPDATE/DELETE，PG 内部原子；两个语句之间崩溃的概率极低，
  // 即便发生也只是「节点解绑了但 NPC 还在」的可重试状态，不是数据损坏。
  // 不写 `RETURNING *` —— 那会把所有受影响行整行返回，浪费；用 `.returning({ id: ... })` 只取 id。
  // 0079 统一模型：引用此 NPC 的剧情节点即 scenes（npcId 软引用列保留），解绑改 scenes。
  const unlinked = await db.update(pmsBuiWenlvScenes)
    .set({ npcId: null, npcLineIds: [], updatedAt: new Date() })
    .where(eq(pmsBuiWenlvScenes.npcId, id))
    .returning({ id: pmsBuiWenlvScenes.id });
  const [row] = await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).returning();
  if (!row) return c.json({ success: false, error: 'NPC 不存在' }, 404);
  // 返回 unlinkedNodes 计数让前端能 toast 警告（spec §4.3 删 NPC 须告知运营有多少节点受影响）。
  // ⚠️ 字段名刻意用 `unlinkedNodes`（不是 `clearedNodes` / `affectedNodes`）—— 与同文件
  //    `unbindAssetsOf` 那条「解绑」口径保持一致，便于读者横向对照。
  return c.json({ success: true, data: row, unlinkedNodes: unlinked.map((n) => n.id) });
});

// AI 优化单个 NPC（全字段重生，含 persona + relationships）。异步：创建 job 后立即返回 taskId。
route.post('/npcs/:id/optimize', async (c) => {
  const id = c.req.param('id');
  const [npc] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  if (!npc) return c.json({ success: false, error: 'NPC 不存在' }, 404);
  const jobId = randomUUID();
  await db.insert(pmsBuiWenlvNpcJobs).values({
    id: jobId,
    productId: npc.productId,
    npcId: id,
    targetType: 'npc',
    targetId: id,
    stage: 'npc_optimize',
    type: 'single_optimize',
    status: 'pending',
  });
  return c.json({ success: true, data: { taskId: jobId } });
});

// AI 一键优化玩家角色（全字段重生，含头像/技能/隐秘任务/背景/语气）。
// 异步：创建 character_optimize job 后立即返回 taskId，前端任务中心轮询回填。
route.post('/content/characters/:id/optimize', async (c) => {
  const id = c.req.param('id');
  const [character] = await db.select().from(pmsBuiWenlvCharacters)
    .where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
  if (!character) return c.json({ success: false, error: '角色不存在' }, 404);
  const taskId = await optimizeCharacter(character.productId, id);
  return c.json({ success: true, data: { taskId } });
});

// 查询单个 NPC 生成/优化任务状态（供前端轮询）。
route.get('/npc-jobs/:id', async (c) => {
  const id = c.req.param('id');
  const [job] = await db.select().from(pmsBuiWenlvNpcJobs).where(eq(pmsBuiWenlvNpcJobs.id, id)).limit(1);
  if (!job) return c.json({ success: false, error: '任务不存在' }, 404);
  return c.json({ success: true, data: job });
});

// 查询某产品下所有 NPC 生成/优化任务（任务中心展示用）。
// 倒序 + 限量：任务中心要展示「最近完成/失败」的任务做采纳/弃用闭环，
// 只按 createdAt 升序全量返回会让最新任务沉底、且历史任务无限膨胀。
route.get('/products/:id/npc-jobs', async (c) => {
  const productId = c.req.param('id');
  const jobs = await db.select().from(pmsBuiWenlvNpcJobs)
    .where(eq(pmsBuiWenlvNpcJobs.productId, productId))
    .orderBy(desc(pmsBuiWenlvNpcJobs.createdAt))
    .limit(30);
  return c.json({ success: true, data: jobs });
});

// 清空已结束的 AI 任务（任务中心「一键清空」）：物理删除该产品下 succeeded/failed 的任务行，
// pending/running 保留。物理删除而非标记位 —— 任务行本就是瞬时队列语义，历史无审计价值；
// 若后续需要审计再换 cleared 标记。
route.post('/products/:id/npc-jobs/clear', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const deleted = await db.delete(pmsBuiWenlvNpcJobs)
    .where(and(
      eq(pmsBuiWenlvNpcJobs.productId, productId),
      inArray(pmsBuiWenlvNpcJobs.status, ['succeeded', 'failed']),
    ))
    .returning({ id: pmsBuiWenlvNpcJobs.id });
  return c.json({ success: true, data: { cleared: deleted.length } });
});

// 弃用 AI 任务草稿（任务中心「弃用」按钮）。幂等：仅 succeeded 且未采纳的任务可弃用；
// 弃用只置 result.discarded 标记，不动业务表——草稿本来就没落库。
route.post('/npc-jobs/:id/discard', async (c) => {
  const id = c.req.param('id');
  const [job] = await db.select().from(pmsBuiWenlvNpcJobs).where(eq(pmsBuiWenlvNpcJobs.id, id)).limit(1);
  if (!job) return c.json({ success: false, error: '任务不存在' }, 404);
  if (job.status !== 'succeeded') return c.json({ success: false, error: '只有已成功的任务才能弃用' }, 409);
  const r = job.result as Record<string, unknown> | null;
  if (r?.applied) return c.json({ success: false, error: '任务已采纳，不能弃用' }, 409);
  if (r?.discarded) return c.json({ success: true, data: { id, discarded: true } });
  await db.update(pmsBuiWenlvNpcJobs).set({
    result: { ...(r ?? {}), discarded: true } as any,
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvNpcJobs.id, id));
  return c.json({ success: true, data: { id, discarded: true } });
});

// ===== NPC 立绘入队辅助（T19 S2，spec §5.4）=====
// /products/:id/npcs/generate（S1→S2）与 /npcs/:id/portrait（仅 S2）共用本辅助。
// 两步走：loadNpcPortraitContext 装载 per-product 上下文（bible/venueId/styleTag），
// enqueueNpcPortrait 用 per-NPC 字段 + per-product 上下文 planBatch + enqueueBatch。
//
// **为什么分两步**：/generate 一次给一批 NPC 入队，per-product 上下文只查一次；
// /portrait 一次只有一个 NPC，无所谓但走同款代码避免分叉。
//
// **候选数固定 3 张**（spec §5.4「候选数量：3 张（半身像，单形象）」）—— 写死在 enqueueNpcPortrait，
// 不读 body.candidates，避免调用方传 1 张或 10 张与 spec 不符。
//
// **不直接 UPDATE portrait_url** —— 回写由 applyWriteback 在候选被采纳时单点承担（spec §5.4）。
// 本辅助只负责「入队 job 行」，与 wenlv-asset-gen.ts /batch 同款分工。
//
// **架构决策（T19）**：plan 文本写「改 wenlv_creation_crew.py 让 AI crew 调素材流水线」，
// 但 AI crew（Python）没有 pms-server（TS/PG）的素材流水线句柄，反过来调会形成
// 循环依赖（admin → AI crew → admin）。本仓既存范式是 admin 路由调 AI crew，不是反向。
// 故 S2 的入队动作放在 admin /generate 里、紧接 S1 upsert 之后做 —— 同进程、同事务边界
// 之外的轻量入队，符合 spec §5.5「每个 stage 完成即写表、不跨 stage 大事务」。
// AI crew 的 run_refine(stage='npc_portrait') 不需要存在（S2 不再是 AI crew 的活）。
/** 装载某 product 的立绘上下文：风格基线 + venueId + communityStyleTag。
 *  返回 `{ok:false,reason:'no_product'|'no_bible'}` 表示前置不满足 —— 调用方各自报 404/409。
 *  spec §8：出图必须有基线，否则风格漂移。fitTag 在入口截宽（码点 50、空白归 null），
 *  避免 enqueueBatch 对超宽 styleTag 硬抛导致整批回滚 500。 */
async function loadNpcPortraitContext(productId: string): Promise<
  | { ok: true; bible: WenlvStyleBible; venueId: string | null; styleTag: string | null }
  | { ok: false; reason: 'no_product' | 'no_bible' }
> {
  const [product] = await db.select().from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  if (!product) return { ok: false, reason: 'no_product' };
  const bible = product.styleBible as WenlvStyleBible | null;
  if (!bible || !bible.artStyle) return { ok: false, reason: 'no_bible' };
  const venueId = product.venueId ?? null;
  let styleTag: string | null = null;
  if (venueId) {
    // 与 wenlv-asset-gen.ts /batch 同款归一 —— fitTag 与 enqueueBatch 同源（enqueue.ts）。
    const [v] = await db.select({ name: pmsBuiWenlvVenues.name }).from(pmsBuiWenlvVenues)
      .where(eq(pmsBuiWenlvVenues.id, venueId)).limit(1);
    styleTag = fitTag(v?.name ?? null);
  }
  return { ok: true, bible, venueId, styleTag };
}

/** 入队一条 npc_portrait job —— 调用方负责先 loadNpcPortraitContext 拿 ctx。
 *  返回 `{ batchId, jobId, count }`；jobId 为 null 表示 planBatch 没产 job（理论上不会）。
 *  target_id = NPC id（回写 npc.portrait_url 的权威键）；sourceText = portrait_prompt 快照；
 *  skipAnchorInsert: true —— 单 NPC 立绘不该顺带补一张锚图（与纯旁白批次同理由）。 */
async function enqueueNpcPortrait(args: {
  npcId: string;
  npcName: string;
  portraitPrompt: string;
  productId: string;
  bible: WenlvStyleBible;
  venueId: string | null;
  styleTag: string | null;
}): Promise<{ batchId: string; jobId: string | null; count: number }> {
  const batchId = randomUUID();
  const jobs = planBatch({
    batchId, venueId: args.venueId, productId: args.productId, bible: args.bible,
    types: ['npc_portrait'],
    nodes: [], collectibles: [], endings: [], rewards: [], tiers: [],
    npcs: [{ id: args.npcId, name: args.npcName, description: args.portraitPrompt }],
    candidateCount: 3,
    communityStyleTag: args.styleTag,
    skipAnchorInsert: true,
  });
  await enqueueBatch(jobs);
  return { batchId, jobId: jobs[0]?.id ?? null, count: jobs.length };
}

/** 入队一条 character_avatar job —— 调用方负责先 loadNpcPortraitContext 拿 ctx（product 级上下文，角色与 NPC 共享）。
 *  返回 `{ batchId, jobId, count }`；jobId 为 null 表示 planBatch 没产 job（理论上不会）。
 *  target_id = 角色 id（回写 characters.avatar_url 的权威键）；sourceText = ip_prompt 快照；
 *  candidateCount=3（与 NPC 立绘同口径，spec §5.4）。
 *  与 enqueueNpcPortrait 的差异仅在 types/characters 参数，其余完全对齐。 */
async function enqueueCharacterAvatar(args: {
  characterId: string;
  characterName: string;
  ipPrompt: string;
  productId: string;
  bible: WenlvStyleBible;
  venueId: string | null;
  styleTag: string | null;
}): Promise<{ batchId: string; jobId: string | null; count: number }> {
  const batchId = randomUUID();
  const jobs = planBatch({
    batchId, venueId: args.venueId, productId: args.productId, bible: args.bible,
    types: ['character_avatar'],
    nodes: [], collectibles: [], endings: [], rewards: [], tiers: [], npcs: [],
    characters: [{ id: args.characterId, name: args.characterName, ipPrompt: args.ipPrompt }],
    candidateCount: 3,
    communityStyleTag: args.styleTag,
    skipAnchorInsert: true,
  });
  await enqueueBatch(jobs);
  return { batchId, jobId: jobs[0]?.id ?? null, count: jobs.length };
}

// ===== NPC AI 生成（异步）：创建 batch_generate job，由 npc-gen-scheduler 后台处理 =====
// 同步逻辑（调 AI crew + upsert + S2 立绘入队）已整体迁移至调度器（services/wenlv/npc-gen/npc-gen-scheduler.ts）。
// 本端点只负责创建 pending job 并立即返回 taskId，前端走任务中心轮询。
// 已有 NPC 会被调度器在写入新 NPC 前整体删除后重建（spec：已有则删后重建）。
route.post('/products/:id/npcs/generate', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const jobId = randomUUID();
  await db.insert(pmsBuiWenlvNpcJobs).values({
    id: jobId, productId, npcId: null, type: 'batch_generate', status: 'pending',
  });
  return c.json({ success: true, data: { taskId: jobId } });
});

// ===== 发布流程阻塞 AI 一键疏通（flow_repair，异步任务流）=====
// 与 node_refine 不同：scheduler 完成后修复已事务落库（无采纳步骤），前端轮询到 succeeded 即可刷新待办。
// 产品级动作 + 自动改图 ⇒ 强制防重：同产品已有 pending/running 的 flow_repair 时直接返回原 taskId。
route.post('/products/:id/flow-repair', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const [existing] = await db.select().from(pmsBuiWenlvNpcJobs)
    .where(and(
      eq(pmsBuiWenlvNpcJobs.productId, productId),
      eq(pmsBuiWenlvNpcJobs.type, 'flow_repair'),
      inArray(pmsBuiWenlvNpcJobs.status, ['pending', 'running']),
    ))
    .orderBy(desc(pmsBuiWenlvNpcJobs.createdAt)).limit(1);
  if (existing) return c.json({ success: true, data: { taskId: existing.id, deduped: true } });

  const jobId = randomUUID();
  await db.insert(pmsBuiWenlvNpcJobs).values({
    id: jobId, productId, targetType: 'product', targetId: productId,
    type: 'flow_repair', status: 'pending',
  });
  return c.json({ success: true, data: { taskId: jobId } });
});

// ===== 剧情骨架 AI 生成（异步任务流）=====
// POST /products/:id/skeleton-generate：body { instruction? }
// 调度器调 AI Crew skeleton_generate stage，批量创建节点 + 边，前端任务中心轮询。
route.post('/products/:id/skeleton-generate', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({})) as { instruction?: string };
  const taskId = await generateSkeleton(productId, body.instruction || '');
  return c.json({ success: true, data: { taskId } });
});

// ===== 证物 AI 生成（P2-D）=====
// POST /products/:id/collectibles/generate —— 原同步调用 LLM 生成证物草稿
// TODO: Phase 2 — migrate to async generateCollectibleImage(productId, collectibleId)（ai-content-gen Task 1.14）
// 旧路由已废弃：原同步 generateCollectible 已移除；新 API 仅支持对已存在证物生成图（collectible_image 任务）。
// Phase 2 将重新设计为「先建证物占位 → 触发 AI 任务 → 任务中心轮询 → 回填图与文案」。
route.post('/products/:id/collectibles/generate', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  return c.json({ success: false, error: '证物 AI 生成已迁移至异步任务流，路由待 Phase 2 重构' }, 501);
});

// ===== 角色 AI 一键生成（P1 Task 3）=====
// POST /products/:id/characters/generate —— 与 /npcs/generate 同构，调 AI crew run_refine
// stage='characters'，写回 pms_bui_wenlv_characters。与 /npcs/generate 的分工：
//   · /npcs/generate 调 npc_setting stage，写 NPC 人设（name/role/lines/...）；
//   · 本路由调 characters stage，写角色卡（name/faction/identity/三维/skills/...）。
// AI 返回结构：{status, output: {characters: {schema_version, characters:[...]}}}。
route.post('/products/:id/characters/generate', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const aiHost = process.env.PMS_AGENT_HOST || 'localhost';
  const aiPort = process.env.PMS_AGENT_PORT || '8000';
  let data: any;
  try {
    const res = await fetch(`http://${aiHost}:${aiPort}/api/wenlv-creation/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: productId, stage: 'characters', instruction: '' }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return c.json({ success: false, error: `AI 生成失败: ${res.status} ${text}` }, 502);
    }
    data = await res.json().catch(() => ({}));
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'AI 生成超时，请稍后重试' : `AI crew 不可达: ${String(e)}`;
    return c.json({ success: false, error: msg }, 502);
  }

  // run_refine stage='characters' 返回 {status, output: {characters: {schema_version, characters:[...]}}}
  // 兜一层：若上游将来把 WenlvCharacters 解包成裸数组，本路径不破（与 /npcs/generate 同款）。
  const refinedCharsRaw = data?.output?.characters?.characters ?? data?.output?.characters ?? [];
  const refinedChars = (Array.isArray(refinedCharsRaw) ? refinedCharsRaw : [])
    .filter((ch: any) => ch && typeof ch.id === 'string');
  if (refinedChars.length === 0) {
    return c.json({ success: false, error: 'AI 未返回角色数据' }, 502);
  }

  // 取当前库行作为基线（与 /npcs/generate 同款：已有行的最大 order 作为新插入的起点）。
  // ⚠️ characters 表的排序列是 `order`（非 npcs 的 `orderId`）—— 见 schema wenlv.ts:265。
  const existing = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId));
  const existingById = new Map(existing.map((ch) => [ch.id, ch]));
  let nextOrder = existing.reduce((m, ch) => Math.max(m, ch.order), -1) + 1;

  // 逐条校验（与 characters POST 路由逐字同款口径：必填非空、三维 0-100、id 宽度 ≤50）。
  for (let i = 0; i < refinedChars.length; i++) {
    const body = refinedChars[i];
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return c.json({ success: false, error: '角色名称不能为空' }, 400);
    }
    if (typeof body.faction !== 'string' || !body.faction.trim()) {
      return c.json({ success: false, error: '角色阵营不能为空' }, 400);
    }
    if (typeof body.identity !== 'string' || !body.identity.trim()) {
      return c.json({ success: false, error: '角色社会身份不能为空' }, 400);
    }
    for (const attr of ['vitality', 'wisdom', 'insight'] as const) {
      const v = body[attr];
      if (v !== undefined && v !== null && (typeof v !== 'number' || v < 0 || v > 100)) {
        return c.json({ success: false, error: `角色 ${body.name} ${attr} 必须在 0-100 之间` }, 400);
      }
    }
    if ([...body.id].length > 50) {
      return c.json({ success: false, error: '角色 id 超长（最多 50 字符）' }, 400);
    }
  }

  // 落库：逐条 upsert（按 id 幂等）。jsonb 列复用 characters POST 的 normalize* 助手
  // （normalizeSkills / normalizeHiddenQuest）—— 不用 JSON.stringify：drizzle jsonb 列
  // 期望的是洗形后的 typed 值，与 POST / PATCH 同一条口径。
  const results = [];
  for (let i = 0; i < refinedChars.length; i++) {
    const body = refinedChars[i];
    const exist = existingById.get(body.id);
    const values = {
      id: body.id,
      productId,
      name: body.name.trim(),
      faction: body.faction.trim(),
      factionColor: body.faction_color ?? body.factionColor ?? null,
      identity: body.identity.trim(),
      identityDesc: body.identity_desc ?? body.identityDesc ?? null,
      role: body.role ?? null,
      vitality: typeof body.vitality === 'number' ? body.vitality : 50,
      wisdom: typeof body.wisdom === 'number' ? body.wisdom : 50,
      insight: typeof body.insight === 'number' ? body.insight : 50,
      skills: normalizeSkills(body.skills),
      hiddenQuest: normalizeHiddenQuest(body.hidden_quest ?? body.hiddenQuest),
      ipPrompt: body.ip_prompt ?? body.ipPrompt ?? null,
      order: exist?.order ?? nextOrder++,
    };
    if (exist) {
      // UPDATE 不动 id / productId（PK + 外键），其余字段全量覆盖。
      const { id: _id, productId: _pid, ...patch } = values;
      await db.update(pmsBuiWenlvCharacters).set(patch).where(eq(pmsBuiWenlvCharacters.id, body.id));
      results.push({ ...values, id: body.id });
    } else {
      const [row] = await db.insert(pmsBuiWenlvCharacters).values(values).returning();
      results.push(row);
    }
  }

  return c.json({ success: true, data: results });
});

// ===== 一键全量生成（骨架 → 角色 → NPC）=====
// POST /products/:id/generate-full —— 一次性触发完整剧本骨架生成：
//   1. 同步调 AI crew stage='characters' 写角色卡；
//   2. 异步创建 NPC 批量生成 job（stage='npc_setting'，由 npc-gen-scheduler 后台处理）。
// 节点/证物/结局仍由创作者逐项精修（分阶段精修模式），本端点只负责「一键出骨架」。
// 返回：{ characterCount, npcTaskId } —— 角色数量 + NPC 任务 id（供前端轮询）。
route.post('/products/:id/generate-full', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;

  const aiHost = process.env.PMS_AGENT_HOST || 'localhost';
  const aiPort = process.env.PMS_AGENT_PORT || '8000';

  // 步骤 1：同步生成角色卡（与 /characters/generate 同构）
  let characterCount = 0;
  try {
    const res = await fetch(`http://${aiHost}:${aiPort}/api/wenlv-creation/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: productId, stage: 'characters', instruction: '' }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return c.json({ success: false, error: `角色生成失败: ${res.status} ${text}` }, 502);
    }
    const data: any = await res.json().catch(() => ({}));
    const refinedCharsRaw = data?.output?.characters?.characters ?? data?.output?.characters ?? [];
    const refinedChars = (Array.isArray(refinedCharsRaw) ? refinedCharsRaw : [])
      .filter((ch: any) => ch && typeof ch.id === 'string');
    if (refinedChars.length > 0) {
      const existing = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId));
      const existingById = new Map(existing.map((ch) => [ch.id, ch]));
      let nextOrder = existing.reduce((m, ch) => Math.max(m, ch.order), -1) + 1;
      for (const body of refinedChars) {
        const values = {
          id: String(body.id),
          productId,
          order: existingById.has(String(body.id)) ? existingById.get(String(body.id))!.order : nextOrder++,
          name: String(body.name ?? ''),
          faction: String(body.faction ?? ''),
          factionColor: body.factionColor ?? null,
          identity: String(body.identity ?? ''),
          identityDesc: body.identityDesc ?? null,
          role: body.role ?? null,
          avatarUrl: body.avatarUrl ?? null,
          ipPrompt: body.ipPrompt ?? null,
          vitality: typeof body.vitality === 'number' ? body.vitality : 0,
          wisdom: typeof body.wisdom === 'number' ? body.wisdom : 0,
          insight: typeof body.insight === 'number' ? body.insight : 0,
          skills: Array.isArray(body.skills) ? body.skills : [],
          hiddenQuest: body.hiddenQuest ?? null,
        };
        if (existingById.has(values.id)) {
          const { id: _id, productId: _pid, ...patch } = values;
          await db.update(pmsBuiWenlvCharacters).set(patch).where(eq(pmsBuiWenlvCharacters.id, values.id));
        } else {
          await db.insert(pmsBuiWenlvCharacters).values(values);
        }
      }
      characterCount = refinedChars.length;
    }
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'AI 生成超时' : `AI crew 不可达: ${String(e)}`;
    return c.json({ success: false, error: msg }, 502);
  }

  // 步骤 2：异步创建 NPC 批量生成 job（与 /npcs/generate 同构）
  const jobId = randomUUID();
  await db.insert(pmsBuiWenlvNpcJobs).values({
    id: jobId, productId, npcId: null, type: 'batch_generate', status: 'pending',
  });

  return c.json({
    success: true,
    data: { characterCount, npcTaskId: jobId },
  });
});

// ===== NPC 立绘生成（T18，spec §5.4 S2 stage）=====
// POST /npcs/:id/portrait —— 取 NPC 的 `portrait_prompt`，调素材流水线生成 3 张候选，
// 选定后由 applyWriteback 回写 `npcs.portrait_url`（spec §5.4「选定后回写 npc.portrait_url」）。
//
// **与 /npcs/generate（S1）的分工**（spec §5.5）：
//   · /npcs/generate 调 AI crew 的 npc_setting stage，写 S1 字段（name/role/description/portrait_prompt/...）；
//   · /npcs/:id/portrait 调素材流水线（planBatch + enqueueBatch），入队一条 npc_portrait job；
//   · 本路由**不直接 UPDATE portrait_url** —— 回写由素材流水线的 applyWriteback 在候选
//     被采纳时单点承担，与 background/cover/ending 同款走 buildWritebackPlan 路径。
//
// **短请求**：本路由只入队 job 行（一条 INSERT），立刻返回 batchId。实际文生图由
// wenlv-asset-gen-scheduler 异步轮询 pending job 完成，PC 轮询 /asset-gen/batch/:batchId 取进度。
// 故 BFF 可走 proxyContent（10s 超时够用），不必像 /npcs/generate 那样挂 300s。
//
// **候选数固定 3 张**（spec §5.4「候选数量：3 张（半身像，单形象）」）—— 不读 body.candidates，
// 避免调用方传 1 张或 10 张与 spec 不符。写死在 enqueueNpcPortrait 里，与 spec §5.4 逐字对齐。
//
// **T19 重构**：本路由的入队逻辑已抽到 `loadNpcPortraitContext` + `enqueueNpcPortrait`，
// 与 /products/:id/npcs/generate 的 S2 段共用 —— 避免双份 planBatch 模板分叉演化。
route.post('/npcs/:id/portrait', async (c) => {
  const id = c.req.param('id');
  const [npc] = await db.select().from(pmsBuiWenlvNpcs)
    .where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  if (!npc) return c.json({ success: false, error: 'NPC 不存在' }, 404);

  const portraitPrompt = (npc.portraitPrompt ?? '').trim();
  if (!portraitPrompt) {
    return c.json({ success: false, error: 'NPC 没有 portrait_prompt，无法生成立绘' }, 400);
  }

  // 装载 per-product 上下文（bible/venueId/styleTag）—— 与 /generate 的 S2 段同款。
  const ctx = await loadNpcPortraitContext(npc.productId);
  if (!ctx.ok) {
    if (ctx.reason === 'no_product') {
      return c.json({ success: false, error: 'NPC 所属剧本不存在' }, 404);
    }
    return c.json({
      success: false,
      error: '该剧本还没有风格基线，请先自举（POST /asset-gen/style-bible/bootstrap）再生成',
    }, 409);
  }

  const data = await enqueueNpcPortrait({
    npcId: npc.id, npcName: npc.name, portraitPrompt,
    productId: npc.productId, bible: ctx.bible, venueId: ctx.venueId, styleTag: ctx.styleTag,
  });
  return c.json({ success: true, data });
});

// ===== NPC 旁白 TTS 生成（T25，spec §5.5 S3 stage）=====
// POST /npcs/:id/voice[?line_id=l1] —— 调 AI crew 的 run_refine(stage='npc_voice')，
// S3 同步合成全部 lines 的旁白音频（含 3× 退避重试 / 并发 5 / hash 缓存，已在 T24 落地），
// 返回每条 line 的 audio_base64。本路由的活是：decode base64 → 转存 OSS → 把 voiceUrl/duration
// 回写进该 NPC 行的 lines JSONB（spec §5.5「每个 stage 完成即写表」）。
//
// **与 /portrait 的分工**（spec §5.4/§5.5）：
//   · /portrait 入队一条 asset_job 行后立即返回（实际出图由 scheduler 异步）—— 故 BFF 走 10s 透传；
//   · /voice 是**同步阻塞**调 AI crew 的 TTS（与 /npcs/generate 调 S1 同款 —— 不是入队后返回），
//     合成 + 转存 OSS 要数十秒，故 admin 端挂 180s、BFF 端挂 300s（与 /npcs/generate 同口径）。
//
// **单条 line 重生成**：?line_id=l1 时 S3 仍全量合成，但本路由只回写该 line 的 voiceUrl/duration，
// 其余 lines 原样保留（不跨 line 误伤已合成音频）。
//
// **失败容忍（spec §5.5 累积语义）**：S3 对某 line 失败/跳过时 audio_base64 为空 —— 本路由
// **不清空**该 line 已有的 voiceUrl（只 log），整批仍 200。与 /generate 的 lines merge 同款：
// 已跑过的 TTS 不被静默擦除。
route.post('/npcs/:id/voice', async (c) => {
  const id = c.req.param('id');
  // 单条 line 重生成过滤（line_id / lineId 双键兜底防上游改形）
  const lineFilter = (c.req.query('line_id') || c.req.query('lineId') || '').trim();

  const [npc] = await db.select().from(pmsBuiWenlvNpcs)
    .where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  if (!npc) return c.json({ success: false, error: 'NPC 不存在' }, 404);

  // === 调 AI crew S3（npc_voice stage，全量重新合成） ===
  const aiHost = process.env.PMS_AGENT_HOST || 'localhost';
  const aiPort = process.env.PMS_AGENT_PORT || '8000';
  let data: any;
  try {
    const res = await fetch(`http://${aiHost}:${aiPort}/api/wenlv-creation/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: npc.productId, stage: 'npc_voice', instruction: '' }),
      // S3 是多 line TTS + 退避重试，比 S1 单次 LLM 更久；180s 与 /generate 的 120s 同量级留余量。
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return c.json({ success: false, error: `AI 语音生成失败: ${res.status} ${text}` }, 502);
    }
    data = await res.json().catch(() => ({}));
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? 'AI 语音生成超时，请稍后重试' : `AI crew 不可达: ${String(e)}`;
    return c.json({ success: false, error: msg }, 502);
  }

  // === 解析 S3 响应：定位本 NPC 的 lines（双形状兜底，与 /generate 读 S1 同款防御） ===
  // AI crew run_refine 返回 `{status:'DRAFT_READY', output: out}`；S3 的 out.npcs 是
  // `[{npc_id, lines:[{line_id, audio_base64, duration, voiceUrl, skipped, error}]}]`。
  // task 给的示例把 npcs 摆在顶层，故同时兜 data.npcs。
  const npcsRaw = data?.output?.npcs ?? data?.npcs ?? [];
  const npcEntries = Array.isArray(npcsRaw) ? npcsRaw : [];
  const npcEntry = npcEntries.find((n: any) => n && (n.npc_id === id || n.npcId === id));
  const s3Lines: any[] = Array.isArray(npcEntry?.lines) ? npcEntry.lines : [];
  const s3ByLineId = new Map<string, any>();
  for (const l of s3Lines) {
    const lid = l?.line_id ?? l?.lineId;
    if (typeof lid === 'string' && lid) s3ByLineId.set(lid, l);
  }

  // === 逐 line：decode base64 → 转存 OSS → 回写 voiceUrl/duration ===
  // 浅拷贝 lines：UPDATE 写回整组 JSONB，但只改命中的 line（?line_id 时其余原样保留）。
  const currentLines: WenlvNpcLine[] = (npc.lines ?? []).map((l) => ({ ...l }));
  const results: Array<{
    lineId: string; voiceUrl: string | null; duration?: number;
    skipped: boolean; error: string | null;
  }> = [];

  for (const line of currentLines) {
    // 单条重生成过滤：只处理 ?line_id 命中的那条，其余原样不动。
    if (lineFilter && line.id !== lineFilter) continue;

    const s3 = s3ByLineId.get(line.id);
    const skipped = Boolean(s3?.skipped);
    const s3Error = typeof s3?.error === 'string' && s3.error ? s3.error : null;
    const audioB64 = typeof s3?.audio_base64 === 'string'
      ? s3.audio_base64
      : (typeof s3?.audioBase64 === 'string' ? s3.audioBase64 : '');
    const s3VoiceUrl = typeof s3?.voiceUrl === 'string' ? s3.voiceUrl : '';
    const duration = typeof s3?.duration === 'number' ? s3.duration : 0;

    // hash 缓存命中：S3 跳过合成但带了已有 voiceUrl —— 直接复用，不重传 OSS。
    if (s3VoiceUrl && !audioB64) {
      line.voiceUrl = s3VoiceUrl;
      line.duration = duration;
      results.push({ lineId: line.id, voiceUrl: s3VoiceUrl, duration, skipped, error: s3Error });
      continue;
    }

    // S3 失败/跳过且无音频：不清空既有 voiceUrl（spec §5.5 累积语义，与 /generate merge 同款）。
    if (!audioB64 || skipped) {
      results.push({
        lineId: line.id, voiceUrl: line.voiceUrl, duration: line.duration,
        skipped, error: s3Error,
      });
      continue;
    }

    // decode base64 → 嗅探格式 → 转存 OSS → 拿 URL 回写
    try {
      const buf = Buffer.from(audioB64, 'base64');
      const { ext, mime } = sniffAudioType(buf);
      // 对象键沿用 tts-provider 的 narration 前缀（pms/wenlv/narration/），加 npcId-lineId-时间戳
      // 防重生成撞键产生孤儿对象（与 tts-provider buildNarrationObjectKey 同前缀）。
      const objectKey = `pms/wenlv/narration/${id}-${line.id}-${Date.now()}.${ext}`;
      const url = await uploadToOSS(buf, objectKey, mime);
      line.voiceUrl = url;
      line.duration = duration;
      results.push({ lineId: line.id, voiceUrl: url, duration, skipped, error: s3Error });
    } catch (e: any) {
      // OSS 转存失败：不清空既有 voiceUrl，只 log + 标 error，整批仍 200（与 S2 入队 best-effort 同款）。
      console.error('[wenlv /voice] OSS 转存失败', id, line.id, e);
      results.push({
        lineId: line.id, voiceUrl: line.voiceUrl, duration: line.duration,
        skipped, error: `OSS 转存失败: ${String(e?.message ?? e)}`,
      });
    }
  }

  // === 回写该 NPC 行的 lines JSONB（单条 UPDATE，原子；spec §5.5 不跨 stage 大事务） ===
  await db.update(pmsBuiWenlvNpcs).set({
    lines: currentLines,
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvNpcs.id, id));

  return c.json({ success: true, data: { npcId: id, lineId: lineFilter || null, lines: results } });
});

// ===== 子资源：triggers（实体触发器：qr/beacon/ar）=====
// P1-B 创作端编排画布第一版：表单编辑触发器，不做拖拽画布。
// type=qr 绑定场景：sceneId（0079 规范图，优先）或旧 nodeId（过渡）；type=beacon 需 beaconUuid/major/minor；type=ar 需 arAssetUrl。

route.get('/products/:id/triggers', async (c) => {
  const rows = await db.select().from(pmsBuiWenlvTriggers)
    .where(eq(pmsBuiWenlvTriggers.productId, c.req.param('id')))
    .orderBy(desc(pmsBuiWenlvTriggers.createdAt));
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/triggers', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  const type = body.type;
  if (!['qr', 'beacon', 'ar'].includes(type)) {
    return c.json({ success: false, error: 'type 必须为 qr/beacon/ar' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvTriggers).where(eq(pmsBuiWenlvTriggers.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  const [row] = await db.insert(pmsBuiWenlvTriggers).values({
    id, productId, type,
    nodeId: body.nodeId ?? null,
    sceneId: body.sceneId ?? null,
    collectibleId: body.collectibleId ?? null,
    beaconUuid: body.beaconUuid ?? null,
    beaconMajor: body.beaconMajor ?? null,
    beaconMinor: body.beaconMinor ?? null,
    arAssetUrl: body.arAssetUrl ?? null,
    arDialogue: body.arDialogue ?? null,
    triggerCondition: body.triggerCondition ?? null,
    unlockContent: body.unlockContent ?? null,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/triggers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const allow = ['type', 'nodeId', 'sceneId', 'collectibleId', 'beaconUuid', 'beaconMajor', 'beaconMinor', 'arAssetUrl', 'arDialogue', 'triggerCondition', 'unlockContent'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  const [row] = await db.update(pmsBuiWenlvTriggers).set(patch).where(eq(pmsBuiWenlvTriggers.id, id)).returning();
  if (!row) return c.json({ success: false, error: '触发器不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/triggers/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.delete(pmsBuiWenlvTriggers).where(eq(pmsBuiWenlvTriggers.id, id)).returning();
  if (!row) return c.json({ success: false, error: '触发器不存在' }, 404);
  return c.json({ success: true, data: row });
});

// ===== 子资源：reward_tiers（集章档位）=====
// condition 为 jsonb 任意对象，CRUD 层不做白名单——无条件档位 draft 可存（condition null 缺省），
// publish 时由 validateWenlvIntegrity 门禁强制定义达成条件（集章档位必须可判定）。勿在此加 zod 白名单。

route.get('/products/:id/tiers', async (c) => {
  const productId = c.req.param('id');
  const rows = await db.select().from(pmsBuiWenlvRewardTiers)
    .where(eq(pmsBuiWenlvRewardTiers.productId, productId)).orderBy(pmsBuiWenlvRewardTiers.order);
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/tiers', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ success: false, error: '档位名称不能为空' }, 400);
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  // 缺省 order = 当前产品最大 order + 1
  const last = await db.select({ m: pmsBuiWenlvRewardTiers.order }).from(pmsBuiWenlvRewardTiers)
    .where(eq(pmsBuiWenlvRewardTiers.productId, productId)).orderBy(desc(pmsBuiWenlvRewardTiers.order));
  const order = body.order != null ? body.order : (last.length ? (last[0].m || 0) + 1 : 1);
  const [row] = await db.insert(pmsBuiWenlvRewardTiers).values({
    id, productId,
    name: body.name, description: body.description ?? null,
    order, condition: body.condition ?? null, rewardId: body.rewardId ?? null, icon: body.icon ?? null,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/tiers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const allow = ['name', 'description', 'order', 'condition', 'rewardId', 'icon'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  patch.updatedAt = new Date();
  const [row] = await db.update(pmsBuiWenlvRewardTiers).set(patch).where(eq(pmsBuiWenlvRewardTiers.id, id)).returning();
  if (!row) return c.json({ success: false, error: '档位不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/tiers/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.id, id)).returning();
  if (!row) return c.json({ success: false, error: '档位不存在' }, 404);
  // 解绑在**确认删除成功之后**（理由与失败可见性见 `unbindAssetsOf` 的注释）
  try {
    await unbindAssetsOf('tier', id);
  } catch (e) {
    console.error('[wenlv] 删档位后解绑素材失败', id, e);
    return c.json({ success: false, error: '档位已删除，但其素材解绑失败，请报运维处理' }, 500);
  }
  return c.json({ success: true, data: row });
});

// ===== 子资源：rewards =====

route.get('/products/:id/rewards', async (c) => {
  const rows = await db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, c.req.param('id')));
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/rewards', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  if (!body.name) return c.json({ success: false, error: '奖励名称不能为空' }, 400);
  const id = typeof body.id === 'string' && body.id ? body.id : randomUUID();
  const [exist] = await db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  const [row] = await db.insert(pmsBuiWenlvRewards).values({
    id, productId, name: body.name, type: body.type || 'coupon',
    merchantId: body.merchantId ?? null, storeId: body.storeId ?? null,
    value: body.value != null ? String(body.value) : null, description: body.description ?? null,
    // 奖励配图（S3 素材生成回写列，见 services/wenlv/asset-gen/writeback.ts 的 `case 'reward'`）。
    // 「应用精修」删光重建时由前端 refine-mapping.mapReward 回填后随 body 送来；本端点没有 zod
    // schema（直接读 body.*），漏了这一行 = 用户花钱生成的配图被静默清空，且**没有任何闸会报错**。
    image: body.image ?? null,
    // 文创商品字段（Task 4.1）
    stockLimit: body.stockLimit != null ? Number(body.stockLimit) : null,
    merchandiseSku: body.merchandiseSku ?? null,
    pickupEnabled: body.pickupEnabled === true,
    deliveryEnabled: body.deliveryEnabled === true,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/rewards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const allow = ['name', 'type', 'merchantId', 'storeId', 'value', 'description', 'image', 'stockLimit', 'merchandiseSku', 'pickupEnabled', 'deliveryEnabled'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  if (patch.value != null) patch.value = String(patch.value);
  if (patch.stockLimit != null) patch.stockLimit = Number(patch.stockLimit);
  const [row] = await db.update(pmsBuiWenlvRewards).set(patch).where(eq(pmsBuiWenlvRewards.id, id)).returning();
  if (!row) return c.json({ success: false, error: '奖励不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/rewards/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, id)).returning();
  if (!row) return c.json({ success: false, error: '奖励不存在' }, 404);
  // 解绑在**确认删除成功之后**（理由与失败可见性见 `unbindAssetsOf` 的注释）
  try {
    await unbindAssetsOf('reward', id);
  } catch (e) {
    console.error('[wenlv] 删奖励后解绑素材失败', id, e);
    return c.json({ success: false, error: '奖励已删除，但其素材解绑失败，请报运维处理' }, 500);
  }
  return c.json({ success: true, data: row });
});

// POST /products/:id/rewards/generate — 批量 AI 生成奖励（异步 reward_batch 任务）
route.post('/products/:id/rewards/generate', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const taskId = await batchGenerateRewards(productId);
  return c.json({ success: true, data: { taskId, status: 'pending' } });
});

// ===== 领取台账（claims）查询 / 员工核销 =====
// 领取发生在 C 端 mini redeem（生成核销码）；admin 侧负责台账查询与到店核销（by-code/状态置 redeemed）。

// GET /products/:id/claims?status= → 某产品领取台账（claimedAt 倒序，可选 status 过滤）
route.get('/products/:id/claims', async (c) => {
  const productId = c.req.param('id');
  const status = c.req.query('status');
  const conds = [eq(pmsBuiWenlvClaims.productId, productId)];
  if (status) conds.push(eq(pmsBuiWenlvClaims.status, status));
  const rows = await db.select().from(pmsBuiWenlvClaims).where(and(...conds)).orderBy(desc(pmsBuiWenlvClaims.claimedAt));
  return c.json({ success: true, data: rows });
});

// GET /claims/by-code/:code → 按唯一核销码查台账（不存在 404）
route.get('/claims/by-code/:code', async (c) => {
  const code = c.req.param('code');
  const [row] = await db.select().from(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.code, code)).limit(1);
  if (!row) return c.json({ success: false, error: '核销码不存在' }, 404);
  return c.json({ success: true, data: row });
});

// POST /claims/:id/redeem {by} → 到店核销（仅 claimed 可核销；已核销/不存在 409 幂等防重）
route.post('/claims/:id/redeem', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const [row] = await db.update(pmsBuiWenlvClaims)
    .set({ status: 'redeemed', redeemedAt: new Date(), redeemedBy: body.by ?? null, updatedAt: new Date() })
    .where(and(eq(pmsBuiWenlvClaims.id, id), eq(pmsBuiWenlvClaims.status, 'claimed')))
    .returning();
  if (!row) return c.json({ success: false, error: '核销码不存在或已核销' }, 409);
  return c.json({ success: true, data: row });
});

// ===== 员工协助（线下补印/补打卡/查进度）=====

// GET /products/:id/progresses?query= → 玩家进度列表（query 命中 miniUserId；limit 50 按 updatedAt 倒序）
route.get('/products/:id/progresses', async (c) => {
  const productId = c.req.param('id');
  const query = c.req.query('query') || '';
  const conds = [eq(pmsBuiWenlvProgress.productId, productId)];
  if (query) conds.push(eq(pmsBuiWenlvProgress.miniUserId, query));
  const rows = await db.select().from(pmsBuiWenlvProgress)
    .where(and(...conds)).orderBy(desc(pmsBuiWenlvProgress.updatedAt)).limit(50);
  return c.json({ success: true, data: rows });
});

// GET /products/:id/free-trial-stats → 免费试玩汇总（人数 / 总次数 / 完成数）
//
// 为什么要有它：上面的 `/progresses` 是**明细**且 `limit 50`，客户端数不出总数。
// 汇总必须在**库侧**做（COUNT/SUM），不能靠客户端把明细加起来。
//
// 🔴 三个数各自的语义（别混）：
//   players     = 有 progress 行的**人数**（有行即「试玩过」）
//   totalVisits = `visit_count` 之和（每次「开始/继续游玩」记一次；**回看不计**）
//   completed   = 通关人数
route.get('/products/:id/free-trial-stats', async (c) => {
  const productId = c.req.param('id');
  const [row] = await db.select({
    players: count(pmsBuiWenlvProgress.id),
    totalVisits: sum(pmsBuiWenlvProgress.visitCount),
    completed: count(sql`CASE WHEN ${pmsBuiWenlvProgress.status} = 'completed' THEN 1 END`),
  }).from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, productId));
  return c.json({
    success: true,
    data: {
      players: Number(row?.players ?? 0),
      // ⚠️ SUM 在**没有行**时返回 null（不是 0）；且 PG 的 SUM(integer) 返回 **bigint**，
      //    drizzle 会给**字符串**。裸用会得到 `"8"` 甚至 `null` ⇒ 前端显示空白。
      //    故必须 `Number(x ?? 0)` **两层兜底**：只写 `?? 0` 在有行时留一个字符串，
      //    只写 `Number()` 在无行时得到 NaN。缺一条就是一个只在特定数据下才现形的 bug。
      totalVisits: Number(row?.totalVisits ?? 0),
      completed: Number(row?.completed ?? 0),
    },
  });
});

/** 一键模拟：把剧本当图跑最小不动点，算「哪些节点永远点不开、为什么」。
 *  **只读** —— 不建 progress、不写 events。它是分析工具，不是代玩家玩。
 *
 *  为什么需要：publish 闸的 `validateWenlvIntegrity` 只查「引用了但没有任何节点会写它」，
 *  问不到「那个会写的节点自己可不可达」——互相依赖的环（A 要 B 完成、B 要 A 完成）
 *  能让静态闸全绿而玩家一步走不动。本端点补的就是这一段。 */
route.post('/products/:id/simulate', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;

  // 0079：nodes/endings 由规范图投影（scenes→nodes，type='ending' 场景→endings，nodeId=scene.id）；
  // reward_tiers 是不挂章节的独立实体表，仍按 productId 直查（结局经 rewardId 与之关联）。
  const runtime = await loadRuntimeGraph(productId);
  const tiers = await db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, productId));

  const result = simulateWenlv({ nodes: runtime.nodes, endings: runtime.endings, tiers });
  return c.json({ success: true, data: result });
});

// POST /products/:id/assist-grant {progressId, collectibleIds[], by?} → 员工线下补印（把指定线索置 collected）
// 越权防护：progress 与 collectible 均须归属该产品；含不存在/跨产品线索整体 400（部分写入不落）。
// 原子性：进度「读→组装 next→update 落 state」与「补印流水 insert events」必须同一事务提交，
// 否则会出现 state 已落而 events 抛错（无流水审计漂移）或两请求交错互相覆盖 collected（丢章）。
// 不做行锁的残余读-写竞态按 spec 接受（见 S1 §6），本层只保证两条写语句的原子一致。
route.post('/products/:id/assist-grant', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  const progressId = typeof body.progressId === 'string' ? body.progressId : '';
  const collectibleIds: string[] = Array.isArray(body.collectibleIds)
    ? body.collectibleIds.filter((x: unknown): x is string => typeof x === 'string') : [];
  if (!progressId || collectibleIds.length === 0) return c.json({ success: false, error: '参数错误' }, 400);
  // 只读越权预校验：progress 归属该产品（否则 404）；线索均归属该产品（否则 400，部分写入不落）
  const [progress] = await db.select().from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.id, progressId), eq(pmsBuiWenlvProgress.productId, productId))).limit(1);
  if (!progress) return c.json({ success: false, error: '进度不存在或不属于该产品' }, 404);
  const cols = await db.select({ id: pmsBuiWenlvCollectibles.id }).from(pmsBuiWenlvCollectibles)
    .where(and(inArray(pmsBuiWenlvCollectibles.id, collectibleIds), eq(pmsBuiWenlvCollectibles.productId, productId)));
  const found = new Set(cols.map((x) => x.id));
  for (const cid of collectibleIds) {
    if (!found.has(cid)) return c.json({ success: false, error: `线索 ${cid} 不存在或不属于该产品` }, 400);
  }
  // 事务内重读进度（避免事务外快照更旧）、组装 next、update 落 state 并 insert 补印流水，整体提交/回滚
  const next = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(pmsBuiWenlvProgress)
      .where(and(eq(pmsBuiWenlvProgress.id, progressId), eq(pmsBuiWenlvProgress.productId, productId))).limit(1);
    if (!fresh) return null;
    const st = (fresh.state ?? {}) as WenlvState;
    const merged: WenlvState = {
      visited: { ...(st.visited || {}) },
      collected: { ...(st.collected || {}) },
      completed: { ...(st.completed || {}) },
    };
    for (const cid of collectibleIds) merged.collected[cid] = true;
    await tx.update(pmsBuiWenlvProgress).set({ state: merged, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvProgress.id, fresh.id));
    // 补印流水留痕（nodeId null：非点位触发的运营侧人工补章）
    await tx.insert(pmsBuiWenlvEvents).values({
      id: randomUUID(), productId, miniUserId: fresh.miniUserId, eventType: 'assist',
      nodeId: null, payload: { by: body.by ?? null, collectibleIds },
    });
    return merged;
  });
  if (!next) return c.json({ success: false, error: '进度不存在或不属于该产品' }, 404);
  return c.json({ success: true, data: { state: next } });
});

// ── 游客端现场问题上报（块 E）────────────────────────────────────────────────
// 读端点两条（summary / 明细分页）+ 写端点一条（PATCH 处理闭环，批 7 Task 24），
// 供创作台「现场问题」页使用。游客写侧在 routes/mini/wenlv.ts。
// 明细返回形状对齐本域列表惯例并补分页：`{ success, data: { list, total, page, pageSize } }`。

// 上报处理状态取值域（0082 追加段 handle_status 列）。GET 过滤与 PATCH 写入共用同一份，
// 两处各写一份字面量会在枚举扩容时静默分叉。
const REPORT_HANDLE_STATUSES = ['new', 'processing', 'resolved'] as const;

// GET /reports/summary → 按剧本×类别归并（E8）。**注册在 /reports 之前**：
// 本任务实测 `/reports`（2 段）**不会**匹配 `/reports/summary`（3 段）—— Hono 按段匹配，
// 顺序在本例无可观测差异（见测试文件说明），此处仍保持 summary 在前，是零成本的保险。
route.get('/reports/summary', async (c) => {
  // ⚠️ **永远全表**，不带任何 where。请勿把本端点当「按产品查询」用：
  // 调用方（创作台）靠返回的 productId 自行取需要的行。
  const rows = await db.select({
    productId: pmsBuiWenlvClientReports.productId,
    category: pmsBuiWenlvClientReports.category,
    createdAt: pmsBuiWenlvClientReports.createdAt,
  }).from(pmsBuiWenlvClientReports);
  if (rows.length === 0) return c.json({ success: true, data: { list: [], total: 0 } });

  const list = summarizeReports(rows).sort((a, b) => b.total - a.total);   // 问题最多的排最前
  // 补产品名 + 场地名（汇总页同样要能行动：光有 id 不知道该找谁、该去哪个场地）。
  // 与 GET /reports 用同一套两跳 join，避免两个端点对同一份数据给出不同的名字。
  // ⚠️ `venueName` 是**创作台汇总表的「场地」列**的数据来源 —— 少了它那一列只能恒空，
  //    而页面按计划是要渲染它的（见块 E 计划 Task 7 Step 4）。
  const pids = list.map((x) => x.productId);
  const prods = await db.select({
    id: pmsBuiWenlvProducts.id,
    name: pmsBuiWenlvProducts.name,
    venueId: pmsBuiWenlvProducts.venueId,
  }).from(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, pids));
  const nameMap = new Map(prods.map((p) => [p.id, p.name]));
  const venueIds = [...new Set(prods.map((p) => p.venueId).filter((v): v is string => !!v))];
  const venues = venueIds.length
    ? await db.select({ id: pmsBuiWenlvVenues.id, name: pmsBuiWenlvVenues.name }).from(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, venueIds))
    : [];
  const vMap = new Map(venues.map((v) => [v.id, v.name]));
  // 未归属场地的产品 → 显式 null（不是缺键）：契约要明确，别让消费端 `?? 默认值` 出差别。
  const vByProduct = new Map(prods.map((p) => [p.id, p.venueId ? (vMap.get(p.venueId) ?? null) : null]));
  return c.json({
    success: true,
    data: {
      list: list.map((x) => ({
        ...x,
        productName: nameMap.get(x.productId) ?? null,
        venueName: vByProduct.get(x.productId) ?? null,
      })),
      total: list.length,
    },
  });
});

// GET /reports?productId=&category=&status=&page=&pageSize= → 上报明细分页（按 createdAt 倒序）。
// 分页（批 7 Task 24）：默认 pageSize 50、上限 200（旧默认 200 全量加载在数据涨上来后会撑爆页面）。
// total 是**过滤后的总条数**（不是本页条数）——分页条要靠它算页数；旧消费方只读 list/total，
// total 口径从「本页条数」改为「过滤总数」在 page=1 且 total≤pageSize 时数值相同，不破旧契约。
route.get('/reports', async (c) => {
  const productId = c.req.query('productId');
  const category = c.req.query('category');
  const status = c.req.query('status');
  const pageRaw = Math.trunc(Number(c.req.query('page')));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const sizeRaw = Math.trunc(Number(c.req.query('pageSize')));
  const pageSize = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(200, sizeRaw) : 50;

  if (status !== undefined && !(REPORT_HANDLE_STATUSES as readonly string[]).includes(status)) {
    return c.json({ success: false, error: `status 仅支持 ${REPORT_HANDLE_STATUSES.join('/')}` }, 400);
  }

  // 不带 productId 时**不加 productId where**（= 全表分页）：这条路径给运营看「最近所有上报」。
  // ⚠️ 因此本地/生产库里的历史残留都会出现在结果里 —— 测试必须自带 productId 收敛。
  const conds = [];
  if (productId) conds.push(eq(pmsBuiWenlvClientReports.productId, productId));
  if (category) conds.push(eq(pmsBuiWenlvClientReports.category, category));
  if (status) conds.push(eq(pmsBuiWenlvClientReports.handleStatus, status));
  const where = conds.length ? and(...conds) : undefined;

  const [cnt] = await db.select({ n: count() }).from(pmsBuiWenlvClientReports).where(where);
  const total = cnt?.n ?? 0;
  const rows = total === 0 ? [] : await db.select().from(pmsBuiWenlvClientReports)
    .where(where).orderBy(desc(pmsBuiWenlvClientReports.createdAt))
    .limit(pageSize).offset((page - 1) * pageSize);
  if (rows.length === 0) return c.json({ success: true, data: { list: [], total, page, pageSize } });

  // 联产品名 + 场地名（上报页要显示「哪个场地哪个剧本」，光有 id 没法行动）
  const pids = [...new Set(rows.map((r) => r.productId))];
  const prods = await db.select({ id: pmsBuiWenlvProducts.id, name: pmsBuiWenlvProducts.name, venueId: pmsBuiWenlvProducts.venueId })
    .from(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, pids));
  const nameMap = new Map(prods.map((p) => [p.id, p.name]));
  const venueIds = [...new Set(prods.map((p) => p.venueId).filter((v): v is string => !!v))];
  const venues = venueIds.length
    ? await db.select({ id: pmsBuiWenlvVenues.id, name: pmsBuiWenlvVenues.name }).from(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, venueIds))
    : [];
  const vMap = new Map(venues.map((v) => [v.id, v.name]));
  // 未归属场地的产品 → venueName 显式 null（不是缺键）：契约要明确，避免将来 `?? 默认值` 出差别。
  const vByProduct = new Map(prods.map((p) => [p.id, p.venueId ? (vMap.get(p.venueId) ?? null) : null]));

  const list = rows.map((r) => ({
    ...r,
    productName: nameMap.get(r.productId) ?? null,
    venueName: vByProduct.get(r.productId) ?? null,
  }));
  return c.json({ success: true, data: { list, total, page, pageSize } });
});

// PATCH /reports/:id — 现场问题处理闭环（批 7 Task 24，0082 追加段四列）。
// body: { handleStatus, note?, handledBy }
//   handleStatus 仅允许 new|processing|resolved（退回 new = 撤销误标，合法操作）。
//   handledBy = 平台用户 id（BFF 从已验签 JWT 注入覆盖客户端值，仅审计归属，同
//               director handle 的纪律：服务端只留痕不鉴权，但**不放行无处理人的留痕**）。
//   note 缺省 ⇒ 覆盖为 null（与 Task 23 handle 的「后值胜完整语义」同款：重复标记可清空备注）。
// handled_at 每次 PATCH 都刷新为当前时间 —— 它是「最近一次处理动作的时间」，不是「首次解决时间」。
route.patch('/reports/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const handleStatus = typeof body.handleStatus === 'string' ? body.handleStatus.trim() : '';
  if (!(REPORT_HANDLE_STATUSES as readonly string[]).includes(handleStatus)) {
    return c.json({ success: false, error: `handleStatus 仅支持 ${REPORT_HANDLE_STATUSES.join('/')}` }, 400);
  }
  const handledBy = typeof body.handledBy === 'string' ? body.handledBy.trim().slice(0, 60) : '';
  if (!handledBy) return c.json({ success: false, error: '缺少 handledBy' }, 400);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

  const [row] = await db.update(pmsBuiWenlvClientReports).set({
    handleStatus, handleNote: note, handledBy, handledAt: new Date(),
  }).where(eq(pmsBuiWenlvClientReports.id, id)).returning();
  if (!row) return c.json({ success: false, error: '上报不存在' }, 404);
  return c.json({ success: true, data: row });
});

// ===== P2.2 PC 创作台测试对话 =====
// POST /api/admin/wenlv/npcs/:id/test-dialogue — 创作者在 NPC 编辑器内直接发起测试对话，
// 验证人格一致性 / 目标达成 / 跑偏检测。不依赖具体章节节点 —— 用当前 NPC 人格 + 临时输入的章节目标。
// 复用 mini 端同一 LLM 客户端（streamNpcReply），但不入库、不鉴 mini JWT。
route.post('/npcs/:id/test-dialogue', async (c) => {
  const id = c.req.param('id');
  const { goalDescription, history } = await c.req.json();

  const [npc] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
  if (!npc) return c.json({ success: false, error: 'NPC 不存在' }, 404);

  // 构造临时章节目标（仅用于本次测试，不入库）
  const tempGoal: WenlvChapterGoal = {
    type: 'puzzle',
    description: goalDescription || '测试：与 NPC 自由对话',
    answerCriteria: [],
    minTurns: 1,
  };

  // 复用 llm-client 的 streamNpcReply（与 mini 端同源，保证测试即生产）
  const stream = streamNpcReply({
    messages: history || [],
    persona: npc.persona || { personality: [], tone: '', catchphrases: [], backstory: '', clues: [], taboos: [] },
    goal: tempGoal,
    npcName: npc.name,
    npcRole: npc.role || '',
    npcMemory: npc.memory || undefined,
  });

  return new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        for await (const chunk of stream) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } },
  );
});

// ===== 场地档案 / 合作商户 / 实体道具 admin CRUD（Task 8，spec §4/§8）=====
// 三张表迁移 0075 已建（schema/wenlv.ts L1283-L1321）。
//   · 场地能力档案：1:1 venue，venueId 唯一索引 → PUT 走 onConflictDoUpdate（upsert）
//   · 合作商户：暗号接头的回执码与三句培训卡载体，按 venueId 挂
//   · 实体道具：暗码系统生成即登记，按 productId 挂
// PATCH 均走手写白名单（与 endings/triggers 同款），结构字段（venueId/productId/id）不放行。

// --- 场地档案（1:1 venue profile）---

route.put('/venues/:venueId/profile', async (c) => {
  const venueId = c.req.param('venueId');
  const body = await c.req.json().catch(() => ({}));
  const id = `vp_${randomUUID()}`;
  // upsert：venueId 唯一索引冲突时更新内容字段（id/venueId 不进 set，保留原行主键）
  const [row] = await db.insert(pmsBuiWenlvVenueProfiles).values({
    id, venueId,
    supportActions: body.supportActions ?? {},
    deployableAtoms: body.deployableAtoms ?? [],
    routeRadiusM: typeof body.routeRadiusM === 'number' ? body.routeRadiusM : null,
    timeWindows: body.timeWindows ?? [],
    notes: body.notes ?? null,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvVenueProfiles.venueId,
    set: {
      supportActions: body.supportActions ?? {},
      deployableAtoms: body.deployableAtoms ?? [],
      routeRadiusM: typeof body.routeRadiusM === 'number' ? body.routeRadiusM : null,
      timeWindows: body.timeWindows ?? [],
      notes: body.notes ?? null,
      updatedAt: new Date(),
    },
  }).returning();
  return c.json({ success: true, data: row });
});

route.get('/venues/:venueId/profile', async (c) => {
  const venueId = c.req.param('venueId');
  const [row] = await db.select().from(pmsBuiWenlvVenueProfiles)
    .where(eq(pmsBuiWenlvVenueProfiles.venueId, venueId)).limit(1);
  if (!row) return c.json({ success: false, error: '场地档案不存在' }, 404);
  return c.json({ success: true, data: row });
});

// --- 合作商户 ---

route.get('/venues/:venueId/merchants', async (c) => {
  const venueId = c.req.param('venueId');
  // 可选 ?scriptRoomId=：只看某剧本房挂接的商户（0079 商户反向关联剧本房）。
  const roomId = c.req.query('scriptRoomId');
  const conds = [eq(pmsBuiWenlvMerchantPartners.venueId, venueId)];
  if (roomId) conds.push(eq(pmsBuiWenlvMerchantPartners.scriptRoomId, roomId));
  // left join 商户主数据带出 masterName/masterStatus：老行 merchant_id 为空，这两列为 null。
  const rows = await db
    .select({
      id: pmsBuiWenlvMerchantPartners.id,
      venueId: pmsBuiWenlvMerchantPartners.venueId,
      name: pmsBuiWenlvMerchantPartners.name,
      role: pmsBuiWenlvMerchantPartners.role,
      cipherDish: pmsBuiWenlvMerchantPartners.cipherDish,
      replyCode: pmsBuiWenlvMerchantPartners.replyCode,
      staffCard: pmsBuiWenlvMerchantPartners.staffCard,
      timeWindows: pmsBuiWenlvMerchantPartners.timeWindows,
      status: pmsBuiWenlvMerchantPartners.status,
      platformMerchantId: pmsBuiWenlvMerchantPartners.platformMerchantId,
      scriptRoomId: pmsBuiWenlvMerchantPartners.scriptRoomId,
      merchantId: pmsBuiWenlvMerchantPartners.merchantId,
      createdAt: pmsBuiWenlvMerchantPartners.createdAt,
      updatedAt: pmsBuiWenlvMerchantPartners.updatedAt,
      masterName: pmsBuiWenlvMerchants.name,
      masterStatus: pmsBuiWenlvMerchants.status,
    })
    .from(pmsBuiWenlvMerchantPartners)
    .leftJoin(pmsBuiWenlvMerchants, eq(pmsBuiWenlvMerchantPartners.merchantId, pmsBuiWenlvMerchants.id))
    .where(and(...conds))
    .orderBy(desc(pmsBuiWenlvMerchantPartners.createdAt));
  return c.json({ success: true, data: rows });
});

// 剧本房维度：编辑器按房取已挂接商户（spec：merchant_partners 补 script_room_id）。
route.get('/script-rooms/:id/merchants', async (c) => {
  const rows = await db.select().from(pmsBuiWenlvMerchantPartners)
    .where(eq(pmsBuiWenlvMerchantPartners.scriptRoomId, c.req.param('id')))
    .orderBy(desc(pmsBuiWenlvMerchantPartners.createdAt));
  return c.json({ success: true, data: rows });
});

route.post('/venues/:venueId/merchants', async (c) => {
  const venueId = c.req.param('venueId');
  // 场地必须存在：本表 venue_id 无外键，缺这道校验会静默落一条指向不存在场地的行
  // 并回 200（与 beacons POST 同款理由，见 L1015-L1018 注释）。
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const body = await c.req.json().catch(() => ({}));
  // merchantId 引用文旅商户主数据（0081）；传了则校验主数据存在，name 可由主数据兜底。
  let merchantId: string | null = null;
  let masterName: string | null = null;
  if (body.merchantId != null) {
    if (typeof body.merchantId !== 'string' || !body.merchantId.trim()) {
      return c.json({ success: false, error: 'merchantId 必须为非空字符串' }, 400);
    }
    const [master] = await db.select().from(pmsBuiWenlvMerchants)
      .where(eq(pmsBuiWenlvMerchants.id, body.merchantId)).limit(1);
    if (!master) return c.json({ success: false, error: '商户主数据不存在' }, 400);
    merchantId = body.merchantId;
    masterName = master.name;
  }
  // name：手填优先；未传则用主数据 name 兜底；都没有才报错（保证落库 name 非空）。
  const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : (masterName ?? '');
  if (!name) return c.json({ success: false, error: '商户名称不可为空' }, 400);
  // 去重：同一 (venueId, merchantId) 只允许一行；重复请求幂等返回既有行（不 409，体验更好）。
  // 仅 merchantId 非空时查重——手填 name 老路径（merchantId=null）不查重，允许多个同名手填商户。
  if (merchantId) {
    const [existByRef] = await db.select().from(pmsBuiWenlvMerchantPartners)
      .where(and(eq(pmsBuiWenlvMerchantPartners.venueId, venueId), eq(pmsBuiWenlvMerchantPartners.merchantId, merchantId)))
      .limit(1);
    if (existByRef) return c.json({ success: true, data: existByRef });
  }
  const id = typeof body.id === 'string' && body.id ? body.id : `mp_${randomUUID()}`;
  const [exist] = await db.select().from(pmsBuiWenlvMerchantPartners)
    .where(eq(pmsBuiWenlvMerchantPartners.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入
  // 可选反向绑定剧本房：非空时房必须存在（防静默挂错房）；null/缺省 = 场地级商户。
  let scriptRoomId: string | null = null;
  if (body.scriptRoomId != null) {
    if (typeof body.scriptRoomId !== 'string') return c.json({ success: false, error: 'scriptRoomId 必须为字符串' }, 400);
    const room = await getScriptRoom(body.scriptRoomId);
    if (!room) return c.json({ success: false, error: '绑定的剧本房不存在' }, 400);
    scriptRoomId = body.scriptRoomId;
  }
  const [row] = await db.insert(pmsBuiWenlvMerchantPartners).values({
    id, venueId,
    name,
    role: body.role ?? 'restaurant',
    cipherDish: body.cipherDish ?? null,
    replyCode: body.replyCode ?? null,
    staffCard: body.staffCard ?? null,
    timeWindows: body.timeWindows ?? [],
    status: body.status ?? 'active',
    scriptRoomId,
    merchantId,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/merchants/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  // 白名单：只放行内容字段，结构字段（venueId/id）不放行；scriptRoomId 可绑定/置 null 解绑；
  // merchantId 可绑定主数据/置 null 解绑（保留历史行能力）。
  const allow = ['name', 'role', 'cipherDish', 'replyCode', 'staffCard', 'timeWindows', 'status', 'scriptRoomId', 'merchantId'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  // 绑定到具体剧本房时房必须存在；显式 null = 解绑回场地级商户，放行。
  if (patch.scriptRoomId != null) {
    const room = await getScriptRoom(String(patch.scriptRoomId));
    if (!room) return c.json({ success: false, error: '绑定的剧本房不存在' }, 400);
  }
  // merchantId：string 需校验主数据存在；null = 解绑主数据，放行。
  if (patch.merchantId != null) {
    if (typeof patch.merchantId !== 'string' || !patch.merchantId.trim()) {
      return c.json({ success: false, error: 'merchantId 必须为非空字符串或 null' }, 400);
    }
    const [master] = await db.select().from(pmsBuiWenlvMerchants)
      .where(eq(pmsBuiWenlvMerchants.id, patch.merchantId)).limit(1);
    if (!master) return c.json({ success: false, error: '商户主数据不存在' }, 400);
  }
  const [row] = await db.update(pmsBuiWenlvMerchantPartners)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvMerchantPartners.id, id)).returning();
  if (!row) return c.json({ success: false, error: '商户不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/merchants/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.delete(pmsBuiWenlvMerchantPartners)
    .where(eq(pmsBuiWenlvMerchantPartners.id, id)).returning();
  if (!row) return c.json({ success: false, error: '商户不存在' }, 404);
  return c.json({ success: true, data: row });
});

// --- 商户主数据（0081，/merchants 模块）---
// 概念区分：本组端点操作 pms_bui_wenlv_merchants（主数据：名称/类型/联系人/合作状态），
// 上面那组 /venues/:venueId/merchants 与 PATCH|DELETE /merchants/:id 操作的是场地级
// 合作挂接行（merchant_partners）。主数据 PATCH 不能复用 /merchants/:id —— Hono 同路径
// 同方法先注册先命中（4.12.18 实测），挂后面被 merchant_partners PATCH 吞掉、挂前面又会
// 吞掉场地商户编辑，故另起 /merchant-master/:id（BFF 的前端契约仍是 PATCH /merchants/:id）。
route.get('/merchants', async (c) => {
  const rows = await listMerchantMaster({ q: c.req.query('q'), status: c.req.query('status') });
  return c.json({ success: true, data: rows });
});

route.get('/merchants/:id', async (c) => {
  const detail = await getMerchantDetail(c.req.param('id'));
  if (!detail) return c.json({ success: false, error: '商户不存在' }, 404);
  return c.json({ success: true, data: detail });
});

route.post('/merchants', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ success: false, error: '商户名称不可为空' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : `mm_${randomUUID()}`;
  const [exist] = await db.select().from(pmsBuiWenlvMerchants)
    .where(eq(pmsBuiWenlvMerchants.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入
  const [row] = await db.insert(pmsBuiWenlvMerchants).values({
    id,
    name: body.name.trim(), // 校验已保证非空；trim 防首尾空白入库后搜索端再 trim 一次对不上
    type: body.type ?? null,
    contactName: body.contactName ?? null,
    contactPhone: body.contactPhone ?? null,
    status: body.status ?? 'active',
    note: body.note ?? null,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/merchant-master/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  // 白名单：只放行内容字段，结构字段（id）不放行（同 merchant_partners PATCH 的 allow 模式）
  const allow = ['name', 'type', 'contactName', 'contactPhone', 'status', 'note'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  const [row] = await db.update(pmsBuiWenlvMerchants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvMerchants.id, id)).returning();
  if (!row) return c.json({ success: false, error: '商户不存在' }, 404);
  return c.json({ success: true, data: row });
});

// --- 实体道具 ---

route.get('/products/:id/props', async (c) => {
  const productId = c.req.param('id');
  const rows = await db.select().from(pmsBuiWenlvProps)
    .where(eq(pmsBuiWenlvProps.productId, productId))
    .orderBy(desc(pmsBuiWenlvProps.createdAt));
  return c.json({ success: true, data: rows });
});

route.post('/products/:id/props', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  const body = await c.req.json().catch(() => ({}));
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ success: false, error: '道具名称不可为空' }, 400);
  }
  const id = typeof body.id === 'string' && body.id ? body.id : `prop_${randomUUID()}`;
  const [exist] = await db.select().from(pmsBuiWenlvProps)
    .where(eq(pmsBuiWenlvProps.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist }); // 幂等重入
  const [row] = await db.insert(pmsBuiWenlvProps).values({
    id, productId,
    name: body.name ?? '',
    kind: body.kind ?? 'letter',
    code: body.code ?? null,
    placeNote: body.placeNote ?? null,
    nodeId: body.nodeId ?? null,
  }).returning();
  return c.json({ success: true, data: row });
});

route.patch('/props/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  // 白名单：只放行内容字段，结构字段（productId/id）不放行
  const allow = ['name', 'kind', 'code', 'placeNote', 'nodeId'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) if (k in body) patch[k] = body[k];
  const [row] = await db.update(pmsBuiWenlvProps)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProps.id, id)).returning();
  if (!row) return c.json({ success: false, error: '道具不存在' }, 404);
  return c.json({ success: true, data: row });
});

route.delete('/props/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.delete(pmsBuiWenlvProps)
    .where(eq(pmsBuiWenlvProps.id, id)).returning();
  if (!row) return c.json({ success: false, error: '道具不存在' }, 404);
  return c.json({ success: true, data: row });
});

// --- 暗码批量生成登记 ---
// 为 code 为空的道具批量生成唯一暗码（WENLV-<6位 base32 去易混淆字符>）。
// 登记即返回更新后的 props 列表（供履约清单与布房勾表即时使用）。

/** 暗码生成：base32 大写，去易混淆字符 I/O/0/1（红线）。
 *  字母表 32 字符，6 位 ⇒ 32^6 ≈ 10.74 亿可能值，单产品内冲突概率极低。 */
function generatePropCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let code = 'WENLV-';
  for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

route.post('/products/:id/props/generate-codes', async (c) => {
  const productId = c.req.param('id');
  const product = await getProductOr404(c, productId);
  if (product instanceof Response) return product;
  // 一次取该产品全部道具：候选（code 为空）与已有暗码集在同一份数据里，
  // 冲突重查直接用集合（O(1)）而不走二次 DB 往返——一次 select 同时完成
  // 「找候选」与「取已有暗码集」两件事（与 generatePointCode 的同域先例同款）。
  const props = await db.select().from(pmsBuiWenlvProps)
    .where(eq(pmsBuiWenlvProps.productId, productId));
  const candidates = props.filter((p) => !p.code);
  if (candidates.length === 0) return c.json({ success: true, data: [] });
  // 已有暗码集合（用于冲突重查，含同产品内已登记的暗码）
  const existing = new Set<string>();
  for (const p of props) if (p.code) existing.add(p.code);
  const updated: any[] = [];
  for (const prop of candidates) {
    let code = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      code = generatePropCode();
      if (!existing.has(code)) break;
    }
    // 3 次内找到不冲突的暗码：10.74 亿空间，概率上不可能 3 次全撞
    // 但代码路径必须兜底：若 3 次全撞（极端不幸），报错而非静默写入重复暗码
    if (existing.has(code)) {
      return c.json({ success: false, error: `道具「${prop.name}」暗码生成冲突，请重试` }, 500);
    }
    existing.add(code);
    const [row] = await db.update(pmsBuiWenlvProps)
      .set({ code, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvProps.id, prop.id)).returning();
    if (row) updated.push(row);
  }
  return c.json({ success: true, data: updated });
});

// ===== 导演 v1 值守干预（Task 16，spec §6.2 P1b）=====
// POST /products/:id/director/:progressId/intervene
//   body: { action: 'grant'|'skip'|'message', collectibleId?, nodeId?, text? }
//   grant  = 补发线索（写 progress.state.collected + 同步 player_progress 线索通道）
//   skip   = 强制完成当前节点（复用 applyNodeCompletion，与 /answer、原子完成同一份链路）
//   message= 值守留言（写 director alerts 留痕 + 经 NPC 对话 hint 同通道推送）
route.post('/products/:id/director/:progressId/intervene', async (c) => {
  const productId = c.req.param('id');
  const progressId = c.req.param('progressId');
  const body = await c.req.json().catch(() => ({}));
  const action = body.action;
  if (action !== 'grant' && action !== 'skip' && action !== 'message') {
    return c.json({ success: false, error: 'action 必须是 grant/skip/message' }, 400);
  }

  const [progress] = await db.select().from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.id, progressId), eq(pmsBuiWenlvProgress.productId, productId)))
    .limit(1);
  if (!progress) return c.json({ success: false, error: '游玩进度不存在' }, 404);

  const nowIso = new Date().toISOString();

  if (action === 'grant') {
    const collectibleId = body.collectibleId;
    if (typeof collectibleId !== 'string' || !collectibleId) {
      return c.json({ success: false, error: '缺少 collectibleId' }, 400);
    }
    // 写 state.collected：单条 jsonb_set（与原子完成端点的 jsonb_set 同风格，免读-改-写丢更新）。
    await db.update(pmsBuiWenlvProgress).set({
      state: sql`jsonb_set(COALESCE(state, '{}'::jsonb), ARRAY['collected', ${collectibleId}]::text[], 'true'::jsonb, true)`,
      updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvProgress.id, progressId));
    // NPC 对话 clueIds 判定读的是 player_progress.collectedCollectibles（与节点发奖同一同步函数）。
    await syncPlayerCollectibles(productId, progress.miniUserId, [collectibleId]);
    const alert: DirectorAlert = {
      id: `manual:grant:${collectibleId}:${nowIso}`,
      level: 'info', kind: 'manual',
      message: `值守补发线索：${collectibleId}`, createdAt: nowIso,
    };
    await appendDirectorAlert(productId, progressId, alert);
    return c.json({ success: true, data: { action: 'grant', collectibleId } });
  }

  if (action === 'skip') {
    const nodeId = body.nodeId;
    if (typeof nodeId !== 'string' || !nodeId) {
      return c.json({ success: false, error: '缺少 nodeId' }, 400);
    }
    // 0079：节点 = 非 ending 场景（nodeId = scene.id），边/结局同由运行时规范图投影。
    const room = await loadRuntimeGraph(productId);
    const node = room.nodes.find((n) => n.id === nodeId);
    if (!node) return c.json({ success: false, error: '节点不存在' }, 404);

    // 角色上下文取法与 mini /answer 同款（边条件/结局判定可能引用 role/skill）。
    let charSkillIds: string[] = [];
    if (progress.characterId) {
      const [ch] = await db.select({ skills: pmsBuiWenlvCharacters.skills })
        .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, progress.characterId)).limit(1);
      charSkillIds = ch?.skills ? ch.skills.map((s) => s.id).filter(Boolean) : [];
    }
    // 不原地改写 progress.state（drizzle 行对象可能被后续逻辑引用）。
    // completed 预标记与原子完成端点同款：applyNodeCompletion 本身不生产 completed 键。
    const baseState = progress.state as WenlvState;
    const state: WenlvState = {
      ...baseState,
      completed: { ...(baseState.completed ?? {}), [nodeId]: true },
    };
    const completion = await applyNodeCompletion({
      productId,
      progressId,
      nodeId,
      state,
      miniUserId: progress.miniUserId,
      sessionId: progress.sessionId,
      node: { venuePointId: node.venuePointId, title: node.title, grants: node.grants },
      edges: room.edges,
      endings: room.endings,
      progress: { id: progress.id, status: progress.status, endingId: progress.endingId },
      charOpts: { characterId: progress.characterId, characterSkillIds: charSkillIds },
      eventPayload: { directorSkip: true },
      eventType: 'node_complete',
    });
    // rally 未绑点位节点的发章闸同样适用：值守不能远程强发印章（与 mini 403 同谓词）。
    if (completion.stampError) return c.json({ success: false, error: completion.stampError }, 403);
    const alert: DirectorAlert = {
      id: `manual:skip:${nodeId}:${nowIso}`,
      level: 'info', kind: 'manual',
      message: `值守强制完成节点：${node.title || nodeId}`, createdAt: nowIso,
    };
    await appendDirectorAlert(productId, progressId, alert);
    return c.json({ success: true, data: { action: 'skip', nodeId, state: completion.state, endings: completion.endings } });
  }

  // action === 'message'
  const text = body.text;
  if (typeof text !== 'string' || !text.trim()) {
    return c.json({ success: false, error: '缺少 text' }, 400);
  }
  const alert: DirectorAlert = {
    id: `manual:message:${nowIso}`,
    level: 'info', kind: 'manual', message: text, createdAt: nowIso,
  };
  await appendDirectorAlert(productId, progressId, alert);
  // 推送通道同 hint：追加为该节点 active dialogue 的 NPC 消息；无 active dialogue 时静默不投。
  let delivered = false;
  if (typeof body.nodeId === 'string' && body.nodeId) {
    delivered = await appendNpcMessage({
      productId, miniUserId: progress.miniUserId, nodeId: body.nodeId, text,
    });
  }
  return c.json({ success: true, data: { action: 'message', delivered } });
});

// ===== 值守「标记已处理」闭环（批 7 Task 23，spec 下册 §3，迁移 0082）=====
// POST /products/:id/director/reports/:progressId/handle
//   body: { nodeKey, note?, handledBy }
//   nodeKey   = 报警 id（导演 alerts 元素 id，形如 stall:<nodeId>:<atomId> / static:<key>）
//   handledBy = 平台用户 id（BFF 从已验签 JWT 注入，仅审计归属，同 getCreator 的纪律：
//               头/体里的 id 不做鉴权，只做事后追责留痕）
// 幂等：同 (progressId, nodeKey) 重复 POST ⇒ ON CONFLICT 覆盖 handled_by/handled_at/note（后值胜）。
route.post('/products/:id/director/reports/:progressId/handle', async (c) => {
  const productId = c.req.param('id');
  const progressId = c.req.param('progressId');
  const body = await c.req.json().catch(() => ({}));
  // node_key 列宽 varchar(120)：trim 后判空照旧，再截断到 120（与 handledBy 的 slice(0,60)
  // 同风格）——不截断的话超长 nodeKey 会炸 PG 22001 → 500，而报警 id 由服务端生成、
  // 超长的只可能是异常客户端输入，截断拒爆即可。
  const nodeKey = typeof body.nodeKey === 'string' ? body.nodeKey.trim().slice(0, 120) : '';
  if (!nodeKey) return c.json({ success: false, error: '缺少 nodeKey' }, 400);
  const handledBy = typeof body.handledBy === 'string' ? body.handledBy.trim().slice(0, 60) : '';
  if (!handledBy) return c.json({ success: false, error: '缺少 handledBy' }, 400);
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

  const [progress] = await db.select({ id: pmsBuiWenlvProgress.id }).from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.id, progressId), eq(pmsBuiWenlvProgress.productId, productId)))
    .limit(1);
  if (!progress) return c.json({ success: false, error: '游玩进度不存在' }, 404);

  const [row] = await db.insert(pmsBuiWenlvDirectorAlertHandles).values({
    id: `dh_${randomUUID()}`, productId, progressId, nodeKey, handledBy, note,
  }).onConflictDoUpdate({
    target: [pmsBuiWenlvDirectorAlertHandles.progressId, pmsBuiWenlvDirectorAlertHandles.nodeKey],
    set: { handledBy, handledAt: new Date(), note },
  }).returning();
  return c.json({ success: true, data: row });
});

// GET /products/:id/director?active=1 — 值守看板：在玩队伍（progress + 导演 state 摘要）+ 未处理 alerts。
route.get('/products/:id/director', async (c) => {
  const productId = c.req.param('id');
  const activeOnly = c.req.query('active') === '1';

  const whereList = [eq(pmsBuiWenlvProgress.productId, productId)];
  if (activeOnly) whereList.push(eq(pmsBuiWenlvProgress.status, 'active'));
  const progresses = await db.select({
    id: pmsBuiWenlvProgress.id,
    miniUserId: pmsBuiWenlvProgress.miniUserId,
    sessionId: pmsBuiWenlvProgress.sessionId,
    status: pmsBuiWenlvProgress.status,
    updatedAt: pmsBuiWenlvProgress.updatedAt,
  }).from(pmsBuiWenlvProgress).where(and(...whereList))
    .orderBy(desc(pmsBuiWenlvProgress.updatedAt));

  const dirRows = await db.select().from(pmsBuiWenlvDirectorStates)
    .where(eq(pmsBuiWenlvDirectorStates.productId, productId));
  const byProgress = new Map(dirRows.map((r) => [r.progressId, r]));

  // 已处理闭环合流（0082）：按 (progress_id, node_key=alert.id) 把 handles 表并到每条报警上，
  // 只追加 handled/handledBy/handledAt 三字段，既有字段结构不动。alert.id 即 handles.node_key
  // （stall/static 报警 id 由 computeTick 生成为 `stall:<eventKey>` / `static:<eventKey>`）。
  const handleRows = await db.select().from(pmsBuiWenlvDirectorAlertHandles)
    .where(eq(pmsBuiWenlvDirectorAlertHandles.productId, productId));
  const handleByKey = new Map(handleRows.map((h) => [`${h.progressId}::${h.nodeKey}`, h]));
  const withHandle = (progressId: string, a: DirectorAlert) => {
    const h = handleByKey.get(`${progressId}::${a.id}`);
    return {
      progressId,
      ...a,
      handled: a.handled || !!h,
      handledBy: h?.handledBy ?? null,
      handledAt: h?.handledAt?.toISOString() ?? null,
    };
  };

  const list = progresses.map((p) => {
    const d = byProgress.get(p.id);
    const openAlerts = (d?.alerts ?? []).filter((a) =>
      !a.handled && !handleByKey.has(`${p.id}::${a.id}`));
    return {
      progressId: p.id,
      miniUserId: p.miniUserId,
      sessionId: p.sessionId,
      status: p.status,
      progressUpdatedAt: p.updatedAt,
      directorUpdatedAt: d?.updatedAt ?? null,
      lastActionAt: d?.state?.lastActionAt ?? null,
      lastKey: d?.state?.lastKey ?? null,
      alertCount: openAlerts.length,
    };
  });

  // 跨队伍 alerts 扁平清单（值守页首屏）：已处理的也带回（handled 三字段标态），
  // 前端据此灰化展示「已处理 · 处理人 · 时间」，刷新后已处理态仍在（真落库）。
  const alerts = dirRows.flatMap((d) =>
    (d.alerts ?? []).map((a) => withHandle(d.progressId, a)),
  );

  return c.json({ success: true, data: { list, alerts } });
});

export default route;
