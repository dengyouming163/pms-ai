// 剧本房中心模型 service（0079 统一重建）：四表 CRUD 数据访问 + 规范图装配 + 全量只读投影纯函数
// （scenes/flows → nodes/edges/endings，引擎运行时与 C端/admin 各接口共用的唯一图对象，无双实现）。
//
// 纪律：
//   · 本 service **只读新表**（script_rooms/chapters/scenes/flows/npcs），绝不读旧 nodes/node_edges。
//   · projectScenesToNodes / projectFlowsToEdges / projectScenesToEndings 是**纯函数**（无 IO），可单测；
//     scene 五型→二元 nodeType（npc→npc；narrative/puzzle/atom→scene；ending 剔除，结局单列）；
//     flow 四型 edgeType 透传（auto/choice/puzzle_pass/puzzle_fail，未知回落 auto），condition 为
//     结构化 jsonb 对象；结局投影元素直接满足引擎 selectEnding/findTriggeredEndings 入参形状。
//   · loadRoomGraph(ByContentId) 是 room→chapters→scenes→flows→npcs 的唯一聚合入口（一次查全、避免 N+1）。
//   · list/get*/loadRoomGraph* 走 db（drizzle），惰性 Pool，import 不连库；db 函数不写单测（无 PG 环境跑不了）。
//   · getScriptRoomFlows 用 inArray 查 room 全部场景的出边（完整实现，非仅首场景）。
import { eq, and, asc, inArray, or } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes, pmsBuiWenlvFlows,
  pmsBuiWenlvNpcs,
} from '../../db/schema/wenlv.js';
import type {
  WenlvCondition, WenlvAtom, WenlvInteraction, WenlvChapterGoal, WenlvGeo, WenlvEdgeType,
  WenlvSceneType, WenlvNpcPersona,
} from '../../db/schema/wenlv.js';

// ===== 行类型（drizzle $inferSelect） =====
export type ScriptRoom = typeof pmsBuiWenlvScriptRooms.$inferSelect;
export type Chapter = typeof pmsBuiWenlvChapters.$inferSelect;
export type Scene = typeof pmsBuiWenlvScenes.$inferSelect;
export type Flow = typeof pmsBuiWenlvFlows.$inferSelect;
export type Npc = typeof pmsBuiWenlvNpcs.$inferSelect;

// ===== C端/引擎只读投影：scenes/flows → nodes/edges/endings 契约（0079 全量对等） =====

