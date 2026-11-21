// AI 协作 DIY 会话 service（0079 / pms_bui_wenlv_ai_sessions）。
//
// 边界：
//   · pms-agent 不直连 DB，经 admin/wenlv-ai-sessions 路由（X-Internal-Service-Token）调本 service。
//   · 七步向导「AI 提案 / 用户决策」：草案只写 ai_sessions.draftSnapshots；**仅 adoptXxx 落盘事务**
//     才写 script_rooms/chapters/scenes/flows/npcs，拒绝/换版不动四表（FR-10）。
//   · 世界观落 script_rooms.config.worldview；角色落 npcs(productId=room.contentId)；骨架落 chapters；
//     场景/流转落 scenes/flows（结局是 type='ending' 的 scene，同一通道）。
//   · 本 service 只做状态存取与按白名单落盘，不调 LLM、不做发布闸判定（质检在 Task 14）。
import { randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { HttpError } from '../../lib/http-error.js';
import {
  pmsBuiWenlvAiSessions,
  pmsBuiWenlvScriptRooms,
  pmsBuiWenlvChapters,
  pmsBuiWenlvScenes,
  pmsBuiWenlvFlows,
  pmsBuiWenlvNpcs,
  pmsBuiWenlvVenues,
  pmsBuiWenlvVenueProfiles,
  pmsBuiWenlvVenuePoints,
  pmsBuiWenlvMerchantPartners,
} from '../../db/schema/wenlv.js';
import type {
  WenlvAiStage, WenlvAiSessionStatus, WenlvCondition, WenlvAtom, WenlvInteraction,
  WenlvChapterGoal, WenlvGeo, WenlvEdgeType, WenlvSceneType, WenlvNpcPersona,
  WenlvNpcLine, WenlvNpcRelationship,
} from '../../db/schema/wenlv.js';

/** 可预期业务错误：路由识别后按 status 直出 message（文案均为本文件自产，不含 SQL/栈）。 */
export class AiSessionError extends HttpError {
  declare status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(status, message);
    this.name = 'AiSessionError';
  }
}

export type AiSession = typeof pmsBuiWenlvAiSessions.$inferSelect;
export type ScriptRoom = typeof pmsBuiWenlvScriptRooms.$inferSelect;

/**
 * 对外会话视图：表定义里 transcript/draftSnapshots 是无 $type 的 jsonb（$inferSelect 为 unknown），
 * 经此收敛为强类型（PG 里实际就是数组/对象，读取端做一次防御归一）。
 */
export interface AiSessionView extends Omit<AiSession, 'transcript' | 'draftSnapshots' | 'intent'> {
  transcript: AiTranscriptEntry[];
  draftSnapshots: DraftSnapshots;
  intent: unknown;
}

function toView(row: AiSession): AiSessionView {
  const t = row.transcript as unknown;
  const d = row.draftSnapshots as unknown;
  return {
    ...row,
    transcript: Array.isArray(t) ? (t as AiTranscriptEntry[]) : [],
    draftSnapshots: (d && typeof d === 'object' ? d : {}) as DraftSnapshots,
  };
}

export interface AiTranscriptEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  stage?: WenlvAiStage | null;
  at?: string;
}

/** 各阶段草案包：键为 stage，值为该步 AI 产出（未采纳仅存这里，结构对 Python LenientModel 宽松）。 */
export type DraftSnapshots = Partial<Record<WenlvAiStage, unknown>>;

export interface CreateSessionInput {
  scriptRoomId: string;
  userId: string;
  intent?: unknown;
}

export interface SessionPatch {
  stage?: WenlvAiStage;
  status?: WenlvAiSessionStatus;
  intent?: unknown;
}

const NOW = () => new Date();

