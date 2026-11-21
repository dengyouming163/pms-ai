// 平台套餐订单 → pms 住宿订单转化服务
// 项目规范：跨模块仅走 HTTP；平台订单对象一律来自 platform-client（不信任回调 body）。
// 纯逻辑层（addDays/resolvePlatformRoomType/buildPlatformStayOrder）与
// DB 写入层（createStayOrderFromPlatform/linkPlatformStayOrder）同置于本文件。

import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiOrders, pmsBuiRoomTypes, pmsBuiStores } from '../db/schema/index.js';
import { getPlatformProduct } from './platform-client.js';
import { withRoomTypeLock, checkAvailability } from './inventory-lock.js';

/** 平台订单最小字段（来自 platform-client.getPlatformProductOrder 的 data.data） */
export interface PlatformOrderLike {
  id: string;
  orderNo: string;
  storeId: string;
  productId: string;
  miniUserId: string | null;
  guestName: string;
  guestPhone: string;
  productName: string | null;
  roomNights: number | null;
  quantity: number | null;
  totalAmount: string | number;
  reservationDate: string | null;
  verifyCode: string | null;
  status: string;
  reservationStatus: string;
}

/** 门店房型最小字段 */
export interface RoomTypeLike {
  id: string;
  name: string;
  basePrice: number;
  status: string | null;
}

/** 组装后的住宿订单写库字段 */
export interface StayOrderValues {
  id: string;
  orderNo: string;
  merchantId: string;
  storeId: string;
  channel: '私域平台';
  icon: '🎫';
  channelOrderId: string;
  platformOrderId: string;
  platformOrderNo: string;
  guestName: string;
  guestPhone: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  roomTypeId: string | null;
  nights: number;
  totalPrice: number;
  originalAmount: number;
  discount: string;
  source: 'platform';
  paymentStatus: 'paid';
  status: string;
  paymentMethod: string;
  verifyCode: string | null;
  remark: string;
}

/**
 * 以 YYYY-MM-DD 为基准加天数，返回 YYYY-MM-DD。
 * 按年月日整数做日历运算（Date.UTC 自动处理跨月/跨年进位），
 * 不依赖运行机器时区，避免 +08:00 解析导致 getUTCDate 偏移一天的日期边界问题。
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * 房型解析（优先级）：
 * 1) 商品关联房型 extraAttrs.roomTypeIds（取门店下第一个有效）
 * 2) 无关联 → 按 productName 与门店房型 name 精确匹配
 * 3) 均无 → null（调用方 roomTypeId=null，roomType 用 productName）
 */
export function resolvePlatformRoomType(
  productRoomTypeIds: string[],
  storeRoomTypes: RoomTypeLike[],
  productName: string | null,
): { roomTypeId: string; roomTypeName: string; basePrice: number } | null {
  const active = storeRoomTypes.filter((rt) => rt.status === 'active' || !rt.status);
  for (const id of productRoomTypeIds) {
    const rt = active.find((r) => r.id === id);
    if (rt) return { roomTypeId: rt.id, roomTypeName: rt.name, basePrice: rt.basePrice };
  }
  if (productName) {
    const rt = active.find((r) => r.name === productName);
    if (rt) return { roomTypeId: rt.id, roomTypeName: rt.name, basePrice: rt.basePrice };
  }
  return null;
}

