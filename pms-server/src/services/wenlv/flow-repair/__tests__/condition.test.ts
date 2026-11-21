import { describe, it, expect } from 'vitest';
import { rewriteGateCondition } from '../condition.js';
import type { WenlvCondition } from '../../../../db/schema/wenlv.js';

function ref(kind: 'collected' | 'visited' | 'completed', id: string): WenlvCondition {
  return { type: 'ref', ref: { kind, id } } as WenlvCondition;
}
function all(...conditions: WenlvCondition[]): WenlvCondition {
  return { type: 'all', conditions };
}
const blocked = { collected: new Set(['C_X']), visited: new Set(['N_DOWN']) };

describe('rewriteGateCondition（门条件机械修复）', () => {
  it('completed ref 迁移为 visited', () => {
    const r = rewriteGateCondition(ref('completed', 'N1'), { collected: new Set(), visited: new Set() });
    expect(r.cond).toEqual(ref('visited', 'N1'));
    expect(r.migratedCompleted).toBe(1);
  });

  it('扁平旧格式 completed 同步迁移', () => {
    const r = rewriteGateCondition({ type: 'completed', id: 'N1' } as any, { collected: new Set(), visited: new Set() });
    expect(r.cond).toEqual({ type: 'visited', id: 'N1' });
  });

  it('all 中不可得 collected 被安全剔除，剩余子句保留', () => {
    const r = rewriteGateCondition(all(ref('collected', 'C_X'), ref('visited', 'N1')), blocked);
    expect(r.cond).toEqual(ref('visited', 'N1'));
    expect(r.removed).toEqual([{ kind: 'collected', id: 'C_X' }]);
  });

  it('all 子句被删空 → null（恒真）', () => {
    const r = rewriteGateCondition(all(ref('collected', 'C_X')), blocked);
    expect(r.cond).toBeNull();
    expect(r.removed.length).toBe(1);
  });

  it('下游 visited 在 all 中剔除', () => {
    const r = rewriteGateCondition(all(ref('visited', 'N_DOWN'), ref('collected', 'C_OK')), blocked);
    expect(r.cond).toEqual(ref('collected', 'C_OK'));
    expect(r.removed.some((x) => x.kind === 'visited' && x.id === 'N_DOWN')).toBe(true);
  });

  it('any 中的阻塞叶子不删除，登记为 stuck', () => {
    const cond: WenlvCondition = { type: 'any', conditions: [ref('collected', 'C_X'), ref('visited', 'N1')] };
    const r = rewriteGateCondition(cond, blocked);
    expect(r.cond).toEqual(cond);
    expect(r.stuck).toEqual([{ kind: 'collected', id: 'C_X' }]);
    expect(r.removed).toEqual([]);
  });

  it('nofM 语境同样不删叶子，只做 completed→visited', () => {
    const cond: WenlvCondition = {
      type: 'nofM', n: 1,
      of: [ref('completed', 'N1'), ref('collected', 'C_X')],
    };
    const r = rewriteGateCondition(cond, blocked);
    expect(r.cond).toEqual({
      type: 'nofM', n: 1,
      of: [ref('visited', 'N1'), ref('collected', 'C_X')],
    });
    expect(r.migratedCompleted).toBe(1);
    expect(r.stuck.map((s) => s.id)).toEqual(['C_X']);
  });

  it('嵌套 all > any：外层安全剔除，内层卡住登记', () => {
    const cond = all(
      ref('collected', 'C_X'),
      { type: 'any', conditions: [ref('collected', 'C_X'), ref('visited', 'N1')] },
    );
    const r = rewriteGateCondition(cond, blocked);
    expect(r.cond).toEqual({ type: 'any', conditions: [ref('collected', 'C_X'), ref('visited', 'N1')] });
    expect(r.removed).toEqual([{ kind: 'collected', id: 'C_X' }]);
    expect(r.stuck).toEqual([{ kind: 'collected', id: 'C_X' }]);
  });

  it('completed 转 visited 后若仍是下游节点：all 中一并剔除', () => {
    const r = rewriteGateCondition(ref('completed', 'N_DOWN'), blocked);
    expect(r.cond).toBeNull();
    expect(r.migratedCompleted).toBe(1);
    expect(r.removed).toEqual([{ kind: 'visited', id: 'N_DOWN' }]);
  });

  it('null 条件原样返回 null', () => {
    const r = rewriteGateCondition(null, blocked);
    expect(r.cond).toBeNull();
    expect(r.migratedCompleted).toBe(0);
  });
});
