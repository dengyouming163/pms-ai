import { describe, it, expect } from 'vitest';
import { generateFuturePlans, computeOccupancyAvg } from './planner.js';

const ORDERS = [
  { checkIn: '2026-08-10', checkOut: '2026-08-12', status: 'confirmed', roomTypeId: 'rt1' },
  { checkIn: '2026-08-11', checkOut: '2026-08-13', status: 'confirmed', roomTypeId: 'rt1' },
  { checkIn: '2026-08-12', checkOut: '2026-08-13', status: 'cancelled', roomTypeId: 'rt1' },
];

describe('computeOccupancyAvg', () => {
  it('统计区间内平均入住率（排除取消）', () => {
    // 左闭右开 [8/10,8/13)：8/10:1间(o1), 8/11:2间(o1,o2), 8/12:1间(o2, o1于8/12退房不占当夜)
    // sum=4 → (4/3/10)*100 ≈ 13.3% → 13
    const avg = computeOccupancyAvg(ORDERS, 'rt1', 10, '2026-08-10', '2026-08-13');
    expect(avg).toBe(13);
  });
  it('总房量 0 返回 50', () => { expect(computeOccupancyAvg(ORDERS, 'rt1', 0, '2026-08-10', '2026-08-13')).toBe(50); });
});

describe('generateFuturePlans', () => {
  it('生成 3 天计划且价格不超 maxDeviationPct 护栏', () => {
    const plans = generateFuturePlans({
      roomTypeId: 'rt1', roomTypeName: '大床房', storeId: 's1', merchantId: 'm1',
      basePrice: 300, weekendPrice: 360, weekdayPrice: 300,
      totalRooms: 10, occupiedToday: 2,
      orders: ORDERS, startDate: '2026-08-14', days: 3,
      commissionRate: 15, competitorPrice: 340, maxDeviationPct: 30,
      recentAvg: 60, priorAvg: 50,
    });
    expect(plans.length).toBe(3);
    for (const p of plans) {
      // 护栏不变式：价格 ∈ [底价×0.7, 底价×1.3]，用布尔表达式 + toBe 规避 vitest/chai 类型冲突
      expect(p.price >= Math.round(300 * 0.7) && p.price <= Math.round(300 * 1.3)).toBe(true);
      expect(p.predictedOccupancy >= 5 && p.predictedOccupancy <= 100).toBe(true);
    }
    expect(plans[0].planDate).toBe('2026-08-14');
  });
});
