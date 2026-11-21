// 导演 v1（spec §6.2 P1b，计划 Task 16）：跨夜运行时编排——卡关救援 / 硬锚点 / 静止警报。
//
// 纪律：
//   · computeTick 是**纯函数**（无 IO）：只根据 state/event/anchors/时间产出决策；
//   · 所有 IO（upsert 状态行、读 product/node/npc、dialogue hint 通道下发）都在 tickDirector；
//   · mini 侧一律 fire-and-forget 调用（`void tickDirector(...).catch(console.error)`），
//     绝不阻塞主请求；
//   · 惰性 tick，无调度器：状态只在 mini 行为事件（trigger/answer/atom complete）后推进。
import { randomUUID } from 'node:crypto';
import { eq, and, or, inArray, desc } from 'drizzle-orm';
import { db, type Tx } from '../../db/index.js';
import {
  pmsBuiWenlvDirectorStates, pmsBuiWenlvProgress, pmsBuiWenlvProducts,
  pmsBuiWenlvScenes, pmsBuiWenlvNpcs, pmsBuiWenlvDialogues, pmsBuiWenlvTeams,
} from '../../db/schema/index.js';
import type {
  DirectorState as SchemaDirectorState,
  DirectorAnchor,
  DirectorAlert,
} from '../../db/schema/wenlv.js';

// 数据类型的唯一真相在 db/schema/wenlv.ts（jsonb 列契约）；此处再导出供路由层消费。
export type { DirectorState, DirectorAnchor, DirectorAlert } from '../../db/schema/wenlv.js';

/** 缺省停滞阈值（分钟）：同一原子/键停滞超过它 ⇒ 卡关 hint。 */
export const DEFAULT_STALL_MINUTES = 20;
/** 静止阈值（分钟）：超过它无动作 ⇒ 睡着/离场 critical 警报（计划 §Task16 固定值）。 */
export const STATIC_MINUTES = 90;

export interface TickIntervention {
  kind: 'stall-hint' | 'anchor';
  message?: string;
  nodeId?: string;
}

export interface TickDecision {
  state: SchemaDirectorState;
  alerts: DirectorAlert[];
  intervention: TickIntervention | null;
}

/**
 * 导演决策纯函数。
 *
 * 判定次序（每轮惰性 tick）：
 *  1. event.key 与 state.lastKey 不同 ⇒ 玩家在新原子/节点上有动作：刷新 lastActionAt、
 *     复位 stallNotified/staticNotified（活动恢复，允许再次报警）。相同 ⇒ lastActionAt 不动。
 *  2. 硬锚点：anchors 中 dueAt ≤ now 且未 fired 者全部标记 fired；首个到期锚点产出 anchor
 *     干预（与玩家是否刚动作无关——时间到即触发）。fired 标记以 state.anchors 为准，
 *     入参 anchors（产品配置）每次重给也不会清掉运行时标记。
 *  3. 静止：idle > 90min 且未通知过 ⇒ critical/static 警报（不发 stall-hint：人疑似离场，
 *     暗示无意义），staticNotified 置位（幂等）。
 *  4. 卡关：同一键且 idle > stallMinutes、未通知过、本轮无更高优先级干预 ⇒
 *     stall-hint 干预 + warn/stall 报警，stallNotified 置位（幂等）。
 */
export function computeTick(input: {
  now: Date;
  state: SchemaDirectorState;
  event: { key: string };
  stallMinutes?: number;
  anchors?: DirectorAnchor[];
}): TickDecision {
  const { now, event } = input;
  const stallMinutes = input.stallMinutes ?? DEFAULT_STALL_MINUTES;
  const nowIso = now.toISOString();
  const alerts: DirectorAlert[] = [];
  let intervention: TickIntervention | null = null;

  // 合并配置锚点与运行时 fired 标记（同 key 沿用已 fired，单调只增不减）。
  const prevByKey = new Map((input.state.anchors ?? []).map((a) => [a.key, a]));
  const anchors: DirectorAnchor[] = (input.anchors ?? input.state.anchors ?? []).map((a) => ({
    ...a,
    fired: prevByKey.get(a.key)?.fired ?? a.fired ?? false,
  }));

  const next: SchemaDirectorState = { ...input.state, anchors };

  const sameKey = !!input.state.lastKey && input.state.lastKey === event.key;
  if (!sameKey) {
    next.lastActionAt = nowIso;
    next.lastKey = event.key;
    next.stallNotified = false;
    next.staticNotified = false;
  }
  const idleMs = now.getTime() - new Date(next.lastActionAt).getTime();

  // 硬锚点（优先于 stall：时间到的剧情节点必须准时发生）。
  const due = anchors.filter((a) => !a.fired && Date.parse(a.dueAt) <= now.getTime());
  if (due.length) {
    for (const a of due) a.fired = true;
    const first = due[0];
    intervention = { kind: 'anchor', nodeId: first.nodeId, message: first.message };
  }

  if (idleMs > STATIC_MINUTES * 60_000 && !next.staticNotified) {
    next.staticNotified = true;
    alerts.push({
      id: `static:${event.key}`,
      level: 'critical',
      kind: 'static',
      message: '长时间无任何动作，玩家可能睡着或离场',
      createdAt: nowIso,
    });
  } else if (sameKey && !next.staticNotified && idleMs > stallMinutes * 60_000 && !next.stallNotified && !intervention) {
    next.stallNotified = true;
    alerts.push({
      id: `stall:${event.key}`,
      level: 'warn',
      kind: 'stall',
      message: `同一原子停滞超过 ${stallMinutes} 分钟`,
      createdAt: nowIso,
    });
    intervention = { kind: 'stall-hint' };
  }

  return { state: next, alerts, intervention };
}