async function insertSession(input: CreateSessionInput): Promise<AiSessionView> {
  const id = randomUUID();
  const [row] = await db.insert(pmsBuiWenlvAiSessions).values({
    id,
    scriptRoomId: input.scriptRoomId,
    userId: input.userId,
    stage: 'intent',
    intent: input.intent ?? null,
    transcript: [],
    draftSnapshots: {},
    status: 'active',
  }).returning();
  return toView(row);
}

/** 建会话；幂等：同 room+user 已有 active 会话则直接返回它（中断恢复/重入不新开）。 */
export async function createOrResumeAiSession(input: CreateSessionInput): Promise<{ session: AiSessionView; resumed: boolean }> {
  const existing = await findActiveAiSession(input.scriptRoomId, input.userId);
  if (existing) return { session: existing, resumed: true };
  return { session: await insertSession(input), resumed: false };
}

export async function getAiSession(id: string): Promise<AiSessionView | null> {
  const [row] = await db.select().from(pmsBuiWenlvAiSessions)
    .where(eq(pmsBuiWenlvAiSessions.id, id)).limit(1);
  return row ? toView(row) : null;
}

/** 按 room+user 取活跃会话（跨请求恢复），updatedAt 最新一条。 */
export async function findActiveAiSession(scriptRoomId: string, userId: string): Promise<AiSessionView | null> {
  const [row] = await db.select().from(pmsBuiWenlvAiSessions)
    .where(and(
      eq(pmsBuiWenlvAiSessions.scriptRoomId, scriptRoomId),
      eq(pmsBuiWenlvAiSessions.userId, userId),
      eq(pmsBuiWenlvAiSessions.status, 'active'),
    ))
    .orderBy(desc(pmsBuiWenlvAiSessions.updatedAt))
    .limit(1);
  return row ? toView(row) : null;
}

async function requireActiveSession(id: string): Promise<AiSessionView> {
  const session = await getAiSession(id);
  if (!session) throw new AiSessionError(404, 'AI 会话不存在');
  if (session.status !== 'active') {
    throw new AiSessionError(409, `会话已${session.status === 'completed' ? '完成' : '终止'}，不可再写（请先恢复为 active）`);
  }
  return session;
}

/** 更新 stage/status/intent（白名单）。终态 completed/abandoned 只由此显式置位。 */
export async function updateAiSession(id: string, patch: SessionPatch): Promise<AiSessionView | null> {
  const session = await getAiSession(id);
  if (!session) return null;
  const set: Record<string, unknown> = { updatedAt: NOW() };
  if (patch.stage !== undefined) set.stage = patch.stage;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.intent !== undefined) set.intent = patch.intent;
  const [row] = await db.update(pmsBuiWenlvAiSessions).set(set)
    .where(eq(pmsBuiWenlvAiSessions.id, id)).returning();
  return row ? toView(row) : null;
}

/** 追加对话记录（读改写；向导同一会话串行推进）。要求会话 active。 */
export async function appendTranscript(id: string, entries: AiTranscriptEntry[]): Promise<AiSessionView> {
  const session = await requireActiveSession(id);
  const transcript = [...session.transcript, ...entries];
  const [row] = await db.update(pmsBuiWenlvAiSessions)
    .set({ transcript, updatedAt: NOW() })
    .where(eq(pmsBuiWenlvAiSessions.id, id)).returning();
  return toView(row);
}

/**
 * 存某步草案到 draftSnapshots（覆盖该 stage 键 = 换版；其余阶段草案保留）。
 * 可选 advanceTo：存草案同时推进 stage。四表不发生任何写入。
 */
export async function saveStageDraft(
  id: string,
  stage: WenlvAiStage,
  draft: unknown,
  advanceTo?: WenlvAiStage,
): Promise<AiSessionView> {
  const session = await requireActiveSession(id);
  const draftSnapshots: DraftSnapshots = { ...session.draftSnapshots, [stage]: draft };
  const [row] = await db.update(pmsBuiWenlvAiSessions)
    .set({ draftSnapshots, ...(advanceTo ? { stage: advanceTo } : {}), updatedAt: NOW() })
    .where(eq(pmsBuiWenlvAiSessions.id, id)).returning();
  return toView(row);
}

