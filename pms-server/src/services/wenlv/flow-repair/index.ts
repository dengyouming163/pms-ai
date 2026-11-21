// flow_repair 主编排：剧情图「发布流程阻塞」一键修复。
//
// 修复分两层：
//  A. 确定性机械修复（不调 LLM，一定落库）：
//     1) edge.condition / node.requires / ending.triggerCondition 中 completed → visited
//        （completed 状态已无写入点，恒假）；
//     2) all 门中「当前判定点时序上不可得」的 collected / 下游 visited 子句安全剔除
//        （all 删子句 = 放宽门，any/nofM 不动，残留转 unresolved）；
//     边条件按拓扑松弛迭代到不动点（删一条死锁边的子句后，下游边可能随之可通行）。
//  B. AI 语义派挂（可选，失败不影响 A）：
//     机械修复后仍「全图无任何可达发放点」的孤儿线索，LLM 在拓扑白名单的可通行上游边中
//     选叙事最契合的一条，追加到 edge.grants。白名单在服务端强制复核。
//
// 只写本产品自己的规范图 scenes（requires / 结局 triggerCondition）与 flows（condition/grants）；
// 白名单校验全部基于本产品数据（0079：经 loadRuntimeGraph 投影，nodeId 即 scene.id）。
import { eq } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvScenes, pmsBuiWenlvFlows,
  pmsBuiWenlvCollectibles, pmsBuiWenlvCharacters,
} from '../../../db/schema/index.js';
import type { WenlvCondition } from '../../../db/schema/wenlv.js';
import { loadRuntimeGraph } from '../script-room.js';
import { analyzeFlow, collectConditionLeaves } from '../node-graph/reachability.js';
import { rewriteGateCondition, type GateRewriteResult } from './condition.js';
import { dispatchOrphansByLlm, type DispatchEdgeInfo, type DispatchOrphan } from './llm-dispatch.js';

export interface FlowRepairUnresolved {
  kind: 'edge_condition' | 'node_requires' | 'orphan_no_candidate' | 'orphan_rejected' | 'cycle';
  refId?: string;
  message: string;
}

export interface FlowRepairResult {
  rounds: number;
  edgesRepaired: Array<{
    edgeId: string; fromTitle: string; toTitle: string;
    migratedCompleted: number; removed: GateRewriteResult['removed']; stuck: GateRewriteResult['stuck'];
  }>;
  nodesRepaired: Array<{
    nodeId: string; title: string;
    migratedCompleted: number; removed: GateRewriteResult['removed']; stuck: GateRewriteResult['stuck'];
  }>;
  endingsRepaired: Array<{ endingId: string; title: string; migratedCompleted: number }>;
  grantsDispatched: Array<{ collectibleId: string; collectibleName: string; edgeId: string; reason: string }>;
  unresolved: FlowRepairUnresolved[];
  llmError?: string;
  summary: string;
}

interface WorkEdge {
  id: string; fromNodeId: string; toNodeId: string; edgeType: string;
  condition: WenlvCondition | null;
  grants: string[];
  changed: boolean;
}
interface WorkNode {
  id: string; title: string; grants: string[];
  requires: WenlvCondition | null;
  changed: boolean;
}

