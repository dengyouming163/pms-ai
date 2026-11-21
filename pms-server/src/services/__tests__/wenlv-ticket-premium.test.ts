// 剧本房溢价纯函数单测（Task 11）：不碰库、不碰网 —— CI/本机恒跑。
// 合成点接线（路由层）另有活库用例钉：routes/mini/__tests__/wenlv-trade-products.db.test.ts。
import { describe, it, expect } from 'vitest';
import { ticketPremiumOf, displayPriceWithPremium } from '../wenlv/ticket-premium.js';

describe('ticketPremiumOf（从内容产品 config 提取溢价）', () => {
  it('config.premium 正数原样取出', () => {
    expect(ticketPremiumOf({ premium: 10 })).toBe(10);
    expect(ticketPremiumOf({ premium: 0.5 })).toBe(0.5);
    // 字符串数字容错（表单/历史数据可能存成字符串）
    expect(ticketPremiumOf({ premium: '12.5' })).toBe(12.5);
  });

  it('缺省/空 config/null/undefined 一律 0（premium 缺省 0 基线）', () => {
    expect(ticketPremiumOf(undefined)).toBe(0);
    expect(ticketPremiumOf(null)).toBe(0);
    expect(ticketPremiumOf({})).toBe(0);
    expect(ticketPremiumOf({ other: 1 })).toBe(0);
  });

  it('非法与负值钳到 0：溢价是加价语义，不做隐性折扣', () => {
    expect(ticketPremiumOf({ premium: -5 })).toBe(0);
    expect(ticketPremiumOf({ premium: 0 })).toBe(0);
    expect(ticketPremiumOf({ premium: NaN })).toBe(0);
    expect(ticketPremiumOf({ premium: 'abc' })).toBe(0);
    expect(ticketPremiumOf({ premium: Infinity })).toBe(0);
  });
});

describe('displayPriceWithPremium（C 端展示价 = 票价 + 溢价）', () => {
  it('premium > 0：base + premium，两位小数字符串', () => {
    expect(displayPriceWithPremium('88.00', 10)).toBe('98.00');
    expect(displayPriceWithPremium('99.00', 0.5)).toBe('99.50');
    expect(displayPriceWithPremium('0.01', 0.02)).toBe('0.03');
    expect(displayPriceWithPremium(88, 12)).toBe('100.00'); // 数字入参同型出参（字符串）
  });

  it('premium = 0 / 负 / NaN：原样透传，不归一化形状（下游钉住 \'88.00\' 字面形状）', () => {
    expect(displayPriceWithPremium('88.00', 0)).toBe('88.00');
    expect(displayPriceWithPremium('88.00', -3)).toBe('88.00');
    expect(displayPriceWithPremium('88.00', NaN)).toBe('88.00');
    // 字符串透传保持逐字（'0.00' 而非 '0'）
    expect(displayPriceWithPremium('0.00', 0)).toBe('0.00');
  });

  it('base 非有限数：原样透传（显示层坏数据不拦交易主流程）', () => {
    expect(displayPriceWithPremium('abc', 10)).toBe('abc');
    expect(displayPriceWithPremium('', 10)).toBe('');
  });
});