// ===== 采纳落盘（唯一写四表的通道；事务）=====

export interface AdoptNpcDraft {
  id?: string;
  name: string;
  order?: number;
  characterId?: string | null;
  description?: string | null;
  role?: string | null;
  persona?: WenlvNpcPersona | null;
  relationships?: WenlvNpcRelationship[] | null;
  lines?: WenlvNpcLine[] | null;
}

export interface AdoptChapterDraft {
  id?: string;
  title: string;
  timeLabel?: string | null;
  goal?: string | null;
  order?: number;
}

/** 场景草案：id 缺省新建、提供则换版/细调覆盖；chapterId 必填（定位归属章）。 */
export interface AdoptSceneDraft {
  id?: string;
  chapterId: string;
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
  triggerCondition?: WenlvCondition | null;
  priority?: number | null;
  rewardId?: string | null;
}

export interface AdoptFlowDraft {
  id?: string;
  fromSceneId: string;
  toSceneId: string;
  type?: WenlvEdgeType | null;
  choiceText?: string | null;
  condition?: WenlvCondition | null;
  grants?: string[] | null;
  sanDelta?: number | null;
  sortOrder?: number | null;
}

export interface AdoptPayload {
  /** 世界观对象，merge 进 script_rooms.config.worldview。 */
  worldview?: unknown;
  npcs?: AdoptNpcDraft[];
  chapters?: AdoptChapterDraft[];
  scenes?: AdoptSceneDraft[];
  flows?: AdoptFlowDraft[];
}

export interface AdoptResult {
  worldview: boolean;
  npcs: string[];
  chapters: string[];
  scenes: string[];
  flows: string[];
}

/**
 * 采纳落盘事务：草案 → room.config / npcs / chapters / scenes / flows（按 id upsert）。
 * 未采纳的草案不经过本函数，四表零变化。同包内 chapters 先于 scenes 落（新章新场可同批采纳）。
 */
