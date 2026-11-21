// funnel 纯函数测试：rate 百分比口径 + pivotMerchantRows 商户透视各分支。
// 纯内存，不打库、不 mock db。buildFunnel 的 DB 聚合不测（由路由层契约覆盖）。
import { describe, it, expect } from 'vitest';
import { rate, pivotMerchantRows } from '../funnel.js';

describe('rate', () => {
  it('分母 0 ⇒ null（前端显「—」）', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(1, 0)).toBeNull();
  });

  it('1/3 ⇒ 33.3、2/3 ⇒ 66.7（保留 1 位小数）', () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(2, 3)).toBe(66.7);
  });

  it('432/1000 ⇒ 43.2（43.2% 形态）', () => {
    expect(rate(432, 1000)).toBe(43.2);
  });

  it('5/5 ⇒ 100（整数不带小数位）', () => {
    expect(rate(5, 5)).toBe(100);
  });
});

describe('pivotMerchantRows', () => {
  it('空输入 ⇒ 空数组', () => {
    expect(pivotMerchantRows([])).toEqual([]);
  });

  it('payload.merchantPartnerId 缺失/空串 ⇒ 归 (未关联) 行', () => {
    expect(pivotMerchantRows([
      { eventType: 'arrived', payload: {} },
      { eventType: 'purchased', payload: { merchantPartnerId: '' } },
    ])).toEqual([
      { merchantPartnerId: '(未关联)', arrived: 1, cipherRedeemed: 0, purchased: 1, tokenRedeemed: 0, paidCustomization: 0 },
    ]);
  });

  it('五种事件各计数正确，互不干扰', () => {
    expect(pivotMerchantRows([
      { eventType: 'arrived', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'cipher_redeemed', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'purchased', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'token_redeemed', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'paid_customization', payload: { merchantPartnerId: 'mp1' } },
    ])).toEqual([
      { merchantPartnerId: 'mp1', arrived: 1, cipherRedeemed: 1, purchased: 1, tokenRedeemed: 1, paidCustomization: 1 },
    ]);
  });

  it('同商户多事件累加；不同商户分行', () => {
    expect(pivotMerchantRows([
      { eventType: 'arrived', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'arrived', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'cipher_redeemed', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'arrived', payload: { merchantPartnerId: 'mp2' } },
    ])).toEqual([
      { merchantPartnerId: 'mp1', arrived: 2, cipherRedeemed: 1, purchased: 0, tokenRedeemed: 0, paidCustomization: 0 },
      { merchantPartnerId: 'mp2', arrived: 1, cipherRedeemed: 0, purchased: 0, tokenRedeemed: 0, paidCustomization: 0 },
    ]);
  });

  it('payload 非对象（null/数组）不炸 ⇒ 归 (未关联)', () => {
    expect(pivotMerchantRows([
      { eventType: 'arrived', payload: null },
      { eventType: 'cipher_redeemed', payload: ['nope'] },
    ])).toEqual([
      { merchantPartnerId: '(未关联)', arrived: 1, cipherRedeemed: 1, purchased: 0, tokenRedeemed: 0, paidCustomization: 0 },
    ]);
  });

  it('白名单外事件（shared/checkin）忽略，不产生行', () => {
    expect(pivotMerchantRows([
      { eventType: 'shared', payload: { merchantPartnerId: 'mp1' } },
      { eventType: 'checkin', payload: { merchantPartnerId: 'mp1' } },
    ])).toEqual([]);
  });
});
