// 节点完成链路（实景原子 Task 4，自 routes/mini/wenlv.ts 的 POST /answer 原样抽取）：
// 谜题/原子全对之后统一走「rally 到场发章闸 → grants 发放（+ visited 标记）→
// 证物表同步 → puzzle_pass 边流转 → progress 写库 → answer 事件流水 → 结局结算 →
// 队伍进度同步」。/answer 的协作/单人两条后置链路与原子完成端点共用本函数，不得各写一份。
import { randomUUID } from 'node:crypto';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvCollectibles,
  pmsBuiWenlvProgress, pmsBuiWenlvEvents, pmsBuiWenlvTeams,
  pmsBuiWenlvPlayerProgress,
} from '../../../db/schema/index.js';
import type { WenlvState, WenlvCondition, WenlvTeamProgress } from '../../../db/schema/wenlv.js';
import { eq, and } from 'drizzle-orm';
import { applyGrants, markVisited, selectEnding, mergeStates } from '../../wenlv-engine.js';
import { traverseEdges, applyTraversalResult } from '../graph-traversal.js';
import type { TraversableEdge } from '../graph-traversal.js';

/**
 * 结局结算所需最小行（引擎 selectEnding 入参形状）。0079 后由
 * projectScenesToEndings(graph.scenes) 产出（type='ending' 的场景），不再查旧 endings 表。
 */
export interface EndingLike {
  id: string;
  priority?: number | null;
  triggerCondition?: WenlvCondition | null;
}

/** 角色上下文（透传给边条件求值与结局判定）。 */
export interface NodeCompletionCharOpts {
  characterId?: string | null;
  characterSkillIds?: string[];
}

export interface CompleteNodeInput {
  productId: string;
  progressId: string;
  nodeId: string;
  /** 携带最新 state 的引用：函数基于它派生 next/finalNext 并写库；不原地改写其 visited/collected。 */
  state: WenlvState;
  miniUserId: string;
  sessionId?: string | null;
  /** 完成相关节点字段：rally 发章闸读 venuePointId/title，发放读 grants。 */
  node: { venuePointId?: string | null; title?: string | null; grants?: string[] | null };
  /** 本房规范图投影出的全量边（projectFlowsToEdges(graph.flows).edges）；答对沿 puzzle_pass 流转。 */
  edges: TraversableEdge[];
  /** 本房结局投影（projectScenesToEndings(graph.scenes)）；供结局结算，不再查旧 endings 表。 */
  endings: EndingLike[];
  /** progress 当前行：结局落库要读 status/endingId（防阶梯倒挂/时间戳刷新）。 */
  progress: { id: string; status: string; endingId?: string | null };
  charOpts?: NodeCompletionCharOpts;
  /** 判定用并集 state（组局/场次）；散客可省，回退 input.state。 */
  evalState?: WenlvState;
  /** 组局模式：传队伍 id 才同步 team.progress；null/缺省 = 散客/单人场次不同步队伍。 */
  team?: { id: string } | null;
  /** 队伍当前 progress 的协作题答题态（只取 collaborativeAnswers；并集三键以 evalState 重算）。 */
  teamProgress?: Pick<WenlvTeamProgress, 'collaborativeAnswers'> | WenlvTeamProgress | null;
  /** 协作题链路：完成后从 team.progress.collaborativeAnswers 删除本节点键。 */
  clearCollabKey?: string | null;
  /** answer 事件 payload（协作题带 collaborative/leaderConfirm；单人 {}）。 */
  eventPayload?: Record<string, unknown>;
  /** 事件类型：谜题链路 'answer'（默认），原子完成链路 'node_complete'。 */
  eventType?: 'answer' | 'node_complete';
}

export interface NodeCompletionResult {
  /** rally 到场发章闸拦截文案；非空 = 链路在发章前中止（/answer 回 403），其余字段不可用。 */
  stampError: string | null;
  /** 最终写库的 state（含边流转结果）。 */
  state: WenlvState;
  /** 主位结局列表（队伍/场次=并集只读求值；散客=mine）。 */
  endings: string[];
  /** 我个人行的结局结算结果。 */
  mine: string[];
  /** 同步后的队伍进度；非组局为 null。 */
  teamProgress: WenlvState | null;
}

/**
 * 将节点/答题 effects.grant 新发放的证物 ID 追加到 pmsBuiWenlvPlayerProgress.collectedCollectibles，
 * 使 NPC 对话的 clueIds 判定能看到节点发放的证物（与扫码收集的证物合并）。
 * 若该玩家尚无 player_progress 行（未开始过任何 NPC 对话），则跳过——证物已在 state.collected，
 * 对话开始时 wenlv-dialogue.ts 会从主进度表合并。
 */
