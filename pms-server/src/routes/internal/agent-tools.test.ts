import { describe, it, expect } from 'vitest';
import { buildPricingSnapshot } from './agent-tools.js';

describe('buildPricingSnapshot', () => {
  it('计算入住率与可售房数', () => {
    const snap = buildPricingSnapshot({
      date: '2026-11-22',
      rooms: [
        { status: 'occupied' }, { status: 'available' }, { status: 'dirty' }, { status: 'available' },
      ],
    });
    expect(snap.total).toBe(4);
    expect(snap.available).toBe(2);
    expect(snap.occupancyRate).toBe(25);
  });

  it('无房时入住率为 0 而不是 NaN', () => {
    expect(buildPricingSnapshot({ date: '2026-11-22', rooms: [] }).occupancyRate).toBe(0);
  });

  it('booked 计入入住率（occupied + booked）', () => {
    const snap = buildPricingSnapshot({
      date: '2026-11-22',
      rooms: [{ status: 'booked' }, { status: 'occupied' }, { status: 'available' }, { status: 'available' }],
    });
    expect(snap.total).toBe(4);
    expect(snap.occupied).toBe(1);
    expect(snap.booked).toBe(1);
    expect(snap.occupancyRate).toBe(50);
  });

  it('回显查询日期', () => {
    expect(buildPricingSnapshot({ date: '2026-11-22', rooms: [] }).date).toBe('2026-11-22');
  });
});
