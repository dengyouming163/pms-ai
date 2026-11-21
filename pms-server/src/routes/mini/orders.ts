import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiOrders, pmsBuiRoomTypes, pmsBuiStores, pmsBuiMiniStoreConfig, pmsBuiPricingCalendar, pmsBuiCustomers,
  pmsBuiCoupons, pmsBuiCouponRecords,
  pmsBuiReferralBindings, pmsBuiPromoters, pmsBuiCommissionRecords,
} from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { enumerateNights, calcNightlyPrices, buildOverrideMap } from '../../utils/mini-price.js';
import { getDiscountRate, applyMemberDiscount } from '../../utils/member-price.js';
import { calcCouponDiscount } from '../../utils/coupon-calc.js';
import { calcCommission } from '../../utils/commission.js';
import { withRoomTypeLock, checkAvailability } from '../../services/inventory-lock.js';

const route = new Hono();

/** 预订单支付时限（毫秒） */
export const PAY_TIMEOUT_MS = 15 * 60 * 1000;

const createSchema = z.object({
  storeId: z.string().min(1),
  roomTypeId: z.string().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guestName: z.string().min(1).max(50),
  guestPhone: z.string().regex(/^1\d{10}$/),
  remark: z.string().max(500).optional(),
  couponRecordId: z.string().optional(),
});

