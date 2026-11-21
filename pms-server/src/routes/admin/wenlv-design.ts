// 文旅设计系统 admin API（创作台经 pms-platform 代理调用；内部 token 守卫，同 /api/admin/wenlv）
// 设计模板 / 设计资产 CRUD：平台全局共享（不按商家隔离），styleTag 按风格筛选。
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';
import {
  pmsBuiWenlvDesignTemplates, pmsBuiWenlvDesignAssets,
  pmsBuiWenlvCharacters, pmsBuiWenlvCollectibles,
  pmsBuiWenlvNpcs, pmsBuiWenlvProducts, pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers,
  pmsBuiWenlvScenes, pmsBuiWenlvChapters, pmsBuiWenlvScriptRooms,
} from '../../db/schema/index.js';
import { ASSET_TYPES, type JobAssetType } from '../../services/wenlv/asset-gen/asset-types.js';
import type { WritebackEntity } from '../../services/wenlv/asset-gen/writeback-type.js';

const route = new Hono();

route.use('*', async (c, next) => {
  if (c.req.header('X-Internal-Service-Token') !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: '禁止访问：内部服务认证失败' }, 403);
  }
  return next();
});

const templateSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(100),
  styleTag: z.string().min(1).max(50),
  tokens: z.any().optional().refine((v) => v === undefined || (typeof v === 'object' && v !== null), 'tokens 必须是对象'),
  isBuiltin: z.boolean().optional(),
});

// PATCH 专用：剥离 isBuiltin，禁止通过就地保存绕过「内置不可删」保护
const templateUpdateSchema = templateSchema.omit({ isBuiltin: true }).partial();

// GET /templates?styleTag= → 模板列表
route.get('/templates', async (c) => {
  const styleTag = c.req.query('styleTag');
  const rows = styleTag
    ? await db.select().from(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.styleTag, styleTag)).orderBy(desc(pmsBuiWenlvDesignTemplates.updatedAt))
    : await db.select().from(pmsBuiWenlvDesignTemplates).orderBy(desc(pmsBuiWenlvDesignTemplates.updatedAt));
  return c.json({ success: true, data: { list: rows, total: rows.length } });
});

// POST /templates → 建模板（body 可带固定 id 幂等；缺省 randomUUID）
route.post('/templates', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawId = typeof body.id === 'string' && body.id ? body.id : null;
  if (rawId && rawId.length > 50) return c.json({ success: false, error: 'id 超长（最大 50）' }, 400);
  const id = rawId ?? randomUUID();
  const parsed = templateSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const [exist] = await db.select().from(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  const d = parsed.data;
  const [row] = await db.insert(pmsBuiWenlvDesignTemplates).values({
    id,
    name: d.name, styleTag: d.styleTag,
    tokens: d.tokens ?? {}, isBuiltin: d.isBuiltin ?? false,
  }).returning();
  return c.json({ success: true, data: row });
});

// PATCH /templates/:id → 就地保存（isBuiltin 已被 templateUpdateSchema 剥离，无法改写）
route.patch('/templates/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = templateUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const [row] = await db.update(pmsBuiWenlvDesignTemplates).set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvDesignTemplates.id, id)).returning();
  if (!row) return c.json({ success: false, error: '模板不存在' }, 404);
  return c.json({ success: true, data: row });
});

// DELETE /templates/:id → 删除（isBuiltin 内置模板拒删）
route.delete('/templates/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '模板不存在' }, 404);
  if (exist.isBuiltin) return c.json({ success: false, error: '内置模板不可删除' }, 409);
  await db.delete(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, id));
  return c.json({ success: true });
});