/** 投影输入 scene（结构兼容 DB Scene 行与字面量；除 id/title 外皆可缺省）。 */
export interface SceneProjectionInput {
  id: string;
  chapterId?: string;
  title: string;
  type?: string | null;
  content?: string | null;
  npcId?: string | null;
  atoms?: WenlvAtom[] | null;
  puzzle?: WenlvInteraction | null;
  order?: number | null;
  // 0079 对等玩法列
  venuePointId?: string | null;
  requires?: WenlvCondition | null;
  geo?: WenlvGeo | null;
  mapX?: number | null;
  mapY?: number | null;
  image?: string | null;
  narrationUrl?: string | null;
  grants?: string[] | null;
  npcLineIds?: string[] | null;
  openingLine?: string | null;
  chapterGoal?: WenlvChapterGoal | null;
  perspectiveCharacterId?: string | null;
  sanDelta?: number | null;
  arAssetUrl?: string | null;
  arAssetUrls?: Record<string, string | null> | null;
  arDialogue?: string | null;
  // 结局承载（type='ending'）
  triggerCondition?: WenlvCondition | null;
  priority?: number | null;
  rewardId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** 投影输入 flow（condition 已是结构化 jsonb 对象）。 */
export interface FlowProjectionInput {
  id: string;
  fromSceneId: string;
  toSceneId: string;
  type?: string | null;
  choiceText?: string | null;
  condition?: WenlvCondition | null;
  grants?: string[] | null;
  sanDelta?: number | null;
  sortOrder?: number | null;
}

/**
 * 旧 nodes 行契约的投影形态（供 GET /:id 的 safeNodes map 零改动复用，字段驼峰对齐旧表）。
 * nodeType 二元：scene.type==='npc' → 'npc'，narrative/puzzle/atom → 'scene'；
 * **ending 场景不进 nodes**（结局走 projectScenesToEndings → endings 数组）。
 */
export interface ProjectedNode {
  id: string;
  productId: string;
  nodeType: 'scene' | 'npc';
  legacyNodeType: 'scene';
  title: string;
  storyText: string | null;
  requires: WenlvCondition | null;
  geo: WenlvGeo | null;
  mapX: number | null;
  mapY: number | null;
  image: string | null;
  narrationUrl: string | null;
  venuePointId: string | null;
  grants: string[];
  puzzle: WenlvInteraction | null;
  atoms: WenlvAtom[] | null;
  order: number;
  npcId: string | null;
  npcLineIds: string[];
  perspectiveCharacterId: string | null;
  chapterGoal: WenlvChapterGoal | null;
  openingLine: string | null;
  sanDelta: number;
  arAssetUrl: string | null;
  arAssetUrls: Record<string, string | null>;
  arDialogue: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 旧 edges 契约（同时是运行时图遍历输入）：edgeType 四值透传，condition 为结构化对象。 */
export interface ProjectedEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: WenlvEdgeType;
  label: string | null;
  condition: WenlvCondition | null;
  grants: string[];
  sanDelta: number;
  sortOrder: number;
}

/**
 * 结局投影（type='ending' 的场景）。**内部形态**保留 triggerCondition 供引擎
 * findTriggeredEndings/selectEnding 直接消费；C 端下发时由路由剥除 triggerCondition（防预知条件）。
 * text=scene.content、image=scene.image（结局不另设列）。
 */
export interface ProjectedEnding {
  id: string;
  title: string;
  text: string | null;
  image: string | null;
  rewardId: string | null;
  priority: number;
  triggerCondition: WenlvCondition | null;
}

/** scenes → nodes：丢弃 chapterId，五型映射二元 nodeType（结局剔除），全玩法字段透传。 */
export function projectScenesToNodes(
  scenes: readonly SceneProjectionInput[],
  productId: string,
): ProjectedNode[] {
  return scenes
    .filter((s) => s.type !== 'ending')
    .map((s) => ({
      id: s.id,
      productId,
      nodeType: s.type === 'npc' ? 'npc' as const : 'scene' as const,
      legacyNodeType: 'scene' as const,
      title: s.title,
      storyText: s.content ?? null,
      requires: s.requires ?? null,
      geo: s.geo ?? null,
      mapX: s.mapX ?? null,
      mapY: s.mapY ?? null,
      image: s.image ?? null,
      narrationUrl: s.narrationUrl ?? null,
      venuePointId: s.venuePointId ?? null,
      grants: s.grants ?? [],
      puzzle: s.puzzle ?? null,
      atoms: s.atoms ?? null,
      order: s.order ?? 0,
      npcId: s.npcId ?? null,
      npcLineIds: s.npcLineIds ?? [],
      perspectiveCharacterId: s.perspectiveCharacterId ?? null,
      chapterGoal: s.chapterGoal ?? null,
      openingLine: s.openingLine ?? null,
      sanDelta: s.sanDelta ?? 0,
      arAssetUrl: s.arAssetUrl ?? null,
      arAssetUrls: s.arAssetUrls ?? {},
      arDialogue: s.arDialogue ?? null,
      createdAt: s.createdAt ?? new Date(),
      updatedAt: s.updatedAt ?? new Date(),
    }));
}

/** flows → edges：fromSceneId/toSceneId→from/toNodeId，choiceText→label，四型/条件对象/产出全透传。 */
export function projectFlowsToEdges(flows: readonly FlowProjectionInput[]): { edges: ProjectedEdge[] } {
  const edges: ProjectedEdge[] = flows.map((f) => ({
    id: f.id,
    fromNodeId: f.fromSceneId,
    toNodeId: f.toSceneId,
    edgeType: (f.type === 'choice' || f.type === 'puzzle_pass' || f.type === 'puzzle_fail'
      ? f.type
      : 'auto') as WenlvEdgeType,
    label: f.choiceText ?? null,
    condition: f.condition ?? null,
    grants: f.grants ?? [],
    sanDelta: f.sanDelta ?? 0,
    sortOrder: f.sortOrder ?? 0,
  }));
  return { edges };
}

/** scenes（type='ending'）→ endings：可直接作为 selectEnding/findTriggeredEndings 的入参。 */
export function projectScenesToEndings(scenes: readonly SceneProjectionInput[]): ProjectedEnding[] {
  return scenes
    .filter((s) => s.type === 'ending')
    .map((s) => ({
      id: s.id,
      title: s.title,
      text: s.content ?? null,
      image: s.image ?? null,
      rewardId: s.rewardId ?? null,
      priority: s.priority ?? 0,
      triggerCondition: s.triggerCondition ?? null,
    }));
}

// ===== C 端脱敏投影（公开详情专用；与引擎内部形态分离） =====

/** 结局 C 端 DTO（对齐 pms-nimi WenlvEnding）：**剥除 triggerCondition**，防游客预知结局触发条件。 */
export interface ClientEnding {
  id: string;
  title: string;
  text: string | null;
  image: string | null;
  rewardId: string | null;
  priority: number;
}

/** 结局内部投影 → C 端白名单 DTO（去 triggerCondition）。 */
export function projectEndingToClient(e: ProjectedEnding): ClientEnding {
  return {
    id: e.id,
    title: e.title,
    text: e.text,
    image: e.image,
    rewardId: e.rewardId,
    priority: e.priority,
  };
}

/**
 * NPC 人格卡 C 端投影：只保留 WenlvNpcPersona 六键（personality/tone/catchphrases/backstory/
 * clues/taboos），逐键类型校验；全无有效值返回 null（调用方不下发 persona 键）。
 * 🔴 输入按 unknown 收敛、逐键白名单——npc.memory（跨章运行时印象）/relationships/
 *    pendingMentions/portraitPrompt 及任何夹带的 answer 类键都不会经此通道泄给游客。
 */
export function toClientNpcPersona(p: unknown): WenlvNpcPersona | null {
  if (!p || typeof p !== 'object') return null;
  const src = p as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(src.personality)) out.personality = src.personality.filter((x) => typeof x === 'string');
  if (typeof src.tone === 'string') out.tone = src.tone;
  if (Array.isArray(src.catchphrases)) out.catchphrases = src.catchphrases.filter((x) => typeof x === 'string');
  if (typeof src.backstory === 'string') out.backstory = src.backstory;
  if (Array.isArray(src.clues)) out.clues = src.clues.filter((x) => typeof x === 'string');
  if (Array.isArray(src.taboos)) out.taboos = src.taboos.filter((x) => typeof x === 'string');
  return Object.keys(out).length > 0 ? (out as WenlvNpcPersona) : null;
}

