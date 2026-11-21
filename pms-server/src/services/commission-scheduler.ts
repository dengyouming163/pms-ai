import { eq, and, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  pmsBuiCommissionRecords, pmsBuiOrders, pmsBuiProfitSharings,
  pmsBuiMiniPayments, pmsBuiCoupons, pmsBuiCouponRecords,
} from '../db/schema/index.js';

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分钟

/** 解冻佣金：套餐订单对应的住宿订单离店（check_out）满 7 天后，frozen → released */
async function releaseCommissions(): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  // 套餐订单佣金（cr.order_id 挂 po_ 套餐订单 id），通过住宿订单 platform_order_id = 套餐订单 id 关联，
  // 住宿订单 status IN ('checked_out','completed') 且 check_out <= 今天-7 天 时解冻
  const result = await db.execute(sql`
    UPDATE pms_bui_commission_records cr
    SET status = 'released', released_at = NOW(), updated_at = NOW()
    FROM pms_bui_orders o
    WHERE cr.order_id = o.platform_order_id
      AND cr.status = 'frozen'
      AND o.status IN ('checked_out', 'completed')
      AND o.check_out <= ${sevenDaysAgo}
    RETURNING cr.id
  `);
  return result.rowCount ?? result.rows.length;
}

export function startCommissionScheduler(): void {
  setInterval(async () => {
    try {
      const released = await releaseCommissions();
      if (released > 0) console.log(`[commission-scheduler] 解冻佣金 ${released} 笔`);
    } catch (err) {
      console.error('[commission-scheduler] 解冻失败:', err);
    }
  }, CHECK_INTERVAL_MS);
  console.log('[commission-scheduler] 已启动（每 10 分钟解冻 T+1 佣金）');
}

// P1: 离店后自动发放回归券（每 24 小时扫一次，昨天 checkout 的订单）
async function issueReturnCoupons(): Promise<number> {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // 查昨天离店的 mini 订单（checked_out 状态）
  const orders = await db.select({ id: pmsBuiOrders.id, storeId: pmsBuiOrders.storeId, guestId: pmsBuiOrders.guestId })
    .from(pmsBuiOrders)
    .where(and(
      eq(pmsBuiOrders.source, 'mini'),
      eq(pmsBuiOrders.checkOut, yesterday),
      eq(pmsBuiOrders.status, 'checked_out'),
    ));
  if (orders.length === 0) return 0;

  let issued = 0;
  for (const o of orders) {
    if (!o.storeId || !o.guestId) continue;
    // 找该门店是否有 active 的回归券模板（type=newcomer）
    const [coupon] = await db.select().from(pmsBuiCoupons)
      .where(and(eq(pmsBuiCoupons.storeId, o.storeId), eq(pmsBuiCoupons.status, 'active'), eq(pmsBuiCoupons.type, 'newcomer')))
      .limit(1);
    if (!coupon) continue;

    // 检查是否已发过（同一客人同门店同券只发一次）
    const [existing] = await db.select({ id: pmsBuiCouponRecords.id })
      .from(pmsBuiCouponRecords).where(and(
        eq(pmsBuiCouponRecords.couponId, coupon.id),
        eq(pmsBuiCouponRecords.miniUserId, o.guestId),
      )).limit(1);
    if (existing) continue;

    const expireAt = new Date(Date.now() + coupon.validDays * 86400000).toISOString().slice(0, 10);
    await db.insert(pmsBuiCouponRecords).values({
      id: `cr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      couponId: coupon.id, miniUserId: o.guestId, storeId: o.storeId, expireAt,
    });
    issued++;
  }
  return issued;
}

// 每 24 小时扫一次回归券
setInterval(async () => {
  try {
    const count = await issueReturnCoupons();
    if (count > 0) console.log(`[commission-scheduler] 离店回归券发放 ${count} 张`);
  } catch (err) {
    console.error('[commission-scheduler] 回归券发放失败:', err);
  }
}, 86400_000);
