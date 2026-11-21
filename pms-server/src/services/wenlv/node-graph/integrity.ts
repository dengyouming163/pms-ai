// 剧本图完整性校验（publish 前置）。
// 输入：productId；输出：错误文案数组（空=通过）。
// R1/R3-R10 覆盖节点可达性、边引用完整性、点位绑定、触发器绑定、
// 角色引用、节点内容闸（NPC 必填字段 / 谜题结构）、无环、边条件时序死锁、免费旁路。
// 0079 统一重建：节点/边只从规范图投影（loadRuntimeGraph：scenes/flows → nodes/edges）取，
// 不再读旧 nodes/node_edges，也无「老剧本幂等迁移线性边链」概念（规范图即唯一承载）；
// 触发器 R5 改按 sceneId 绑定场景（nodeId 为过渡兼容列）。规则本身零改动，只换数据源。
import { db } from '../../../db/index.js';
import { eq } from 'drizzle-orm';
import {
  pmsBuiWenlvVenuePoints,
  pmsBuiWenlvTriggers,
  pmsBuiWenlvCharacters,
} from '../../../db/schema/wenlv.js';
import { loadRuntimeGraph } from '../script-room.js';
import { analyzeFlow } from './reachability.js';
import { isCommerceAtom } from '../atoms/registry.js';
import type { WenlvAtom } from '../../../db/schema/wenlv.js';

/** R10：商业原子必须声明免费旁路（spec §5 红线机器化：主线必须 100% 免费可达）。 */
export function checkFreeBypass(
  nodes: readonly { id: string; title: string | null; atoms?: WenlvAtom[] | null }[],
): string[] {
  const errs: string[] = [];
  for (const n of nodes) {
    for (const a of n.atoms ?? []) {
      if (!isCommerceAtom(a)) continue;
      // normalizeNodeAtoms 只校验不净化，多余键（含 bypass）原样落库，可直接读。
      const how = (a.config as { bypass?: { how?: unknown } } | undefined)?.bypass?.how;
      if (typeof how !== 'string' || how.trim().length === 0) {
        errs.push(`R10: 节点「${n.title ?? n.id}」的商业原子「${a.title ?? a.id}」缺少免费旁路（config.bypass.how），主线必须100%免费可达`);
      }
    }
  }
  return errs;
}

/**
 * 校验剧本有向图的结构完整性（R1/R3-R10）。
 *
 * 节点/边来自规范图投影 loadRuntimeGraph（scenes/flows 装配），nodeId 即 scene.id；
 * ending 场景已从 nodes 剔除（结局单列），触发器应绑非结局场景。
 *
 * @returns 错误文案数组；空数组表示全部通过。
 */
