import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index';
import { pmsBuiOrders, pmsBuiRooms } from '../db/schema';
import { pmsOtaOrders } from '../db/schema/ota.js';
import { eq, and, or, like, sql, desc } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { findStayOrderByPlatformOrder } from '../services/platform-order-converter.js';

const route = new Hono();

const channelIconMap: Record<string, string> = {
  '携程': '✈️', '美团': '🍔', '飞猪': '🐷', 'Booking': '🌍', '爱彼迎': '🏠',
  '抖音': '🎵', '途家': '🏢', '直营': '🏨', '去哪儿': '🔍', '同程旅行': '🚄',
  'Agoda': '🌏', '途家民宿': '🏡', 'Booking.com': '🌍',
  '微信直营': '💬', '到店散客': '🚶', '电话预订': '📞', '企业协议': '🏢',
  '小红书': '📕', '到店': '🚶', 'walk-in': '🚶', '私域平台': '🎫',
};

const channelColorMap: Record<string, string> = {
  '携程': 'bg-blue-600', '美团': 'bg-amber-500', '飞猪': 'bg-red-500',
  'Booking': 'bg-indigo-600', '爱彼迎': 'bg-pink-500',
  '抖音': 'bg-gray-900', '途家': 'bg-cyan-600', '直营': 'bg-emerald-600',
  '去哪儿': 'bg-blue-500', '同程旅行': 'bg-green-500',
  'Agoda': 'bg-indigo-500', '途家民宿': 'bg-orange-500', 'Booking.com': 'bg-indigo-600',
  '微信直营': 'bg-green-600', '到店散客': 'bg-teal-500', '电话预订': 'bg-violet-500',
  '企业协议': 'bg-slate-600', '小红书': 'bg-rose-500', '到店': 'bg-teal-500',
  'walk-in': 'bg-teal-500', '私域平台': 'bg-purple-600',
};

const statusMap: Record<string, { label: string; color: string }> = {
  pending: { label: '待确认', color: 'amber' },
  pending_confirm: { label: '待确认', color: 'amber' },
  confirmed: { label: '已确认', color: 'blue' },
  checked_in: { label: '已入住', color: 'emerald' },
  checked_out: { label: '已退房', color: 'gray' },
  cancelled: { label: '已取消', color: 'red' },
  no_show: { label: '未到店', color: 'orange' },
};

