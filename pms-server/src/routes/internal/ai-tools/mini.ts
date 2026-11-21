import { Hono } from 'hono';
import { db } from '../../../db/index.js';
import { pmsBuiRoomTypes, pmsBuiRooms, pmsBuiOrders, pmsBuiStores } from '../../../db/schema/index.js';
import { pmsBuiMiniStoreConfig } from '../../../db/schema/mini-store.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { OCCUPYING_STATUSES } from '../../../utils/mini-availability.js';

const route = new Hono();

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00+08:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// 获取逐日房态 + 房型信息
route.get('/room-availability', async (c) => {
  const storeId = c.req.header('X-Store-Id') || '';
  const checkIn = c.req.query('check_in') || '';
  const nights = parseInt(c.req.query('nights') || '0');

  if (!storeId || !checkIn || nights <= 0) return c.json({ error: '缺少参数' }, 400);

  const endDate = addDays(checkIn, nights);
  const roomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')));
  if (roomTypes.length === 0) return c.json({ availabilities: {}, room_info: {} });

  const roomTypeIds = roomTypes.map(rt => rt.id);
  const rooms = await db.select({ id: pmsBuiRooms.id, roomTypeId: pmsBuiRooms.roomTypeId })
    .from(pmsBuiRooms).where(and(eq(pmsBuiRooms.storeId, storeId), inArray(pmsBuiRooms.roomTypeId, roomTypeIds)));

  const totalByType: Record<string, number> = {};
  rooms.forEach(r => { if (r.roomTypeId) totalByType[r.roomTypeId] = (totalByType[r.roomTypeId] || 0) + 1; });

  const availabilities: Record<string, boolean[]> = {};
  const room_info: Record<string, any> = {};

  for (const rt of roomTypes) {
    room_info[rt.id] = {
      name: rt.name,
      price_per_night: rt.basePrice,
      bed_type: rt.bedType,
      max_guests: rt.maxGuests,
    };
    const total = totalByType[rt.id] || 0;
    availabilities[rt.id] = [];

    for (let d = 0; d < nights; d++) {
      const date = addDays(checkIn, d);
      const nextDate = addDays(checkIn, d + 1);
      const occupied = await db.select({ id: pmsBuiOrders.id }).from(pmsBuiOrders)
        .where(and(
          eq(pmsBuiOrders.storeId, storeId), eq(pmsBuiOrders.roomTypeId, rt.id),
          inArray(pmsBuiOrders.status, OCCUPYING_STATUSES as string[]),
          sql`${pmsBuiOrders.checkIn} < ${nextDate}`,
          sql`${pmsBuiOrders.checkOut} > ${date}`,
        ));
      availabilities[rt.id].push(occupied.length < total);
    }
  }

  return c.json({ availabilities, room_info });
});

// 民宿信息
route.get('/property-info', async (c) => {
  const storeId = c.req.header('X-Store-Id') || '';
  const [store] = await db.select().from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId)).limit(1);
  const [config] = await db.select().from(pmsBuiMiniStoreConfig).where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1);

  return c.json({
    name: store?.name || '',
    address: store?.address || '',
    phone: store?.phone || '',
    facilities: store?.facilities || [],
    intro: config?.intro || '',
    cancelPolicy: config?.cancelPolicy || { freeHours: 24, feeRate: 20 },
  });
});

export default route;
