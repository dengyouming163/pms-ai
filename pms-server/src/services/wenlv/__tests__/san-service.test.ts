import { describe, it, expect } from 'vitest';
import { applySanDelta, getEndingBySan } from '../san-service.js';

describe('san-service', () => {
  it('applySanDelta 增加不超过100', () => {
    expect(applySanDelta(95, 10)).toBe(100);
  });
  it('applySanDelta 减少不低于0', () => {
    expect(applySanDelta(5, -15)).toBe(0);
  });
  it('applySanDelta 正常增减', () => {
    expect(applySanDelta(80, -15)).toBe(65);
  });
  it('getEndingBySan >=60 good', () => {
    expect(getEndingBySan(60)).toBe('good');
  });
  it('getEndingBySan 30-59 normal', () => {
    expect(getEndingBySan(59)).toBe('normal');
    expect(getEndingBySan(30)).toBe('normal');
  });
  it('getEndingBySan <30 bad', () => {
    expect(getEndingBySan(29)).toBe('bad');
  });
  it('getEndingBySan 0 force bad', () => {
    expect(getEndingBySan(0)).toBe('bad');
  });
});
