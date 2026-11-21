// 漏斗聚合（P2 spec §6）：商户维度事件透视 + 剧本开局/完本/分享。不引图表库，前端零推断只做展示。
//
// 纪律（同 project-board.ts）：
//   · rate / pivotMerchantRows 是**纯函数**（无 IO），可单测；
//   · buildFunnel 承担全部 IO（事件行拉取 + 进度计数），窗口按**行为发生时间**落窗
//     （事件 createdAt / 进度 startedAt·completedAt），而非记录创建时间。
import { and, eq, gte, count } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiWenlvEvents, pmsBuiWenlvProgress } from '../../db/schema/index.js';

/** 转化率：分母 0 ⇒ null（前端显「—」）。保留 1 位小数（43.2），百分比号由前端拼。 */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

export type MerchantFunnelRow = {
  merchantPartnerId: string; arrived: number; cipherRedeemed: number;
  purchased: number; tokenRedeemed: number; paidCustomization: number;
};
export type ScriptFunnel = { started: number; completed: number; shared: number };

// 商户透视只认这五种事件；其余（checkin/answer/shared…）对商户漏斗无意义，忽略。
// payload.merchantPartnerId 缺失/空串/非字符串的行归 '(未关联)'，不丢数据也不炸。
const UNLINKED = '(未关联)';
const EVENT_FIELD: Record<string, keyof Omit<MerchantFunnelRow, 'merchantPartnerId'>> = {
  arrived: 'arrived',
  cipher_redeemed: 'cipherRedeemed',
  purchased: 'purchased',
  token_redeemed: 'tokenRedeemed',
  paid_customization: 'paidCustomization',
};

/** 商户事件透视纯函数：输入已过滤的 (eventType, payload) 行，输出按 merchantPartnerId 聚合的行。 */
export function pivotMerchantRows(rows: Array<{ eventType: string; payload: unknown }>): MerchantFunnelRow[] {
  const byMerchant = new Map<string, MerchantFunnelRow>();
  for (const row of rows) {
    const field = EVENT_FIELD[row.eventType];
    if (!field) continue;
    // payload 可能是 null/数组（历史脏数据），只在「普通对象且字段为非空字符串」时取值
    const mp = row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>).merchantPartnerId
      : undefined;
    const key = typeof mp === 'string' && mp.trim() ? mp.trim() : UNLINKED;
    let agg = byMerchant.get(key);
    if (!agg) {
      agg = { merchantPartnerId: key, arrived: 0, cipherRedeemed: 0, purchased: 0, tokenRedeemed: 0, paidCustomization: 0 };
      byMerchant.set(key, agg);
    }
    agg[field] += 1;
  }
  return [...byMerchant.values()];
}

/**
 * 漏斗聚合：merchants = 商户维度五事件透视；script = 剧本开局/完本/分享。
 * days clamp 到 [1, 365]（NaN/undefined ⇒ 30）。窗口口径：按行为发生时间。
 * shared 计 **distinct miniUserId**（同一用户多次分享只算 1），与事件行数口径区分。
 */
export async function buildFunnel(productId: string, days: number): Promise<{ merchants: MerchantFunnelRow[]; script: ScriptFunnel }> {
  const d = Number.isFinite(days) ? days : 30;
  const windowDays = Math.min(365, Math.max(1, d));
  const since = new Date(Date.now() - windowDays * 86400_000);

  // 事件行一次拉取：eventType/payload 供商户透视，miniUserId 供 shared 去重计数
  const [eventRows, startedAgg, completedAgg] = await Promise.all([
    db.select({
      eventType: pmsBuiWenlvEvents.eventType,
      payload: pmsBuiWenlvEvents.payload,
      miniUserId: pmsBuiWenlvEvents.miniUserId,
    }).from(pmsBuiWenlvEvents)
      .where(and(eq(pmsBuiWenlvEvents.productId, productId), gte(pmsBuiWenlvEvents.createdAt, since))),
    db.select({ n: count() }).from(pmsBuiWenlvProgress)
      .where(and(eq(pmsBuiWenlvProgress.productId, productId), gte(pmsBuiWenlvProgress.startedAt, since))),
    db.select({ n: count() }).from(pmsBuiWenlvProgress)
      .where(and(
        eq(pmsBuiWenlvProgress.productId, productId),
        eq(pmsBuiWenlvProgress.status, 'completed'),
        gte(pmsBuiWenlvProgress.completedAt, since),
      )),
  ]);

  return {
    merchants: pivotMerchantRows(eventRows),
    script: {
      started: startedAgg[0]?.n ?? 0,
      completed: completedAgg[0]?.n ?? 0,
      shared: new Set(eventRows.filter((r) => r.eventType === 'shared').map((r) => r.miniUserId)).size,
    },
  };
}
