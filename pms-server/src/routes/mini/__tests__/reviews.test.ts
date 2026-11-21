import { describe, it, expect } from 'vitest';
import { aggregateReviews } from '../../../services/store-reviews.js';

// 测试辅助：生成偏移 N 小时的 Date（t(0) < t(1) < ...）
const t = (offsetHours: number) => new Date(Date.UTC(2026, 0, 2, 12, 0, 0) + offsetHours * 3600 * 1000);

describe('aggregateReviews 门店口碑聚合', () => {
  it('空数据 → reviewCount 0 / avgScore 0 / 分布全 0 / tags 空 / list 空', () => {
    const r = aggregateReviews([]);
    expect(r.reviewCount).toBe(0);
    expect(r.avgScore).toBe(0);
    expect(r.distribution).toEqual({ '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 });
    expect(r.tags).toEqual([]);
    expect(r.list).toEqual([]);
  });

  it('全为 NULL 分数（问卷已投递未回填）→ 视为无评价', () => {
    const r = aggregateReviews([
      { score: null, createdAt: t(0) },
      { score: null, createdAt: t(1) },
    ]);
    expect(r.reviewCount).toBe(0);
    expect(r.avgScore).toBe(0);
    expect(r.list).toEqual([]);
  });

  it('混合分数（5,4,3,2,1）→ 平均分 3.0、分布各 1', () => {
    const r = aggregateReviews([
      { score: 5, createdAt: t(0) },
      { score: 4, createdAt: t(1) },
      { score: 3, createdAt: t(2) },
      { score: 2, createdAt: t(3) },
      { score: 1, createdAt: t(4) },
    ]);
    expect(r.reviewCount).toBe(5);
    expect(r.avgScore).toBe(3.0);
    expect(r.distribution).toEqual({ '5': 1, '4': 1, '3': 1, '2': 1, '1': 1 });
  });

  it('满意度标签：5 条里「卫生」出现 2 条 → 卫生 goodRate 60；「床品」1 条 → 80', () => {
    const r = aggregateReviews([
      { score: 5, complaints: ['卫生'], createdAt: t(0) },
      { score: 5, complaints: ['床品'], createdAt: t(1) },
      { score: 4, complaints: ['卫生'], createdAt: t(2) },
      { score: 4, createdAt: t(3) },
      { score: 3, createdAt: t(4) },
    ]);
    const hygiene = r.tags.find((x) => x.key === '卫生');
    const bedding = r.tags.find((x) => x.key === '床品');
    expect(hygiene?.goodRate).toBe(60);
    expect(bedding?.goodRate).toBe(80);
  });

  it('未知 complaint 标签被忽略（不在已知维度中）', () => {
    const r = aggregateReviews([
      { score: 3, complaints: ['噪音大'], createdAt: t(0) },
    ]);
    expect(r.tags).toEqual([]);
  });

  it('list 按 createdAt 倒序、取前 10、无 comment 输出空字符串', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      score: 5,
      comment: i === 11 ? '最新的一条' : `评价${i}`,
      createdAt: t(i),
    }));
    const r = aggregateReviews(rows);
    expect(r.list.length).toBe(10);
    expect(r.list[0].comment).toBe('最新的一条');   // 最新在前
    expect(r.list[9].comment).toBe('评价2');        // 只保留前 10 条
    expect(r.list[0].createdAt).toBe(t(11).toISOString());
  });

  it('评价样本含 complaints 数组，缺省为空数组', () => {
    const r = aggregateReviews([
      { score: 5, complaints: ['服务'], createdAt: t(0) },
      { score: 4, createdAt: t(1) },
    ]);
    expect(r.list[0].complaints).toEqual([]);        // 最新在前（t(1) 无不满点）
    expect(r.list[1].complaints).toEqual(['服务']);
    expect(r.list[1].comment).toBe('');
  });
});
