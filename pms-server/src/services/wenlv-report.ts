/**
 * 游客端问题上报的可判定逻辑。**纯函数**，端点只做鉴权 + 落库。
 *
 * 抽出来的理由：去重窗口这类边界（恰好 60s 算不算、类别不同算不算）打在端点上的
 * DB 用例极难精确构造时间，放在这里可以穷尽。
 */
/**
 * 固定枚举。**顺序即展示顺序**（页面按它输出，保证不同次渲染一致）。
 *
 * 类别联合类型**就定义在这里，不放到 schema** —— 原稿写的
 * `import type { WenlvClientReportCategory } from '../db/schema/wenlv.js'` 是**悬空引用**：
 * 没有任何一个 Task 定义过那个导出名，照抄即 TS2305，第一次 ts-check 就炸。
 * 而本域 schema 对枚举列的一贯写法是**注释**而非类型（对照 `db/schema/wenlv.ts` 的
 * `status: varchar('status', { length: 20 }).notNull().default('pending'), // pending/running/succeeded/failed`），
 * 所以 Task 1 的建表块里也不该凭空加一个导出类型。**服务层是这个枚举的唯一权威。**
 */
export const REPORT_CATEGORIES = ['audio', 'image', 'cert', 'other'] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** 未知值一律归 `other` —— **不拒绝**：上报是降门槛动作，宁可存糙也不能因为枚举不匹配把游客的反馈丢掉。 */
export function normalizeCategory(v: unknown): ReportCategory {
  return (REPORT_CATEGORIES as readonly string[]).includes(v as string) ? (v as ReportCategory) : 'other';
}

export const DEDUPE_WINDOW_MS = 60_000;

/** 同类别且时间差 **≤** 窗口长 ⇒ 视为重复（闭区间）。类别不同**永不**视为重复。 */
export function isDuplicateWithin(
  last: { createdAt: Date | string; category: string } | null | undefined,
  category: string,
  now: Date,
  windowMs: number = DEDUPE_WINDOW_MS,
): boolean {
  if (!last) return false;
  if (last.category !== category) return false;
  const t = last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt);
  if (Number.isNaN(t.getTime())) return false;   // 脏数据不当作重复，宁可多记一条
  return now.getTime() - t.getTime() <= windowMs;
}

export interface ReportSummary {
  productId: string;
  total: number;
  byCategory: Record<ReportCategory, number>;
  lastAt: string | null;
}

/** 按剧本归并。**类别键恒全量输出**（计数为 0 也在），页面才能画稳定的列。 */
export function summarizeReports(
  rows: { productId: string; category: string; createdAt?: Date | string | null }[],
): ReportSummary[] {
  const m = new Map<string, ReportSummary>();
  for (const r of rows) {
    let s = m.get(r.productId);
    if (!s) {
      s = { productId: r.productId, total: 0, byCategory: Object.fromEntries(REPORT_CATEGORIES.map((c) => [c, 0])) as Record<ReportCategory, number>, lastAt: null };
      m.set(r.productId, s);
    }
    s.total++;
    s.byCategory[normalizeCategory(r.category)]++;
    const t = r.createdAt ? (r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt)) : null;
    if (t && (!s.lastAt || t > s.lastAt)) s.lastAt = t;
  }
  return [...m.values()];
}
