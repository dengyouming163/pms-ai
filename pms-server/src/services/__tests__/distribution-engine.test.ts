import { describe, it, expect } from 'vitest';
import { resolveDistRates, calcDistCommission } from '../distribution-engine.js';

describe('resolveDistRates', () => {
  it('套餐配置优先于全局默认', () => {
    const cfg = { enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200 };
    const product = { distributionConfig: { enabled: true, lv1Rate: 800, lv2Rate: 300 } };
    expect(resolveDistRates(cfg, product)).toEqual({ lv1: 800, lv2: 300 });
  });
  it('套餐缺失时回落全局默认', () => {
    const cfg = { enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200 };
    const product = { distributionConfig: null };
    expect(resolveDistRates(cfg, product)).toEqual({ lv1: 500, lv2: 200 });
  });
  it('总开关关闭时返回 null', () => {
    const cfg = { enabled: false, defaultLv1Rate: 500, defaultLv2Rate: 200 };
    expect(resolveDistRates(cfg, { distributionConfig: null })).toBeNull();
  });
  it('套餐关闭分销时返回 null', () => {
    const cfg = { enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200 };
    const product = { distributionConfig: { enabled: false, lv1Rate: 800, lv2Rate: 300 } };
    expect(resolveDistRates(cfg, product)).toBeNull();
  });
});

describe('calcDistCommission', () => {
  it('万分比计算：500 元 × 8% = 4000 分', () => {
    expect(calcDistCommission(500 * 100, 800)).toBe(4000);
  });
  it('向下取整', () => {
    expect(calcDistCommission(101, 500)).toBe(5); // 101 * 500 / 10000 = 5.05 → 5
  });
});
