/** 满意度维度（回访 complaints 的已知标签） */
const COMPLAINT_LABELS: Record<string, string> = {
  '床品': '床品', '卫生': '卫生', '隔音': '隔音', '服务': '服务', '其他': '其他',
};

export interface StoreReviews {
  avgScore: number;
  reviewCount: number;
  distribution: Record<string, number>; // { '5': n, '4': n, ... '1': n }
  tags: { key: string; label: string; goodRate: number }[];
  list: { score: number; comment: string; complaints: string[]; createdAt: string }[];
}

/** 回访记录行：兼容 db.select 投影（score 可能为 NULL=未回填）与单测直接构造 */
export interface ReviewRow {
  score: number | null;
  complaints?: string[] | null;
  comment?: string | null;
  createdAt: Date;
}

/** 从回访记录计算门店口碑聚合（纯函数，可单测） */
export function aggregateReviews(rows: ReviewRow[]): StoreReviews {
  // 仅统计已回填分数（score != NULL）的答卷；NULL 代表问卷已投递但客人未回填
  const scored = rows.filter((r) => r.score != null) as Array<{
    score: number;
    complaints?: string[] | null;
    comment?: string | null;
    createdAt: Date;
  }>;
  const reviewCount = scored.length;
  if (reviewCount === 0) {
    return { avgScore: 0, reviewCount: 0, distribution: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 }, tags: [], list: [] };
  }
  const total = scored.reduce((s, r) => s + r.score, 0);
  const avgScore = Math.round((total / reviewCount) * 10) / 10;
  const distribution: Record<string, number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
  const complaintCount: Record<string, number> = {};
  for (const r of scored) {
    distribution[String(r.score)] = (distribution[String(r.score)] || 0) + 1;
    for (const cp of r.complaints || []) {
      if (COMPLAINT_LABELS[cp]) complaintCount[cp] = (complaintCount[cp] || 0) + 1;
    }
  }
  // 满意度标签：问题维度出现次数 → 好评率 = 1 - 出现率；好评率低（问题多）在前，便于优先关注
  const tags = Object.keys(COMPLAINT_LABELS)
    .filter((k) => complaintCount[k])
    .map((k) => ({ key: k, label: COMPLAINT_LABELS[k], goodRate: Math.round((1 - (complaintCount[k] / reviewCount)) * 100) }))
    .sort((a, b) => a.goodRate - b.goodRate);
  // 评价样本：按 createdAt 倒序，取前 10
  const list = [...scored]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 10)
    .map((r) => ({ score: r.score, comment: r.comment || '', complaints: r.complaints || [], createdAt: r.createdAt.toISOString() }));
  return { avgScore, reviewCount, distribution, tags, list };
}
