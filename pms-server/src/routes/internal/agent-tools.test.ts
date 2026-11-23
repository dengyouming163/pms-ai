import { describe, it, expect } from 'vitest';
import { buildPricingSnapshot, searchKbEntries } from './agent-tools.js';

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

describe('searchKbEntries', () => {
  const entries = [
    { id: 'a', title: 'WiFi 与网络', content: '密码 yunqi2026', guideType: 'faq', metadata: null },
    { id: 'b', title: '退房与延迟退房', content: '退房时间 12:00，视房态可延迟至 14:00', guideType: 'faq', metadata: null },
    { id: 'c', title: '早餐时间', content: '自助早餐 07:30-09:30', guideType: 'faq', metadata: null },
  ];

  it('按关键词 OR 匹配，未命中的条目不返回', () => {
    expect(searchKbEntries(entries, ['退房']).map((entry) => entry.id)).toEqual(['b']);
    expect(searchKbEntries(entries, ['宠物'])).toEqual([]);
  });

  it('多条命中时按命中关键词数量排序', () => {
    // b 同时命中「退房」「延迟」，应排在只命中「早餐」的 c 之前
    const result = searchKbEntries(entries, ['退房', '延迟', '早餐']);
    expect(result.map((entry) => entry.id)).toEqual(['b', 'c']);
  });

  it('无关键词返回空数组', () => {
    expect(searchKbEntries(entries, [])).toEqual([]);
  });

  it('结果超过 limit 时截断', () => {
    expect(searchKbEntries(entries, ['退房', '早餐'], 1)).toHaveLength(1);
  });
});
