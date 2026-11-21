import { describe, it, expect } from 'vitest';
import {
  calcFloatPct, calcTargetPrice, forecastOccupancy, calcRemainingRooms,
  buildSlotTargets, countBookedOnDate, computeTrendFactor, forecastOccupancyWithTrend,
} from './engine.js';

describe('calcFloatPct', () => {
  it('standard 17:00 无剩余时取基准 15%', () => {
    expect(calcFloatPct('standard', '17:00', 0)).toBe(15);
  });
  it('standard 17:00 满房时浮动降低至 11', () => {
    expect(calcFloatPct('standard', '17:00', 1)).toBe(11);
  });
  it('21:00 始终为 0', () => {
    expect(calcFloatPct('aggressive', '21:00', 0)).toBe(0);
  });
  it('无效时点抛错', () => {
    let threw = false;
    try {
      calcFloatPct('standard', '22:00', 0);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('calcTargetPrice 护栏', () => {
  it('正常浮动', () => { expect(calcTargetPrice(300, 15)).toBe(345); });
  it('上浮封顶 1.5x', () => { expect(calcTargetPrice(300, 100)).toBe(450); });
  it('绝不低于底价', () => { expect(calcTargetPrice(300, -20)).toBe(300); });
});

describe('forecastOccupancy', () => {
  it('已订为主', () => { expect(forecastOccupancy(10, 5, 2)).toBe(56); });
  it('总房量为 0 时返回 50', () => { expect(forecastOccupancy(0, 0, 0)).toBe(50); });
});

describe('buildSlotTargets', () => {
  it('standard 生成三档目标价且均不低于底价', () => {
    const t = buildSlotTargets(300, 'standard', 0);
    expect(t['17:00'].targetPrice).toBe(345);
    expect(t['19:00'].targetPrice).toBe(315);
    expect(t['21:00'].targetPrice).toBe(300);
  });
});

describe('calcRemainingRooms', () => {
  it('剩余 = 总量 − 已订 − 在住，不为负', () => {
    expect(calcRemainingRooms(10, 4, 2)).toBe(4);
    expect(calcRemainingRooms(3, 4, 2)).toBe(0);
  });
});

describe('countBookedOnDate', () => {
  it('统计覆盖该日的未取消订单', () => {
    const orders = [
      { checkIn: '2026-08-05', checkOut: '2026-08-06', status: 'confirmed' },
      { checkIn: '2026-08-04', checkOut: '2026-08-05', status: 'confirmed' },
      { checkIn: '2026-08-05', checkOut: '2026-08-07', status: 'cancelled' },
      { checkIn: '2026-08-05', checkOut: '2026-08-06', status: 'no_show' },
    ];
    expect(countBookedOnDate(orders, '2026-08-05')).toBe(1);
  });
});

describe('computeTrendFactor', () => {
  it('近期高于前期取正并封顶10', () => { expect(computeTrendFactor(75, 60)).toBe(10); });
  it('近期低于前期取负并封底-10', () => { expect(computeTrendFactor(50, 70)).toBe(-10); });
  it('持平为 0', () => { expect(computeTrendFactor(60, 60)).toBe(0); });
  it('非有限值返回 0', () => { expect(computeTrendFactor(NaN, 60)).toBe(0); });
  it('四舍五入', () => { expect(computeTrendFactor(66, 60)).toBe(6); });
});

describe('forecastOccupancyWithTrend', () => {
  it('基准 + 趋势', () => { expect(forecastOccupancyWithTrend(10, 5, 2, 8)).toBe(64); }); // 56 + 8
  it('封顶 100', () => { expect(forecastOccupancyWithTrend(10, 9, 2, 50)).toBe(100); });
  it('下限 5', () => { expect(forecastOccupancyWithTrend(10, 0, 0, -50)).toBe(5); });
});