export const assetTypes = ['icon', 'stamp', 'background', 'reward', 'mascot', 'bgm', 'sfx', 'ending', 'cutscene', 'celebrate', 'particle', 'narration', 'npc_portrait', 'npc_voice'] as const;
export const assetSchema = z.object({
  type: z.enum(assetTypes),
  styleTag: z.string().min(1).max(50).optional().nullable(),
  name: z.string().min(1, '名称不能为空').max(100),
  url: z.string().max(500).optional().nullable(),
  meta: z.record(z.string(), z.unknown()).optional(),
  isBuiltin: z.boolean().optional(),
});
// ↑ 关于上面 `assetTypes` 的说明。**故意写在声明下方**：两条 `backfill-*.sql` 与
//   `services/wenlv/asset-gen/asset-types.ts:14` 都按**行号**引用本文件（`:84` / `:79`），
//   在声明上方插注释就会把它们顶偏 —— 注释指着空气正是本仓反复踩的那类坑。
// ⚠️ `assetTypes` 是**接口允许**的类型清单，**不是**「库里有的类型」的全集：调度器的
//   `writeAsset` 直接 insert、**绕过**本枚举，所以库里真存在不在清单中的行（如 `anchor`
//   —— 见 `asset-types.ts` 的 `PUBLIC_POOL_TYPES`，它落公共池、venue_id 为 NULL）。
//   `narration` 于 2026-09-20 补入 —— 此前经本端点建/改一条 narration 资产会被 400 挡下
//   （该 400 是 zod 的原始 issue message，**会**列出全部允许值）。
//   `npc_portrait` 于 2026-09-29 补入（NPC 立绘，spec §5.4 S2 stage）—— 与 `narration` 同理：
//   此前经本端点手工登记一条 NPC 立绘素材会被 400 挡下。**注意**：本清单只是「接口允许」，
//   生成侧的类型映射表（`asset-types.ts` 的 `ASSET_TYPES`）与回写目标 `npcs.portrait_url` 的接线
//   在 Task 18/19 完成（spec §12 R1：素材类型多点同步，漏一处则九宫格恒空）。
//   `npc_voice` 于 2026-09-29 补入（NPC 旁白 TTS，spec §5.4 S3 stage）—— 同理：
//   生成侧的接线（TTS 适配器 + S3 stage + admin /voice 路由）在 Task 23–25 完成。
//   `export` 只为让 `__tests__/wenlv-design.test.ts` 能直接钉这份数量契约。
// PATCH 专用：剥离 isBuiltin（同 templates，防绕过「内置不可删」）
const assetUpdateSchema = assetSchema.omit({ isBuiltin: true }).partial();

// GET /assets?type=&styleTag=&productId= → 资产列表（多条件用 and 组合）
//
// productId 按**真列 `product_id`** 过滤（Task C6 从 `meta->>'productId'` 切过来；
// 迁移 0036 加列 + btree 索引 + 只补空的回填），**不是**按 venue_id：锚图/印章/图标走
// PUBLIC_POOL_TYPES 落公共池（venue_id 为 NULL），按场地过滤会把它们全漏掉，
// 而 writeAsset 对公共池与私有池**都**写 productId —— 这一个条件对两类素材都成立。
//
// `meta.productId` 仅作**双写**保留（迁移前写入的行与回滚路径识别用），**不再是查询源**：
// 它是 jsonb 键、无索引，且语义不透明 —— 一个 jsonb 键承载「这条素材属于哪个剧本」。
//
// 不传 productId 时行为与加这个参数之前**逐字不变**（有回归用例钉住）。
route.get('/assets', async (c) => {
  const type = c.req.query('type');
  const styleTag = c.req.query('styleTag');
  const productId = c.req.query('productId');
  const conds = [];
  if (type) conds.push(eq(pmsBuiWenlvDesignAssets.type, type));
  if (styleTag) conds.push(eq(pmsBuiWenlvDesignAssets.styleTag, styleTag));
  if (productId) conds.push(eq(pmsBuiWenlvDesignAssets.productId, productId));
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
  const rows = await db.select().from(pmsBuiWenlvDesignAssets).where(where).orderBy(desc(pmsBuiWenlvDesignAssets.updatedAt));

  // 每行的 targetKind / targetId 现在**就在 `rows` 里** —— 它们是 `design_assets` 自己的
  // 真列（迁移 0038），直接就是「用在」列的数据源。
  // （targetKind 取值：node / product / collectible / ending / reward / tier / npc / character）
  //
  // ⚠️ 这里原先有一段「按 jobId 批量回查 asset_jobs 再补进结果」的代码。它能删掉，正是因为
  //    0038 把坐标**下沉到了素材行**：那段补查的语义等价物现在由 writeCandidate / writeAsset
  //    在写入时保证，并有 `__tests__/wenlv-design-target.db.test.ts` 的全表断言守着。
  //    ⚠️ 而且它在今天就**已经把素材行自己的列盖掉了**（`{ ...r, targetKind: job?.… }`）——
  //    留着它，「读素材行」这条路永远是死的。
  // ⚠️ 删的是**数据来源**，不是查询形状：本端点的 WHERE / ORDER BY 一个字都没动，
  //    被回归用例钉住的那部分不受影响。
  // ⚠️ `targetId` 是**权威键**，前端按 id 查名字。这里只透传，不做任何名称解析
  //    （asset_jobs 的注释：不用标题字符串匹配，条目会被改名）。
  const list = rows;

  return c.json({ success: true, data: { list, total: list.length } });
});

