/**
 * 私域小程序后台定时任务：预订单支付超时自动释放。
 *
 * 边界说明（超时瞬间与支付回调的竞争）：
 * - 用户在超时瞬间正好支付成功：支付回调把订单置 confirmed 后，
 *   本任务的 where 条件（status='pending'）自然不再匹配，无竞争问题。
 * - 反向（先释放后回调）：回调事务里 UPDATE 带 pending 条件、
 *   0 行受影响即跳过（T10 修复已处理），钱会停在已支付的支付单上，
 *   等 T11 的对账/退款兜底。
 *
 * 库存关系：cancelled 不在 OCCUPYING_STATUSES 中，状态一改库存即隐式释放。
 */
import { eq, and, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiOrders } from '../db/schema/index.js';

const CHECK_INTERVAL_MS = 60_000;

/** 释放支付超时的小程序预订单（status=pending 且过了支付截止时间） */
export async function releaseExpiredMiniOrders(): Promise<number> {
  const result = await db.update(pmsBuiOrders).set({
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelReason: '支付超时自动取消',
    updatedAt: new Date(),
  }).where(and(
    eq(pmsBuiOrders.source, 'mini'),
    eq(pmsBuiOrders.status, 'pending'),
    eq(pmsBuiOrders.paymentStatus, 'unpaid'),
    lt(pmsBuiOrders.otaTimeout, new Date()),
  )).returning({ id: pmsBuiOrders.id });
  return result.length;
}

/** 启动小程序后台定时任务（server.ts 调用一次） */
export function startMiniScheduler(): void {
  setInterval(async () => {
    try {
      const released = await releaseExpiredMiniOrders();
      if (released > 0) console.log(`[mini-scheduler] 释放超时预订单 ${released} 笔`);
    } catch (err) {
      console.error('[mini-scheduler] 超时释放失败:', err);
    }
  }, CHECK_INTERVAL_MS);
  console.log('[mini-scheduler] 已启动（每 60s 检查支付超时预订单）');
}