export async function adoptStageDrafts(
  sessionId: string,
  scriptRoomId: string,
  payload: AdoptPayload,
  advanceTo?: WenlvAiStage,
): Promise<AdoptResult> {
  const session = await requireActiveSession(sessionId);
  if (session.scriptRoomId !== scriptRoomId) throw new AiSessionError(400, '会话与剧本房不匹配');
  const room = await getRoomOrThrow(scriptRoomId);

  const result: AdoptResult = { worldview: false, npcs: [], chapters: [], scenes: [], flows: [] };

  await db.transaction(async (tx) => {
    // 世界观 → room.config.worldview（merge，不覆盖 config 其它键）。
    if (payload.worldview !== undefined) {
      const prevConfig = (room.config ?? {}) as Record<string, unknown>;
      await tx.update(pmsBuiWenlvScriptRooms)
        .set({ config: { ...prevConfig, worldview: payload.worldview }, updatedAt: NOW() })
        .where(eq(pmsBuiWenlvScriptRooms.id, room.id));
      result.worldview = true;
    }

    // 角色 → npcs（productId = room.contentId）。
    for (const npc of payload.npcs ?? []) {
      const id = npc.id?.trim() || randomUUID();
      const row = {
        id,
        productId: room.contentId,
        name: npc.name,
        orderId: npc.order ?? 0,
        characterId: npc.characterId ?? null,
        description: npc.description ?? null,
        role: npc.role ?? null,
        persona: npc.persona ?? {},
        relationships: npc.relationships ?? [],
        lines: npc.lines ?? [],
      };
      await tx.insert(pmsBuiWenlvNpcs).values(row).onConflictDoUpdate({
        target: pmsBuiWenlvNpcs.id,
        set: {
          name: row.name, orderId: row.orderId, characterId: row.characterId,
          description: row.description, role: row.role, persona: row.persona,
          relationships: row.relationships, lines: row.lines, updatedAt: NOW(),
        },
      });
      result.npcs.push(id);
    }

    // 骨架 → chapters。
    for (const ch of payload.chapters ?? []) {
      const id = ch.id?.trim() || randomUUID();
      const row = {
        id, scriptRoomId: room.id, title: ch.title,
        timeLabel: ch.timeLabel ?? null, goal: ch.goal ?? null, order: ch.order ?? 0,
      };
      await tx.insert(pmsBuiWenlvChapters).values(row).onConflictDoUpdate({
        target: pmsBuiWenlvChapters.id,
        set: { title: row.title, timeLabel: row.timeLabel, goal: row.goal, order: row.order, updatedAt: NOW() },
      });
      result.chapters.push(id);
    }

    // 场景（含结局场景）。chapterId 必须属于本房（已存在或同包章节）。
    if (payload.scenes && payload.scenes.length > 0) {
      const knownChapterIds = new Set<string>(result.chapters);
      const existChapters = await tx.select({ id: pmsBuiWenlvChapters.id }).from(pmsBuiWenlvChapters)
        .where(eq(pmsBuiWenlvChapters.scriptRoomId, room.id));
      for (const c of existChapters) knownChapterIds.add(c.id);

      for (const sc of payload.scenes) {
        if (!sc.chapterId || !knownChapterIds.has(sc.chapterId)) {
          throw new AiSessionError(400, `场景「${sc.title}」的 chapterId 缺失或不属于该剧本房`);
        }
        const id = sc.id?.trim() || randomUUID();
        const row = {
          id,
          chapterId: sc.chapterId,
          title: sc.title,
          type: sc.type ?? 'narrative',
          content: sc.content ?? null,
          npcId: sc.npcId ?? null,
          atoms: sc.atoms ?? [],
          puzzle: sc.puzzle ?? null,
          order: sc.order ?? 0,
          venuePointId: sc.venuePointId ?? null,
          requires: sc.requires ?? null,
          geo: sc.geo ?? null,
          mapX: sc.mapX ?? null,
          mapY: sc.mapY ?? null,
          image: sc.image ?? null,
          narrationUrl: sc.narrationUrl ?? null,
          grants: sc.grants ?? [],
          npcLineIds: sc.npcLineIds ?? [],
          openingLine: sc.openingLine ?? null,
          chapterGoal: sc.chapterGoal ?? null,
          perspectiveCharacterId: sc.perspectiveCharacterId ?? null,
          sanDelta: sc.sanDelta ?? 0,
          arAssetUrl: sc.arAssetUrl ?? null,
          arAssetUrls: sc.arAssetUrls ?? {},
          arDialogue: sc.arDialogue ?? null,
          triggerCondition: sc.triggerCondition ?? null,
          priority: sc.priority ?? 0,
          rewardId: sc.rewardId ?? null,
        };
        await tx.insert(pmsBuiWenlvScenes).values(row).onConflictDoUpdate({
          target: pmsBuiWenlvScenes.id,
          set: {
            title: row.title, type: row.type, content: row.content, npcId: row.npcId,
            atoms: row.atoms, puzzle: row.puzzle, order: row.order, venuePointId: row.venuePointId,
            requires: row.requires, geo: row.geo, mapX: row.mapX, mapY: row.mapY, image: row.image,
            narrationUrl: row.narrationUrl, grants: row.grants, npcLineIds: row.npcLineIds,
            openingLine: row.openingLine, chapterGoal: row.chapterGoal,
            perspectiveCharacterId: row.perspectiveCharacterId, sanDelta: row.sanDelta,
            arAssetUrl: row.arAssetUrl, arAssetUrls: row.arAssetUrls, arDialogue: row.arDialogue,
            triggerCondition: row.triggerCondition, priority: row.priority, rewardId: row.rewardId,
            updatedAt: NOW(),
          },
        });
        result.scenes.push(id);
      }
    }

    // 流转（四型 + jsonb condition/grants）。from/to 存在性不在此强制，由发布闸 R1/R3 兜底。
    for (const fl of payload.flows ?? []) {
      const id = fl.id?.trim() || randomUUID();
      const row = {
        id,
        fromSceneId: fl.fromSceneId,
        toSceneId: fl.toSceneId,
        type: fl.type ?? 'auto',
        choiceText: fl.choiceText ?? null,
        condition: fl.condition ?? null,
        grants: fl.grants ?? [],
        sanDelta: fl.sanDelta ?? 0,
        sortOrder: fl.sortOrder ?? 0,
      };
      await tx.insert(pmsBuiWenlvFlows).values(row).onConflictDoUpdate({
        target: pmsBuiWenlvFlows.id,
        set: {
          type: row.type, choiceText: row.choiceText, condition: row.condition,
          grants: row.grants, sanDelta: row.sanDelta, sortOrder: row.sortOrder, updatedAt: NOW(),
        },
      });
      result.flows.push(id);
    }

    if (advanceTo) {
      await tx.update(pmsBuiWenlvAiSessions).set({ stage: advanceTo, updatedAt: NOW() })
        .where(eq(pmsBuiWenlvAiSessions.id, sessionId));
    } else {
      await tx.update(pmsBuiWenlvAiSessions).set({ updatedAt: NOW() })
        .where(eq(pmsBuiWenlvAiSessions.id, sessionId));
    }
  });

  return result;
}