// POST /assets → 建资产（幂等；id 长度校验；isBuiltin 缺省 false）
route.post('/assets', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const rawId = typeof body.id === 'string' && body.id ? body.id : null;
  if (rawId && rawId.length > 50) return c.json({ success: false, error: 'id 超长（最大 50）' }, 400);
  const id = rawId ?? randomUUID();
  const parsed = assetSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const [exist] = await db.select().from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, id)).limit(1);
  if (exist) return c.json({ success: true, data: exist });
  const d = parsed.data;
  // `meta.productId` 才是剧本归属的**既有表达方式**（该端点没有顶层 `productId` 入参，
  // 夹具也从 meta 里塞）。所以这里是**从 meta 派生**列值，双写进真列（迁移 0036 回填同源）
  // —— 而不是给 `assetSchema` 加一条顶层通路，那会造出第二种表达方式。
  const meta = d.meta ?? {};
  const [row] = await db.insert(pmsBuiWenlvDesignAssets).values({
    id,
    type: d.type, styleTag: d.styleTag ?? null, name: d.name,
    url: d.url ?? null, meta, isBuiltin: d.isBuiltin ?? false,
    // `typeof === 'string'` 而非 `?? null`：meta 是 Record<string, unknown>，值类型是
    // unknown，非字符串（数字 / 对象 / null）直接塞进 varchar(50) 会落成 'undefined'、
    // '[object Object]' 之类的脏值（本仓有同类前科）。
    productId: typeof meta.productId === 'string' ? meta.productId : null,
  }).returning();
  return c.json({ success: true, data: row });
});

/**
 * 手工上传可落的槽位 = 注册表里**有回写目标**的类型 + 旁白（旁白的回写目标是
 * `nodes.narrationUrl`，**不经注册表** —— 见 asset-types.ts 里 `narration` 那条
 * `writeback: null` 的说明：null 在这里不等于「不回写业务表」）。
 *
 * 为什么从注册表推导而不是手抄一份清单：手抄的那份会在加类型时漏掉，而漏掉的
 * 表现恰好是「上传成功、素材库里没有」—— 与本次要修的那个洞长得一模一样。
 */
const MANUAL_ASSET_TYPES = (Object.keys(ASSET_TYPES) as JobAssetType[])
  .filter((t) => t === 'narration' || ASSET_TYPES[t].writeback !== null) as [JobAssetType, ...JobAssetType[]];

const manualAssetSchema = z.object({
  type: z.enum(MANUAL_ASSET_TYPES),
  name: z.string().min(1, '名称不能为空').max(100),
  url: z.string().min(1).max(500),
  targetKind: z.enum(['node', 'product', 'collectible', 'ending', 'reward', 'tier', 'npc', 'character']),
  targetId: z.string().min(1).max(64),
});

/** 某槽位的坐标必须是哪个 entity。注册表是唯一真相，别在这里写 if 链。 */
function expectedKindOf(type: JobAssetType): WritebackEntity {
  if (type === 'narration') return 'node';
  const wb = ASSET_TYPES[type].writeback;
  if (!wb) throw new Error(`槽位 ${type} 没有回写目标，不该出现在手工上传清单里`);
  return wb.entity;
}