const paymentStatusMap: Record<string, { label: string; color: string }> = {
  paid: { label: '已支付', color: 'emerald' },
  unpaid: { label: '未支付', color: 'amber' },
  partial: { label: '部分支付', color: 'blue' },
  refunded: { label: '已退款', color: 'red' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatOrder(o: any) {
  const statusInfo = statusMap[o.status] || { label: o.status, color: 'gray' };
  const paymentStatusInfo = paymentStatusMap[o.paymentStatus] || { label: o.paymentStatus || '未支付', color: 'gray' };
  return {
    id: o.id,
    orderNo: o.orderNo,
    channel: o.channel,
    channelColor: channelColorMap[o.channel] || 'bg-gray-500',
    icon: o.icon || channelIconMap[o.channel] || '📋',
    channelOrderId: o.channelOrderId,
    guestName: o.guestName,
    guestPhone: o.guestPhone || '',
    guestId: o.guestId || '',
    checkIn: o.checkIn,
    checkOut: o.checkOut,
    roomType: o.roomType,
    roomTypeId: o.roomTypeId,
    roomNumber: o.roomNumber,
    roomId: o.roomId || '',
    nights: o.nights,
    source: o.source || (o.channel === '直营' ? 'direct' : 'ota'),
    amount: Number(o.totalPrice) || 0,
    originalAmount: o.originalAmount ? Number(o.originalAmount) : Number(o.totalPrice) || 0,
    discount: o.discount || '',
    extras: o.extras || [],
    paymentMethod: o.paymentMethod || '在线支付',
    paymentStatus: o.paymentStatus,
    paymentStatusInfo,
    status: o.status,
    statusInfo,
    remark: o.remark || '',
    otaTimeout: o.otaTimeout ? new Date(o.otaTimeout).toISOString() : '',
    otaOrderId: o.otaOrderId || o.channelOrderId || '',
    platformOrderId: o.platformOrderId || '',
    platformOrderNo: o.platformOrderNo || '',
    verifyCode: o.verifyCode || '',
    confirmedAt: o.confirmedAt ? new Date(o.confirmedAt).toISOString() : '',
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt).toISOString() : '',
    cancelReason: o.cancelReason || '',
    channelInfo: { color: channelColorMap[o.channel] || 'bg-gray-500', icon: channelIconMap[o.channel] || '📋' },
    createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : '',
  };
}

function buildTimeline(o: { createdAt: Date; orderNo: string; id: string; status: string; confirmedAt: Date | null; checkIn: string; guestName: string; roomNumber: string | null; checkOut: string; cancelledAt: Date | null; cancelReason: string | null }) {
  const timeline = [
    { time: o.createdAt.toISOString(), label: '创建订单', desc: `订单${o.orderNo || o.id}创建` },
  ];
  if (o.status !== 'pending' && o.status !== 'pending_confirm' && o.status !== 'cancelled') {
    timeline.push({ time: (o.confirmedAt || o.createdAt).toISOString(), label: '确认订单', desc: '订单已确认' });
  }
  if (o.status === 'pending_confirm') {
    timeline.push({ time: o.createdAt.toISOString(), label: '等待确认', desc: '渠道订单待确认' });
  }
  if (o.status === 'checked_in' || o.status === 'checked_out') {
    timeline.push({ time: o.checkIn, label: '办理入住', desc: `${o.guestName}入住${o.roomNumber || ''}` });
  }
  if (o.status === 'checked_out') {
    timeline.push({ time: o.checkOut, label: '办理退房', desc: `${o.guestName}退房` });
  }
  if (o.status === 'cancelled') {
    timeline.push({ time: (o.cancelledAt || o.createdAt).toISOString(), label: '取消订单', desc: o.cancelReason || '订单已取消' });
  }
  return timeline;
}

route.get('/', async (c) => {
  const type = c.req.query('type');
  const status = c.req.query('status');
  const channel = c.req.query('channel');
  const keyword = c.req.query('keyword');
  const id = c.req.query('id');
  const platformOrderId = c.req.query('platformOrderId');
  const scope = getTenantScope(c);

  if (type === 'detail' && id) {
    const order = await db.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.id, id)).limit(1);
    if (order.length === 0) return c.json({ error: '订单不存在' }, 404);
    const o = order[0];
    return c.json({
      ...formatOrder(o),
      channelInfo: { color: channelColorMap[o.channel] || 'bg-gray-500', icon: channelIconMap[o.channel] || '📋' },
      timeline: buildTimeline(o),
    });
  }

  // 平台单反查：员工端核销列表「查看住宿订单」按 platform_order_id（唯一索引）反查已转化住宿订单
  if (type === 'byPlatformOrder' && platformOrderId) {
    const stay = await findStayOrderByPlatformOrder(platformOrderId);
    if (!stay) return c.json({ error: '未找到对应住宿订单' }, 404);
    const o = stay;
    return c.json({
      ...formatOrder(o),
      channelInfo: { color: channelColorMap[o.channel] || 'bg-gray-500', icon: channelIconMap[o.channel] || '📋' },
      timeline: buildTimeline(o),
    });
  }

  if (type === 'stats') {
    const todayStr = new Date().toISOString().slice(0, 10);
    const mid = scope.merchantId && scope.merchantId !== 'default' ? scope.merchantId : undefined;
    const orderWhere = mid ? eq(pmsBuiOrders.merchantId, mid) : undefined;

    const statsResult = await db.select({
      total: sql<number>`count(*)`,
      pending: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.status} IN ('pending', 'pending_confirm'))`,
      todayCheckin: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.checkIn} = ${todayStr})`,
      todayCheckout: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.checkOut} = ${todayStr})`,
    }).from(pmsBuiOrders).where(orderWhere);

    const otaStatsCons = [eq(pmsBuiOrders.source, 'ota'), eq(pmsBuiOrders.status, 'pending_confirm')];
    if (orderWhere) otaStatsCons.push(orderWhere);
    const otaPendingResult = await db.select({
      count: sql<number>`count(*)`,
      urgent: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.otaTimeout} IS NOT NULL AND ${pmsBuiOrders.otaTimeout} < ${new Date(Date.now() + 3600000)})`,
    }).from(pmsBuiOrders).where(and(...otaStatsCons));

    const channelCounts = await db.select({
      channel: pmsBuiOrders.channel,
      count: sql<number>`count(*)::int`,
    }).from(pmsBuiOrders).where(orderWhere).groupBy(pmsBuiOrders.channel);

    const statusCounts = await db.select({
      status: pmsBuiOrders.status,
      count: sql<number>`count(*)::int`,
    }).from(pmsBuiOrders).where(orderWhere).groupBy(pmsBuiOrders.status);

    const channelColors: Record<string, string> = { '携程':'bg-blue-500','美团':'bg-yellow-500','自来客':'bg-emerald-500','飞猪':'bg-orange-500','抖音':'bg-gray-600','小红书':'bg-pink-500' };

    return c.json({
      total: Number(statsResult[0].total),
      pending: Number(statsResult[0].pending),
      otaPending: Number(otaPendingResult[0].count),
      urgent: Number(otaPendingResult[0].urgent),
      todayCheckin: Number(statsResult[0].todayCheckin),
      todayCheckout: Number(statsResult[0].todayCheckout),
      channelBreakdown: channelCounts.filter(c => c.count > 0).map(c => ({ name: c.channel, count: Number(c.count), color: channelColors[c.channel] || 'bg-slate-500' })),
      statusBreakdown: Object.entries(statusMap).map(([key, val]) => ({
        key,
        label: val.label,
        count: Number(statusCounts.find(s => s.status === key)?.count ?? 0),
      })),
    });
  }

  // 渠道订单：直接从 pms_ota_orders 拉取（已弃用 pms_bui_channel_orders）
  if (type === 'channel-pending') {
    // 不按门店过滤（OTA 数据归集于 s1，与 X-Store-Id 无关）

    const otaOrders = await db.select().from(pmsOtaOrders)
      .orderBy(desc(pmsOtaOrders.createdAt))
      .limit(500);

    const chName = (s: string) => s === 'ctrip' ? '携程' : '美团';
    const grouped: Record<string, any> = {};
    for (const o of otaOrders) {
      const cn = chName(o.source);
      if (!grouped[cn]) {
        grouped[cn] = { name: cn, color: channelColorMap[cn] || 'bg-gray-500', icon: channelIconMap[cn] || '', count: 0, urgentCount: 0, orders: [] as any[] };
      }
      grouped[cn].count++;
      const statusInfo = statusMap[o.status ?? ''] || { label: o.status ?? '', color: 'gray' };
      grouped[cn].orders.push({
        id: o.id,
        orderNo: o.sourceOrderId,
        channel: cn,
        channelColor: channelColorMap[cn] || 'bg-gray-500',
        icon: channelIconMap[cn] || '📋',
        channelOrderId: o.sourceOrderId,
        guestName: o.guestName,
        guestPhone: o.guestPhone || '',
        checkIn: o.checkIn,
        checkOut: o.checkOut,
        roomType: o.roomType,
        nights: o.roomCount || 1,
        source: 'ota',
        amount: o.totalAmount ? Number(o.totalAmount) : 0,
        originalAmount: o.totalAmount ? Number(o.totalAmount) : 0,
        discount: '',
        extras: [],
        paymentMethod: '在线支付',
        paymentStatus: 'unpaid',
        status: o.status || 'confirmed',
        statusInfo,
        remark: o.remark || '',
        createdAt: o.createdAt?.toISOString() || '',
        formDate: o.createdAt?.toISOString() || '',
      });
    }
    const result = Object.values(grouped);
    if (channel) return c.json({ channels: result.filter((g: any) => g.name === channel) });
    return c.json({ channels: result });
  }

  // 解析分页参数
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = (page - 1) * limit;

  // 构建查询条件（含租户过滤）
  const conditions = [];
  if (scope.merchantId && scope.merchantId !== 'default') {
    conditions.push(eq(pmsBuiOrders.merchantId, scope.merchantId));
  }
  if (scope.storeId && scope.storeId !== '*') {
    conditions.push(eq(pmsBuiOrders.storeId, scope.storeId));
  }
  if (status) conditions.push(eq(pmsBuiOrders.status, status));
  if (channel) conditions.push(eq(pmsBuiOrders.channel, channel));
  if (keyword) {
    conditions.push(
      or(
        like(pmsBuiOrders.guestName, `%${keyword}%`),
        like(pmsBuiOrders.orderNo, `%${keyword}%`),
        like(pmsBuiOrders.guestPhone, `%${keyword}%`),
      )
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // 统计符合条件的总数
  const countResult = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiOrders).where(whereClause);
  const total = Number(countResult[0].count);

  // 分页查询订单列表
  const orders = await db.select().from(pmsBuiOrders)
    .where(whereClause)
    .orderBy(desc(pmsBuiOrders.createdAt))
    .limit(limit)
    .offset(offset);

  // 用 SQL 聚合替代全量加载（仅用于统计）
  const todayStr = new Date().toISOString().slice(0, 10);
  const statsResult = await db.select({
    total: sql<number>`count(*)`,
    pending: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.status} IN ('pending', 'pending_confirm'))`,
    todayCheckin: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.checkIn} = ${todayStr})`,
    todayCheckout: sql<number>`count(*) FILTER (WHERE ${pmsBuiOrders.checkOut} = ${todayStr})`,
  }).from(pmsBuiOrders);

  const channelColors: Record<string, string> = { '携程':'bg-blue-500','美团':'bg-yellow-500','自来客':'bg-emerald-500','飞猪':'bg-orange-500','抖音':'bg-gray-600','小红书':'bg-pink-500' };
  const channelCounts = await db.select({
    channel: pmsBuiOrders.channel,
    count: sql<number>`count(*)::int`,
  }).from(pmsBuiOrders).where(whereClause).groupBy(pmsBuiOrders.channel);

  const statusCounts = await db.select({
    status: pmsBuiOrders.status,
    count: sql<number>`count(*)::int`,
  }).from(pmsBuiOrders).groupBy(pmsBuiOrders.status);

  // 获取渠道侧栏数据（OTA 订单）
  const otaCons: any[] = [eq(pmsBuiOrders.source, 'ota')];
  if (scope.storeId && scope.storeId !== '*') otaCons.push(eq(pmsBuiOrders.storeId, scope.storeId));
  const channelPending = await db.select().from(pmsBuiOrders).where(and(...otaCons));
  const grouped = channelPending.reduce((acc: Record<string, { name: string; color: string; icon: string; count: number; urgentCount: number; orders: typeof channelPending }>, o) => {
    if (!acc[o.channel]) {
      acc[o.channel] = { name: o.channel, color: o.channelColor || '', icon: channelIconMap[o.channel] || '', count: 0, urgentCount: 0, orders: [] };
    }
    acc[o.channel].count++;
    const timeout = new Date(o.otaTimeout || '').getTime();
    if (!isNaN(timeout) && timeout - Date.now() < 3600000) acc[o.channel].urgentCount++;
    acc[o.channel].orders.push(o);
    return acc;
  }, {});

  return c.json({
    orders: orders.map(formatOrder),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    stats: {
      total: Number(statsResult[0].total),
      pending: Number(statsResult[0].pending),
      otaPending: channelPending.length,
      urgent: channelPending.filter(o => {
        const timeout = new Date(o.otaTimeout || '').getTime();
        return !isNaN(timeout) && timeout - Date.now() < 3600000;
      }).length,
      todayCheckin: Number(statsResult[0].todayCheckin),
      todayCheckout: Number(statsResult[0].todayCheckout),
      channelBreakdown: channelCounts.filter(c => c.count > 0).map(c => ({ name: c.channel, count: Number(c.count), color: channelColors[c.channel] || 'bg-slate-500' })),
      channels: channelCounts.map(c => c.channel),
      statusBreakdown: Object.entries(statusMap).map(([key, val]) => ({
        key,
        label: val.label,
        count: Number(statusCounts.find(s => s.status === key)?.count ?? 0),
      })),
    },
    channels: Object.values(grouped).map(g => ({
      ...g,
      orders: g.orders.map(formatOrder),
    })),
  });
});

const orderActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), orderId: z.string().min(1, '订单ID不能为空') }),
  z.object({ action: z.literal('cancel'), orderId: z.string().min(1, '订单ID不能为空'), reason: z.string().optional() }),
  z.object({ action: z.literal('batchConfirm'), orderIds: z.array(z.string()).min(1, '订单ID列表不能为空') }),
  z.object({ action: z.literal('batchCancel'), orderIds: z.array(z.string()).min(1, '订单ID列表不能为空'), reason: z.string().optional() }),
  z.object({ action: z.literal('create'), guestName: z.string().min(1), guestPhone: z.string().length(11), roomId: z.string().min(1), channel: z.string().optional(), checkIn: z.string().optional(), checkOut: z.string().optional(), roomType: z.string().optional(), roomTypeId: z.string().optional(), roomNumber: z.string().optional(), amount: z.union([z.string(), z.number()]).optional(), source: z.string().optional(), paymentMethod: z.string().optional(), remark: z.string().optional() }),
]);

route.post('/', async (c) => {
  const body = await c.req.json();

  const validation = await validateBody(body, orderActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;

  if (data.action === 'confirm') {
    const now = new Date();
    await db.update(pmsBuiOrders).set({ status: 'confirmed', confirmedAt: now }).where(eq(pmsBuiOrders.id, data.orderId));
    return c.json({ success: true });
  }

  if (data.action === 'cancel') {
    const now = new Date();
    const reason = data.reason || '';
    await db.update(pmsBuiOrders).set({ status: 'cancelled', cancelledAt: now, cancelReason: reason }).where(eq(pmsBuiOrders.id, data.orderId));
    return c.json({ success: true });
  }

  if (data.action === 'batchConfirm') {
    const now = new Date();
    for (const oid of data.orderIds) {
      await db.update(pmsBuiOrders).set({ status: 'confirmed', confirmedAt: now }).where(eq(pmsBuiOrders.id, oid));
    }
    return c.json({ success: true });
  }

  if (data.action === 'batchCancel') {
    const now = new Date();
    for (const oid of data.orderIds) {
      await db.update(pmsBuiOrders).set({ status: 'cancelled', cancelledAt: now, cancelReason: data.reason || '' }).where(eq(pmsBuiOrders.id, oid));
    }
    return c.json({ success: true });
  }

  if (data.action === 'create') {
    const scope = getTenantScope(c);
    const now = new Date();
    const orderNo = `ORD${Date.now().toString().slice(-8)}`;
    const checkIn = data.checkIn || now.toISOString().split('T')[0];
    const room = await db.select().from(pmsBuiRooms).where(and(eq(pmsBuiRooms.id, data.roomId), ...tenantWhere(scope, pmsBuiRooms))).limit(1);

    await db.insert(pmsBuiOrders).values({
      id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      orderNo,
      channel: data.channel || 'walk-in',
      guestName: data.guestName,
      guestPhone: data.guestPhone || '',
      checkIn: data.checkIn || checkIn,
      checkOut: data.checkOut || '',
      roomType: data.roomType || room[0]?.roomTypeName || '',
      roomNumber: data.roomNumber || '',
      totalPrice: data.amount || 0,
      status: 'confirmed',
      paymentStatus: 'unpaid',
      source: data.source || 'walk_in',
      paymentMethod: data.paymentMethod || '到店付',
      remark: data.remark || '',
      roomId: data.roomId,
      roomTypeId: data.roomTypeId || room[0]?.roomTypeId || '',
      merchantId: scope.merchantId,
      storeId: room[0]?.storeId || scope.storeId === '*' ? 'default_store' : scope.storeId,
      createdAt: now,
      updatedAt: now,
    } as any);

    return c.json({ success: true, message: '订单创建成功', data: { orderNo } });
  }

  return c.json({ success: true });
});

export default route;
