// OTA 订单路由 — 批量上报（RPA 客户端）+ 查询/统计（Web 端）
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { pmsOtaOrders, pmsOtaCaptureLogs } from '../../db/schema/ota.js';
import { pmsBuiRoomTypes } from '../../db/schema/rooms.js';
import { pmsBuiOrders } from '../../db/schema/orders.js';
import { otaOrdersBatchSchema } from '../../schemas/ota.schema.js';
import { getTenantScope } from '../../utils/tenant.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// 声明 context variables：ota-auth 中间件注入 storeId/merchantId（Hono 需显式泛型才能 c.get 类型安全）
const ordersRoute = new Hono<{ Variables: { storeId: string; merchantId: string } }>();

// OTA 状态 → 住宿订单状态（新单/已确认 → 待接单 pending_confirm 占房；完成 → 已退房 checked_out）
const OTA_STATUS_MAP: Record<string, string> = {
  'new': 'pending_confirm',
  'confirmed': 'pending_confirm',
  'checked_in': 'checked_in',
  'completed': 'checked_out',
  'cancelled': 'cancelled',
};

export function mapOtaStatus(otaStatus: string): string {
  return OTA_STATUS_MAP[otaStatus] || 'pending_confirm';
}

/**
 * 重复抓取时是否应把现有住宿订单更新为目标状态。
 * 关键：员工已接单（confirmed）不因 OTA 再报 confirmed 被降级回 pending_confirm；终态不回退。
 */
export function shouldApplyOtaUpdate(existingStatus: string, targetStatus: string): boolean {
  if (existingStatus === targetStatus) return false;
  if (existingStatus === 'cancelled' || existingStatus === 'checked_out') return false;
  if (targetStatus === 'pending_confirm') return existingStatus === 'pending_confirm';
  if (targetStatus === 'confirmed') return existingStatus === 'pending_confirm';
  return true; // checked_in / checked_out / cancelled 均为前进方向
}

// 从租户上下文解析门店 ID（通配符 '*' 回退到 'default'）
function resolveStoreId(scope: { storeId: string }): string {
  return scope.storeId !== '*' ? scope.storeId : 'default';
}