const MAX_ROUNDS = 32;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function repairProductFlow(productId: string): Promise<FlowRepairResult> {
  // —— 1. 加载（0079：规范图投影 scenes/flows → nodes/edges，结局取 type='ending' 场景投影）——
  const [runtime, [product], collectibles, characters] = await Promise.all([
    loadRuntimeGraph(productId),
    db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1),
    db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, productId)),
    db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, productId)),
  ]);
  if (!product) throw new Error(`产品不存在: ${productId}`);

  // 投影节点/边：结构与旧 nodes/node_edges 契约对齐（id/title/grants/requires/storyText；
  // edge 的 id/fromNodeId/toNodeId/edgeType/condition/grants/label），下游分析零改动。
  const dbNodes = runtime.nodes;
  const dbEdges = runtime.edges;
  // 结局投影：{ id, title, triggerCondition }（id 即 ending 场景 id，写回按 scenes.id）。
  const endings = runtime.endings;

  const nodeTitle = new Map(dbNodes.map((n) => [n.id, n.title]));
  const collectibleName = new Map(collectibles.map((c) => [c.id, c.name]));
  const collectibleIds = new Set(collectibles.map((c) => c.id));

  const wNodes: WorkNode[] = dbNodes.map((n) => ({
    id: n.id, title: n.title, grants: [...(n.grants ?? [])],
    requires: (n.requires ?? null) as WenlvCondition | null,
    changed: false,
  }));
  const wEdges: WorkEdge[] = dbEdges.map((e) => ({
    id: e.id, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, edgeType: e.edgeType,
    condition: (e.condition ?? null) as WenlvCondition | null,
    grants: [...(e.grants ?? [])],
    changed: false,
  }));

  const analyze = () => analyzeFlow(
    wNodes.map((n) => ({ id: n.id, grants: n.grants })),
    wEdges.map((e) => ({ id: e.id, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, edgeType: e.edgeType, condition: e.condition, grants: e.grants })),
  );

  const edgeAcc = new Map<string, { migratedCompleted: number; removed: GateRewriteResult['removed']; stuck: GateRewriteResult['stuck'] }>();
  const accOf = (edgeId: string) => {
    let a = edgeAcc.get(edgeId);
    if (!a) { a = { migratedCompleted: 0, removed: [], stuck: [] }; edgeAcc.set(edgeId, a); }
    return a;
  };

  // —— 2. 边条件迭代松弛到不动点 ——
  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    const analysis = analyze();
    let changedThisRound = false;
    for (const e of wEdges) {
      const issues = analysis.edgeIssues.filter((i) => i.edgeId === e.id);
      if (issues.length === 0) continue;
      // completed 不进 blocked：先无条件转 visited，转换后是否下游由下一轮分析再判；
      // 转换后明确下游/缺失的 completed（本轮 issues 里 completed 且其目标拓扑下游）
      // 无法在本轮直接知道（叶子还没转），由后续轮次收口。
      const blocked = {
        collected: new Set(issues.filter((i) => i.reason === 'unreachable_collected').map((i) => i.refId)),
        visited: new Set(issues.filter((i) => i.reason === 'downstream_visited' || i.reason === 'node_missing').map((i) => i.refId)),
      };
      const before = e.condition;
      const rw = rewriteGateCondition(e.condition, blocked);
      if (!sameJson(before, rw.cond)) {
        e.condition = rw.cond;
        e.changed = true;
        changedThisRound = true;
        const a = accOf(e.id);
        a.migratedCompleted += rw.migratedCompleted;
        a.removed.push(...rw.removed);
        a.stuck.push(...rw.stuck);
      }
    }
    if (!changedThisRound) break;
  }

  const finalAnalysis = analyze();
  if (finalAnalysis.hasCycle) {
    // 有环由 R8 拦截发布；环内条件不保证修全，登记但继续（机械修复仍有效）。
    // unresolved 在终检统一输出。
  }

  // —— 3. 节点 requires：判定时机是「进入节点之前」（markVisited 之前）——
  const nodeAcc = new Map<string, { migratedCompleted: number; removed: GateRewriteResult['removed']; stuck: GateRewriteResult['stuck'] }>();
  for (const n of wNodes) {
    if (!n.requires) continue;
    const ti = finalAnalysis.topoIndex.get(n.id);
    if (ti === undefined) continue; // 环内节点交给 R8
    const beforeAvail = finalAnalysis.availBefore.get(n.id) ?? new Set<string>();
    const blockedCollected = new Set<string>();
    const blockedVisited = new Set<string>();
    for (const leaf of collectConditionLeaves(n.requires)) {
      if (leaf.kind === 'collected' && leaf.id && !beforeAvail.has(leaf.id)) blockedCollected.add(leaf.id);
      if (leaf.kind === 'visited' && leaf.id) {
        const rti = finalAnalysis.topoIndex.get(leaf.id);
        if (rti === undefined || rti >= ti) blockedVisited.add(leaf.id);
      }
      // completed：转换为 visited 后立即按拓扑判定（进入前只能已到访严格上游；自身也未写）
      if (leaf.kind === 'completed' && leaf.id) {
        const rti = finalAnalysis.topoIndex.get(leaf.id);
        if (rti === undefined || rti >= ti) blockedVisited.add(leaf.id);
      }
    }
    const before = n.requires;
    const rw = rewriteGateCondition(n.requires, { collected: blockedCollected, visited: blockedVisited });
    if (!sameJson(before, rw.cond)) {
      n.requires = rw.cond;
      n.changed = true;
    }
    if (rw.migratedCompleted > 0 || rw.removed.length > 0 || rw.stuck.length > 0) {
      nodeAcc.set(n.id, { migratedCompleted: rw.migratedCompleted, removed: rw.removed, stuck: rw.stuck });
    }
  }

  // —— 4. 结局 triggerCondition：只做 completed→visited（结局定义不删 collected）——
  const endingsRepaired: FlowRepairResult['endingsRepaired'] = [];
  const endingNewCond = new Map<string, WenlvCondition>();
  for (const en of endings) {
    const rw = rewriteGateCondition(en.triggerCondition, { collected: new Set(), visited: new Set() });
    if (rw.migratedCompleted > 0 && rw.cond) {
      endingNewCond.set(en.id, rw.cond);
      endingsRepaired.push({ endingId: en.id, title: en.title, migratedCompleted: rw.migratedCompleted });
    }
  }

  // —— 5. 汇总孤儿线索（机械修复后全图仍无可达发放点）——
  const demandedBy = new Map<string, Set<string>>();
  const earliestT = new Map<string, number>(); // 判定点拓扑上界：线索必须在 < earliestT 的边上
  const markOrphan = (cid: string, where: string, bound: number) => {
    if (!collectibleIds.has(cid)) return; // 引用了不存在的线索，R3/COLLECTIBLE_NOT_FOUND 另管
    let s = demandedBy.get(cid);
    if (!s) { s = new Set(); demandedBy.set(cid, s); }
    s.add(where);
    earliestT.set(cid, Math.min(earliestT.get(cid) ?? Infinity, bound));
  };

  // 5a. 结局条件 collected
  for (const en of endings) {
    const cond = endingNewCond.get(en.id) ?? en.triggerCondition;
    for (const leaf of collectConditionLeaves(cond)) {
      if (leaf.kind === 'collected' && leaf.id && !finalAnalysis.availGlobal.has(leaf.id)) {
        markOrphan(leaf.id, `结局「${en.title}」`, Infinity);
      }
    }
  }
  // 5b. 角色隐秘任务
  for (const ch of characters) {
    for (const cid of ch.hiddenQuest?.collectible_ids ?? []) {
      if (!finalAnalysis.availGlobal.has(cid)) {
        markOrphan(cid, `角色「${ch.name}」隐秘任务${ch.hiddenQuest?.title ? `「${ch.hiddenQuest.title}」` : ''}`, Infinity);
      }
    }
  }
  // 5c. 节点 requires 改写后仍不可得的 collected（多为 any/nofM 卡住的）
  for (const n of wNodes) {
    const ti = finalAnalysis.topoIndex.get(n.id);
    const beforeAvail = finalAnalysis.availBefore.get(n.id) ?? new Set<string>();
    for (const leaf of collectConditionLeaves(n.requires)) {
      if (leaf.kind === 'collected' && leaf.id && !beforeAvail.has(leaf.id)) {
        markOrphan(leaf.id, `节点「${n.title}」入场条件`, ti ?? Infinity);
      }
    }
  }
  // 5d. 边条件残留不可达 collected（any/nofM 卡住）
  for (const iss of finalAnalysis.edgeIssues) {
    if (iss.reason !== 'unreachable_collected' || !iss.refId) continue;
    const after = finalAnalysis.availAfter.get(iss.fromNodeId);
    if (after && after.has(iss.refId)) continue;
    markOrphan(iss.refId, `边「${nodeTitle.get(iss.fromNodeId) ?? iss.fromNodeId}」→「${nodeTitle.get(iss.toNodeId) ?? iss.toNodeId}」条件`, finalAnalysis.topoIndex.get(iss.fromNodeId) ?? Infinity);
  }

  // —— 6. AI 派挂（拓扑白名单）——
  const grantsDispatched: FlowRepairResult['grantsDispatched'] = [];
  const unresolved: FlowRepairUnresolved[] = [];
  const blockedEdgeIds = new Set(finalAnalysis.edgeIssues.map((i) => i.edgeId));

  const llmErrorHolder: { error?: string } = {};
  // 有环时拓扑分析不完整（R8 已拦发布）：跳过 AI 派挂，避免把线索挂到环内不可判定的边上；
  // 机械修复仍已落库，孤儿转 unresolved 等人工拆环后重跑。
  if (finalAnalysis.hasCycle) {
    for (const [cid, where] of demandedBy) {
      unresolved.push({ kind: 'orphan_no_candidate', refId: cid, message: `剧情图存在环，线索「${collectibleName.get(cid) ?? cid}」未派挂（被需要于：${[...where].join('；')}），请先拆环后重跑疏通` });
    }
    demandedBy.clear();
  }
  if (demandedBy.size > 0) {
    const edgeInfoMap = new Map<string, DispatchEdgeInfo>();
    for (const e of wEdges) {
      edgeInfoMap.set(e.id, {
        edgeId: e.id,
        fromTitle: nodeTitle.get(e.fromNodeId) ?? e.fromNodeId,
        toTitle: nodeTitle.get(e.toNodeId) ?? e.toNodeId,
        edgeType: e.edgeType,
        label: dbEdges.find((d) => d.id === e.id)?.label ?? null,
        grantsNames: e.grants.map((g) => collectibleName.get(g) ?? g),
        fromStoryBrief: (dbNodes.find((n) => n.id === e.fromNodeId)?.storyText ?? '').slice(0, 120) || null,
      });
    }
    const edgeToT = new Map(wEdges.map((e) => [e.id, finalAnalysis.topoIndex.get(e.toNodeId)]));

    const orphans: DispatchOrphan[] = [];
    for (const [cid, where] of demandedBy) {
      const bound = earliestT.get(cid) ?? Infinity;
      const candidateEdgeIds = wEdges
        .filter((e) =>
          !blockedEdgeIds.has(e.id) &&
          !e.grants.includes(cid) &&
          edgeToT.get(e.id) !== undefined &&
          (edgeToT.get(e.id) as number) < bound,
        )
        .map((e) => e.id);
      if (candidateEdgeIds.length === 0) {
        unresolved.push({ kind: 'orphan_no_candidate', refId: cid, message: `线索「${collectibleName.get(cid) ?? cid}」在引用点之前没有可通行边可派挂（被需要于：${[...where].join('；')}），需人工指定发放点` });
        continue;
      }
      orphans.push({ collectibleId: cid, name: collectibleName.get(cid) ?? cid, description: collectibles.find((c) => c.id === cid)?.description ?? null, demandedBy: [...where], candidateEdgeIds });
    }

    if (orphans.length > 0) {
      try {
        const assignments = await dispatchOrphansByLlm(product.name, orphans, orphans.length ? [...edgeInfoMap.values()].filter((ei) => orphans.some((o) => o.candidateEdgeIds.includes(ei.edgeId))) : []);
        const orphanMap = new Map(orphans.map((o) => [o.collectibleId, o]));
        const assignedCids = new Set<string>();
        for (const a of assignments) {
          const o = orphanMap.get(a.collectibleId);
          if (!o) continue; // AI 幻觉的线索 id
          if (!o.candidateEdgeIds.includes(a.edgeId)) {
            unresolved.push({ kind: 'orphan_rejected', refId: a.collectibleId, message: `AI 为线索「${o.name}」选择的边 ${a.edgeId} 不在拓扑白名单，已拒绝` });
            continue;
          }
          if (assignedCids.has(a.collectibleId)) continue;
          const target = wEdges.find((e) => e.id === a.edgeId);
          if (!target) continue;
          target.grants.push(a.collectibleId);
          target.changed = true;
          assignedCids.add(a.collectibleId);
          grantsDispatched.push({ collectibleId: a.collectibleId, collectibleName: o.name, edgeId: a.edgeId, reason: a.reason });
        }
        for (const o of orphans) {
          if (!assignedCids.has(o.collectibleId) && !unresolved.some((u) => u.refId === o.collectibleId)) {
            unresolved.push({ kind: 'orphan_rejected', refId: o.collectibleId, message: `AI 未给线索「${o.name}」返回有效派挂（被需要于：${o.demandedBy.join('；')}），可重试` });
          }
        }
      } catch (err) {
        const llmError = String((err as Error)?.message ?? err);
        for (const o of orphans) {
          unresolved.push({ kind: 'orphan_rejected', refId: o.collectibleId, message: `AI 派挂失败，线索「${o.name}」待重试（被需要于：${o.demandedBy.join('；')}）` });
        }
        // 挂到返回对象上（闭包外赋值）
        llmErrorHolder.error = llmError;
      }
    }
  }

  // —— 7. 派挂后终检：仍残留的边条件阻塞 ——
  const verify = analyze();
  if (verify.hasCycle) {
    unresolved.push({ kind: 'cycle', message: '剧情图存在环，环内条件未参与可达性分析（R8 拦截项，需人工拆环）' });
  }
  for (const iss of verify.edgeIssues) {
    // 已通过 AI 派挂解决的不再报（grantsDispatched 覆盖的 collectible）
    if (iss.reason === 'unreachable_collected' && grantsDispatched.some((g) => g.collectibleId === iss.refId)) continue;
    const reasonText: Record<string, string> = {
      completed: '仍引用已废弃的 completed 状态',
      unreachable_collected: `线索 ${iss.refId ?? ''} 在到达该边前仍不可得`,
      downstream_visited: `visited 引用了下游节点 ${iss.refId ?? ''}（选项语境不可自动松弛）`,
      node_missing: `visited 引用了不存在的节点 ${iss.refId ?? ''}`,
    };
    unresolved.push({
      kind: 'edge_condition', refId: iss.refId,
      message: `边「${nodeTitle.get(iss.fromNodeId) ?? iss.fromNodeId}」→「${nodeTitle.get(iss.toNodeId) ?? iss.toNodeId}」：${reasonText[iss.reason] ?? iss.reason}`,
    });
  }
  for (const [nodeId, a] of nodeAcc) {
    for (const s of a.stuck) {
      unresolved.push({ kind: 'node_requires', refId: s.id, message: `节点「${nodeTitle.get(nodeId) ?? nodeId}」入场条件的选项分支引用了不可得的 ${s.kind} ${s.id}，需人工调整` });
    }
  }

  // —— 8. 事务落库（0079：flows.condition/grants、scenes.requires、结局 scenes.triggerCondition）——
  await db.transaction(async (tx) => {
    for (const e of wEdges) {
      if (!e.changed) continue;
      await tx.update(pmsBuiWenlvFlows)
        .set({ condition: e.condition, grants: e.grants, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvFlows.id, e.id));
    }
    for (const n of wNodes) {
      if (!n.changed) continue;
      await tx.update(pmsBuiWenlvScenes)
        .set({ requires: n.requires, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvScenes.id, n.id));
    }
    for (const [endingId, cond] of endingNewCond) {
      // endingId 即 type='ending' 场景的 id；triggerCondition 是该型专属列。
      await tx.update(pmsBuiWenlvScenes)
        .set({ triggerCondition: cond, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvScenes.id, endingId));
    }
  });

  const edgesRepaired = [...edgeAcc.entries()].map(([edgeId, a]) => {
    const e = wEdges.find((x) => x.id === edgeId)!;
    return { edgeId, fromTitle: nodeTitle.get(e.fromNodeId) ?? e.fromNodeId, toTitle: nodeTitle.get(e.toNodeId) ?? e.toNodeId, ...a };
  });
  const nodesRepaired = [...nodeAcc.entries()].map(([nodeId, a]) => ({ nodeId, title: nodeTitle.get(nodeId) ?? nodeId, ...a }));

  const summary = `修复边条件 ${edgesRepaired.length} 条、节点入场条件 ${nodesRepaired.length} 个、结局条件 ${endingsRepaired.length} 个` +
    (grantsDispatched.length ? `；AI 派挂线索 ${grantsDispatched.length} 条` : '') +
    (unresolved.length ? `；残留 ${unresolved.length} 项需人工确认` : '；无残留阻塞');

  return { rounds, edgesRepaired, nodesRepaired, endingsRepaired, grantsDispatched, unresolved, ...(llmErrorHolder.error ? { llmError: llmErrorHolder.error } : {}), summary };
}
