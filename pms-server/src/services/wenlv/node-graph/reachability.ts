// 剧情图「边条件时序可达性」分析（纯函数，无 DB）。
//
// 背景：二元图模型下线索由边（edge.grants）/节点（node.grants）发放，边的 condition
// 在 traverseEdges 中「先判条件、后发 grants」。若条件引用的线索要等该边（或更下游）
// 才发放，玩家会被永久卡死；completed 状态已无任何写入点，引用它的条件恒假。
// 内容闸的 COLLECTIBLE_UNREACHABLE 只回答「全图有没有人发」，回答不了「发放点在条件点
// 之后」的时序死锁——本模块补这道闸（R9），也是 flow-repair 一键修复的分析底座。
//
// 分析口径（乐观）：假定谜题都能答对、choice 边玩家可以选、role/skill 条件恒满足；
// 只对 collected / completed / visited 三类叶子做拓扑时序判定。DAG 由 R8（无环）
// 兜底，Kahn 拓扑取不出的环内节点不参与分析（hasCycle=true 时 R9 结果不完整，R8 已拦发布）。
import type { WenlvCondition } from '../../../db/schema/wenlv.js';

export interface ReachNode {
  id: string;
  grants?: string[] | null;
}
export interface ReachEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  condition?: WenlvCondition | null;
  grants?: string[] | null;
}

/** 边条件中不可满足的叶子引用。一条边可有多条（all 里同时卡 collected + completed）。 */
export interface EdgeCondIssue {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  /**
   * - completed：引用了已废弃的 completed 状态（无写入点，恒假）
   * - unreachable_collected：到达源节点时该线索尚不可得（发放点在本边或更下游）
   * - downstream_visited：visited 引用了拓扑序更靠后的节点（还没走到）
   * - node_missing：visited/completed 引用的节点不存在
   */
  reason: 'completed' | 'unreachable_collected' | 'downstream_visited' | 'node_missing';
  refId: string;
}

export interface FlowAnalysis {
  /** 节点拓扑序号（环内节点缺失）。 */
  topoIndex: Map<string, number>;
  /** 进入节点「之前」玩家可收集的线索集合（可通行入边贡献的并集，不含本节点 grants）。 */
  availBefore: Map<string, Set<string>>;
  /** 到达并完成节点「之后」可收集集合（availBefore ∪ node.grants）。 */
  availAfter: Map<string, Set<string>>;
  /** 沿所有可通行边可收集的全图并集（结局/隐秘任务判定点用）。 */
  availGlobal: Set<string>;
  /** 阻塞的边条件叶子。 */
  edgeIssues: EdgeCondIssue[];
  /** 图是否有环；有环时环内节点未分析（R8 已拦发布）。 */
  hasCycle: boolean;
}

interface CondLeaf {
  kind: 'collected' | 'completed' | 'visited' | 'skill' | 'role';
  id?: string;
}

/** 收集条件树叶子（兼容扁平旧格式 {type:'collected'|'visited'|'completed'|'skill', id}）。 */
export function collectConditionLeaves(cond: WenlvCondition | undefined | null, out: CondLeaf[] = []): CondLeaf[] {
  if (!cond) return out;
  const c = cond as unknown as { type: string; id?: string; ref?: { kind: string; id: string }; conditions?: WenlvCondition[]; of?: WenlvCondition[] };
  if (c.type === 'ref') {
    const kind = c.ref?.kind;
    if (kind === 'collected' || kind === 'completed' || kind === 'visited' || kind === 'skill') {
      out.push({ kind, id: c.ref!.id });
    }
    return out;
  }
  if (c.type === 'collected' || c.type === 'visited' || c.type === 'completed' || c.type === 'skill') {
    out.push({ kind: c.type, id: c.id });
    return out;
  }
  if (c.type === 'role') { out.push({ kind: 'role' }); return out; }
  const children = c.type === 'nofM' ? c.of : c.conditions;
  if (Array.isArray(children)) for (const ch of children) collectConditionLeaves(ch, out);
  return out;
}

