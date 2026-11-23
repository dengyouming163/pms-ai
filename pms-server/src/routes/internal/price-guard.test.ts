import { describe, it, expect } from 'vitest';
// 计划矛盾 A 修正：源码在 src/services/price-guard.ts，测试在 src/routes/internal/ 下，
// 故相对路径为 ../../services/price-guard.js（保持测试文件路径不变，仅修正 import）。
import { checkPriceAdjustment } from '../../services/price-guard.js';

const base = { currentPrice: 480, nextPrice: 520, minPrice: 100, maxDeltaPct: 30 };

describe('checkPriceAdjustment', () => {
  // 计划矛盾 B 修正：checkPriceAdjustment 恒返回 deltaPct，
  // 故成功断言用 toMatchObject 允许额外字段，而非严格 toEqual({ ok: true })。
  it('允许 30% 以内的上调', () => {
    expect(checkPriceAdjustment(base)).toMatchObject({ ok: true });
  });

  it('拒绝超过 30% 的上调', () => {
    const r = checkPriceAdjustment({ ...base, nextPrice: 700 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('30%');
  });

  it('拒绝低于最低价', () => {
    const r = checkPriceAdjustment({ ...base, nextPrice: 80, currentPrice: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('最低价');
  });

  it('拒绝非正数价格', () => {
    expect(checkPriceAdjustment({ ...base, nextPrice: 0 }).ok).toBe(false);
  });

  it('拒绝与当前价相同', () => {
    expect(checkPriceAdjustment({ ...base, nextPrice: 480 }).ok).toBe(false);
  });
});