/**
 * 向 NPC 对话 hint 通道下发一条 NPC 消息：追加为玩家在该节点 active dialogue 的
 * assistant 消息（前端轮询 GET /dialogue/:id 时以气泡展示，与 SSE hint 事件同通道同形状）。
 * 没有 active dialogue（玩家当前没在与该 NPC 对话）⇒ 返回 false，调用方按静默跳过处理；
 * 这是惰性 tick 的 best-effort 通道，不做离线推送。
 * 团队共享对话（dialogues.teamId）同投：玩家所属队伍在该节点的 active dialogue 也算。
 */
export async function appendNpcMessage(opts: {
  productId: string;
  miniUserId: string;
  nodeId: string;
  text: string;
}): Promise<boolean> {
  const { productId, miniUserId, nodeId, text } = opts;
  const teams = await db.select({ id: pmsBuiWenlvTeams.id, members: pmsBuiWenlvTeams.members })
    .from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.productId, productId));
  const myTeamIds = teams
    .filter((t) => (t.members ?? []).some((m) => m.userId === miniUserId))
    .map((t) => t.id);

  const dialogueFilter = [
    eq(pmsBuiWenlvDialogues.productId, productId),
    eq(pmsBuiWenlvDialogues.nodeId, nodeId),
    eq(pmsBuiWenlvDialogues.status, 'active'),
    myTeamIds.length
      ? or(eq(pmsBuiWenlvDialogues.miniUserId, miniUserId), inArray(pmsBuiWenlvDialogues.teamId, myTeamIds))
      : eq(pmsBuiWenlvDialogues.miniUserId, miniUserId),
  ];
  const [dialogue] = await db.select().from(pmsBuiWenlvDialogues)
    .where(and(...dialogueFilter))
    .orderBy(desc(pmsBuiWenlvDialogues.updatedAt))
    .limit(1);
  if (!dialogue) return false;

  await db.update(pmsBuiWenlvDialogues).set({
    messages: [...dialogue.messages, { role: 'assistant', content: text, ts: Date.now() }],
    updatedAt: new Date(),
  }).where(eq(pmsBuiWenlvDialogues.id, dialogue.id));
  return true;
}

/**
 * 在事务内取得导演状态行的行锁（SELECT ... FOR UPDATE），行不存在时原子建行
 * （INSERT ... ON CONFLICT (progress_id) DO NOTHING）后在**同一事务**内重读上锁。
 *
 * 并发语义：两个首 tick/insert 撞车时，负方的 INSERT 阻塞到正方提交后变为 no-op，
 * 随后的 FOR UPDATE 再阻塞到正方释放行锁——两个事务在该行上严格串行，不再撞唯一索引。
 * `created` 仅真正插入该行的事务为 true（DO NOTHING 不产生 RETURNING 行）。
 * 必须在调用方事务内调用（行锁随事务持有到提交/回滚）。
 */
async function lockOrSeedDirectorState(
  tx: Tx,
  productId: string,
  progressId: string,
  seed: SchemaDirectorState,
): Promise<{ row: typeof pmsBuiWenlvDirectorStates.$inferSelect; created: boolean }> {
  const now = new Date();
  const [inserted] = await tx.insert(pmsBuiWenlvDirectorStates).values({
    id: `ds_${randomUUID()}`, productId, progressId, state: seed, alerts: [],
    createdAt: now, updatedAt: now,
  })
    .onConflictDoNothing({ target: pmsBuiWenlvDirectorStates.progressId })
    .returning({ id: pmsBuiWenlvDirectorStates.id });
  const [row] = await tx.select().from(pmsBuiWenlvDirectorStates)
    .where(eq(pmsBuiWenlvDirectorStates.progressId, progressId))
    .for('update')
    .limit(1);
  // 自己刚插入或冲突后读到并发方的行，二者必居其一。
  return { row: row!, created: !!inserted };
}

/** 向导演状态行追加一条报警（manual 值守留言等）；行不存在时随最小种子 state 建行。 */
export async function appendDirectorAlert(
  productId: string,
  progressId: string,
  alert: DirectorAlert,
): Promise<void> {
  // 与 tickDirector 共用同一把行锁路径：锁行→读 alerts→按 id 去重 append→写回，
  // 避免与 tick 的读-改-写交叠时 manual alert 被旧快照覆盖。
  await db.transaction(async (tx) => {
    const now = new Date();
    const seed: SchemaDirectorState = { startedAt: now.toISOString(), lastActionAt: now.toISOString() };
    const { row } = await lockOrSeedDirectorState(tx, productId, progressId, seed);
    const alerts = [...(row.alerts ?? [])];
    if (!alerts.some((a) => a.id === alert.id)) alerts.push(alert);
    await tx.update(pmsBuiWenlvDirectorStates).set({ alerts, updatedAt: now })
      .where(eq(pmsBuiWenlvDirectorStates.id, row.id));
  });
}