// 创建预订单：锁房型 → 校验可订 → 服务端算价 → 建单（status=pending 占库存，15分钟内未支付释放）
route.post('/', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const { storeId, roomTypeId, checkIn, checkOut, guestName, guestPhone, remark } = parsed.data;
  let couponRecordId = parsed.data.couponRecordId;

  const nights = enumerateNights(checkIn, checkOut);
  if (nights.length === 0) return c.json({ success: false, error: '退房日期必须晚于入住日期' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (checkIn < today) return c.json({ success: false, error: '入住日期不能早于今天' }, 400);

  // 门店必须已上线
  const [config] = await db.select().from(pmsBuiMiniStoreConfig)
    .where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1);
  if (!config?.online) return c.json({ success: false, error: '该门店尚未开通线上预订' }, 400);

  const [roomType] = await db.select().from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.id, roomTypeId), eq(pmsBuiRoomTypes.storeId, storeId))).limit(1);
  if (!roomType) return c.json({ success: false, error: '房型不存在' }, 404);
  const [store] = await db.select().from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId)).limit(1);
  if (!store) return c.json({ success: false, error: '门店不存在' }, 404);

  // 服务端算价（不信任前端金额）
  const calendarRows = await db.select({ date: pmsBuiPricingCalendar.date, roomTypes: pmsBuiPricingCalendar.roomTypes })
    .from(pmsBuiPricingCalendar)
    .where(and(
      eq(pmsBuiPricingCalendar.storeId, storeId),
      sql`${pmsBuiPricingCalendar.date} >= ${nights[0]}`,
      sql`${pmsBuiPricingCalendar.date} <= ${nights[nights.length - 1]}`,
    ));
  let nightly = calcNightlyPrices(nights, buildOverrideMap(calendarRows, roomType), roomType);
  let totalPrice = nightly.reduce((s, n) => s + n.price, 0); // 元

  // 会员价：查当前用户在该门店的等级与折扣率
  {
    const [customer] = await db.select({ memberLevel: pmsBuiCustomers.memberLevel })
      .from(pmsBuiCustomers)
      .where(and(eq(pmsBuiCustomers.storeId, storeId), eq(pmsBuiCustomers.miniUserId, miniUser.miniUserId)))
      .limit(1);
    if (customer && customer.memberLevel !== 'regular') {
      const discountRate = getDiscountRate(customer.memberLevel, config?.memberDiscounts as any);
      if (discountRate < 100) {
        nightly = applyMemberDiscount(nightly, discountRate);
        totalPrice = nightly.reduce((s, n) => s + n.price, 0);
      }
    }
  }

  // 券试算（在会员折扣价基础上）
  let couponDiscount = 0;
  if (couponRecordId) {
    const [record] = await db.select().from(pmsBuiCouponRecords)
      .where(and(eq(pmsBuiCouponRecords.id, couponRecordId),
                 eq(pmsBuiCouponRecords.miniUserId, miniUser.miniUserId),
                 eq(pmsBuiCouponRecords.status, 'pending')))
      .limit(1);
    if (!record || record.expireAt < checkIn) {
      couponRecordId = undefined; // 券不可用，忽略
    } else {
      const [coupon] = await db.select().from(pmsBuiCoupons)
        .where(eq(pmsBuiCoupons.id, record.couponId)).limit(1);
      if (coupon) {
        const result = calcCouponDiscount(
          { originalTotal: totalPrice, memberTotal: totalPrice, nights: nights.length },
          { type: coupon.type, value: coupon.value, minAmount: coupon.minAmount },
        );
        if (result.discount > 0) {
          couponDiscount = result.discount;
          totalPrice = result.finalTotal;
        }
      }
    }
  }

  // 锁房型 → 事务内校验可订 → 建单
  const result = await withRoomTypeLock(roomTypeId, async (tx) => {
    const avail = await checkAvailability(tx, storeId, roomTypeId, checkIn, checkOut);
    if (!avail.available) return null;

    const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const orderNo = `MINI${Date.now().toString().slice(-10)}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // 券核销
    if (couponRecordId && couponDiscount > 0) {
      await tx.update(pmsBuiCouponRecords)
        .set({ status: 'used', usedOrderId: orderId, usedAt: new Date() })
        .where(and(eq(pmsBuiCouponRecords.id, couponRecordId), eq(pmsBuiCouponRecords.status, 'pending')));
    }

    const [order] = await tx.insert(pmsBuiOrders).values({
      id: orderId,
      merchantId: store.merchantId,
      orderNo,
      channel: '私域小程序',
      guestName,
      guestPhone,
      guestId: miniUser.miniUserId,
      checkIn,
      checkOut,
      roomType: roomType.name,
      roomTypeId,
      nights: nights.length,
      totalPrice,
      source: 'mini',
      paymentStatus: 'unpaid',
      status: 'pending', // 待支付，占用库存
      remark: (remark || '') + (couponDiscount > 0 ? ` [用券减¥${couponDiscount}]` : ''),
      // 复用 otaTimeout 字段作为支付截止时间（超时由 mini-scheduler 释放）
      otaTimeout: new Date(Date.now() + PAY_TIMEOUT_MS),
      storeId,
    }).returning();

    // 分销佣金冻结：查推广绑定 → 算佣金 → 冻结
    if (order.storeId) {
      const [cfg] = await tx.select({ commissionRate: pmsBuiMiniStoreConfig.commissionRate })
        .from(pmsBuiMiniStoreConfig).where(eq(pmsBuiMiniStoreConfig.storeId, order.storeId)).limit(1);
      const storeRate = cfg?.commissionRate || 0;
      if (storeRate > 0) {
        const [binding] = await tx.select().from(pmsBuiReferralBindings)
          .where(and(
            eq(pmsBuiReferralBindings.miniUserId, miniUser.miniUserId),
            eq(pmsBuiReferralBindings.storeId, order.storeId),
            sql`${pmsBuiReferralBindings.protectedUntil} >= ${checkIn}`,
          )).limit(1);
        if (binding) {
          const [promoter] = await tx.select().from(pmsBuiPromoters)
            .where(and(eq(pmsBuiPromoters.id, binding.promoterId), eq(pmsBuiPromoters.status, 'active')))
            .limit(1);
          if (promoter) {
            const rate = promoter.commissionRate ?? storeRate;
            const amountFen = order.totalPrice * 100;
            const commissionFen = calcCommission(amountFen, rate);
            if (commissionFen > 0) {
              await tx.insert(pmsBuiCommissionRecords).values({
                id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                promoterId: promoter.id,
                orderId: order.id,
                orderNo: order.orderNo,
                amount: commissionFen,
                rate,
              });
            }
          }
        }
      }
    }

    return order;
  });

  if (!result) return c.json({ success: false, error: '该日期房量不足，房间已被订完或刚被抢订' }, 409);
  return c.json({
    success: true,
    data: {
      orderId: result.id,
      orderNo: result.orderNo,
      totalPrice,
      nightly,
      payDeadline: result.otaTimeout,
    },
  });
});

// 我的订单列表
route.get('/', async (c) => {
  const miniUser = getMiniUser(c);
  const orders = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.guestId, miniUser.miniUserId), eq(pmsBuiOrders.source, 'mini')))
    .orderBy(desc(pmsBuiOrders.createdAt)).limit(50);
  return c.json({ success: true, data: orders.map(formatOrder) });
});

// 订单详情（校验归属，防越权）
route.get('/:id', async (c) => {
  const miniUser = getMiniUser(c);
  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, c.req.param('id')), eq(pmsBuiOrders.guestId, miniUser.miniUserId))).limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  return c.json({ success: true, data: formatOrder(order) });
});

// 取消未支付订单（已支付订单的取消退款在 /api/mini/pay/cancel-paid，Task 11）
// 注意：取消在锁外执行，极端并发下 checkAvailability 可能误拒（不超卖，M2 移入锁临界区）
route.post('/:id/cancel', async (c) => {
  const miniUser = getMiniUser(c);
  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, c.req.param('id')), eq(pmsBuiOrders.guestId, miniUser.miniUserId))).limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
    return c.json({ success: false, error: '当前状态不可直接取消' }, 400);
  }
  await db.update(pmsBuiOrders).set({
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelReason: '用户主动取消',
    updatedAt: new Date(),
  }).where(eq(pmsBuiOrders.id, order.id));
  return c.json({ success: true, message: '订单已取消' });
});

function formatOrder(o: typeof pmsBuiOrders.$inferSelect) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    storeId: o.storeId,
    roomType: o.roomType,
    checkIn: o.checkIn,
    checkOut: o.checkOut,
    nights: o.nights,
    totalPrice: o.totalPrice,
    status: o.status,
    paymentStatus: o.paymentStatus,
    guestName: o.guestName,
    payDeadline: o.otaTimeout,
    createdAt: o.createdAt,
  };
}

export default route;
