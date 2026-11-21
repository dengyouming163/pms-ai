import { describe, it, expect } from 'vitest';
import { REPORT_CATEGORIES, normalizeCategory, isDuplicateWithin, summarizeReports } from '../wenlv-report.js';

describe('normalizeCategory', () => {
  it('已知类别原样返回', () => {
    for (const c of REPORT_CATEGORIES) expect(normalizeCategory(c)).toBe(c);
  });
  it('未知 / 空 / 非字符串一律归 other（**不拒绝**：上报宁可存糙也不能丢）', () => {
    for (const v of ['', 'x', null, undefined, 42, {}]) expect(normalizeCategory(v as any)).toBe('other');
  });
});

describe('isDuplicateWithin —— 去重窗口（E6）', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  it('窗口内同类别算重复', () => {
    expect(isDuplicateWithin({ createdAt: new Date('2026-09-16T11:59:30Z'), category: 'image' }, 'image', now, 60_000)).toBe(true);
  });
  it('**恰好在窗口边界算不算，由实现显式决定**：等于窗口长算重复（闭区间）', () => {
    expect(isDuplicateWithin({ createdAt: new Date('2026-09-16T11:59:00Z'), category: 'image' }, 'image', now, 60_000)).toBe(true);
  });
  it('超出窗口不算重复', () => {
    expect(isDuplicateWithin({ createdAt: new Date('2026-09-16T11:58:59Z'), category: 'image' }, 'image', now, 60_000)).toBe(false);
  });
  it('**类别不同就不算重复** —— 同一分钟内音频坏了又图裂了，是两件事', () => {
    expect(isDuplicateWithin({ createdAt: new Date('2026-09-16T11:59:59Z'), category: 'audio' }, 'image', now, 60_000)).toBe(false);
  });
  it('没有上一条 ⇒ 不重复', () => {
    expect(isDuplicateWithin(null, 'image', now, 60_000)).toBe(false);
  });
});

describe('summarizeReports —— 按剧本×类别归并（E8）', () => {
  it('计数正确，且类别按固定顺序输出（保证页面稳定）', () => {
    const rows = [
      { productId: 'p1', category: 'image' }, { productId: 'p1', category: 'image' },
      { productId: 'p1', category: 'audio' }, { productId: 'p2', category: 'cert' },
    ];
    const s = summarizeReports(rows as any);
    const p1 = s.find((x) => x.productId === 'p1')!;
    expect(p1.total).toBe(3);
    expect(p1.byCategory.image).toBe(2);
    expect(p1.byCategory.audio).toBe(1);
    expect(p1.byCategory.cert).toBe(0);
    expect(Object.keys(p1.byCategory)).toEqual([...REPORT_CATEGORIES]);   // 顺序稳定
  });
  it('空输入 ⇒ 空数组（不抛）', () => {
    expect(summarizeReports([])).toEqual([]);
  });
  // ⚠️ 原稿的上面两条**全部没传 createdAt** ⇒ `lastAt` 恒为 null，那段逻辑一行都没跑到，
  //    而 `lastAt` 是汇总表要显示的一列（「最近一条时间」）。补这条把分支盖住：
  //    故意**乱序**给，才能证明取的是**最大值**而不是「最后一行」。
  it('lastAt 取**最新**一条（乱序输入也算对）', () => {
    const s = summarizeReports([
      { productId: 'p1', category: 'image', createdAt: '2026-09-16T12:00:00.000Z' },
      { productId: 'p1', category: 'audio', createdAt: '2026-09-16T14:00:00.000Z' },
      { productId: 'p1', category: 'cert',  createdAt: '2026-09-16T13:00:00.000Z' },
    ]);
    expect(s[0].lastAt).toBe('2026-09-16T14:00:00.000Z');
  });
});