export async function syncPlayerCollectibles(productId: string, miniUserId: string, newlyGrantedIds: string[]) {
  if (!newlyGrantedIds.length) return;
  const [row] = await db.select({ id: pmsBuiWenlvPlayerProgress.id, collectedCollectibles: pmsBuiWenlvPlayerProgress.collectedCollectibles })
    .from(pmsBuiWenlvPlayerProgress)
    .where(and(
      eq(pmsBuiWenlvPlayerProgress.productId, productId),
      eq(pmsBuiWenlvPlayerProgress.miniUserId, miniUserId),
    ))
    .limit(1);
  if (!row) return;
  const merged = Array.from(new Set([...(row.collectedCollectibles || []), ...newlyGrantedIds]));
  await db.update(pmsBuiWenlvPlayerProgress)
    .set({ collectedCollectibles: merged, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvPlayerProgress.id, row.id));
}

// 检查结局并落库（返回满足条件的结局 id 列表，**胜出者排首位**）
//
// 为什么用 `selectEnding` 而不是旧的 `findTriggeredEndings` + `hit[0]`：
//   本引擎条件语言单调（无否定、state 只增不减）⇒ 多个结局必然**同时**满足，
//   旧实现落 `hit[0]` 而 `select` 无 `orderBy`，游客拿到哪个结局由 PG 行序决定。
//   `selectEnding` 从所有满足项中取 priority 最大者（平手按 id 字典序），彻底消除行序依赖。
//   与走场模拟器 `services/wenlv-simulate.ts` **共用同一份**（不得各写一份）。
export async function settleEndings(
  endings: EndingLike[], state: WenlvState, progressId: string,
  current: { status: string; endingId?: string | null },
  opts?: NodeCompletionCharOpts,
): Promise<string[]> {
  const { endingId, satisfiedIds } = selectEnding(endings, state, opts);
  // 结局落库的**两条正交规则**（2026-10-01 订正：此前把两条捆在一个守卫里，造成「阶梯倒挂」）：
  //   ① `completedAt` —— D6「时间戳一律首次进入时盖章，不覆盖」⇒ **只在首次**进终态时写。
  //      （旧实现每次命中都写 `new Date()`，用户每多答一题完成时间就被刷新，端到端时长被掩盖。）
  //   ② `endingId`    —— 跟随达成度，**只升不降**（守卫 = 值变了才写）。
  //      ⚠️ 此前写成「已 completed 就不再改写」⇒ 低档结局一旦落库就永久钉死，更高档永远拿不到。
  //         实测受害产品：`WENLV_1790582980` 的 `END_LEAVE_QUIETLY`（条件 = 入口关发放的那一条线索）
  //         ⇒ 游客过完第 1 关即被翻成 completed，其余 4 档结构上不可达。
  //
  // 为什么**不可能降级**（故无需再查一次当前 priority）：条件语言单调 —— `evalCondition` 无否定分支、
  //   `applyEffects`/`markVisited` 只置 true、全库无置 false 的路径（证明见
  //   specs/2026-09-18-wenlv-ending-resolution-design.md §2.1）⇒ 满足集只增不减 ⇒
  //   `selectEnding` 取的 priority 最大者**只会变大**。唯一例外是管理员在玩家游玩途中改 endings 表。
  if (endingId && endingId !== current.endingId) {
    await db.update(pmsBuiWenlvProgress).set({
      endingId, status: 'completed',
      ...(current.status === 'completed' ? {} : { completedAt: new Date() }),
      updatedAt: new Date(),
    }).where(eq(pmsBuiWenlvProgress.id, progressId));
  }
  return satisfiedIds;
}

// 队伍结局：并集**只读**求值，**绝不落库**（P2 §4.4「队伍结局读并集」/ S §6.3 主位）。
// 为什么另开一个函数、而不是给 settleEndings 加一份 state 参数：后者兼具「求值 + **落库到我那行**」，
// 而它的落库必须**永远**按个人（S:585「队员的个人 completedAt 恒为 NULL」）⇒ 拆成两条路更难写错。
// 散客路径**不调它** ⇒ 零新增读。
export function teamEndings(endings: EndingLike[], evalState: WenlvState): string[] {
  return selectEnding(endings, evalState).satisfiedIds;
}

// 集章「到场证明」的**运行时那一半**（发布闸只在 publish 那一刻跑一次）。
// 为什么必须有它：发布闸不会随之后的 PATCH 重跑 —— 一个合法的 rally 产品在发布后
// 把发章节点的 venuePointId 改回 null，就精确复现了「发布门放行、运行时无人拦」的旧缺陷。
// 故在**应用 grants 之前**再判一次：rally 产品里，未绑定点位的节点不得发放印章。
// fail-closed：拒绝（403）而不是静默发章；返回文案须说清原因。
// 判定「是否发章」按 collectibles.type='stamp' 现查，不靠调用方信仰发布闸——
// 发布后 PATCH 同样能塞进非印章引用，此处只拦印章（真正拆掉商业承诺的那一类）。
// 成本：只有「未绑点位且 grants 非空」的可疑分支才查库，正常路径（已绑点位）零额外查询。
export async function rallyStampOnSiteErr(
  productId: string,
  node: { venuePointId?: string | null; title?: string | null; grants?: string[] | null },
): Promise<string | null> {
  if (node.venuePointId) return null;
  const grant = node.grants ?? [];
  if (grant.length === 0) return null;
  const [product] = await db.select({ mode: pmsBuiWenlvProducts.mode }).from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  if (product?.mode !== 'rally') return null;
  const stamps = await db.select({ id: pmsBuiWenlvCollectibles.id }).from(pmsBuiWenlvCollectibles)
    .where(and(eq(pmsBuiWenlvCollectibles.productId, productId), eq(pmsBuiWenlvCollectibles.type, 'stamp')));
  const granted = grant.filter((id) => stamps.some((s) => s.id === id));
  if (granted.length === 0) return null;
  return `节点[${node.title ?? ''}] 未绑定点位，集章模式下不能发放印章（${granted.join('、')}）：集章必须到场扫码，禁止远程集章`;
}

