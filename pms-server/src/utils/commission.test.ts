import { describe, it, expect } from 'vitest';
import { calcCommission, calcWithdrawable } from './commission.js';

describe('calcCommission', () => {
  it('标准佣金：订单 1000 元(100000分) × 300(3%) = 3000 分', () => {
    expect(calcCommission(100000, 300)).toBe(3000);
  });
  it('向下取整', () => {
    expect(calcCommission(99999, 300)).toBe(2999); // 2999.97 → 2999
  });
  it('佣金比例 0 = 0', () => {
    expect(calcCommission(100000, 0)).toBe(0);
  });
  it('佣金比例 10000(100%) = 全额', () => {
    expect(calcCommission(100000, 10000)).toBe(100000);
  });
});

describe('calcWithdrawable', () => {
  it('可提现 = released - withdrawn - processing', () => {
    expect(calcWithdrawable(10000, 3000, 1000)).toBe(6000);
  });
  it('负余额归零', () => {
    expect(calcWithdrawable(5000, 6000, 0)).toBe(0);
  });
  it('全部可提', () => {
    expect(calcWithdrawable(10000, 0, 0)).toBe(10000);
  });
});
