import { describe, it, expect } from 'vitest';
import { REGION_CITIES, REGION_DESTINATIONS, REGION_TAGS } from './constants.js';

describe('REGION_TAGS 固定标签库', () => {
  it('城市级 9 个 + 目的地级 12 个，全量 21 个', () => {
    expect(REGION_CITIES.length).toBe(9);
    expect(REGION_DESTINATIONS.length).toBe(12);
    expect(REGION_TAGS.length).toBe(21);
  });
  it('两级标签无重叠、全量无重复', () => {
    const overlap = REGION_CITIES.filter((c) => (REGION_DESTINATIONS as readonly string[]).includes(c));
    expect(overlap).toEqual([]);
    expect(new Set(REGION_TAGS).size).toBe(REGION_TAGS.length);
  });
  it('包含贵州核心热门目的地', () => {
    expect(REGION_DESTINATIONS).toContain('黄果树');
    expect(REGION_DESTINATIONS).toContain('荔波小七孔');
    expect(REGION_CITIES).toContain('贵阳');
  });
});