// 批量上报订单（客户端调用）
ordersRoute.post('/batch', async (c) => {
  const body = await c.req.json();
  const parsed = otaOrdersBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: '参数校验失败', details: parsed.error.issues }, 400);
  }

  const { orders } = parsed.data;
  // OTA 客户端鉴权优先使用 middleware 注入的 storeId，其次 tenant scope
  const storeId = (c.get('storeId') as string) || resolveStoreId(getTenantScope(c));
  const deviceId = c.req.header('X-Device-Id') || 'unknown';

  // merchantId 由 tenant 中间件自动注入
  const merchantId = c.get('merchantId') as string;

  let newCount = 0;
  let changeCount = 0;

  for (const order of orders) {
    // 按 source + sourceOrderId 去重（与唯一索引一致）
    const existing = await db
      .select({ id: pmsOtaOrders.id, status: pmsOtaOrders.status })
      .from(pmsOtaOrders)
      .where(
        and(
          eq(pmsOtaOrders.source, order.source),
          eq(pmsOtaOrders.sourceOrderId, order.sourceOrderId),
        )
      )
      .limit(1);

    if (existing.length === 0) {
      // 新订单
      await db.insert(pmsOtaOrders).values({
        id: randomUUID(),
        storeId,
        source: order.source,
        sourceOrderId: order.sourceOrderId,
        sourceStoreId: order.sourceStoreId,
        guestName: order.guestName,
        guestPhone: order.guestPhone,
        roomType: order.roomType,
        roomCount: order.roomCount,
        checkIn: order.checkIn,
        checkOut: order.checkOut,
        totalAmount: String(order.totalAmount),
        status: order.status,
        breakfast: order.breakfast,
        remark: order.remark,
        guestIdNumber: order.guestIdNumber,
        commission: order.commission ? String(order.commission) : undefined,
        arrivalTime: order.arrivalTime,
        orderLabel: order.orderLabel,
        rawData: order as any,
        capturedAt: new Date(order.capturedAt),
        clientVersion: order.clientVersion,
      });
      newCount++;
    } else {
      // 已存在，更新可变字段；状态变更时单独计数
      const existingStatus = existing[0].status;
      await db
        .update(pmsOtaOrders)
        .set({
          guestName: order.guestName,
          guestPhone: order.guestPhone,
          roomType: order.roomType,
          roomCount: order.roomCount,
          checkIn: order.checkIn,
          checkOut: order.checkOut,
          totalAmount: String(order.totalAmount),
          status: order.status,
          breakfast: order.breakfast ?? false,
          remark: order.remark,
          guestIdNumber: order.guestIdNumber,
          commission: order.commission ? String(order.commission) : undefined,
          arrivalTime: order.arrivalTime,
          orderLabel: order.orderLabel,
          updatedAt: new Date(),
          rawData: order as any,
        })
        .where(eq(pmsOtaOrders.id, existing[0].id));
      if (existingStatus !== order.status) {
        changeCount++;
      }
    }
  }

  // 记录抓取日志
  await db.insert(pmsOtaCaptureLogs).values({
    id: randomUUID(),
    storeId,
    platform: 'meituan',
    deviceId,
    result: newCount > 0 || changeCount > 0 ? 'success' : 'no_change',
    newCount,
    changeCount,
    capturedAt: new Date(),
  });

  // 自动同步房型：将订单中的 OTA 房型写入 PMS 房型表（首次写入，已有则跳过）
  const seenRoomTypes = new Set<string>();
  for (const order of orders) {
    const rtName = (order.roomType || '').trim().slice(0, 100);
    if (!rtName || seenRoomTypes.has(rtName)) continue;
    seenRoomTypes.add(rtName);

    const exist = await db.select({ id: pmsBuiRoomTypes.id })
      .from(pmsBuiRoomTypes)
      .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.name, rtName)))
      .limit(1);
    if (exist.length > 0) continue;

    await db.insert(pmsBuiRoomTypes).values({
      id: randomUUID(),
      // 从门店获取 merchantId
      merchantId,
      storeId,
      name: rtName,
      bedType: '大床',
      maxGuests: 2,
      roomCount: 1,
      basePrice: Math.round(order.totalAmount),
      status: 'active',
    });
  }

  // 同步到 PMS 主订单表（房态自动计算基于此表；新单 → pending_confirm 待员工接单，占房态）
  for (const order of orders) {
    const pmsStatus = mapOtaStatus(order.status);
    const orderNo = 'OTA-' + order.sourceOrderId.slice(-20);

    // 计算入住天数
    let nights = 1;
    try {
      const ci = new Date(order.checkIn);
      const co = new Date(order.checkOut);
      nights = Math.max(1, Math.round((co.getTime() - ci.getTime()) / 86400000));
    } catch {}

    // 房型名称 → 门店房型 id（房态占用按房型维度，未匹配则 null）；名称与自动建房型段一致做 trim+slice 归一化
    const [matchedRt] = order.roomType
      ? await db.select({ id: pmsBuiRoomTypes.id }).from(pmsBuiRoomTypes)
          .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.name, (order.roomType || '').trim().slice(0, 100))))
          .limit(1)
      : [undefined];

    // 查找是否已存在
    const existOrder = await db.select({ id: pmsBuiOrders.id, status: pmsBuiOrders.status })
      .from(pmsBuiOrders)
      .where(eq(pmsBuiOrders.otaOrderId, order.sourceOrderId))
      .limit(1);

    if (existOrder.length > 0) {
      // 仅当允许推进时更新状态（员工已接单不被重复抓取降级；终态不回退）
      if (shouldApplyOtaUpdate(existOrder[0].status, pmsStatus)) {
        await db.update(pmsBuiOrders)
          .set({
            status: pmsStatus,
            updatedAt: new Date(),
            checkIn: order.checkIn,
            checkOut: order.checkOut,
            totalPrice: Math.round(order.totalAmount || 0),
          } as any)
          .where(eq(pmsBuiOrders.id, existOrder[0].id));
      }
      continue;
    }

    // 新建 PMS 订单：新单待接单（pending_confirm）+ 1h 确认时限（otaTimeout）
    await db.insert(pmsBuiOrders).values({
      id: randomUUID(),
      // 从门店获取 merchantId
      merchantId,
      storeId,
      orderNo,
      channel: order.source === 'ctrip' ? '携程' : '美团',
      channelColor: order.source === 'ctrip' ? 'bg-blue-600' : 'bg-amber-500',
      channelOrderId: order.sourceOrderId,
      otaOrderId: order.sourceOrderId,
      guestName: order.guestName || '未知',
      guestPhone: order.guestPhone || '',
      checkIn: order.checkIn,
      checkOut: order.checkOut,
      roomType: order.roomType || '',
      roomTypeId: matchedRt?.id ?? null,
      nights,
      totalPrice: Math.round(order.totalAmount || 0),
      status: pmsStatus,
      source: 'ota',
      remark: order.orderLabel || order.remark || '',
      paymentMethod: '在线支付',
      paymentStatus: 'paid',
      otaTimeout: new Date(Date.now() + 60 * 60 * 1000), // 1h 确认时限
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  }

  return c.json({ ok: true, newCount, changeCount });
});

