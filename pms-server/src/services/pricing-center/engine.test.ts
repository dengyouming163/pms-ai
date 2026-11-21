import { describe, it, expect } from 'vitest';
import { calcDefaultPrice, suggestToday } from './engine.js';

const base = { baseWeekday: 288, baseWeekend: 358, basePrice: 288, holidayMarkupPct: 0 };

describe('calcDefaultPrice', () => {
  it('平日用周中价', () => {
    expect(calcDefaultPrice({ ...base, isWeekend: false, isHoliday: false })).toBe(288);
  });
  it('周末用周末价', () => {
    expect(calcDefaultPrice({ ...base, isWeekend: true, isHoliday: false })).toBe(358);
  });
  it('节假日按加价%', () => {
    expect(calcDefaultPrice({ ...base, isWeekend: false, isHoliday: true, holidayMarkupPct: 40 })).toBe(403);
  });
});

describe('suggestToday', () => {
  it('剩余多则下调促单', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 1, occupied: 0, competitorPrice: null, minPrice: null, currentPrice: 288 });
    expect(r.suggestedPrice < 288).toBe(true);
    expect(r.reasons.length > 0).toBe(true);
  });
  it('剩余少则上调', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 6, occupied: 0, competitorPrice: null, minPrice: null, currentPrice: 288 });
    expect(r.suggestedPrice > 288).toBe(true);
  });
  it('最低卖价护栏钳制', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 1, occupied: 0, competitorPrice: null, minPrice: 290, currentPrice: 288 });
    expect(r.suggestedPrice).toBe(290);
  });
  it('竞对高于你则上调并给理由', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 3, occupied: 0, competitorPrice: 330, minPrice: null, currentPrice: 288 });
    expect(r.suggestedPrice > 288).toBe(true);
    expect(r.reasons.some(x => x.includes('竞对'))).toBe(true);
  });
  it('无变化时 change=0', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 3, occupied: 0, competitorPrice: null, minPrice: null, currentPrice: 288 });
    expect(r.change).toBe(0);
  });
  it('竞对低于你则下调并给理由', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 3, occupied: 0, competitorPrice: 265, minPrice: null, currentPrice: 288 });
    expect(r.suggestedPrice < 288).toBe(true);
    expect(r.reasons.some(x => x.includes('竞对'))).toBe(true);
  });
  it('上限护栏钳制（maxPrice）', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 6, occupied: 0, competitorPrice: null, minPrice: null, maxPrice: 300, currentPrice: 288 });
    expect(r.suggestedPrice).toBe(300);
  });
  it('满房不出无意义建议（已订满 reasons 正确）', () => {
    const r = suggestToday({ ...base, isWeekend: false, isHoliday: false, totalRooms: 8, booked: 8, occupied: 0, competitorPrice: null, minPrice: null, currentPrice: 288 });
    expect(r.suggestedPrice).toBe(346);
    expect(r.reasons.join('')).toContain('已订8/8间');
  });
});
