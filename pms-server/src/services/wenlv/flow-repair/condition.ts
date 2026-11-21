// 门条件（edge.condition / node.requires）机械修复 —— flow-repair 的确定性部分，不调 LLM。
//
// 两类安全变换：
//  1. completed → visited：completed 状态已无任何写入点（effects.complete 删除），
//     引擎对 completed 恒判 false；作者真实意图是「完成/到访该节点」，visited 是
//     唯一仍被写入（markVisited）的等价状态。扁平旧格式 {type:'completed',id} 同步转换。
//  2. all 语境下剔除「当前判定点不可满足」的 collected / 下游 visited 子句：
//     all(门) 删子句 = 放宽（其余子句仍守），语义安全；删空 → 无条件（恒真）。
//
// any / nofM 是「选项」语境：删子句会改变/收紧选项意义，nofM 的 n 也要重算，
// 故事性判断强 ⇒ 一律不删，阻塞叶子收入 stuck，由 AI/人工处理（生产数据均为 all，
// stuck 是兜底通道）。
import type { WenlvCondition } from '../../../db/schema/wenlv.js';

export interface BlockedRefs {
  /** 判定点不可得的线索 id（reachability unreachable_collected）。 */
  collected: Set<string>;
  /** 下游或不存在的 visited 节点 id。 */
  visited: Set<string>;
}

export interface GateRewriteResult {
  /** 改写后的条件；null = 恒真（阻塞子句已全部安全移除，或原本就无条件）。 */
  cond: WenlvCondition | null;
  /** 已安全移除的阻塞叶子（仅 all 语境）。 */
  removed: { kind: 'collected' | 'visited'; id: string }[];
  /** 选项语境（any/nofM）中无法安全移除的阻塞叶子。 */
  stuck: { kind: 'collected' | 'visited'; id: string }[];
  /** completed → visited 改写计数。 */
  migratedCompleted: number;
}

interface RewriteCtx {
  blocked: BlockedRefs;
  /** true = 当前处于 any/nofM 子树，阻塞叶子只登记不删除。 */
  inChoice: boolean;
}

/** 宽松结构视图：WenlvCondition 之外兼容存量扁平旧格式 {type:'collected'|... ,id}（不在 TS 类型中）。 */
type CondLike = {
  type: string;
  id?: string;
  ref?: { kind: string; id: string };
  conditions?: WenlvCondition[];
  of?: WenlvCondition[];
  n?: number;
};

function rewriteNode(node: WenlvCondition, ctx: RewriteCtx, acc: Omit<GateRewriteResult, 'cond'>): WenlvCondition | null {
  const c = node as unknown as CondLike;

  // —— 叶子：ref 型 ——
  if (c.type === 'ref') {
    const ref = c.ref!;
    if (ref.kind === 'completed') {
      acc.migratedCompleted += 1;
      // 先落 visited，再按 visited 可用性走同一道判定
      if (ctx.blocked.visited.has(ref.id)) {
        if (ctx.inChoice) { acc.stuck.push({ kind: 'visited', id: ref.id }); return node; }
        acc.removed.push({ kind: 'visited', id: ref.id });
        return null;
      }
      return { type: 'ref', ref: { kind: 'visited', id: ref.id } };
    }
    if (ref.kind === 'collected' && ctx.blocked.collected.has(ref.id)) {
      if (ctx.inChoice) { acc.stuck.push({ kind: 'collected', id: ref.id }); return node; }
      acc.removed.push({ kind: 'collected', id: ref.id });
      return null;
    }
    if (ref.kind === 'visited' && ctx.blocked.visited.has(ref.id)) {
      if (ctx.inChoice) { acc.stuck.push({ kind: 'visited', id: ref.id }); return node; }
      acc.removed.push({ kind: 'visited', id: ref.id });
      return null;
    }
    return node;
  }

  // —— 叶子：扁平旧格式 {type:'collected'|'visited'|'completed'|'skill', id} ——
  if (c.type === 'completed' || c.type === 'collected' || c.type === 'visited') {
    const id = c.id ?? '';
    if (c.type === 'completed') {
      acc.migratedCompleted += 1;
      if (ctx.blocked.visited.has(id)) {
        if (ctx.inChoice) { acc.stuck.push({ kind: 'visited', id }); return node; }
        acc.removed.push({ kind: 'visited', id });
        return null;
      }
      return { type: 'visited', id } as unknown as WenlvCondition;
    }
    if (c.type === 'collected' && ctx.blocked.collected.has(id)) {
      if (ctx.inChoice) { acc.stuck.push({ kind: 'collected', id }); return node; }
      acc.removed.push({ kind: 'collected', id });
      return null;
    }
    if (c.type === 'visited' && ctx.blocked.visited.has(id)) {
      if (ctx.inChoice) { acc.stuck.push({ kind: 'visited', id }); return node; }
      acc.removed.push({ kind: 'visited', id });
      return null;
    }
    return node;
  }

  // —— 组合 ——
  if (c.type === 'all') {
    const children = c.conditions ?? [];
    const kept = children
      .map((ch) => rewriteNode(ch, ctx, acc))
      .filter((x): x is WenlvCondition => x !== null);
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0];
    return { type: 'all', conditions: kept };
  }
  if (c.type === 'any' || c.type === 'nofM') {
    // 选项语境：completed→visited 照做，阻塞叶子只登记，绝不删
    const childCtx: RewriteCtx = { ...ctx, inChoice: true };
    if (c.type === 'any') {
      const children = c.conditions ?? [];
      return { type: 'any', conditions: children.map((ch) => rewriteNode(ch, childCtx, acc) ?? ch) };
    }
    const of = c.of ?? [];
    return { type: 'nofM', n: c.n ?? 1, of: of.map((ch) => rewriteNode(ch, childCtx, acc) ?? ch) };
  }

  // role 及其它：原样
  return node;
}

/**
 * 改写一道门条件。
 * @param cond 原条件（null/undefined = 恒真，原样返回 null）
 * @param blocked 当前判定点不可满足的引用集合
 */
export function rewriteGateCondition(
  cond: WenlvCondition | null | undefined,
  blocked: BlockedRefs,
): GateRewriteResult {
  const acc: Omit<GateRewriteResult, 'cond'> = { removed: [], stuck: [], migratedCompleted: 0 };
  if (!cond) return { cond: null, ...acc };
  const rewritten = rewriteNode(cond, { blocked, inChoice: false }, acc);
  return { cond: rewritten, ...acc };
}