// 查询 OTA 订单列表（Web 端调用）
ordersRoute.get('/', async (c) => {
  const storeId = c.req.query('storeId') || resolveStoreId(getTenantScope(c));
  const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(c.req.query('pageSize') || '20') || 20));
  const offset = (page - 1) * pageSize;

  const orders = await db
    .select()
    .from(pmsOtaOrders)
    .where(eq(pmsOtaOrders.storeId, storeId))
    .orderBy(desc(pmsOtaOrders.capturedAt))
    .limit(pageSize)
    .offset(offset);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pmsOtaOrders)
    .where(eq(pmsOtaOrders.storeId, storeId));

  // 今日新增订单数
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [{ todayNew }] = await db
    .select({ todayNew: sql<number>`count(*)::int` })
    .from(pmsOtaOrders)
    .where(
      and(
        eq(pmsOtaOrders.storeId, storeId),
        sql`${pmsOtaOrders.capturedAt} >= ${todayStart.toISOString()}`
      )
    );

  return c.json({
    orders: orders.map(o => ({
      ...o,
      totalAmount: o.totalAmount ? parseFloat(o.totalAmount) : 0,
    })),
    total: Number(count),
    page,
    pageSize,
    todayNew: Number(todayNew),
  });
});

// 查询今日统计
ordersRoute.get('/stats', async (c) => {
  const storeId = c.req.query('storeId') || resolveStoreId(getTenantScope(c));
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  // 今日新增
  const [{ todayNew }] = await db
    .select({ todayNew: sql<number>`count(*)::int` })
    .from(pmsOtaOrders)
    .where(and(eq(pmsOtaOrders.storeId, storeId), sql`${pmsOtaOrders.capturedAt} >= ${todayStart.toISOString()}`));

  // 今日变更（排除今日新增：仅统计今日之前创建、今日发生更新的订单）
  const [{ todayChanged }] = await db
    .select({ todayChanged: sql<number>`count(*)::int` })
    .from(pmsOtaOrders)
    .where(and(
      eq(pmsOtaOrders.storeId, storeId),
      sql`${pmsOtaOrders.updatedAt} >= ${todayStart.toISOString()}`,
      sql`${pmsOtaOrders.createdAt} < ${todayStart.toISOString()}`
    ));

  // 今日取消
  const [{ todayCancelled }] = await db
    .select({ todayCancelled: sql<number>`count(*)::int` })
    .from(pmsOtaOrders)
    .where(and(eq(pmsOtaOrders.storeId, storeId), eq(pmsOtaOrders.status, 'cancelled'), sql`${pmsOtaOrders.updatedAt} >= ${todayStart.toISOString()}`));

  return c.json({ todayNew: Number(todayNew), todayChanged: Number(todayChanged), todayCancelled: Number(todayCancelled) });
});

export default ordersRoute;