export async function validateGraphIntegrity(productId: string): Promise<string[]> {
  const errors: string[] = [];
  const { nodes, edges } = await loadRuntimeGraph(productId);
  const nodeIds = new Set(nodes.map((n) => n.id));

  const hasIncoming = (nodeId: string) => edges.some((e) => e.toNodeId === nodeId);

  // R1：非入口节点必须有至少一条入边。
  // 入口节点 = 没有入边的节点（取第一个匹配，图通常只有一个起点）。
  const entryNode = nodes.find((n) => !hasIncoming(n.id));
  for (const n of nodes) {
    if (entryNode && n.id === entryNode.id) continue;
    if (!hasIncoming(n.id)) errors.push(`R1: 节点「${n.title}」无入边`);
  }

  // R3：边的 fromNodeId / toNodeId 必须引用已存在的节点。
  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNodeId)) errors.push(`R3: 边 ${edge.id} 源节点不存在`);
    if (!nodeIds.has(edge.toNodeId)) errors.push(`R3: 边 ${edge.id} 目标节点不存在`);
  }

  // R4：venuePointId 必须引用已存在的点位。
  // 点位按 venueId 归属，非 productId；此处仅校验「点位存在」，
  // 「属于本产品场地」由 wenlv-integrity.ts 的发布闸在已知 product.venueId 时把关。
  const venuePoints = await db
    .select({ id: pmsBuiWenlvVenuePoints.id })
    .from(pmsBuiWenlvVenuePoints);
  const vpIds = new Set(venuePoints.map((v) => v.id));
  for (const n of nodes) {
    if (n.venuePointId && !vpIds.has(n.venuePointId)) {
      errors.push(`R4: 节点「${n.title}」绑定的点位不存在`);
    }
  }

  // R5：触发器的绑定场景必须引用已存在的（非结局）场景。
  // 0079 起触发器绑 scenes（sceneId）；nodeId 为旧列过渡保留，新数据走 sceneId。
  // nodeId 即 scene.id，两者都在 nodeIds（投影已剔除 ending 场景）中判存在。
  const triggers = await db
    .select()
    .from(pmsBuiWenlvTriggers)
    .where(eq(pmsBuiWenlvTriggers.productId, productId));
  for (const t of triggers) {
    const ref = t.sceneId ?? t.nodeId;
    if (ref && !nodeIds.has(ref)) {
      errors.push(`R5: 触发器 ${t.id} 关联的节点不存在`);
    }
  }

  // R6：perspectiveCharacterId 必须引用已存在的角色。
  const characters = await db
    .select({ id: pmsBuiWenlvCharacters.id })
    .from(pmsBuiWenlvCharacters)
    .where(eq(pmsBuiWenlvCharacters.productId, productId));
  const charIds = new Set(characters.map((c) => c.id));
  for (const n of nodes) {
    if (n.perspectiveCharacterId && !charIds.has(n.perspectiveCharacterId)) {
      errors.push(`R6: 节点「${n.title}」的视角角色不存在`);
    }
  }

  // R7：节点内容闸（逐字段检查，与边类型无关）。
  //   - npc 节点：必须绑定 NPC、有章节目标、有开场白；
  //     chapterGoal.type='choice' 时 options[].nextNodeId 非空则必须指向存在的节点。
  //   - scene 节点且挂 puzzle：题面非空；single/multiple 选项 ≥2 且答案命中选项；
  //     judge 答案必须是 'true'/'false'；meditate seconds 必须正整数；
  //     input/photo 无额外字段要求。
  for (const n of nodes) {
    if (n.nodeType === 'npc') {
      if (!n.npcId) {
        errors.push(`R7: NPC 剧情「${n.title}」未绑定 NPC`);
      }
      const goal = n.chapterGoal as any;
      if (!goal) {
        errors.push(`R7: NPC 剧情「${n.title}」缺少章节目标`);
      } else if (goal.type === 'choice' && Array.isArray(goal.options)) {
        for (const opt of goal.options) {
          const nextNodeId = opt?.nextNodeId;
          if (nextNodeId && !nodeIds.has(nextNodeId)) {
            errors.push(`R7:「${n.title}」分支选项下一节点不存在：${nextNodeId}`);
          }
        }
      }
      if (!n.openingLine || !n.openingLine.trim()) {
        errors.push(`R7: NPC 剧情「${n.title}」缺少开场白`);
      }
      continue;
    }

    const p = n.puzzle as any;
    if (n.nodeType === 'scene' && p) {
      if (!p.question) {
        errors.push(`R7: 节点「${n.title}」谜题缺少题面`);
      }
      if (p.type === 'single' || p.type === 'multiple') {
        if (!Array.isArray(p.options) || p.options.length < 2) {
          errors.push(`R7: 节点「${n.title}」选择题选项不足 2 个`);
        } else {
          const answers = p.type === 'single' ? [p.answer] : p.answer;
          if (!Array.isArray(answers) || answers.some((a: unknown) => !p.options.includes(a))) {
            errors.push(`R7: 节点「${n.title}」选择题答案未命中选项`);
          }
        }
      } else if (p.type === 'judge') {
        if (p.answer !== 'true' && p.answer !== 'false') {
          errors.push(`R7: 节点「${n.title}」判断题答案非法`);
        }
      } else if (p.type === 'meditate') {
        if (!Number.isInteger(p.seconds) || p.seconds <= 0) {
          errors.push(`R7: 节点「${n.title}」静坐时长非法`);
        }
      }
    }
  }

  // R8：有向图无环（DFS 三色法的简化版：visited + 当前栈）。
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.fromNodeId)) adj.set(e.fromNodeId, []);
    adj.get(e.fromNodeId)!.push(e.toNodeId);
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(node: string): boolean {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    stack.delete(node);
    return false;
  }
  for (const n of nodes) {
    if (dfs(n.id)) {
      errors.push('R8: 剧情图存在环');
      break;
    }
  }

  // R9：边条件时序可达性（先判条件、后发 edge.grants 的运行时语义下的流程死锁）。
  // 内容闸 COLLECTIBLE_UNREACHABLE 只回答「全图有没有人发」，回答不了「发放点在条件点之后」；
  // completed 状态无写入点恒假；visited 引用下游节点时序颠倒 —— 这些都会让边永不放行、玩家卡死。
  // 有环时 R8 已拦，环内节点分析不完整，故 R9 仅在无环结果上展开（避免连环误报）。
  const title = (id: string) => nodeIds.has(id) ? (nodes.find((n) => n.id === id)?.title ?? id) : id;
  const flow = analyzeFlow(
    nodes.map((n) => ({ id: n.id, grants: n.grants })),
    edges.map((e) => ({ id: e.id, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, edgeType: e.edgeType, condition: e.condition, grants: e.grants })),
  );
  if (!flow.hasCycle) {
    for (const iss of flow.edgeIssues) {
      const label = `边「${title(iss.fromNodeId)}→${title(iss.toNodeId)}」`;
      if (iss.reason === 'completed') {
        errors.push(`R9: ${label}条件引用了已废弃的 completed 状态（节点 ${iss.refId}），该条件恒假，流程无法继续`);
      } else if (iss.reason === 'unreachable_collected') {
        errors.push(`R9: ${label}条件要求线索 ${iss.refId}，但玩家到达该边前无法获得（无人在上游发放，或由此边自己发放），流程死锁`);
      } else if (iss.reason === 'downstream_visited') {
        errors.push(`R9: ${label}条件要求先到访下游节点 ${iss.refId}，时序颠倒，流程死锁`);
      } else {
        errors.push(`R9: ${label}条件引用了不存在的节点 ${iss.refId}`);
      }
    }
  }

  // R10：商业原子必须声明免费旁路（纯同步，不引入 DB/网络调用）。
  errors.push(...checkFreeBypass(nodes));

  return errors;
}
