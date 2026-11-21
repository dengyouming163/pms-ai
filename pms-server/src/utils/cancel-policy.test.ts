import { describe, it, expect } from 'vitest';
import { calcRefundAmount } from './cancel-policy.js';

// 政策：入住日 00:00 前 24 小时外免费取消，之内收 20% 手续费
const policy = { freeHours: 24, feeRate: 20 };

describe('calcRefundAmount', () => {
  it('免费取消期外全额退（元）', () => {
    // 入住 2026-07-20，当前 2026-07-18 12:00（距入住日0点 36 小时 > 24）
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-18T12:00:00+08:00'), policy);
    expect(refund).toBe(1000);
  });
  it('免费期内收手续费', () => {
    // 当前 2026-07-19 12:00（距入住日0点 12 小时 < 24）→ 退 80%
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-19T12:00:00+08:00'), policy);
    expect(refund).toBe(800);
  });
  it('入住日当天及之后取消不退', () => {
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-20T08:00:00+08:00'), policy);
    expect(refund).toBe(0);
  });
  it('可退金额向下取整（元不出现小数）', () => {
    const refund = calcRefundAmount(999, '2026-07-20', new Date('2026-07-19T12:00:00+08:00'), policy);
    expect(refund).toBe(Math.floor(999 * 0.8)); // 799
  });
});

describe('calcRefundAmount freeHours 边界', () => {
  it('恰好在 freeHours 边界（距入住日 0 点整 24 小时）按免费取消全额退', () => {
    // 入住 2026-07-20，当前 2026-07-19 00:00（hoursLeft === 24，>= freeHours）
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-19T00:00:00+08:00'), policy);
    expect(refund).toBe(1000);
  });
  it('刚进入边界内（23 小时 59 分）收手续费', () => {
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-19T00:01:00+08:00'), policy);
    expect(refund).toBe(800);
  });
  it('入住日 00:00 整点取消不退（>= 边界闭区间）', () => {
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-20T00:00:00+08:00'), policy);
    expect(refund).toBe(0);
  });
  it('freeHours=0 时入住日 0 点前任意时刻均全额退', () => {
    const refund = calcRefundAmount(1000, '2026-07-20', new Date('2026-07-19T23:59:00+08:00'), { freeHours: 0, feeRate: 20 });
    expect(refund).toBe(1000);
  });
});
