import { Hono } from 'hono';
import { db } from '../db/index';
import {
  pmsBuiOrders, pmsBuiRooms, pmsBuiReconciliationAlerts,
  pmsBuiChannels,
} from '../db/schema';
import { sql, desc } from 'drizzle-orm';

const route = new Hono();

// ============ GET /api/notifications/unread ============
route.get('/unread', async (c) => {
  // 从主通知列表聚合未读数
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  let count = 0;

  // 新订单
  const [newOrders] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiOrders)
    .where(sql`${pmsBuiOrders.createdAt} >= ${twentyFourHoursAgo}::timestamp`);
  count += Number(newOrders?.count || 0);

  // 今日预计到店
  const [todayArrivals] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiOrders)
    .where(sql`${pmsBuiOrders.checkIn}::date = ${todayStr}::date AND ${pmsBuiOrders.status} IN ('confirmed', 'pending')`);
  count += todayArrivals?.count > 0 ? 1 : 0;

  // 今日应退房
  const [checkouts] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiRooms)
    .where(sql`${pmsBuiRooms.checkOutDate} = ${todayStr} AND ${pmsBuiRooms.status} = 'occupied'`);
  count += checkouts?.count > 0 ? 1 : 0;

  // 异常房间
  const [problemRooms] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiRooms)
    .where(sql`${pmsBuiRooms.status} IN ('maintenance', 'locked')`);
  count += Number(problemRooms?.count || 0);

  return c.json({ count });
});

// ============ GET /api/notifications ============
route.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  const notifications: Array<{
    id: string;
    type: 'order' | 'checkin' | 'checkout' | 'reconciliation' | 'alert' | 'channel';
    title: string;
    desc: string;
    time: string;
    read: boolean;
  }> = [];

  // 1. 新订单通知（最近 24 小时内的新订单）
  const newOrders = await db.select().from(pmsBuiOrders)
    .where(sql`${pmsBuiOrders.createdAt} >= ${twentyFourHoursAgo}::timestamp`)
    .orderBy(desc(pmsBuiOrders.createdAt))
    .limit(5);

  newOrders.forEach(order => {
    const createdTime = order.createdAt ? new Date(order.createdAt) : now;
    const hoursAgo = Math.max(0, Math.round((now.getTime() - createdTime.getTime()) / 3600000));
    notifications.push({
      id: `notif-order-${order.id}`,
      type: 'order',
      title: `新订单：${order.channel || '直接'}-${order.roomType || '房间'}x1`,
      desc: `${order.guestName} · ￥${order.totalPrice || 0} · ${order.checkIn || ''} 至 ${order.checkOut || ''}`,
      time: hoursAgo < 1 ? '刚刚' : hoursAgo < 24 ? `${hoursAgo}小时前` : '昨天',
      read: false,
    });
  });

  // 2. 入住提醒（今日预计到店的订单）
  const todayArrivals = await db.select().from(pmsBuiOrders)
    .where(sql`${pmsBuiOrders.checkIn}::date = ${todayStr}::date AND ${pmsBuiOrders.status} IN ('confirmed', 'pending')`)
    .limit(5);

  if (todayArrivals.length > 0) {
    notifications.push({
      id: 'notif-arrivals-today',
      type: 'checkin',
      title: `今日预计到店：${todayArrivals.length}间房`,
      desc: todayArrivals.map(o => `${o.guestName || '未知'}·${o.roomType || ''}`).join('，'),
      time: '今天',
      read: false,
    });
  }

  // 3. 退房提醒（今日应离店的房间）
  const roomCheckouts = await db.select().from(pmsBuiRooms)
    .where(sql`${pmsBuiRooms.checkOutDate} = ${todayStr} AND ${pmsBuiRooms.status} = 'occupied'`)
    .limit(10);

  if (roomCheckouts.length > 0) {
    notifications.push({
      id: 'notif-checkouts-today',
      type: 'checkout',
      title: `今日应退房：${roomCheckouts.length}间`,
      desc: roomCheckouts.map(r => `${r.roomNumber} ${r.guestName || ''}`).join('，'),
      time: '今天',
      read: false,
    });
  }

  // 4. 即将超时未入住（预订日期为今天但状态仍为booked）
  const overdueRooms = await db.select().from(pmsBuiRooms)
    .where(sql`${pmsBuiRooms.checkInDate} = ${todayStr} AND ${pmsBuiRooms.status} = 'booked'`)
    .limit(5);

  if (overdueRooms.length > 0) {
    notifications.push({
      id: 'notif-overdue',
      type: 'alert',
      title: `${overdueRooms.length}间房即将超时未入住`,
      desc: overdueRooms.map(r => `${r.roomNumber} ${r.guestName || ''}`).join('，'),
      time: '今天',
      read: false,
    });
  }

  // 5. 维修/异常房间
  const problemRooms = await db.select().from(pmsBuiRooms)
    .where(sql`${pmsBuiRooms.status} IN ('maintenance', 'locked')`)
    .limit(5);

  problemRooms.forEach(r => {
    notifications.push({
      id: `notif-problem-${r.id}`,
      type: 'alert',
      title: `房间${r.roomNumber}${r.status === 'maintenance' ? '维修中' : '已锁房'}`,
      desc: r.lockReason || r.dirtyType || '暂无备注',
      time: r.updatedAt ? formatRelativeTime(new Date(r.updatedAt), now) : '未知',
      read: false,
    });
  });

  // 6. 对账预警
  const reconciliationAlerts = await db.select().from(pmsBuiReconciliationAlerts)
    .where(sql`${pmsBuiReconciliationAlerts.status} = 'pending'`)
    .orderBy(desc(pmsBuiReconciliationAlerts.createdAt))
    .limit(5);

  reconciliationAlerts.forEach(alert => {
    notifications.push({
      id: `notif-recon-${alert.id}`,
      type: 'reconciliation',
      title: alert.title || '对账差异提醒',
      desc: alert.description || `渠道: ${alert.channel || ''}, 差异金额: ￥${alert.amount || 0}`,
      time: alert.createdAt ? formatRelativeTime(new Date(alert.createdAt), now) : '最近',
      read: false,
    });
  });

  // 7. 渠道连接状态
  const disconnectedChannels = await db.select().from(pmsBuiChannels)
    .where(sql`${pmsBuiChannels.status} != 'connected'`)
    .limit(3);

  disconnectedChannels.forEach(ch => {
    notifications.push({
      id: `notif-channel-${ch.id}`,
      type: 'channel',
      title: `渠道${ch.name}连接异常`,
      desc: ch.status === 'error' ? '连接出现错误，请检查配置' : '渠道已断开连接',
      time: ch.lastSyncAt ? formatRelativeTime(new Date(ch.lastSyncAt), now) : '未知',
      read: false,
    });
  });

  // 按时间排序，限制数量
  const sorted = notifications.slice(0, limit);

  return c.json({ success: true, data: sorted });
});

/** 格式化相对时间 */
function formatRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return '昨天';
  if (diffDay < 7) return `${diffDay}天前`;
  return date.toISOString().split('T')[0];
}

export default route;
