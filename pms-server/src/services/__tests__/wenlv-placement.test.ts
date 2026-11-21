import { describe, it, expect } from 'vitest';
import {
  derivePlacement, canAdvance, patchForAdvance, clearedByReset,
  type PlacementState,
} from '../wenlv-placement.js';

describe('derivePlacement —— 四态派生', () => {
  const d = (s: string) => new Date(s);

  it('全空 = 未印', () => {
    expect(derivePlacement({})).toBe('none');
  });

  // 八个组合全枚举：优先级的**每一条**都要被钉住。
  // 后三种是「不可能状态」，但 reset 能造出它们，派生必须仍有确定答案。
  it.each([
    [null, null, null, 'none'],
    [d('2026-01-01'), null, null, 'printed'],
    [null, d('2026-01-02'), null, 'placed'],
    [null, null, d('2026-01-03'), 'verified'],
    [d('2026-01-01'), d('2026-01-02'), null, 'placed'],
    [d('2026-01-01'), null, d('2026-01-03'), 'verified'],
    [null, d('2026-01-02'), d('2026-01-03'), 'verified'],
    [d('2026-01-01'), d('2026-01-02'), d('2026-01-03'), 'verified'],
  ])('printed=%s placed=%s verified=%s ⇒ %s', (p, pl, v, want) => {
    expect(derivePlacement({ printedAt: p, placedAt: pl, verifiedAt: v })).toBe(want);
  });

  it('字符串时间戳（从 pg 原始行来）与 Date 等价', () => {
    expect(derivePlacement({ placedAt: '2026-01-02T00:00:00Z' })).toBe('placed');
  });
});

describe('canAdvance —— 只前进', () => {
  it('同阶段幂等成功', () => {
    for (const s of ['printed', 'placed', 'verified'] as const) {
      expect(canAdvance(s, s), `${s} → ${s}`).toBe(true);
    }
  });

  it('前进允许', () => {
    expect(canAdvance('none', 'printed')).toBe(true);
    expect(canAdvance('none', 'placed')).toBe(true);
    expect(canAdvance('none', 'verified')).toBe(true); // D9：跳阶是真实场景
    expect(canAdvance('printed', 'placed')).toBe(true);
    expect(canAdvance('printed', 'verified')).toBe(true);
    expect(canAdvance('placed', 'verified')).toBe(true);
  });

  it('倒退一律拒绝', () => {
    expect(canAdvance('placed', 'printed')).toBe(false);
    expect(canAdvance('verified', 'placed')).toBe(false);
    expect(canAdvance('verified', 'printed')).toBe(false);
  });
});

describe('patchForAdvance —— 只写该阶段的 at/by', () => {
  const now = new Date('2026-02-02T02:02:02Z');

  it('推进到 printed 只写 printed_at/printed_by', () => {
    expect(patchForAdvance('printed', 'pu-1', now)).toEqual({ printedAt: now, printedBy: 'pu-1' });
  });
  it('推进到 placed 只写 placed_at/placed_by', () => {
    expect(patchForAdvance('placed', 'pu-1', now)).toEqual({ placedAt: now, placedBy: 'pu-1' });
  });
  it('推进到 verified 只写 verified_at/verified_by', () => {
    expect(patchForAdvance('verified', 'pu-1', now)).toEqual({ verifiedAt: now, verifiedBy: 'pu-1' });
  });
  it('by 为 null 时仍写时间戳（操作人未知 ≠ 没发生）', () => {
    expect(patchForAdvance('printed', null, now)).toEqual({ printedAt: now, printedBy: null });
  });
});

describe('clearedByReset —— 清空该阶段及其之后', () => {
  it('reset printed ⇒ 清空全部三个阶段', () => {
    expect(clearedByReset('printed')).toEqual({
      printedAt: null, printedBy: null,
      placedAt: null, placedBy: null,
      verifiedAt: null, verifiedBy: null,
    });
  });
  it('reset placed ⇒ 清空 placed 与 verified，**保留** printed', () => {
    const c = clearedByReset('placed');
    expect(c).toEqual({ placedAt: null, placedBy: null, verifiedAt: null, verifiedBy: null });
    expect(c).not.toHaveProperty('printedAt');
  });
  it('reset verified ⇒ 只清 verified', () => {
    const c = clearedByReset('verified');
    expect(c).toEqual({ verifiedAt: null, verifiedBy: null });
    expect(c).not.toHaveProperty('placedAt');
  });
});