/**
 * 导演惰性 tick（IO 层）：mini 行为事件后 fire-and-forget 调用。
 * 流程：取 progress → 取/建导演状态行 → 读 product.config.director.anchors →
 * computeTick → 写回 state/alerts → intervention 经 NPC 对话 hint 通道下发。
 * 任何失败由调用方 .catch（本函数不吞异常，便于日志看到原因）。
 */
export async function tickDirector(
  productId: string,
  progressId: string,
  eventKey: string,
): Promise<void> {
  const [progress] = await db.select({
    id: pmsBuiWenlvProgress.id,
    productId: pmsBuiWenlvProgress.productId,
    miniUserId: pmsBuiWenlvProgress.miniUserId,
    status: pmsBuiWenlvProgress.status,
  }).from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.id, progressId), eq(pmsBuiWenlvProgress.productId, productId)))
    .limit(1);
  if (!progress || progress.status !== 'active') return;

  // 事务内完成「建行（锁行）+ 读 product/state + computeTick + 写回」：
  // FOR UPDATE 行锁让并发 tick / appendDirectorAlert 串行化，杜绝旧快照覆盖；
  // 事务内只做 DB 读写与纯函数决策，hint 下发（appendNpcMessage 等 IO）一律放到事务外。
  const result = await db.transaction(async (tx) => {
    const now = new Date();
    // 首次 tick：只建种子（以本次事件为首个动作），不判定、不报警。
    const seed: SchemaDirectorState = {
      startedAt: now.toISOString(),
      lastActionAt: now.toISOString(),
      lastKey: eventKey,
    };
    const { row, created } = await lockOrSeedDirectorState(tx, productId, progressId, seed);
    if (created) return { intervention: null as TickIntervention | null };

    const [product] = await tx.select({ config: pmsBuiWenlvProducts.config })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
    const anchors: DirectorAnchor[] = (product?.config as { director?: { anchors?: DirectorAnchor[] } })
      ?.director?.anchors ?? [];

    const state: SchemaDirectorState = {
      startedAt: row.state?.startedAt ?? now.toISOString(),
      lastActionAt: row.state?.lastActionAt ?? now.toISOString(),
      ...(row.state?.lastKey ? { lastKey: row.state.lastKey } : {}),
      ...(row.state?.stallNotified ? { stallNotified: true } : {}),
      ...(row.state?.staticNotified ? { staticNotified: true } : {}),
      ...(row.state?.anchors ? { anchors: row.state.anchors } : {}),
    };

    const decision = computeTick({ now, state, event: { key: eventKey }, anchors });

    // alerts 按 id 去重后追加（computeTick 幂等位已防重复，这层再挡一次异常重入）。
    const merged: DirectorAlert[] = [...(row.alerts ?? [])];
    const existingIds = new Set(merged.map((a) => a.id));
    for (const a of decision.alerts) {
      if (!existingIds.has(a.id)) merged.push(a);
    }
    await tx.update(pmsBuiWenlvDirectorStates)
      .set({ state: decision.state, alerts: merged, updatedAt: now })
      .where(eq(pmsBuiWenlvDirectorStates.id, row.id));

    return { intervention: decision.intervention };
  });

  const intervention = result.intervention;
  if (!intervention) return;

  if (intervention.kind === 'anchor') {
    // 本期只有 npc-message 走 hint 通道；ambient/push-node 无通道，仅标记 fired。
    if (intervention.nodeId && intervention.message) {
      await appendNpcMessage({
        productId, miniUserId: progress.miniUserId,
        nodeId: intervention.nodeId, text: intervention.message,
      });
    }
    return;
  }

  // stall-hint：当前节点取 criteriaHints 首条，模板「{NPC名}恰好路过：{卡关提示}」。
  const nodeId = eventKey.split(':')[0];
  if (!nodeId) return;
  // 0079 统一模型：剧情节点即 scenes（nodeId=scene.id），卡关提示读 scene.chapterGoal。
  // scene 属 chapter→room，按 id 直取即可（nodeId 来自本 productId 的 progress state 键）。
  const [node] = await db.select({
    npcId: pmsBuiWenlvScenes.npcId,
    chapterGoal: pmsBuiWenlvScenes.chapterGoal,
  }).from(pmsBuiWenlvScenes)
    .where(eq(pmsBuiWenlvScenes.id, nodeId))
    .limit(1);
  const hint = node?.chapterGoal?.criteriaHints?.[0];
  if (!hint) return;
  let text = hint;
  if (node.npcId) {
    const [npc] = await db.select({ name: pmsBuiWenlvNpcs.name })
      .from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, node.npcId)).limit(1);
    if (npc?.name) text = `${npc.name}恰好路过：${hint}`;
  }
  await appendNpcMessage({ productId, miniUserId: progress.miniUserId, nodeId, text });
}
