// flow_repair 的语义部分（LLM）：为「真·孤儿线索」（机械松弛后全图仍无发放点）选择
// 叙事上最合适的边来发放。LLM 只做「选哪条边」，所有硬约束（边必须属于本产品、
// 必须在引用点上游、必须当前可通行）由编排层白名单兜底 —— prompt 里不给裸 id 自由。
import { chatJsonObject } from '../node-refiner/llm-client.js';

export interface DispatchOrphan {
  collectibleId: string;
  name: string;
  description?: string | null;
  /** 引用该线索的判定点（结局标题 / 节点标题），帮 AI 理解它应在剧情何处到手。 */
  demandedBy: string[];
  /** 允许挂载的边 id 白名单（已按拓扑序与可通行性算好）。 */
  candidateEdgeIds: string[];
}

export interface DispatchEdgeInfo {
  edgeId: string;
  fromTitle: string;
  toTitle: string;
  edgeType: string;
  label?: string | null;
  /** 边当前已发放的线索名（给 AI 判读叙事归属，避免重复/矛盾）。 */
  grantsNames: string[];
  /** 源节点剧情摘要（截断）。 */
  fromStoryBrief?: string | null;
}

export interface DispatchAssignment {
  collectibleId: string;
  edgeId: string;
  reason: string;
}

const SYSTEM = `你是实景剧本杀的剧情流程编辑。玩家沿剧情节点组成的有向图推进：到访节点、沿「边」流转，线索在走过某条边时发放，结局/前置条件再检查玩家是否已获得某条线索。
当前有若干线索被结局或前置条件需要，却没有任何节点或边会发放它。你要为每条线索选择「玩家在叙事上最可能在此获得它」的那条边，把线索挂到该边的发放列表。

硬性规则：
1. edgeId 只能从每条线索给出的 candidateEdgeIds 白名单中挑选（这些边保证在引用点之前、且当前可通行）；
2. 一条线索只挂一条边；多条线索可以挂同一条边；
3. 优先选择剧情内容与线索含义直接相关的边（如「密信全文」应挂在玩家取得密信的剧情节点之后），其次选择最接近引用点的上游边；
4. 只输出 JSON，不要解释。`;

function buildUser(productName: string, orphans: DispatchOrphan[], edges: DispatchEdgeInfo[]): string {
  const edgeLines = edges.map((e) =>
    `- edgeId=${e.edgeId} | ${e.edgeType}${e.label ? `（选项：${e.label}）` : ''} | 「${e.fromTitle}」→「${e.toTitle}」` +
    ` | 此处已发线索：${e.grantsNames.length ? e.grantsNames.join('、') : '无'}` +
    `${e.fromStoryBrief ? ` | 出发剧情：${e.fromStoryBrief}` : ''}`,
  );
  const orphanLines = orphans.map((o) =>
    `- collectibleId=${o.collectibleId}｜${o.name}${o.description ? `：${o.description}` : ''}` +
    `\n  被需要于：${o.demandedBy.join('；') || '(全局)'}` +
    `\n  可选 edgeId：${o.candidateEdgeIds.join(', ')}`,
  );
  return `剧本：${productName}

【剧情边候选】
${edgeLines.join('\n')}

【待发放线索】
${orphanLines.join('\n')}

输出格式（严格 JSON）：
{"assignments":[{"collectibleId":"线索id","edgeId":"白名单内的边id","reason":"不超过40字的中文理由"}]`;
}

/**
 * 调 LLM 为孤儿线索指派发放边。
 * 失败（网络/空响应/格式错）向上抛错，由编排层决定降级（机械修复已落库，孤儿转人工 stuck）。
 */
export async function dispatchOrphansByLlm(
  productName: string,
  orphans: DispatchOrphan[],
  edges: DispatchEdgeInfo[],
): Promise<DispatchAssignment[]> {
  const raw = await chatJsonObject({
    system: SYSTEM,
    user: buildUser(productName, orphans, edges),
    temperature: 0.3,
  });
  const arr = (raw as { assignments?: unknown })?.assignments;
  if (!Array.isArray(arr)) throw new Error('AI 未返回 assignments 数组');
  const out: DispatchAssignment[] = [];
  for (const item of arr) {
    const a = item as { collectibleId?: unknown; edgeId?: unknown; reason?: unknown };
    if (typeof a.collectibleId === 'string' && typeof a.edgeId === 'string') {
      out.push({
        collectibleId: a.collectibleId,
        edgeId: a.edgeId,
        reason: typeof a.reason === 'string' ? a.reason : '',
      });
    }
  }
  return out;
}