/**
 * 目标要素 → 它所属剧本的 id。**逐表 switch，不拼表名字符串** ——
 * 拼出来的名字写错时要么运行期报错、要么（更糟）静默 0 行。
 * 末支 `never` 与 writeback.ts 的 applyWriteback 同款：将来 WritebackEntity 加成员
 * 时这里会在 **ts-check 阶段**红，而不是静默放行一个查不到的表。
 */
async function productIdOfTarget(kind: WritebackEntity, id: string): Promise<string | null> {
  switch (kind) {
    case 'product': return id;
    case 'node': {
      // 0079 统一模型：节点即 scenes，经 chapter→script_room.contentId 反查产品。
      const [r] = await db.select({ p: pmsBuiWenlvScriptRooms.contentId })
        .from(pmsBuiWenlvScenes)
        .innerJoin(pmsBuiWenlvChapters, eq(pmsBuiWenlvScenes.chapterId, pmsBuiWenlvChapters.id))
        .innerJoin(pmsBuiWenlvScriptRooms, eq(pmsBuiWenlvChapters.scriptRoomId, pmsBuiWenlvScriptRooms.id))
        .where(eq(pmsBuiWenlvScenes.id, id)).limit(1);
      return r?.p ?? null;
    }
    case 'collectible': {
      const [r] = await db.select({ p: pmsBuiWenlvCollectibles.productId }).from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, id)).limit(1);
      return r?.p ?? null;
    }
    case 'ending': {
      // 结局也是 scenes（type='ending'），同样经 chapter→script_room 反查。
      const [r] = await db.select({ p: pmsBuiWenlvScriptRooms.contentId })
        .from(pmsBuiWenlvScenes)
        .innerJoin(pmsBuiWenlvChapters, eq(pmsBuiWenlvScenes.chapterId, pmsBuiWenlvChapters.id))
        .innerJoin(pmsBuiWenlvScriptRooms, eq(pmsBuiWenlvChapters.scriptRoomId, pmsBuiWenlvScriptRooms.id))
        .where(eq(pmsBuiWenlvScenes.id, id)).limit(1);
      return r?.p ?? null;
    }
    case 'reward': {
      const [r] = await db.select({ p: pmsBuiWenlvRewards.productId }).from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, id)).limit(1);
      return r?.p ?? null;
    }
    case 'tier': {
      const [r] = await db.select({ p: pmsBuiWenlvRewardTiers.productId }).from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.id, id)).limit(1);
      return r?.p ?? null;
    }
    case 'npc': {
      const [r] = await db.select({ p: pmsBuiWenlvNpcs.productId }).from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
      return r?.p ?? null;
    }
    case 'character': {
      const [r] = await db.select({ p: pmsBuiWenlvCharacters.productId }).from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
      return r?.p ?? null;
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`未知的目标实体：${String(_exhaustive)}`);
    }
  }
}

/**
 * POST /assets/manual —— 手工上传的素材落库（设计文档 §4.2 纪律二）。
 *
 * 为什么需要它：`ImageUpload` 走 `/api/upload`，只把 URL 写进**业务表**
 *（products.cover_image / collectibles.image / endings.image），根本不进 design_assets
 * ⇒ 这类素材在资源库与全景页里**完全不存在**，是设计文档 §2.2 的洞②。
 *
 * 为什么是「ensure」而不是「insert」：调用点在**保存之后**（那一刻才知道要素 id ——
 * 新建的行在上传时根本没有 id）。同一个槽位会被反复 ensure（连点保存、改别的字段再保存），
 * 所以必须幂等：按 (targetKind, targetId, type, url) 命中已有行就直接返回它。
 * 顺带的好处是它能把**部署前就存在**的业务列 URL 一并补登记（自愈），
 * 不依赖「用户重新上传一次」。
 *
 * 为什么 venueId 由服务端推导：`design_assets.venue_id` 的 NULL 语义是**公共池**
 *（跨场地复用），不是「没填」。手工上传一张结局图却落成公共池，会让它在**别的场地**
 * 的资源库里出现。场地只能从目标要素的剧本上取 —— 那是唯一真相，客户端送什么不算数。
 *
 * 与 `POST /assets`（上面那条）的关系：**不改那一条**。它的契约有回归用例钉住
 *（「不传时行为逐字不变」），兼做这件事会让那条断言失去判别力。
 */
