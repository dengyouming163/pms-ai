import { describe, it, expect } from 'vitest';
import { analyzeFlow, collectConditionLeaves, type ReachNode, type ReachEdge } from '../reachability.js';

function ref(kind: 'collected' | 'visited' | 'completed', id: string): any {
  return { type: 'ref', ref: { kind, id } };
}
function all(...conditions: any[]): any { return { type: 'all', conditions }; }

function nodes(ids: string[], grants: Record<string, string[]> = {}): ReachNode[] {
  return ids.map((id) => ({ id, grants: grants[id] ?? [] }));
}
function edge(id: string, fromNodeId: string, toNodeId: string, extra: Partial<ReachEdge> = {}): ReachEdge {
  return { id, fromNodeId, toNodeId, edgeType: 'auto', condition: null, grants: [], ...extra };
}

describe('collectConditionLeaves', () => {
  it('收集嵌套条件与扁平旧格式的叶子', () => {
    const leaves = collectConditionLeaves(all(ref('collected', 'C1'), { type: 'completed', id: 'N9' } as any));
    expect(leaves).toEqual([
      { kind: 'collected', id: 'C1' },
      { kind: 'completed', id: 'N9' },
    ]);
  });
});

describe('analyzeFlow（边条件时序可达性）', () => {
  it('线性链可通行：上游节点发放的线索满足下游边条件，grants 逐级累积', () => {
    // N1(grants=C1) → E12(cond=C1, grants=C2) → N2 → E23(cond=C2) → N3
    const ns = nodes(['N1', 'N2', 'N3'], { N1: ['C1'] });
    const es = [
      edge('E12', 'N1', 'N2', { condition: ref('collected', 'C1'), grants: ['C2'] }),
      edge('E23', 'N2', 'N3', { condition: ref('collected', 'C2') }),
    ];
    const r = analyzeFlow(ns, es);
    expect(r.hasCycle).toBe(false);
    expect(r.edgeIssues).toEqual([]);
    expect([...(r.availAfter.get('N2') ?? [])]).toEqual(['C1', 'C2']);
    expect(r.availGlobal.has('C2')).toBe(true);
  });

  it('边条件引用本边自己发放的线索 → unreachable_collected（先判条件后发放）', () => {
    // 生产案例：E56 条件要求 MIXIN_QUANWEN，grants 却也是它 → 死锁
    const ns = nodes(['N5', 'N6']);
    const es = [edge('E56', 'N5', 'N6', {
      condition: all(ref('collected', 'C_MIXIN'), ref('visited', 'N5')),
      grants: ['C_MIXIN'],
    })];
    const r = analyzeFlow(ns, es);
    const issues = r.edgeIssues.filter((i) => i.edgeId === 'E56');
    expect(issues.some((i) => i.reason === 'unreachable_collected' && i.refId === 'C_MIXIN')).toBe(true);
  });

  it('completed 引用恒假：边条件与节点无关地报 completed', () => {
    const ns = nodes(['N1', 'N2']);
    const es = [edge('E12', 'N1', 'N2', { condition: ref('completed', 'N1') })];
    const r = analyzeFlow(ns, es);
    expect(r.edgeIssues).toContainEqual(expect.objectContaining({ edgeId: 'E12', reason: 'completed', refId: 'N1' }));
  });

  it('死锁边不贡献 grants，连锁导致后续边条件同样不可达', () => {
    // E12 自己发 C1 又要 C1 → 不通 → C1/C2 都到不了 N2；E23 要 C2 也卡死
    const ns = nodes(['N1', 'N2', 'N3']);
    const es = [
      edge('E12', 'N1', 'N2', { condition: ref('collected', 'C1'), grants: ['C1', 'C2'] }),
      edge('E23', 'N2', 'N3', { condition: ref('collected', 'C2') }),
    ];
    const r = analyzeFlow(ns, es);
    expect(r.edgeIssues.some((i) => i.edgeId === 'E12' && i.reason === 'unreachable_collected')).toBe(true);
    expect(r.edgeIssues.some((i) => i.edgeId === 'E23' && i.reason === 'unreachable_collected' && i.refId === 'C2')).toBe(true);
  });

  it('多入边取并集：任一可通行入边发放的线索都算到达该节点', () => {
    // N1a→N2 发 C1；N1b→N2 无条件发 C2；N2→N3 条件 all(C1,C2) 应可通行
    const ns = nodes(['N1a', 'N1b', 'N2', 'N3']);
    const es = [
      edge('Ea', 'N1a', 'N2', { grants: ['C1'] }),
      edge('Eb', 'N1b', 'N2', { grants: ['C2'] }),
      edge('Ec', 'N2', 'N3', { condition: all(ref('collected', 'C1'), ref('collected', 'C2')) }),
    ];
    const r = analyzeFlow(ns, es);
    expect(r.edgeIssues).toEqual([]);
  });

  it('visited 引用下游节点 → downstream_visited', () => {
    const ns = nodes(['N1', 'N2']);
    const es = [edge('E12', 'N1', 'N2', { condition: ref('visited', 'N2') })];
    const r = analyzeFlow(ns, es);
    expect(r.edgeIssues).toContainEqual(expect.objectContaining({ reason: 'downstream_visited', refId: 'N2' }));
  });

  it('visited 源节点自身（到场即写 visited）满足', () => {
    const ns = nodes(['N1', 'N2']);
    const es = [edge('E12', 'N1', 'N2', { condition: ref('visited', 'N1') })];
    const r = analyzeFlow(ns, es);
    expect(r.edgeIssues).toEqual([]);
  });

  it('有环时 hasCycle=true（R8 已拦，环内节点不分析）', () => {
    const ns = nodes(['N1', 'N2']);
    const es = [edge('E12', 'N1', 'N2'), edge('E21', 'N2', 'N1')];
    const r = analyzeFlow(ns, es);
    expect(r.hasCycle).toBe(true);
  });
});
