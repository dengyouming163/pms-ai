import { describe, it, expect } from 'vitest';
import { enumerateNights, calcNightlyPrices, type RoomTypePrice } from './mini-price.js';

const rt: RoomTypePrice = { id: 'rt_1', name: '海景大床房', basePrice: 688, weekendPrice: 888 };

describe('enumerateNights', () => {
  it('枚举入住到退房间的每一晚（退房日不含）', () => {
    expect(enumerateNights('2026-07-20', '2026-07-22')).toEqual(['2026-07-20', '2026-07-21']);
  });
  it('单晚', () => {
    expect(enumerateNights('2026-07-20', '2026-07-21')).toEqual(['2026-07-20']);
  });
  it('退房不晚于入住返回空数组', () => {
    expect(enumerateNights('2026-07-22', '2026-07-20')).toEqual([]);
    expect(enumerateNights('2026-07-20', '2026-07-20')).toEqual([]);
  });
});

describe('calcNightlyPrices', () => {
  it('无日历覆盖：工作日用 basePrice，周五/周六用 weekendPrice', () => {
    // 2026-07-20 周一，2026-07-24 周五
    const prices = calcNightlyPrices(['2026-07-20', '2026-07-24'], new Map(), rt);
    expect(prices).toEqual([
      { date: '2026-07-20', price: 688 },
      { date: '2026-07-24', price: 888 },
    ]);
  });
  it('日历覆盖价优先', () => {
    const overrides = new Map([['2026-07-20', 999]]);
    const prices = calcNightlyPrices(['2026-07-20'], overrides, rt);
    expect(prices).toEqual([{ date: '2026-07-20', price: 999 }]);
  });
  it('weekendPrice 缺失时周末回退 basePrice', () => {
    const prices = calcNightlyPrices(['2026-07-24'], new Map(), { ...rt, weekendPrice: null });
    expect(prices[0].price).toBe(688);
  });
});
