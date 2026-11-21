import { describe, it, expect } from 'vitest';
import { applyMemberDiscount, getDiscountRate } from './member-price.js';

describe('getDiscountRate', () => {
  it('从配置中取对应等级的折扣率', () => {
    const config = { gold: 95, platinum: 90, diamond: 85 };
    expect(getDiscountRate('gold', config)).toBe(95);
    expect(getDiscountRate('platinum', config)).toBe(90);
    expect(getDiscountRate('diamond', config)).toBe(85);
  });
  it('未配置的等级返回 100（无折扣）', () => {
    expect(getDiscountRate('regular', { gold: 95 })).toBe(100);
    expect(getDiscountRate('gold', {})).toBe(100);
  });
  it('null/undefined 配置返回 100', () => {
    expect(getDiscountRate('gold', null as any)).toBe(100);
    expect(getDiscountRate('gold', undefined as any)).toBe(100);
  });
});

describe('applyMemberDiscount', () => {
  const nightly = [
    { date: '2026-07-20', price: 688 },
    { date: '2026-07-21', price: 888 },
  ];
  it('按折扣率计算逐晚价格（向下取整到元）', () => {
    const result = applyMemberDiscount(nightly, 90);
    expect(result).toEqual([
      { date: '2026-07-20', price: Math.floor(688 * 0.9) },
      { date: '2026-07-21', price: Math.floor(888 * 0.9) },
    ]);
  });
  it('折扣率 100 等于门市价', () => {
    expect(applyMemberDiscount(nightly, 100)).toEqual(nightly);
  });
});