/**
 * 拓扑数据流分析。
 *
 * 处理顺序 = Kahn 拓扑序：处理节点 v 时其全部入边的来源节点已处理完，
 * 故「进入 v 前可得集合」incoming[v] 已累积完毕；随后扫描 v 的出边，用
 * availAfter(v) 判边条件，可通行边把 grants 贡献累积给目标节点的 incoming。
 */
export function analyzeFlow(nodes: ReachNode[], edges: ReachEdge[]): FlowAnalysis {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const outEdges = new Map<string, ReachEdge[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) { indegree.set(n.id, 0); outEdges.set(n.id, []); }
  for (const e of edges) {
    if (!nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId)) continue; // R3 管端点不存在
    outEdges.get(e.fromNodeId)!.push(e);
    indegree.set(e.toNodeId, (indegree.get(e.toNodeId) ?? 0) + 1);
  }

  const topoIndex = new Map<string, number>();
  const availBefore = new Map<string, Set<string>>();
  const availAfter = new Map<string, Set<string>>();
  /** 各节点「可通行入边」贡献的累积槽；节点被拓扑取出时固化为 availBefore。 */
  const incoming = new Map<string, Set<string>>();
  for (const n of nodes) incoming.set(n.id, new Set());
  const edgeIssues: EdgeCondIssue[] = [];

  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  let order = 0;
  while (queue.length > 0) {
    const u = queue.shift()!;
    topoIndex.set(u, order++);
    const uNode = nodes.find((n) => n.id === u)!;
    const before = incoming.get(u) ?? new Set<string>();
    availBefore.set(u, before);
    const after = new Set(before);
    for (const g of uNode.grants ?? []) after.add(g);
    availAfter.set(u, after);

    for (const e of outEdges.get(u) ?? []) {
      const leaves = collectConditionLeaves(e.condition);
      let passable = true;
      for (const leaf of leaves) {
        if (leaf.kind === 'completed') {
          edgeIssues.push({ edgeId: e.id, fromNodeId: u, toNodeId: e.toNodeId, reason: 'completed', refId: leaf.id ?? '' });
          passable = false;
        } else if (leaf.kind === 'collected') {
          if (!leaf.id || !after.has(leaf.id)) {
            edgeIssues.push({ edgeId: e.id, fromNodeId: u, toNodeId: e.toNodeId, reason: 'unreachable_collected', refId: leaf.id ?? '' });
            passable = false;
          }
        } else if (leaf.kind === 'visited') {
          if (!leaf.id || !nodeIds.has(leaf.id)) {
            edgeIssues.push({ edgeId: e.id, fromNodeId: u, toNodeId: e.toNodeId, reason: 'node_missing', refId: leaf.id ?? '' });
            passable = false;
          } else {
            const ti = topoIndex.get(leaf.id);
            // 引用节点尚未在拓扑序中出现 = 下游节点（含同层不可能：拓扑序严格）
            if (ti === undefined || ti > order - 1) {
              edgeIssues.push({ edgeId: e.id, fromNodeId: u, toNodeId: e.toNodeId, reason: 'downstream_visited', refId: leaf.id });
              passable = false;
            }
          }
        }
        // skill / role：乐观视为满足（R4 管 skill 存在性，role 为角色门控）
      }
      if (passable) {
        // 状态沿边整体流动：把到达源节点时的全部已收集集合（after(u)）连同本边
        // grants 一起带入目标节点的入边槽 —— 不是只传边增量，否则上游线索会断流。
        const slot = incoming.get(e.toNodeId);
        if (slot) {
          for (const g of after) slot.add(g);
          for (const g of e.grants ?? []) slot.add(g);
        }
      }

      const d = indegree.get(e.toNodeId)! - 1;
      indegree.set(e.toNodeId, d);
      if (d === 0) queue.push(e.toNodeId);
    }
  }

  const hasCycle = order < nodes.length;
  const availGlobal = new Set<string>();
  for (const [id, set] of availAfter) {
    // 环外节点的可得集合并入全局
    if (topoIndex.has(id)) for (const g of set) availGlobal.add(g);
  }
  return { topoIndex, availBefore, availAfter, availGlobal, edgeIssues, hasCycle };
}
