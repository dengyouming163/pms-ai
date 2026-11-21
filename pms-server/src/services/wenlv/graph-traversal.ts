// 剧情图遍历（0079 统一重建后改为**表无关纯函数**）：不再查旧 pms_bui_wenlv_node_edges，
// 边由调用方经规范图投影 projectFlowsToEdges(graph.flows) 一次性装配后传入（见 script-room.ts）。
// 引擎内核 evalCondition 与本函数都不关心边来自 flows 还是旧 edge 表，故这里只做结构遍历。
import type { WenlvState, WenlvEdgeType, WenlvCondition } from '../../db/schema/wenlv.js';
import { evalCondition } from '../wenlv-engine.js';

/** 可遍历的最小边结构（ProjectedEdge / 旧 edge 行均满足）。 */
export interface TraversableEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: WenlvEdgeType;
  label?: string | null;
  condition?: WenlvCondition | null;
  grants?: string[] | null;
  sanDelta?: number | null;
}

export interface TraversalResult {
  /** 通过 auto 边自动解锁的目标节点 id 列表（玩家可直接进入） */
  autoUnlocked: string[];
  /** 需要玩家选择的 choice 边（label + toNodeId） */
  choices: { edgeId: string; label: string; toNodeId: string }[];
  /** 所有被遍历边的 grants 合并 */
  grants: string[];
  /** 所有被遍历边的 sanDelta 求和 */
  sanDelta: number;
}

export type EdgeFilter = 'auto' | 'puzzle_pass' | 'puzzle_fail' | 'all';

/**
 * 遍历某节点的出边，返回可流转的目标及效果。**纯函数**（无 IO），边集由调用方传入。
 *
 * @param edges     本房规范图投影出的**全量边**（函数内部按 fromNodeId 过滤，装载顺序即遍历顺序，
 *                  script-room 仓储已按 sortOrder 升序取 flows）。
 * @param fromNodeId 源节点（= 新模型 scene.id，对外仍是 nodeId 形态）。
 * @param edgeFilter 只考虑哪些类型的边：
 *   - 'auto'：场景节点完成时用，只走 auto 边
 *   - 'puzzle_pass'：谜题答对时用
 *   - 'puzzle_fail'：谜题答错时用
 *   - 'all'：NPC 对话完成时用（auto + choice 都返回）
 * @param opts 角色上下文（用于 edge.condition 中的 role/skill 条件）
 */
export function traverseEdges(
  edges: readonly TraversableEdge[],
  fromNodeId: string,
  state: WenlvState,
  edgeFilter: EdgeFilter,
  opts?: { characterId?: string | null; characterSkillIds?: string[] },
): TraversalResult {
  const result: TraversalResult = { autoUnlocked: [], choices: [], grants: [], sanDelta: 0 };

  for (const edge of edges) {
    if (edge.fromNodeId !== fromNodeId) continue;
    // 边条件不满足则跳过
    if (edge.condition && !evalCondition(edge.condition, state, opts)) continue;

    // 按过滤器选择边类型
    if (edgeFilter !== 'all' && edge.edgeType !== edgeFilter) continue;

    // 合并效果
    if (Array.isArray(edge.grants) && edge.grants.length) {
      result.grants.push(...edge.grants);
    }
    result.sanDelta += edge.sanDelta || 0;

    if (edge.edgeType === 'choice') {
      result.choices.push({ edgeId: edge.id, label: edge.label || '', toNodeId: edge.toNodeId });
    } else {
      // auto / puzzle_pass / puzzle_fail → 自动解锁目标节点
      result.autoUnlocked.push(edge.toNodeId);
    }
  }

  return result;
}

/**
 * 将遍历结果应用到玩家状态：
 * - 把 autoUnlocked 的节点标记为 visited（可进入）
 * - 把 grants 加入 collected
 * 返回新状态和 sanDelta。
 */
export function applyTraversalResult(result: TraversalResult, state: WenlvState): { state: WenlvState; sanDelta: number } {
  let next = state;
  for (const nodeId of result.autoUnlocked) {
    next = { ...next, visited: { ...next.visited, [nodeId]: true } };
  }
  if (result.grants.length) {
    const collected = { ...next.collected };
    for (const id of result.grants) collected[id] = true;
    next = { ...next, collected };
  }
  return { state: next, sanDelta: result.sanDelta };
}