// ===== CRUD（db 数据访问，无单测；惰性 Pool，import 安全） =====

/** 列出全部剧本房（按创建时间升序）。 */
export async function listScriptRooms(): Promise<ScriptRoom[]> {
  return db.select().from(pmsBuiWenlvScriptRooms).orderBy(asc(pmsBuiWenlvScriptRooms.createdAt));
}

/** 按 id 取单条剧本房，无则 null。 */
export async function getScriptRoom(id: string): Promise<ScriptRoom | null> {
  const rows = await db.select().from(pmsBuiWenlvScriptRooms)
    .where(eq(pmsBuiWenlvScriptRooms.id, id)).limit(1);
  return rows[0] ?? null;
}

/** 按 contentId 取单条剧本房，无则 null（Task 5 C端投影入口按 contentId 找房）。 */
export async function getScriptRoomByContentId(contentId: string): Promise<ScriptRoom | null> {
  const rows = await db.select().from(pmsBuiWenlvScriptRooms)
    .where(eq(pmsBuiWenlvScriptRooms.contentId, contentId)).limit(1);
  return rows[0] ?? null;
}

/** 取某剧本房的全部章节（按 order 升序）。 */
export async function getScriptRoomChapters(scriptRoomId: string): Promise<Chapter[]> {
  return db.select().from(pmsBuiWenlvChapters)
    .where(eq(pmsBuiWenlvChapters.scriptRoomId, scriptRoomId))
    .orderBy(asc(pmsBuiWenlvChapters.order));
}

