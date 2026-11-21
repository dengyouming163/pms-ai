// graph-traversal 纯函数测试（0079 统一重建后表无关）：边集由调用方传入（projectFlowsToEdges 产物），
// 本机无 PG 可绿。覆盖四型边过滤、条件门、grants/SAN 合并、源节点过滤、结果应用。
import { describe, it, expect } from 'vitest';
import { traverseEdges, applyTraversalResult } from '../graph-traversal.js';
import type { TraversableEdge } from '../graph-traversal.js';
import type { WenlvState, WenlvCondition } from '../../../db/schema/wenlv.js';

const state = (visited: Record<string, boolean> = {}, collected: Record<string, boolean> = {}): WenlvState =>
  ({ visited, collected, completed: {} });

const edge = (e: Partial<TraversableEdge> & Pick<TraversableEdge, 'id' | 'fromNodeId' | 'toNodeId' | 'edgeType'>): TraversableEdge => ({
  label: null, condition: null, grants: [], sanDelta: 0, ...e,
});

const visitedCond = (id: string): WenlvCondition => ({ type: 'ref', ref: { kind: 'visited', id } });
const collectedCond = (id: string): WenlvCondition => ({ type: 'ref', ref: { kind: 'collected', id } });

describe('traverseEdges（表无关纯函数）', () => {
  it('auto 边：条件满足即解锁目标、并入 grants、累加 sanDelta', () => {
    const edges = [
      edge({ id: 'e1', fromNodeId: 'a', toNodeId: 'b', edgeType: 'auto', grants: ['g1'], sanDelta: -1 }),
      edge({ id: 'e2', fromNodeId: 'a', toNodeId: 'c', edgeType: 'auto', grants: ['g2'], sanDelta: -2 }),
    ];
    const r = traverseEdges(edges, 'a', state(), 'auto');
    expect(r.autoUnlocked).toEqual(['b', 'c']);
    expect(r.choices).toEqual([]);
    expect(r.grants).toEqual(['g1', 'g2']);
    expect(r.sanDelta).toBe(-3);
  });

  it('只遍历 fromNodeId 匹配的边（全量边集内部过滤）', () => {
    const edges = [
      edge({ id: 'e1', fromNodeId: 'other', toNodeId: 'x', edgeType: 'auto' }),
      edge({ id: 'e2', fromNodeId: 'a', toNodeId: 'b', edgeType: 'auto' }),
    ];
    const r = traverseEdges(edges, 'a', state(), 'auto');
    expect(r.autoUnlocked).toEqual(['b']);
  });

  it('过滤器：puzzle_pass 边在 auto 过滤下被排除，反之亦然', () => {
    const edges = [
      edge({ id: 'e1', fromNodeId: 'a', toNodeId: 'b', edgeType: 'auto' }),
      edge({ id: 'e2', fromNodeId: 'a', toNodeId: 'ok', edgeType: 'puzzle_pass' }),
      edge({ id: 'e3', fromNodeId: 'a', toNodeId: 'bad', edgeType: 'puzzle_fail' }),
    ];
    expect(traverseEdges(edges, 'a', state(), 'puzzle_pass').autoUnlocked).toEqual(['ok']);
    expect(traverseEdges(edges, 'a', state(), 'puzzle_fail').autoUnlocked).toEqual(['bad']);
    expect(traverseEdges(edges, 'a', state(), 'auto').autoUnlocked).toEqual(['b']);
  });

  it("'all' 过滤器：auto 解锁 + choice 进 choices（choice 不自动解锁）", () => {
    const edges = [
      edge({ id: 'e1', fromNodeId: 'a', toNodeId: 'b', edgeType: 'auto' }),
      edge({ id: 'e2', fromNodeId: 'a', toNodeId: 'c', edgeType: 'choice', label: '走后门' }),
    ];
    const r = traverseEdges(edges, 'a', state(), 'all');
    expect(r.autoUnlocked).toEqual(['b']);
    expect(r.choices).toEqual([{ edgeId: 'e2', label: '走后门', toNodeId: 'c' }]);
  });

  it('条件门：visited/collected 不满足则跳过该边（不发 grants、不解锁、不计 SAN）', () => {
    const edges = [
      edge({ id: 'e1', fromNodeId: 'a', toNodeId: 'b', edgeType: 'auto', condition: visitedCond('gate'), sanDelta: -5, grants: ['g1'] }),
      edge({ id: 'e2', fromNodeId: 'a', toNodeId: 'c', edgeType: 'auto', condition: collectedCond('item'), grants: ['g2'] }),
      edge({ id: 'e3', fromNodeId: 'a', toNodeId: 'd', edgeType: 'auto' }),
    ];
    const r = traverseEdges(edges, 'a', state(), 'auto');
    expect(r.autoUnlocked).toEqual(['d']);
    expect(r.grants).toEqual([]);
    expect(r.sanDelta).toBe(0);
  });

  it('条件满足：visited 已到门 ⇒ 边生效', () => {
    const edges = [edge({ id: 'e1', fromNodeId: 'a', toNodeId: 'b', edgeType: 'puzzle_pass', condition: visitedCond('gate') })];
    const r = traverseEdges(edges, 'a', state({ gate: true }), 'puzzle_pass');
    expect(r.autoUnlocked).toEqual(['b']);
  });

  it('空边集：零效果（无边剧本 / 无房）', () => {
    const r = traverseEdges([], 'a', state(), 'auto');
    expect(r).toEqual({ autoUnlocked: [], choices: [], grants: [], sanDelta: 0 });
  });
});

describe('applyTraversalResult', () => {
  it('autoUnlocked 置 visited、grants 置 collected，不原地改写输入 state', () => {
    const before = state({ keep: true }, { old: true });
    const r = applyTraversalResult(
      { autoUnlocked: ['n2', 'n3'], choices: [], grants: ['g1', 'g2'], sanDelta: -3 },
      before,
    );
    expect(r.sanDelta).toBe(-3);
    expect(r.state.visited).toMatchObject({ keep: true, n2: true, n3: true });
    expect(r.state.collected).toMatchObject({ old: true, g1: true, g2: true });
    // 输入不被污染
    expect(before.visited).toEqual({ keep: true });
    expect(before.collected).toEqual({ old: true });
  });
});
