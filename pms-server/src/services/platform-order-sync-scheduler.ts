/**
 * 平台订单转化补偿调度器（D，Task5）
 *
 * 主链路（回调）之外的安全网：每 60s 拉取平台「预约已确认」与「已核销」订单，
 * 对 pms 侧缺失住宿订单的补转化 / 补联动。全部幂等：
 *  - 转化以 platform_order_id 唯一索引（先查后插 + onConflictDoNothing）
 *  - 联动以 shouldUpdateStayStatus 条件更新
 *
 * 数据访问边界：平台订单在平台库（禁止跨 schema 直查），按项目规范经 pms-platform-server
 * 内部接口（platform-client.listConfirmedProductOrders / listUsedProductOrders）分页拉取。
 */
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiOrders } from '../db/schema/index.js';
import { listConfirmedProductOrders, listUsedProductOrders } from './platform-client.js';
import {
  createStayOrderFromPlatform,
  linkPlatformStayOrder,
  pickConfirmedForConversion,
} from './platform-order-converter.js';

/** 核销联动 usedAt 时间窗：仅联动近期核销（不追溯历史存量），避免首轮扫描把全部历史核销单补成 checked_in */
export const USED_LINK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 核销联动候选：平台订单已核销（status=used）且 usedAt 在时间窗内。
 * 缺 usedAt / usedAt 非法 → 不联动（无法证明是新单，规避追溯历史）。
 * now 为测试注入点（默认 Date.now()），windowMs 覆盖窗口。
 */
export function pickUsedForCheckin(orders: any[], now: number = Date.now(), windowMs: number = USED_LINK_WINDOW_MS): any[] {
  return (orders || []).filter((o) => {
    if (!o || o.status !== 'used' || !o.usedAt) return false;
    const usedAt = new Date(o.usedAt).getTime();
    if (!Number.isFinite(usedAt)) return false;
    return now - usedAt <= windowMs;
  });
}

/** 扫描一次：补转化已确认订单 + 核销联动已核销订单。返回计数 */
export async function runPlatformOrderSyncScan(): Promise<{ converted: number; linked: number }> {
  // 1) 补转化：预约已确认且可转化（排除已取消/退款/核销终态）
  let converted = 0;
  const confirmed = await listConfirmedProductOrders();
  const candidates = pickConfirmedForConversion(confirmed);
  if (candidates.length > 0) {
    const existing = await db.select({ platformOrderId: pmsBuiOrders.platformOrderId })
      .from(pmsBuiOrders)
      .where(inArray(pmsBuiOrders.platformOrderId, candidates.map((o) => o.id)));
    const existingSet = new Set(existing.map((r) => r.platformOrderId));
    for (const o of candidates) {
      if (existingSet.has(o.id)) continue;
      try {
        const r = await createStayOrderFromPlatform(o);
        if (r?.created) converted++;
      } catch (err) {
        console.error(`[platform-order-sync] 转化失败 orderId=${o.id}:`, err);
      }
    }
  }

  // 2) 核销联动：平台已核销订单 → 住宿订单 checked_in
  let linked = 0;
  const used = await listUsedProductOrders();
  for (const o of pickUsedForCheckin(used)) {
    try {
      const r = await linkPlatformStayOrder(o, 'checked_in');
      if (r?.handled) linked++;
    } catch (err) {
      console.error(`[platform-order-sync] 核销联动失败 orderId=${o.id}:`, err);
    }
  }

  if (converted > 0 || linked > 0) {
    console.log(`[platform-order-sync] 补转化 ${converted} 笔，核销联动 ${linked} 笔`);
  }
  return { converted, linked };
}

/** 启动补偿调度器（server.ts 调用一次）；启动即扫一次，之后每 intervalMs 扫描 */
export function startPlatformOrderSyncScheduler(intervalMs = 60_000): void {
  setInterval(async () => {
    try {
      await runPlatformOrderSyncScan();
    } catch (err) {
      console.error('[platform-order-sync] 扫描失败:', err);
    }
  }, intervalMs);
  runPlatformOrderSyncScan().catch((err) => console.error('[platform-order-sync] 首次扫描失败:', err));
  console.log(`[platform-order-sync] 已启动（每 ${intervalMs / 1000}s 补偿平台订单转化）`);
}