/** 取某章节的全部场景（按 order 升序）。 */
export async function getChapterScenes(chapterId: string): Promise<Scene[]> {
  return db.select().from(pmsBuiWenlvScenes)
    .where(eq(pmsBuiWenlvScenes.chapterId, chapterId))
    .orderBy(asc(pmsBuiWenlvScenes.order));
}

/**
 * 取某剧本房全部 flow（完整实现）：room → chapters → sceneIds → 这些 scene 的出边。
 * 一条 flow 属于某 room 当且仅当其源场景在该 room 内；用 inArray 一次查全，非仅首场景。
 */
export async function getScriptRoomFlows(scriptRoomId: string): Promise<Flow[]> {
  const chapters = await db.select({ id: pmsBuiWenlvChapters.id }).from(pmsBuiWenlvChapters)
    .where(eq(pmsBuiWenlvChapters.scriptRoomId, scriptRoomId));
  if (chapters.length === 0) return [];
  const chapterIds = chapters.map((c) => c.id);
  const scenes = await db.select({ id: pmsBuiWenlvScenes.id }).from(pmsBuiWenlvScenes)
    .where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
  if (scenes.length === 0) return [];
  const sceneIds = scenes.map((s) => s.id);
  // orderBy sortOrder：与旧 getOutgoingEdges 同序，保证图遍历 choice 边展示顺序确定。
  return db.select().from(pmsBuiWenlvFlows)
    .where(inArray(pmsBuiWenlvFlows.fromSceneId, sceneIds))
    .orderBy(asc(pmsBuiWenlvFlows.sortOrder));
}

// ===== 运行时反查（新模型 scenes 承载 venuePointId/title；替代旧 nodes 表的两处运行时读端） =====

/**
 * 按点位 id 反查「绑定了该点位的场景」所属的全部产品 id（扫码发现候选）。
 * 链路：scenes.venuePointId → chapters.scriptRoomId → script_rooms.contentId(= productId)，逐级去重。
 * 无任一命中返回 []（等价旧 nodes 表在该点位无行）。
 */
export async function findProductIdsByVenuePoint(venuePointId: string): Promise<string[]> {
  const sceneRows = await db.select({ chapterId: pmsBuiWenlvScenes.chapterId })
    .from(pmsBuiWenlvScenes)
    .where(eq(pmsBuiWenlvScenes.venuePointId, venuePointId));
  const chapterIds = [...new Set(sceneRows.map((r) => r.chapterId).filter(Boolean))] as string[];
  if (chapterIds.length === 0) return [];
  const chapterRows = await db.select({ scriptRoomId: pmsBuiWenlvChapters.scriptRoomId })
    .from(pmsBuiWenlvChapters)
    .where(inArray(pmsBuiWenlvChapters.id, chapterIds));
  const roomIds = [...new Set(chapterRows.map((r) => r.scriptRoomId).filter(Boolean))] as string[];
  if (roomIds.length === 0) return [];
  const roomRows = await db.select({ contentId: pmsBuiWenlvScriptRooms.contentId })
    .from(pmsBuiWenlvScriptRooms)
    .where(inArray(pmsBuiWenlvScriptRooms.id, roomIds));
  return [...new Set(roomRows.map((r) => r.contentId).filter(Boolean))];
}

/** 按 sceneId 集合批量取 {id,title}（组队详情 visited 键 → 节点标题映射）。空入参不查库。 */
export async function findSceneTitlesByIds(ids: readonly string[]): Promise<{ id: string; title: string }[]> {
  if (ids.length === 0) return [];
  return db.select({ id: pmsBuiWenlvScenes.id, title: pmsBuiWenlvScenes.title })
    .from(pmsBuiWenlvScenes)
    .where(inArray(pmsBuiWenlvScenes.id, ids as string[]));
}

/** 按 contentId 批量统计场景数（Task 19：替代旧 nodes/endings 两表计数）。
 *  nodes = 非 ending 场景数；endings = type='ending' 场景数。经 room→chapters→scenes 三跳关联。
 *  无房/无章节的 contentId 不出现在结果 Map 中（调用方按 0 兜底）。 */