async function getRoomOrThrow(scriptRoomId: string): Promise<ScriptRoom> {
  const [room] = await db.select().from(pmsBuiWenlvScriptRooms)
    .where(eq(pmsBuiWenlvScriptRooms.id, scriptRoomId)).limit(1);
  if (!room) throw new AiSessionError(404, '剧本房不存在');
  return room;
}

// ===== 步①反向锚定：场地档案能力 + 商户合作配置 + 可锚点位 =====

export interface AnchorContext {
  room: Pick<ScriptRoom, 'id' | 'name' | 'venueId' | 'mode' | 'difficulty' | 'config'>;
  venue: unknown | null;
  venueProfile: unknown | null;
  merchants: unknown[];
  venuePoints: unknown[];
}

/**
 * 意图采集步反向锚定：room.venueId → 场地主数据 / 能力档案（supportActions、
 * deployableAtoms、动线半径、时段）/ 合作商户（含房间挂接与场地级）/ 可绑定点位。
 * room 不存在 404；未绑场地时 venue 各域为 null/[]，不报错（向导可提示先绑场地）。
 */
export async function buildAnchorContext(scriptRoomId: string): Promise<AnchorContext> {
  const room = await getRoomOrThrow(scriptRoomId);
  const context: AnchorContext = {
    room: {
      id: room.id, name: room.name, venueId: room.venueId,
      mode: room.mode, difficulty: room.difficulty, config: room.config,
    },
    venue: null,
    venueProfile: null,
    merchants: [],
    venuePoints: [],
  };
  if (!room.venueId) return context;

  const [venueRow] = await db.select().from(pmsBuiWenlvVenues)
    .where(eq(pmsBuiWenlvVenues.id, room.venueId)).limit(1);
  context.venue = venueRow ?? null;

  const [profile] = await db.select().from(pmsBuiWenlvVenueProfiles)
    .where(eq(pmsBuiWenlvVenueProfiles.venueId, room.venueId)).limit(1);
  context.venueProfile = profile ?? null;

  context.merchants = await db.select().from(pmsBuiWenlvMerchantPartners)
    .where(eq(pmsBuiWenlvMerchantPartners.venueId, room.venueId));

  context.venuePoints = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.venueId, room.venueId));

  return context;
}