route.post('/assets/manual', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = manualAssetSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const { type, name, url, targetKind, targetId } = parsed.data;

  // 槽位与坐标必须自洽：`cover` 不能挂在 collectible 上。判据来自注册表（唯一真相）。
  const expected = expectedKindOf(type);
  if (expected !== targetKind) {
    return c.json({ success: false, error: `槽位 ${type} 的目标必须是 ${expected}，收到 ${targetKind}` }, 400);
  }

  // 目标必须**真的存在**：坐标指向不存在的行 = 全景页里一条永远消不掉的孤儿。
  // 在写入口挡掉，比事后让运维去清理便宜得多。
  const productId = await productIdOfTarget(targetKind, targetId);
  if (!productId) return c.json({ success: false, error: '目标要素不存在' }, 404);
  const [prod] = await db.select({ venueId: pmsBuiWenlvProducts.venueId })
    .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  if (!prod) return c.json({ success: false, error: '目标要素所属的剧本不存在' }, 404);

  // ensure：同坐标同 URL 已有行就返回它。
  // ⚠️ 这里的判据必须与设计文档 §4.3 的「在用」逐字相同（target 两列 + type + url）。
  //    两个判据一分叉，就会出现「资源库里明明有一条、全景页却说这个槽位是空的」。
  const [exist] = await db.select().from(pmsBuiWenlvDesignAssets).where(and(
    eq(pmsBuiWenlvDesignAssets.targetKind, targetKind),
    eq(pmsBuiWenlvDesignAssets.targetId, targetId),
    eq(pmsBuiWenlvDesignAssets.type, type),
    eq(pmsBuiWenlvDesignAssets.url, url),
  )).limit(1);
  if (exist) return c.json({ success: true, data: exist });

  // id 前缀 `ma-`（manual asset），与生成侧的 `wa-` 区分开，便于人眼与 grep 分辨来源。
  // 列宽 50：`ma-` + 36 字符 UUID = 39，不触截断。
  const id = 'ma-' + randomUUID();
  const [row] = await db.insert(pmsBuiWenlvDesignAssets).values({
    id, type, name, url,
    productId,
    venueId: prod.venueId,
    targetKind, targetId,
    // 手工上传没有生成动作 ⇒ 恒 NULL。这一列非空即表示「有候选组」，
    // 前端 `groupCandidates` 第一句就是 `if (!r.jobId) continue`。
    jobId: null,
    meta: { manual: true, uploadedAt: new Date().toISOString() },
    isBuiltin: false,
    isSelected: false,
  }).returning();
  return c.json({ success: true, data: row });
});

// PATCH /assets/:id → 就地保存（isBuiltin 被剥离）
route.patch('/assets/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = assetUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  // 只在 body **带了** meta 时才重派生列值；没带就一个字都不碰列。
  // 不做的话会留下一个脏角落：改了 `meta.productId` 而列不动 ⇒ 列与 meta **分岔**，
  // 而 C6 之后查询看列、界面看列，两处会给出不同答案（本仓有「两个方向都错」的前科）。
  const patch: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (parsed.data.meta !== undefined) {
    patch.productId = typeof parsed.data.meta.productId === 'string' ? parsed.data.meta.productId : null;
  }
  const [row] = await db.update(pmsBuiWenlvDesignAssets).set(patch)
    .where(eq(pmsBuiWenlvDesignAssets.id, id)).returning();
  if (!row) return c.json({ success: false, error: '资产不存在' }, 404);
  return c.json({ success: true, data: row });
});

// DELETE /assets/:id → 删除（isBuiltin 拒删 409）
route.delete('/assets/:id', async (c) => {
  const id = c.req.param('id');
  const [exist] = await db.select().from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, id)).limit(1);
  if (!exist) return c.json({ success: false, error: '资产不存在' }, 404);
  if (exist.isBuiltin) return c.json({ success: false, error: '内置资产不可删除' }, 409);
  await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, id));
  return c.json({ success: true });
});

export default route;