/**
 * 节点完成链路：completed 语义 = visited 标记 + grants 发放 + 事件流水 + 结局结算/推进。
 * （自 POST /answer 原样搬移；唯一新增分支是末尾对 state.atoms 的显式回带——
 * 旧引擎 applyGrants 出口只含 visited/collected/completed，原子链路的 done 记录不回带会被
 * 持久化丢掉；/answer 旧链路 state 不带 atoms 键，该分支对其零影响。）
 *
 * 协作题与单人题的调用差异全部由入参表达：team/teamProgress/clearCollabKey/eventPayload/
 * evalState/sessionId；两条 /answer 后置链路与原子完成端点共用本函数。
 */
export async function applyNodeCompletion(input: CompleteNodeInput): Promise<NodeCompletionResult> {
  const {
    productId, progressId, nodeId, state, miniUserId,
    sessionId = null, node, edges, endings: endingRows, progress, charOpts,
    team = null, teamProgress: existingTeamProgress = null,
    clearCollabKey = null, eventPayload = {}, eventType = 'answer',
  } = input;
  const evalState = input.evalState ?? state;

  const stampError = await rallyStampOnSiteErr(productId, node);
  if (stampError) return { stampError, state, endings: [], mine: [], teamProgress: null };

  // 单题节点：答对即通关 —— 应用产出（grants）+ 发章 + 结算结局。
  const next = applyGrants(node.grants, markVisited(state, nodeId));
  // 同步答题发放的证物到 pmsBuiWenlvPlayerProgress.collectedCollectibles
  const prevCollected = new Set(Object.keys(state.collected || {}));
  const newlyGranted = Object.keys(next.collected || {}).filter((id) => !prevCollected.has(id));
  if (newlyGranted.length) {
    await syncPlayerCollectibles(productId, miniUserId, newlyGranted);
  }

  // 剧情图遍历：谜题答对沿 puzzle_pass 边流转（边由规范图投影传入；空集 = 无边剧本，零效果）
  let finalNext = next;
  if (edges.length) {
    const trav = traverseEdges(edges, nodeId, next, 'puzzle_pass', charOpts);
    const applied = applyTraversalResult(trav, next);
    finalNext = applied.state;
    const edgeGrants = trav.grants.filter((id) => !prevCollected.has(id));
    if (edgeGrants.length) {
      await syncPlayerCollectibles(productId, miniUserId, edgeGrants);
    }
  }

  // 原子链路回带（见函数注释）：state.atoms 存在时原样挂回最终 state 再持久化。
  if (state.atoms) finalNext = { ...finalNext, atoms: state.atoms };

  await db.update(pmsBuiWenlvProgress).set({ state: finalNext, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvProgress.id, progressId));
  await db.insert(pmsBuiWenlvEvents).values({
    id: randomUUID(), productId, miniUserId, eventType, nodeId,
    payload: eventPayload,
  });

  // 结局结算（组局/场次：个人行落库用 finalNext，队伍主位结局用并集只读求值）
  const isTeam = !!team || !!sessionId;
  const mine = await settleEndings(endingRows, finalNext, progressId, progress, charOpts);
  const endings = isTeam ? teamEndings(endingRows, mergeStates([evalState, finalNext])) : mine;

  // 队伍进度同步：visited/collected/completed 用并集整体重算；collaborativeAnswers 保留，
  // 协作题完成时删掉本节点键（与 /answer 协作链路逐字一致）。
  let teamProgressOut: WenlvState | null = null;
  if (team) {
    const merged = mergeStates([evalState, finalNext]);
    const collaborativeAnswers: Record<string, Record<string, unknown>> = {
      ...(existingTeamProgress?.collaborativeAnswers ?? {}),
    };
    if (clearCollabKey) delete collaborativeAnswers[clearCollabKey];
    const nextTeamProgress: WenlvTeamProgress = {
      visited: merged.visited,
      collected: merged.collected,
      completed: merged.completed,
      collaborativeAnswers,
    };
    await db.update(pmsBuiWenlvTeams).set({ progress: nextTeamProgress })
      .where(eq(pmsBuiWenlvTeams.id, team.id));
    teamProgressOut = nextTeamProgress;
  }

  return { stampError: null, state: finalNext, endings, mine, teamProgress: teamProgressOut };
}
