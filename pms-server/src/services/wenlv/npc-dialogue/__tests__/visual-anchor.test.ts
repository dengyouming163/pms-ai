import { describe, it, expect, vi } from 'vitest';
import { generateVisualAnchors, parseAnchors } from '../visual-anchor.js';

describe('visual-anchor', () => {
  it('parseAnchors 正常解析', () => {
    const raw = '[{"criteriaIndex":0,"anchor":"竹丛","line":"你看那竹子"}]';
    const r = parseAnchors(raw, 3);
    expect(r).toEqual([{ criteriaIndex: 0, anchor: '竹丛', line: '你看那竹子' }]);
  });
  it('parseAnchors 去 markdown 代码块', () => {
    const raw = '```json\n[{"criteriaIndex":1,"anchor":"石头","line":"看石头"}]\n```';
    const r = parseAnchors(raw, 3);
    expect(r).toEqual([{ criteriaIndex: 1, anchor: '石头', line: '看石头' }]);
  });
  it('parseAnchors 越界下标丢弃', () => {
    const raw = '[{"criteriaIndex":5,"anchor":"x","line":"y"}]';
    expect(parseAnchors(raw, 3)).toEqual([]);
  });
  it('parseAnchors 空字段丢弃', () => {
    const raw = '[{"criteriaIndex":0,"anchor":"","line":"y"}]';
    expect(parseAnchors(raw, 3)).toEqual([]);
  });
  it('generateVisualAnchors 无图返回空', async () => {
    const r = await generateVisualAnchors({ image: '' }, { answerCriteria: ['a'] } as any);
    expect(r).toEqual([]);
  });
});