export async function countScenesByContent(
  contentIds: readonly string[],
): Promise<Map<string, { nodes: number; endings: number }>> {
  const out = new Map<string, { nodes: number; endings: number }>();
  if (contentIds.length === 0) return out;
  const rooms = await db.select({ id: pmsBuiWenlvScriptRooms.id, contentId: pmsBuiWenlvScriptRooms.contentId })
    .from(pmsBuiWenlvScriptRooms)
    .where(inArray(pmsBuiWenlvScriptRooms.contentId, contentIds as string[]));
  if (rooms.length === 0) return out;
  const roomByChapter = new Map<string, string>();
  const chapters = await db.select({ id: pmsBuiWenlvChapters.id, scriptRoomId: pmsBuiWenlvChapters.scriptRoomId })
    .from(pmsBuiWenlvChapters)
    .where(inArray(pmsBuiWenlvChapters.scriptRoomId, rooms.map((r) => r.id)));
  for (const ch of chapters) roomByChapter.set(ch.id, ch.scriptRoomId);
  const contentByRoom = new Map(rooms.map((r) => [r.id, r.contentId]));
  if (chapters.length === 0) return out;
  const scenes = await db.select({ chapterId: pmsBuiWenlvScenes.chapterId, type: pmsBuiWenlvScenes.type })
    .from(pmsBuiWenlvScenes)
    .where(inArray(pmsBuiWenlvScenes.chapterId, chapters.map((c) => c.id)));
  for (const s of scenes) {
    const roomId = roomByChapter.get(s.chapterId);
    if (!roomId) continue;
    const contentId = contentByRoom.get(roomId);
    if (!contentId) continue;
    const cur = out.get(contentId) ?? { nodes: 0, endings: 0 };
    if (s.type === 'ending') cur.endings += 1;
    else cur.nodes += 1;
    out.set(contentId, cur);
  }
  return out;
}

// ===== 规范图装配（只读新表：room→chapters→scenes→flows→npcs 的唯一聚合入口） =====

/**
 * 一个剧本房的规范图。引擎运行时与各接口（C 端详情 / admin 编辑 / 发布闸）共用此唯一聚合结果，
 * 派生 nodes/edges/endings 一律走上面的 project* 纯函数，不再各写一套装配（无双实现）。
 */
export interface RoomGraph {
  room: ScriptRoom;
  chapters: Chapter[];
  /** 全量场景（含 type='ending'），按 chapters 顺序、章内 order 排列。 */
  scenes: Scene[];
  flows: Flow[];
  /** room.contentId 关联的剧本 NPC（npcs.productId = room.contentId）。 */
  npcs: Npc[];
}

/** 按 room.id 聚合规范图；room 不存在返回 null。 */
export async function loadRoomGraph(roomId: string): Promise<RoomGraph | null> {
  const room = await getScriptRoom(roomId);
  if (!room) return null;
  return assembleGraph(room);
}

/** 按 contentId 聚合规范图（C 端详情入口）；无房返回 null。 */
export async function loadRoomGraphByContentId(contentId: string): Promise<RoomGraph | null> {
  const room = await getScriptRoomByContentId(contentId);
  if (!room) return null;
  return assembleGraph(room);
}

async function assembleGraph(room: ScriptRoom): Promise<RoomGraph> {
  const chapters = await getScriptRoomChapters(room.id);
  const chapterIds = chapters.map((c) => c.id);
  // 一次查全量场景（db 按 order 升序），再在内存按 chapters 顺序归并，避免 N+1 且保证跨章次序。
  const sceneRows = chapterIds.length === 0 ? [] : await db.select().from(pmsBuiWenlvScenes)
    .where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds))
    .orderBy(asc(pmsBuiWenlvScenes.order));
  const byChapter = new Map<string, Scene[]>();
  for (const s of sceneRows) {
    const list = byChapter.get(s.chapterId);
    if (list) list.push(s);
    else byChapter.set(s.chapterId, [s]);
  }
  const scenes = chapters.flatMap((c) => byChapter.get(c.id) ?? []);
  const flows = await getScriptRoomFlows(room.id);
  const npcs = await db.select().from(pmsBuiWenlvNpcs)
    .where(eq(pmsBuiWenlvNpcs.productId, room.contentId))
    .orderBy(asc(pmsBuiWenlvNpcs.orderId));
  return { room, chapters, scenes, flows, npcs };
}