/** 组装住宿订单字段（纯函数，merchantId 由调用方查门店后填充） */
export function buildPlatformStayOrder(
  order: PlatformOrderLike,
  resolved: { roomTypeId: string; roomTypeName: string; basePrice: number } | null,
  opts: { initialStatus?: string } = {},
): StayOrderValues {
  const checkIn = order.reservationDate || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const nights = Math.max(1, Number(order.roomNights) || 1);
  const roomTypeName = resolved?.roomTypeName || order.productName || '平台套餐';
  const totalPrice = Math.round(Number(order.totalAmount) || 0);
  const originalAmount = resolved && resolved.basePrice > 0 ? Math.round(resolved.basePrice * nights) : 0;
  const discount = originalAmount > totalPrice ? `平台套餐 ${originalAmount - totalPrice} 元优惠` : '';
  return {
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    orderNo: `PLAT${Date.now().toString().slice(-8)}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    merchantId: 'default', // 由 createStayOrderFromPlatform 查门店后覆盖
    storeId: order.storeId,
    channel: '私域平台',
    icon: '🎫',
    channelOrderId: order.orderNo,
    platformOrderId: order.id,
    platformOrderNo: order.orderNo,
    guestName: order.guestName || '未知',
    guestPhone: order.guestPhone || '',
    checkIn,
    checkOut: addDays(checkIn, nights),
    roomType: roomTypeName,
    roomTypeId: resolved?.roomTypeId ?? null,
    nights,
    totalPrice,
    originalAmount,
    discount,
    source: 'platform',
    paymentStatus: 'paid',
    status: opts.initialStatus || 'confirmed',
    paymentMethod: '在线支付',
    verifyCode: order.verifyCode ?? null,
    remark: `${order.productName || '平台套餐'}${order.verifyCode ? ` · 核销码 ${order.verifyCode}` : ''}`,
  };
}

/** 状态联动是否应更新（终态不回退；相同状态不重复写） */
export function shouldUpdateStayStatus(existingStatus: string, targetStatus: string): boolean {
  if (existingStatus === targetStatus) return false;
  if (existingStatus === 'cancelled' || existingStatus === 'checked_out') return false;
  return true;
}

/** 轮询补偿候选：预约已确认 + 状态可转化（used/refunded/cancelled 为终态，不转化） */
export function pickConfirmedForConversion(orders: any[]): any[] {
  return (orders || []).filter(
    (o) => o && o.reservationStatus === 'confirmed' && ['paid', 'platform_approved', 'store_accepted'].includes(o.status),
  );
}

/**
 * 生成住宿订单（幂等，1:1）。
 * 主触发：reservation-confirmed 回调 / 轮询补偿调度器。
 * 幂等：platform_order_id 部分唯一索引 + 先查后插 + onConflictDoNothing。
 * 防超售：roomTypeId 已解析时走 withRoomTypeLock + checkAvailability；预约已确认订单即使超售仍生成（员工可见，仅告警）。
 */
export async function createStayOrderFromPlatform(
  order: PlatformOrderLike,
  opts: { initialStatus?: string } = {},
): Promise<{ id: string; created: boolean }> {
  // 幂等快查
  const exist = await db.select({ id: pmsBuiOrders.id }).from(pmsBuiOrders)
    .where(eq(pmsBuiOrders.platformOrderId, order.id)).limit(1);
  if (exist.length > 0) return { id: exist[0].id, created: false };

  // 商品关联房型（best-effort：平台商品接口失败则跳过关联，走名称匹配/兜底）
  let productRoomTypeIds: string[] = [];
  try {
    const prod = await getPlatformProduct(order.productId);
    productRoomTypeIds = Array.isArray(prod?.extraAttrs?.roomTypeIds) ? prod.extraAttrs.roomTypeIds : [];
  } catch { /* 非关键 */ }

  const storeRoomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(eq(pmsBuiRoomTypes.storeId, order.storeId));
  const resolved = resolvePlatformRoomType(productRoomTypeIds, storeRoomTypes, order.productName);
  const values = buildPlatformStayOrder(order, resolved, opts);

  // 门店归属 merchantId（不信任请求体）
  const [store] = await db.select({ merchantId: pmsBuiStores.merchantId }).from(pmsBuiStores)
    .where(eq(pmsBuiStores.id, order.storeId)).limit(1);
  values.merchantId = store?.merchantId ?? 'default';

  const doInsert = async (tx: any) => {
    // 部分唯一索引（platform_order_id IS NOT NULL）：冲突目标不带索引谓词会导致
    // Postgres 解析报错「no unique or exclusion constraint matching the ON CONFLICT specification」，
    // 故省略 target（已先查后插，onConflictDoNothing 仅作并发竞态兜底，忽略任意唯一冲突即可）
    const [inserted] = await tx.insert(pmsBuiOrders).values(values as any)
      .onConflictDoNothing()
      .returning({ id: pmsBuiOrders.id });
    if (inserted) return { id: inserted.id, created: true };
    const dup = await tx.select({ id: pmsBuiOrders.id }).from(pmsBuiOrders)
      .where(eq(pmsBuiOrders.platformOrderId, order.id)).limit(1);
    return { id: dup?.[0]?.id ?? '', created: false };
  };

  if (values.roomTypeId) {
    return withRoomTypeLock(values.roomTypeId, async (tx) => {
      const avail = await checkAvailability(tx, values.storeId, values.roomTypeId!, values.checkIn, values.checkOut);
      if (!avail.available) {
        console.warn(`[platform-converter] 平台订单 ${order.id} 转化超售 roomTypeId=${values.roomTypeId}（预约已确认仍生成住宿订单，请人工关注）`);
      }
      return doInsert(tx);
    });
  }
  return doInsert(db);
}

/**
 * 状态联动（核销即入住 / 取消/退款安全网）。
 * checked_in：无住宿订单则补转化生成（核销即生成+入住）；有则条件更新。
 * cancelled：仅更新已存在的住宿订单（孤儿订单静默跳过）。
 */
export async function linkPlatformStayOrder(
  order: PlatformOrderLike,
  targetStatus: 'checked_in' | 'cancelled',
  reason?: string,
): Promise<{ handled: boolean; id?: string }> {
  const exist = await db.select().from(pmsBuiOrders)
    .where(eq(pmsBuiOrders.platformOrderId, order.id)).limit(1);
  if (exist.length === 0) {
    if (targetStatus === 'checked_in') {
      const r = await createStayOrderFromPlatform(order, { initialStatus: 'checked_in' });
      // 并发竞态兜底：转化落败方（created=false）可能停在 confirmed/pending_confirm，
      // 补一次条件更新；WHERE 带状态守卫原子化，避免覆盖竞态窗口内已流转的终态（TOCTOU）
      if (!r.created && r.id) {
        await db.update(pmsBuiOrders).set({ status: 'checked_in', updatedAt: new Date() })
          .where(and(eq(pmsBuiOrders.id, r.id), inArray(pmsBuiOrders.status, ['confirmed', 'pending_confirm'])));
      }
      return { handled: true, id: r.id };
    }
    return { handled: false };
  }
  const stay = exist[0];
  if (!shouldUpdateStayStatus(stay.status, targetStatus)) return { handled: false, id: stay.id };
  await db.update(pmsBuiOrders).set({
    status: targetStatus,
    cancelledAt: targetStatus === 'cancelled' ? new Date() : stay.cancelledAt,
    cancelReason: targetStatus === 'cancelled' ? (reason || '平台订单取消') : stay.cancelReason,
    updatedAt: new Date(),
  }).where(eq(pmsBuiOrders.id, stay.id));
  return { handled: true, id: stay.id };
}

/** 按平台订单 ID 反查已转化住宿订单（唯一索引最多命中一条；无则 null） */
export async function findStayOrderByPlatformOrder(platformOrderId: string): Promise<any | null> {
  if (!platformOrderId) return null;
  const [order] = await db.select().from(pmsBuiOrders)
    .where(eq(pmsBuiOrders.platformOrderId, platformOrderId))
    .limit(1);
  return order || null;
}
