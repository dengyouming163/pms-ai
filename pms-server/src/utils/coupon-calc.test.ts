import { describe, it, expect } from 'vitest';
import { calcCouponDiscount, type OrderAmount } from './coupon-calc.js';

const base: OrderAmount = { originalTotal: 1000, memberTotal: 900, nights: 2 };

describe('calcCouponDiscount', () => {
  it('满减券：满 800 减 100 → 减 100', () => {
    const d = calcCouponDiscount(base, { type: 'full_reduce', value: 100, minAmount: 800 });
    expect(d).toEqual({ discount: 100, finalTotal: 800 });
  });
  it('满减券：不满门槛 → 减 0', () => {
    const d = calcCouponDiscount(base, { type: 'full_reduce', value: 100, minAmount: 1000 });
    expect(d).toEqual({ discount: 0, finalTotal: 900 });
  });
  it('折扣券：85 折 → 在会员价基础上再折', () => {
    const d = calcCouponDiscount(base, { type: 'discount', value: 85, minAmount: 0 });
    expect(d).toEqual({ discount: 135, finalTotal: 765 });
  });
  it('新客券：固定减 50', () => {
    const d = calcCouponDiscount(base, { type: 'newcomer', value: 50, minAmount: 0 });
    expect(d).toEqual({ discount: 50, finalTotal: 850 });
  });
  it('折扣后不低于 0', () => {
    const d = calcCouponDiscount({ originalTotal: 100, memberTotal: 100, nights: 1 },
      { type: 'full_reduce', value: 200, minAmount: 0 });
    expect(d).toEqual({ discount: 100, finalTotal: 0 });
  });
});