/**
 * 运行时写端点（trigger/answer/atoms/beacon）一次查全 + 三投影的便捷装配。
 * nodes 已剔除 ending 场景（故对外 nodeId 查不到结局，结局不可被打卡/答题）；
 * 无房（未搭建内容的已发布门票）⇒ 各数组为空，等价空剧本（任何 nodeId 都 404）。
 */
export interface RuntimeRoomGraph {
  graph: RoomGraph | null;
  nodes: ProjectedNode[];
  edges: ProjectedEdge[];
  endings: ProjectedEnding[];
}

/** 按 contentId(= productId) 取运行时规范图；无房返回全空集合（不抛错）。 */
export async function loadRuntimeGraph(contentId: string): Promise<RuntimeRoomGraph> {
  const graph = await loadRoomGraphByContentId(contentId);
  if (!graph) return { graph: null, nodes: [], edges: [], endings: [] };
  return {
    graph,
    nodes: projectScenesToNodes(graph.scenes, contentId),
    edges: projectFlowsToEdges(graph.flows).edges,
    endings: projectScenesToEndings(graph.scenes),
  };
}

// ===== reorder 纯函数（可单测） =====

/** 批量重排：按数组顺序重写 order 为 0,1,2...。纯函数，不碰 db。 */
export function reorderPlans(items: { id: string; order: number }[]): { id: string; order: number }[] {
  return items.map((item, i) => ({ id: item.id, order: i }));
}

// ===== Chapter CRUD（db 数据访问，无单测） =====

/** 创建章节。id 用 randomUUID，order 默认 0。 */
export async function createChapter(scriptRoomId: string, data: {
  title: string;
  timeLabel?: string | null;
  goal?: string | null;
  order?: number;
}): Promise<Chapter> {
  const id = randomUUID();
  const [row] = await db.insert(pmsBuiWenlvChapters).values({
    id,
    scriptRoomId,
    title: data.title,
    timeLabel: data.timeLabel ?? null,
    goal: data.goal ?? null,
    order: data.order ?? 0,
  }).returning();
  return row;
}

/** 更新章节（白名单字段）。 */
export async function updateChapter(id: string, patch: {
  title?: string;
  timeLabel?: string | null;
  goal?: string | null;
  order?: number;
  status?: string;
}): Promise<Chapter | null> {
  const allow: Record<string, boolean> = { title: true, timeLabel: true, goal: true, order: true, status: true };
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (allow[k] && v !== undefined) set[k] = v;
  }
  const [row] = await db.update(pmsBuiWenlvChapters).set(set).where(eq(pmsBuiWenlvChapters.id, id)).returning();
  return row ?? null;
}

/** 删除章节（级联删场景 + flows）。 */
export async function deleteChapter(id: string): Promise<boolean> {
  const scenes = await db.select({ id: pmsBuiWenlvScenes.id }).from(pmsBuiWenlvScenes)
    .where(eq(pmsBuiWenlvScenes.chapterId, id));
  if (scenes.length > 0) {
    const sceneIds = scenes.map((s) => s.id);
    await db.delete(pmsBuiWenlvFlows)
      .where(or(inArray(pmsBuiWenlvFlows.fromSceneId, sceneIds), inArray(pmsBuiWenlvFlows.toSceneId, sceneIds)));
    await db.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.id, sceneIds));
  }
  const [deleted] = await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, id)).returning();
  return !!deleted;
}

// ===== Scene CRUD =====

/** scene 可写字段（0079 全量对等；id/chapterId/aiGenerated/时间戳不由客户端直写）。 */
export interface SceneWriteData {
  title: string;
  type?: WenlvSceneType | null;
  content?: string | null;
  npcId?: string | null;
  atoms?: WenlvAtom[] | null;
  puzzle?: WenlvInteraction | null;
  order?: number | null;
  venuePointId?: string | null;
  requires?: WenlvCondition | null;
  geo?: WenlvGeo | null;
  mapX?: number | null;
  mapY?: number | null;
  image?: string | null;
  narrationUrl?: string | null;
  grants?: string[] | null;
  npcLineIds?: string[] | null;
  openingLine?: string | null;
  chapterGoal?: WenlvChapterGoal | null;
  perspectiveCharacterId?: string | null;
  sanDelta?: number | null;
  arAssetUrl?: string | null;
  arAssetUrls?: Record<string, string | null> | null;
  arDialogue?: string | null;
  // 结局承载（type='ending'）
  triggerCondition?: WenlvCondition | null;
  priority?: number | null;
  rewardId?: string | null;
}

