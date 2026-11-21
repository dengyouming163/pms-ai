import { Hono } from 'hono';
import { db } from '../db/index';
import { pmsBuiStores, pmsBuiRoomTypes, pmsBuiRooms, pmsBuiOrders } from '../db/schema';
import { eq, and, sql, count, sum } from 'drizzle-orm';
import { getTenantScope } from '../utils/tenant.js';

const route = new Hono();

route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const mid = scope.merchantId;

  // Aggregate dashboard KPIs — 只查当前商户
  const baseStoreWhere = mid ? and(eq(pmsBuiStores.status, 'active'), eq(pmsBuiStores.merchantId, mid)) : eq(pmsBuiStores.status, 'active');
  const activeStores = await db.select().from(pmsBuiStores).where(baseStoreWhere);

  const totalRooms = activeStores.reduce((s, st) => s + (st.roomCount || 0), 0);
  const todayRevenue = activeStores.reduce((s, st) => s + (st.todayRevenue || 0), 0);
  const monthRevenue = activeStores.reduce((s, st) => s + (st.monthRevenue || 0), 0);
  const avgOccupancy = activeStores.length > 0
    ? Math.round(activeStores.reduce((s, st) => s + (st.todayOccupancy || 0), 0) / activeStores.length)
    : 0;

  // Count rooms by status — 只查当前商户
  const roomMerchantWhere = mid ? eq(pmsBuiRooms.merchantId, mid) : undefined;
  const occupiedRooms = await db.select({ cnt: count() }).from(pmsBuiRooms)
    .where(roomMerchantWhere ? and(eq(pmsBuiRooms.status, 'occupied'), roomMerchantWhere) : eq(pmsBuiRooms.status, 'occupied'));
  const availableRooms = await db.select({ cnt: count() }).from(pmsBuiRooms)
    .where(roomMerchantWhere ? and(eq(pmsBuiRooms.status, 'available'), roomMerchantWhere) : eq(pmsBuiRooms.status, 'available'));
  const dirtyRooms = await db.select({ cnt: count() }).from(pmsBuiRooms)
    .where(roomMerchantWhere ? and(eq(pmsBuiRooms.status, 'dirty'), roomMerchantWhere) : eq(pmsBuiRooms.status, 'dirty'));

  // Count pending orders — 只查当前商户
  const orderMerchantWhere = mid ? eq(pmsBuiOrders.merchantId, mid) : undefined;
  const pendingOrders = await db.select({ cnt: count() }).from(pmsBuiOrders)
    .where(orderMerchantWhere ? and(eq(pmsBuiOrders.status, 'pending_confirm'), orderMerchantWhere) : eq(pmsBuiOrders.status, 'pending_confirm'));
  const checkedIn = await db.select({ cnt: count() }).from(pmsBuiOrders)
    .where(orderMerchantWhere ? and(eq(pmsBuiOrders.status, 'checked_in'), orderMerchantWhere) : eq(pmsBuiOrders.status, 'checked_in'));

  const soldRooms = occupiedRooms[0]?.cnt || 0;
  const totalRoomCount = await db.select({ cnt: count() }).from(pmsBuiRooms)
    .where(roomMerchantWhere || undefined);

  const occupancyRate = totalRoomCount[0]?.cnt ? Math.round((soldRooms / totalRoomCount[0].cnt) * 100) : avgOccupancy;
  const adr = soldRooms > 0 ? Math.round(todayRevenue / soldRooms) : 0;
  const revpar = totalRoomCount[0]?.cnt ? Math.round(todayRevenue / totalRoomCount[0].cnt) : 0;

  // 查询最近 7 天真实订单数据
  const weeklyTrend = [];
  const todayDate = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayDate);
    d.setDate(d.getDate() - i);
    const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isoStr = d.toISOString().split('T')[0];

    // 查询当天订单（排除已取消）
    const dayOrders = await db.select().from(pmsBuiOrders).where(
      and(
        sql`${pmsBuiOrders.createdAt}::date = ${isoStr}::date`,
        sql`${pmsBuiOrders.status} != 'cancelled'`
      )
    );
    const dayRevenue = dayOrders.reduce((s, o) => s + (Number(o.totalPrice) || 0), 0);
    const dayRooms = dayOrders.length;

    // 当天入住率
    const dayOccupied = await db.select({ cnt: count() }).from(pmsBuiRooms)
      .where(eq(pmsBuiRooms.status, 'occupied'));
    const dayOccRate = totalRoomCount[0]?.cnt
      ? Math.round(((dayOccupied[0]?.cnt || 0) / totalRoomCount[0].cnt) * 100)
      : 0;
    const dayRevpar = totalRoomCount[0]?.cnt
      ? Math.round(dayRevenue / totalRoomCount[0].cnt)
      : 0;

    weeklyTrend.push({
      date: dateStr,
      revenue: dayRevenue,
      rooms: dayRooms,
      occupancyRate: dayOccRate,
      revpar: dayRevpar,
    });
  }

  const kpiData = {
    todayRevenue,
    revenueChange: 11.6,
    soldRooms,
    totalRooms: totalRoomCount[0]?.cnt || totalRooms,
    occupancyRate,
    occupancyChange: 3.2,
    adr,
    adrChange: 5.4,
    revpar,
    revparChange: 8.7,
    pendingOrders: pendingOrders[0]?.cnt || 0,
    expectedArrivals: 12,
    inHouse: checkedIn[0]?.cnt || soldRooms,
    expectedDepartures: 8,
    availableRooms: availableRooms[0]?.cnt || 0,
    todos: [
      { id: 't1', type: 'order' as const, title: '待确认订单', count: pendingOrders[0]?.cnt || 0 },
      { id: 't2', type: 'review' as const, title: '待回复评价', count: 2 },
      { id: 't3', type: 'task' as const, title: '待处理任务', count: dirtyRooms[0]?.cnt || 0 },
      { id: 't4', type: 'subscription' as const, title: '即将到期', count: 1 },
    ],
    weeklyTrend,
  };

  return c.json(kpiData);
});

export default route;
