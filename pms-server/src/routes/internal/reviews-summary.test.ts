import { describe, it, expect } from 'vitest';
import { summarizeReviews, type ReviewSummaryRow } from './agent-tools.js';

/** 构造一条评价行：默认 5 分已回复，按需覆盖字段。 */
function review(overrides: Partial<ReviewSummaryRow> = {}): ReviewSummaryRow {
  return {
    id: 'r1',
    channelName: '携程',
    rating: 5,
    content: '很好',
    reviewTime: '2026-11-20',
    replyStatus: 'replied',
    ...overrides,
  };
}

describe('summarizeReviews', () => {
  it('平均分保留两位小数', () => {
    const summary = summarizeReviews([
      review({ rating: 5 }), review({ rating: 4 }), review({ rating: 4 }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.avgRating).toBe(4.33);
  });

  it('平均分可整除时不受取整影响', () => {
    const summary = summarizeReviews([review({ rating: 5 }), review({ rating: 4 })]);
    expect(summary.avgRating).toBe(4.5);
  });

  it('低分统计 rating <= 3', () => {
    const summary = summarizeReviews([
      review({ rating: 1 }), review({ rating: 3 }), review({ rating: 4 }), review({ rating: 5 }),
    ]);
    expect(summary.lowRatingCount).toBe(2);
  });

  it('待回复统计 replyStatus === pending', () => {
    const summary = summarizeReviews([
      review({ replyStatus: 'pending' }),
      review({ replyStatus: 'pending' }),
      review({ replyStatus: 'replied' }),
    ]);
    expect(summary.pendingReplyCount).toBe(2);
  });

  it('空列表不除零：均分为 0 且各计数为 0', () => {
    const summary = summarizeReviews([]);
    expect(summary).toEqual({
      total: 0,
      avgRating: 0,
      lowRatingCount: 0,
      pendingReplyCount: 0,
      items: [],
    });
  });

  it('明细最多返回 20 条', () => {
    const rows = Array.from({ length: 25 }, (_, i) => review({ id: `r${i}` }));
    expect(summarizeReviews(rows).items).toHaveLength(20);
  });
});