const SCENE_WRITABLE_KEYS: (keyof SceneWriteData)[] = [
  'title', 'type', 'content', 'npcId', 'atoms', 'puzzle', 'order',
  'venuePointId', 'requires', 'geo', 'mapX', 'mapY', 'image', 'narrationUrl', 'grants',
  'npcLineIds', 'openingLine', 'chapterGoal', 'perspectiveCharacterId', 'sanDelta',
  'arAssetUrl', 'arAssetUrls', 'arDialogue', 'triggerCondition', 'priority', 'rewardId',
];

/** 创建场景。 */
export async function createScene(chapterId: string, data: SceneWriteData): Promise<Scene> {
  const id = randomUUID();
  const [row] = await db.insert(pmsBuiWenlvScenes).values({
    id,
    chapterId,
    title: data.title,
    type: data.type ?? 'narrative',
    content: data.content ?? null,
    npcId: data.npcId ?? null,
    atoms: data.atoms ?? [],
    puzzle: data.puzzle ?? null,
    order: data.order ?? 0,
    venuePointId: data.venuePointId ?? null,
    requires: data.requires ?? null,
    geo: data.geo ?? null,
    mapX: data.mapX ?? null,
    mapY: data.mapY ?? null,
    image: data.image ?? null,
    narrationUrl: data.narrationUrl ?? null,
    grants: data.grants ?? [],
    npcLineIds: data.npcLineIds ?? [],
    openingLine: data.openingLine ?? null,
    chapterGoal: data.chapterGoal ?? null,
    perspectiveCharacterId: data.perspectiveCharacterId ?? null,
    sanDelta: data.sanDelta ?? 0,
    arAssetUrl: data.arAssetUrl ?? null,
    arAssetUrls: data.arAssetUrls ?? {},
    arDialogue: data.arDialogue ?? null,
    triggerCondition: data.triggerCondition ?? null,
    priority: data.priority ?? 0,
    rewardId: data.rewardId ?? null,
  }).returning();
  return row;
}

/** 更新场景（白名单字段，允许显式置 null）。 */
export async function updateScene(id: string, patch: Partial<SceneWriteData>): Promise<Scene | null> {
  const allow = new Set<string>(SCENE_WRITABLE_KEYS);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (allow.has(k) && v !== undefined) set[k] = v;
  }
  const [row] = await db.update(pmsBuiWenlvScenes).set(set).where(eq(pmsBuiWenlvScenes.id, id)).returning();
  return row ?? null;
}

/** 删除场景（级联删 flows）。 */
export async function deleteScene(id: string): Promise<boolean> {
  await db.delete(pmsBuiWenlvFlows)
    .where(or(inArray(pmsBuiWenlvFlows.fromSceneId, [id]), inArray(pmsBuiWenlvFlows.toSceneId, [id])));
  const [deleted] = await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, id)).returning();
  return !!deleted;
}

// ===== Ending（结局 = type='ending' 的 scene；0079 统一模型，不再有独立 endings 表写入）=====

/**
 * 取某剧本房的全部结局场景（priority 降序在前、章内 order 兜底）。
 * 链路 room → chapters(in) → scenes(type='ending')。
 */
export async function listRoomEndings(scriptRoomId: string): Promise<Scene[]> {
  const chapters = await db.select({ id: pmsBuiWenlvChapters.id }).from(pmsBuiWenlvChapters)
    .where(eq(pmsBuiWenlvChapters.scriptRoomId, scriptRoomId));
  if (chapters.length === 0) return [];
  const chapterIds = chapters.map((c) => c.id);
  return db.select().from(pmsBuiWenlvScenes)
    .where(and(eq(pmsBuiWenlvScenes.type, 'ending'), inArray(pmsBuiWenlvScenes.chapterId, chapterIds)))
    .orderBy(asc(pmsBuiWenlvScenes.priority), asc(pmsBuiWenlvScenes.order));
}

