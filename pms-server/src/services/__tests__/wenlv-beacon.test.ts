import { describe, it, expect } from 'vitest';
import { normalizeMac, normalizeUuid, isValidBeaconNumber } from '../wenlv-beacon.js';

describe('normalizeMac', () => {
  it('冒号分隔 / 连字符分隔 / 裸 12 位 三种形态归一到同一结果', () => {
    const want = 'AABBCCDDEEFF';
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe(want);
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe(want);
    expect(normalizeMac('aabbccddeeff')).toBe(want);
    expect(normalizeMac('  AA:BB:CC:DD:EE:FF  ')).toBe(want); // 容忍两端空白
  });

  it('非 12 位十六进制一律 null（不做「抽掉非十六进制字符」的宽松清洗）', () => {
    // 这一条是核心：宽松清洗会把垃圾串静默收成合法 MAC。
    expect(normalizeMac('ZZ:AA:BB:CC:DD:EE:FF')).toBeNull();
    expect(normalizeMac('AA:BB:CC:DD:EE')).toBeNull();      // 10 位
    expect(normalizeMac('AABBCCDDEEFFF')).toBeNull();        // 13 位
    expect(normalizeMac('GGHHIIJJKKLL')).toBeNull();
    expect(normalizeMac('')).toBeNull();
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac(undefined)).toBeNull();
    expect(normalizeMac(12345 as unknown)).toBeNull();
    // 混合分隔符不是合法形态（只有两种严格形态被接受）
    expect(normalizeMac('AA:BB-CC:DD-EE:FF')).toBeNull();
  });
});

describe('normalizeUuid', () => {
  it('统一转小写', () => {
    const lower = 'fda50693-a4e2-4fb1-afcf-c6eb07647825';
    expect(normalizeUuid('FDA50693-A4E2-4FB1-AFCF-C6EB07647825')).toBe(lower);
    expect(normalizeUuid(lower)).toBe(lower);
    expect(normalizeUuid('  ' + lower.toUpperCase() + ' ')).toBe(lower);
  });

  it('非 8-4-4-4-12 十六进制一律 null', () => {
    expect(normalizeUuid('fda50693a4e24fb1afcfc6eb07647825')).toBeNull();  // 没连字符
    expect(normalizeUuid('fda50693-a4e2-4fb1-afcf-c6eb0764782')).toBeNull(); // 末段 11 位
    expect(normalizeUuid('zda50693-a4e2-4fb1-afcf-c6eb07647825')).toBeNull();
    expect(normalizeUuid('')).toBeNull();
    expect(normalizeUuid(null)).toBeNull();
    expect(normalizeUuid(undefined)).toBeNull();
  });
});

describe('isValidBeaconNumber', () => {
  it('接受 0..65535 的整数', () => {
    expect(isValidBeaconNumber(0)).toBe(true);
    expect(isValidBeaconNumber(1)).toBe(true);
    expect(isValidBeaconNumber(10001)).toBe(true);
    expect(isValidBeaconNumber(65535)).toBe(true);
  });

  it('拒绝越界 / 非整数 / 非数字', () => {
    expect(isValidBeaconNumber(-1)).toBe(false);
    expect(isValidBeaconNumber(65536)).toBe(false);
    expect(isValidBeaconNumber(1.5)).toBe(false);
    expect(isValidBeaconNumber('1')).toBe(false);
    expect(isValidBeaconNumber(null)).toBe(false);
    expect(isValidBeaconNumber(NaN)).toBe(false);
  });
});
