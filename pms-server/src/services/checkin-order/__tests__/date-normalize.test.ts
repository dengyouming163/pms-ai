import { describe, it, expect } from 'vitest';
import { normalizeCheckinDate, nightsBetween, toDateOrNull } from '../date-normalize.js';

describe('normalizeCheckinDate', () => {
  it('标准 ISO 格式原样通过', () => {
    expect(normalizeCheckinDate('2026-10-18', 2026)).toBe('2026-10-18');
  });

  it('斜杠分隔', () => {
    expect(normalizeCheckinDate('2026/10/18', 2026)).toBe('2026-10-18');
  });

  it('点分隔', () => {
    expect(normalizeCheckinDate('2026.10.18', 2026)).toBe('2026-10-18');
  });

  it('中文年月日', () => {
    expect(normalizeCheckinDate('2026年10月18日', 2026)).toBe('2026-10-18');
  });

  it('带空格的月日与「号」后缀', () => {
    expect(normalizeCheckinDate('10 月 18 号', 2026)).toBe('2026-10-18');
  });

  it('缺年份按 fallbackYear 补全', () => {
    expect(normalizeCheckinDate('10月18日', 2025)).toBe('2025-10-18');
  });

  it('月日无「日」后缀（H5 解析器实际产出形如 8月14）', () => {
    expect(normalizeCheckinDate('8月14', 2026)).toBe('2026-08-14');
  });

  it('一位数字月日补零', () => {
    expect(normalizeCheckinDate('2026-1-2', 2026)).toBe('2026-01-02');
  });

  it('不存在的日期返回 null（2 月 30 日）', () => {
    expect(normalizeCheckinDate('2026-02-30', 2026)).toBeNull();
  });

  it('月份越界返回 null', () => {
    expect(normalizeCheckinDate('2026-13-01', 2026)).toBeNull();
  });

  it('日越界返回 null', () => {
    expect(normalizeCheckinDate('2026-01-32', 2026)).toBeNull();
  });

  it('空串返回 null', () => {
    expect(normalizeCheckinDate('', 2026)).toBeNull();
    expect(normalizeCheckinDate('   ', 2026)).toBeNull();
  });

  it('无法识别的文本返回 null', () => {
    expect(normalizeCheckinDate('待定', 2026)).toBeNull();
    expect(normalizeCheckinDate('20261 018', 2026)).toBeNull();
  });
});

describe('nightsBetween', () => {
  it('同日为 0 晚', () => {
    expect(nightsBetween('2026-10-18', '2026-10-18')).toBe(0);
  });

  it('跨一日为 1 晚', () => {
    expect(nightsBetween('2026-10-18', '2026-10-19')).toBe(1);
  });

  it('跨月正确', () => {
    expect(nightsBetween('2026-10-30', '2026-11-02')).toBe(3);
  });

  it('退房早于入住返回 null', () => {
    expect(nightsBetween('2026-10-19', '2026-10-18')).toBeNull();
  });

  it('任一为 null 返回 null', () => {
    expect(nightsBetween(null, '2026-10-18')).toBeNull();
    expect(nightsBetween('2026-10-18', null)).toBeNull();
  });
});

describe('toDateOrNull', () => {
  it('空串/undefined/null 一律 null（date 列不接受空串）', () => {
    expect(toDateOrNull('')).toBeNull();
    expect(toDateOrNull(null)).toBeNull();
    expect(toDateOrNull(undefined)).toBeNull();
    expect(toDateOrNull('  ')).toBeNull();
  });

  it('合法值原样归一', () => {
    expect(toDateOrNull('2026-10-18', 2026)).toBe('2026-10-18');
  });

  it('非法值回落 null，不抛异常', () => {
    expect(toDateOrNull('不确定', 2026)).toBeNull();
  });
});
