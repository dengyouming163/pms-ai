import { describe, it, expect } from 'vitest';
import { orderNoPrefix, nextSequence, formatOrderNo } from '../order-no.js';

describe('orderNoPrefix', () => {
  it('CK + 本地日期 yyyyMMdd', () => {
    expect(orderNoPrefix(new Date(2026, 9, 18))).toBe('CK20261018');
  });

  it('个位数月日补零', () => {
    expect(orderNoPrefix(new Date(2026, 0, 5))).toBe('CK20260105');
  });
});

describe('nextSequence', () => {
  it('无既有单号时从 1 开始', () => {
    expect(nextSequence('CK20261018', [])).toBe(1);
  });

  it('取当日最大序号 + 1', () => {
    const existing = ['CK202610180001', 'CK202610180007', 'CK202610180003'];
    expect(nextSequence('CK20261018', existing)).toBe(8);
  });

  it('忽略其他日期的单号', () => {
    const existing = ['CK202610170009', 'CK202610180002'];
    expect(nextSequence('CK20261018', existing)).toBe(3);
  });

  it('忽略非法尾串（长度不足 / 非数字）而不抛异常', () => {
    const existing = ['CK20261018', 'CK20261018AB', 'CK2026101801', null as unknown as string];
    expect(nextSequence('CK20261018', existing)).toBe(1);
  });

  it('序号超过 9999 时继续递增（不截断）', () => {
    expect(nextSequence('CK20261018', ['CK202610189999'])).toBe(10000);
  });

  it('序号超过 4 位时仍能读回并继续递增（≥10000 不再原地打转）', () => {
    expect(nextSequence('CK20261018', ['CK202610189999', 'CK2026101810000'])).toBe(10001);
  });

  it('忽略 undefined 与 null 与非法尾串', () => {
    expect(nextSequence('CK20261018', [null, undefined, '', 'CK20261018abcd'])).toBe(1);
  });
});

describe('formatOrderNo', () => {
  it('4 位补零', () => {
    expect(formatOrderNo('CK20261018', 1)).toBe('CK202610180001');
    expect(formatOrderNo('CK20261018', 9999)).toBe('CK202610189999');
  });

  it('超过 4 位不截断', () => {
    expect(formatOrderNo('CK20261018', 10000)).toBe('CK2026101810000');
  });
});
