import { describe, it, expect } from 'vitest';
import { nightsOverlap, countOccupied, isAvailable, OCCUPYING_STATUSES } from './mini-availability.js';

describe('nightsOverlap', () => {
  it('区间重叠', () => {
    expect(nightsOverlap('2026-07-20', '2026-07-22', '2026-07-21', '2026-07-23')).toBe(true);
  });
  it('退房日等于对方入住日不算重叠（退房日不占当晚）', () => {
    expect(nightsOverlap('2026-07-20', '2026-07-22', '2026-07-22', '2026-07-24')).toBe(false);
  });
  it('完全包含算重叠', () => {
    expect(nightsOverlap('2026-07-20', '2026-07-25', '2026-07-21', '2026-07-22')).toBe(true);
  });
  it('跨月字典序比较正确', () => {
    expect(nightsOverlap('2026-07-31', '2026-08-02', '2026-08-01', '2026-08-03')).toBe(true);
  });
});

describe('countOccupied / isAvailable', () => {
  const orders = [
    { roomTypeId: 'rt_1', checkIn: '2026-07-20', checkOut: '2026-07-22', status: 'confirmed' },
    { roomTypeId: 'rt_1', checkIn: '2026-07-21', checkOut: '2026-07-23', status: 'pending' },
    { roomTypeId: 'rt_1', checkIn: '2026-07-21', checkOut: '2026-07-23', status: 'cancelled' }, // 已取消不占
    { roomTypeId: 'rt_2', checkIn: '2026-07-21', checkOut: '2026-07-23', status: 'confirmed' }, // 其他房型不占
  ];
  it('只统计同房型且状态占用且区间重叠的订单', () => {
    expect(countOccupied(orders, 'rt_1', '2026-07-21', '2026-07-22')).toBe(2);
  });
  it('剩余 = 总数 - 占用，>0 可订', () => {
    expect(isAvailable(3, 2)).toBe(true);
    expect(isAvailable(2, 2)).toBe(false);
  });
  it('待支付(pending)占用库存', () => {
    expect(OCCUPYING_STATUSES).toContain('pending');
    expect(OCCUPYING_STATUSES).not.toContain('cancelled');
  });
  it('空订单列表占用为 0', () => {
    expect(countOccupied([], 'rt_1', '2026-07-21', '2026-07-22')).toBe(0);
  });
  it('roomTypeId 为 null 的订单不计数且不抛错', () => {
    const withNull = [...orders, { roomTypeId: null, checkIn: '2026-07-21', checkOut: '2026-07-23', status: 'confirmed' }];
    expect(countOccupied(withNull, 'rt_1', '2026-07-21', '2026-07-22')).toBe(2);
  });
  it('房型未配房间时不可订', () => {
    expect(isAvailable(0, 0)).toBe(false);
  });
});