/** 判定章节是否挂在该剧本房下（结局创建前的归属校验，防跨房挂章）。 */
export async function chapterBelongsToRoom(scriptRoomId: string, chapterId: string): Promise<boolean> {
  const rows = await db.select({ id: pmsBuiWenlvChapters.id }).from(pmsBuiWenlvChapters)
    .where(and(eq(pmsBuiWenlvChapters.id, chapterId), eq(pmsBuiWenlvChapters.scriptRoomId, scriptRoomId)))
    .limit(1);
  return rows.length > 0;
}

/** 结局可写字段（正文存 scenes.content，投影时映射为 ending.text）。 */
export interface EndingWriteData {
  chapterId: string;
  title: string;
  content?: string | null;
  image?: string | null;
  triggerCondition?: WenlvCondition | null;
  priority?: number | null;
  rewardId?: string | null;
  order?: number | null;
}

/**
 * 创建结局：强制 type='ending' 的场景。triggerCondition 缺省落空 all（恒真，
 * 与旧 endings 表 NOT NULL 列的兜底语义一致），其余结局专属列直写 scenes。
 */
export async function createEndingScene(data: EndingWriteData): Promise<Scene> {
  return createScene(data.chapterId, {
    title: data.title,
    type: 'ending',
    content: data.content ?? null,
    image: data.image ?? null,
    triggerCondition: data.triggerCondition ?? { type: 'all', conditions: [] },
    priority: data.priority ?? 0,
    rewardId: data.rewardId ?? null,
    order: data.order ?? 0,
  });
}

// ===== Flow CRUD =====

/** flow 可写字段（0079 全量对等；id/时间戳不由客户端直写）。condition 为结构化 jsonb 对象。 */
export interface FlowWriteData {
  fromSceneId: string;
  toSceneId: string;
  type?: WenlvEdgeType | null;
  choiceText?: string | null;
  condition?: WenlvCondition | null;
  grants?: string[] | null;
  sanDelta?: number | null;
  sortOrder?: number | null;
}

const FLOW_WRITABLE_KEYS = ['type', 'choiceText', 'condition', 'grants', 'sanDelta', 'sortOrder'] as const;

/** 创建流转。 */
export async function createFlow(data: FlowWriteData): Promise<Flow> {
  const id = randomUUID();
  const [row] = await db.insert(pmsBuiWenlvFlows).values({
    id,
    fromSceneId: data.fromSceneId,
    toSceneId: data.toSceneId,
    type: data.type ?? 'auto',
    choiceText: data.choiceText ?? null,
    condition: data.condition ?? null,
    grants: data.grants ?? [],
    sanDelta: data.sanDelta ?? 0,
    sortOrder: data.sortOrder ?? 0,
  }).returning();
  return row;
}

/** 更新流转（白名单字段，允许显式置 null）。 */
export async function updateFlow(id: string, patch: Partial<Omit<FlowWriteData, 'fromSceneId' | 'toSceneId'>>): Promise<Flow | null> {
  const allow = new Set<string>(FLOW_WRITABLE_KEYS);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (allow.has(k) && v !== undefined) set[k] = v;
  }
  const [row] = await db.update(pmsBuiWenlvFlows).set(set).where(eq(pmsBuiWenlvFlows.id, id)).returning();
  return row ?? null;
}

/** 删除流转。 */
export async function deleteFlow(id: string): Promise<boolean> {
  const [deleted] = await db.delete(pmsBuiWenlvFlows).where(eq(pmsBuiWenlvFlows.id, id)).returning();
  return !!deleted;
}

// ===== ScriptRoom 更新 =====

/** 更新剧本房基础信息（白名单字段）。 */
export async function updateScriptRoom(id: string, patch: {
  name?: string;
  coverImage?: string | null;
  intro?: string | null;
  venueId?: string | null;
  mode?: string;
  difficulty?: string;
  purePlay?: boolean;
  status?: string;
  config?: unknown;
}): Promise<ScriptRoom | null> {
  const allow: Record<string, boolean> = { name: true, coverImage: true, intro: true, venueId: true, mode: true, difficulty: true, purePlay: true, status: true, config: true };
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (allow[k] && v !== undefined) set[k] = v;
  }
  const [row] = await db.update(pmsBuiWenlvScriptRooms).set(set).where(eq(pmsBuiWenlvScriptRooms.id, id)).returning();
  return row ?? null;
}
