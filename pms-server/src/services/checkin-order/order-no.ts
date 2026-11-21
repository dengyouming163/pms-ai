// 订单号：CK + 录入日 yyyyMMdd + 4 位当日序号（规格 §6）。
// 序号按**全局当日**派生（不分商户），`order_no` 唯一索引兜底；冲突由调用方捕获后重试。
// 注意：order_no 编码的是**录入日**（凭证号），补录单的 createdAt / 入住退房日期可为历史值 —— 语义不同，勿混用。
import { db } from '../../db/index.js';
import { pmsBuiCheckinOrders } from '../../db/schema/index.js';
import { like } from 'drizzle-orm';

// 取**进程本地时区**的墙钟日作为「录入日」；生产由 docker-compose 给 pms-server 注入 TZ=Asia/Shanghai（见 docker-compose.yml）。
// 若脱离 compose 直接以 UTC 运行，则北京时间 00:00–08:00 会落到前一日（仅影响跨日边界的可移植性，非当前故障）。
export function orderNoPrefix(recordedAt: Date): string {
  const y = recordedAt.getFullYear();
  const m = String(recordedAt.getMonth() + 1).padStart(2, '0');
  const d = String(recordedAt.getDate()).padStart(2, '0');
  return `CK${y}${m}${d}`;
}

/**
 * 由当日既有单号推导下一个序号（纯函数）：非法尾串一律忽略，不抛异常。
 * 尾串 4 位是**最小宽度**（`formatOrderNo` 用 `padStart(4,'0')` 补零），`seq >= 10000` 时自然扩展为 5 位；
 * 因此正则取 `^\d{4,}$` 以保证「自己产出的号一定读得回」，从而让唯一索引冲突后的重试能够推进。
 */
export function nextSequence(prefix: string, existing: (string | null | undefined)[]): number {
  let max = 0;
  for (const no of existing) {
    if (typeof no !== 'string' || !no.startsWith(prefix)) continue;
    const tail = no.slice(prefix.length);
    if (!/^\d{4,}$/.test(tail)) continue;
    max = Math.max(max, Number(tail));
  }
  return max + 1;
}

export function formatOrderNo(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/** 读取当日已用单号（全局，不分商户） */
export async function readDayOrderNos(prefix: string): Promise<string[]> {
  const rows = await db
    .select({ orderNo: pmsBuiCheckinOrders.orderNo })
    .from(pmsBuiCheckinOrders)
    .where(like(pmsBuiCheckinOrders.orderNo, `${prefix}%`));
  return rows.map((r) => r.orderNo).filter((v): v is string => Boolean(v));
}

/** 生成当日下一个订单号 */
export async function generateOrderNo(recordedAt: Date): Promise<string> {
  const prefix = orderNoPrefix(recordedAt);
  const existing = await readDayOrderNos(prefix);
  return formatOrderNo(prefix, nextSequence(prefix, existing));
}
