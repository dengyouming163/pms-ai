import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, gte, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiRoomTypes, pmsBuiRooms, pmsBuiOrders, pmsBuiPricingCalendar, pmsBuiCustomers, pmsBuiMiniStoreConfig } from '../../db/schema/index.js';
import { enumerateNights, calcNightlyPrices, buildOverrideMap } from '../../utils/mini-price.js';
import { OCCUPYING_STATUSES } from '../../utils/mini-availability.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { getDiscountRate, applyMemberDiscount } from '../../utils/member-price.js';

const route = new Hono();

const querySchema = z.object({
  storeId: z.string().min(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// 房型列表：给定日期区间，返回每个房型的总价与剩余可订数
route.get('/', async (c) => {
  const parsed = querySchema.safeParse({
    storeId: c.req.query('storeId'),
    checkIn: c.req.query('checkIn'),
    checkOut: c.req.query('checkOut'),
  });
  if (!parsed.success) return c.json({ success: false, error: '参数错误：storeId/checkIn/checkOut 必填' }, 400);
  const { storeId, checkIn, checkOut } = parsed.data;

  const nights = enumerateNights(checkIn, checkOut);
  if (nights.length === 0) return c.json({ success: false, error: '退房日期必须晚于入住日期' }, 400);

  const roomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')));
  const rooms = await db.select({ id: pmsBuiRooms.id, roomTypeId: pmsBuiRooms.roomTypeId })
    .from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId));
  // 与查询区间重叠的占用订单
  const occupying = await db.select({ roomTypeId: pmsBuiOrders.roomTypeId })
    .from(pmsBuiOrders)
    .where(and(
      eq(pmsBuiOrders.storeId, storeId),
      inArray(pmsBuiOrders.status, OCCUPYING_STATUSES),
      sql`${pmsBuiOrders.checkIn} < ${checkOut}`,
      sql`${pmsBuiOrders.checkOut} > ${checkIn}`,
    ));
  const calendarRows = await db.select({ date: pmsBuiPricingCalendar.date, roomTypes: pmsBuiPricingCalendar.roomTypes })
    .from(pmsBuiPricingCalendar)
    .where(and(
      eq(pmsBuiPricingCalendar.storeId, storeId),
      gte(pmsBuiPricingCalendar.date, nights[0]),
      lte(pmsBuiPricingCalendar.date, nights[nights.length - 1]),
    ));

  const countByType = (arr: { roomTypeId: string | null }[]) =>
    arr.reduce<Record<string, number>>((acc, r) => {
      if (r.roomTypeId) acc[r.roomTypeId] = (acc[r.roomTypeId] || 0) + 1;
      return acc;
    }, {});
  const totalByType = countByType(rooms);
  const occupiedByType = countByType(occupying);

  // 会员价：查当前用户在该门店的等级与折扣率
  const miniUserId = (() => { try { return getMiniUser(c).miniUserId; } catch { return undefined; } })();
  let discountRate = 100;
  let memberLevel = '';
  if (miniUserId) {
    const [customer] = await db.select({ memberLevel: pmsBuiCustomers.memberLevel })
      .from(pmsBuiCustomers)
      .where(and(eq(pmsBuiCustomers.storeId, storeId), eq(pmsBuiCustomers.miniUserId, miniUserId)))
      .limit(1);
    if (customer && customer.memberLevel !== 'regular') {
      const [cfg] = await db.select({ memberDiscounts: pmsBuiMiniStoreConfig.memberDiscounts })
        .from(pmsBuiMiniStoreConfig).where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1);
      discountRate = getDiscountRate(customer.memberLevel, cfg?.memberDiscounts as any);
      if (discountRate < 100) memberLevel = customer.memberLevel;
    }
  }

  const data = roomTypes.map((rt) => {
    const overrides = buildOverrideMap(calendarRows, rt);
    const nightly = calcNightlyPrices(nights, overrides, rt);
    const totalPrice = nightly.reduce((s, n) => s + n.price, 0);
    const realRemaining = Math.max(0, (totalByType[rt.id] || 0) - (occupiedByType[rt.id] || 0));
    const remaining = 0; // TODO: 日历房功能启动后改为 realRemaining
    return {
      id: rt.id,
      name: rt.name,
      images: rt.images ?? [],
      nights: nightly,
      totalPrice,        // 元
      remaining,
      available: false, // TODO: 日历房功能启动后改为 realRemaining > 0
      memberLevel: memberLevel || undefined,
      memberPrice: memberLevel ? applyMemberDiscount(nightly, discountRate) : undefined,
    };
  });

  return c.json({ success: true, data: { checkIn, checkOut, nightCount: nights.length, roomTypes: data } });
});

// 日历可用性：返回某月每天的总可订间数（必须在 /:id 之前注册，否则 /calendar 被 :id 拦截）
route.get('/calendar', async (c) => {
  const storeId = c.req.query('storeId');
  const month = c.req.query('month'); // YYYY-MM
  if (!storeId || !month) return c.json({ success: false, error: '缺少 storeId 或 month' }, 400);

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days: { date: string; available: number }[] = [];

  const roomTypes = await db.select({ id: pmsBuiRoomTypes.id })
    .from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')));
  const roomTypeIds = roomTypes.map(rt => rt.id);
  if (roomTypeIds.length === 0) {
    for (let d = 1; d <= daysInMonth; d++) days.push({ date: `${month}-${String(d).padStart(2, '0')}`, available: 0 });
    return c.json({ success: true, data: { month, days } });
  }

  const rooms = await db.select({ id: pmsBuiRooms.id, roomTypeId: pmsBuiRooms.roomTypeId })
    .from(pmsBuiRooms).where(and(eq(pmsBuiRooms.storeId, storeId), inArray(pmsBuiRooms.roomTypeId, roomTypeIds)));
  const totalByType: Record<string, number> = {};
  rooms.forEach(r => { if (r.roomTypeId) totalByType[r.roomTypeId] = (totalByType[r.roomTypeId] || 0) + 1; });

  const today = new Date().toISOString().slice(0, 10);

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (date < today) { days.push({ date, available: 0 }); continue; }

    const occupying = await db.select({ id: pmsBuiOrders.id, roomTypeId: pmsBuiOrders.roomTypeId })
      .from(pmsBuiOrders)
      .where(and(
        eq(pmsBuiOrders.storeId, storeId),
        inArray(pmsBuiOrders.roomTypeId, roomTypeIds),
        inArray(pmsBuiOrders.status, OCCUPYING_STATUSES),
        sql`${pmsBuiOrders.checkIn} < (${date}::date + interval '1 day')::text`,
        sql`${pmsBuiOrders.checkOut} > ${date}`,
      ));

    const occupied: Record<string, number> = {};
    occupying.forEach(o => { if (o.roomTypeId) occupied[o.roomTypeId] = (occupied[o.roomTypeId] || 0) + 1; });

    let available = 0;
    for (const rtId of roomTypeIds) {
      available += Math.max(0, (totalByType[rtId] || 0) - (occupied[rtId] || 0));
    }
    days.push({ date, available });
  }

  return c.json({ success: true, data: { month, days } });
});

// 无日期房型基础列表：门店首页「房型介绍」用（不含价格/日历/可用性，必须在 /:id 之前注册）
route.get('/list', async (c) => {
  const storeId = c.req.query('storeId') || '';
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);
  const roomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')));
  return c.json({
    success: true,
    data: {
      roomTypes: roomTypes.map((r) => ({
        id: r.id,
        name: r.name,
        images: r.images ?? [],
        bedType: r.bedType,
        area: r.area,
        maxGuests: r.maxGuests,
        facilities: r.facilities ?? [],
      })),
    },
  });
});

// 单房型详情：给定房型 ID + 日期区间，返回完整价格与可订信息（必须在 /calendar、/list 之后）
route.get('/:id', async (c) => {
  const roomTypeId = c.req.param('id');
  const storeId = c.req.query('storeId');
  const checkIn = c.req.query('checkIn');
  const checkOut = c.req.query('checkOut');

  if (!storeId || !checkIn || !checkOut) return c.json({ success: false, error: '缺少 storeId/checkIn/checkOut' }, 400);
  const nights = enumerateNights(checkIn, checkOut);
  if (nights.length === 0) return c.json({ success: false, error: '退房日期必须晚于入住日期' }, 400);

  const [roomType] = await db.select().from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.id, roomTypeId), eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')))
    .limit(1);
  if (!roomType) return c.json({ success: false, error: '房型不存在' }, 404);

  const rooms = await db.select({ id: pmsBuiRooms.id }).from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.storeId, storeId), eq(pmsBuiRooms.roomTypeId, roomTypeId)));
  const occupying = await db.select({ id: pmsBuiOrders.id }).from(pmsBuiOrders)
    .where(and(
      eq(pmsBuiOrders.storeId, storeId), eq(pmsBuiOrders.roomTypeId, roomTypeId),
      inArray(pmsBuiOrders.status, OCCUPYING_STATUSES),
      sql`${pmsBuiOrders.checkIn} < ${checkOut}`,
      sql`${pmsBuiOrders.checkOut} > ${checkIn}`,
    ));
  const calendarRows = await db.select({ date: pmsBuiPricingCalendar.date, roomTypes: pmsBuiPricingCalendar.roomTypes })
    .from(pmsBuiPricingCalendar)
    .where(and(eq(pmsBuiPricingCalendar.storeId, storeId),
      sql`${pmsBuiPricingCalendar.date} >= ${nights[0]}`,
      sql`${pmsBuiPricingCalendar.date} <= ${nights[nights.length - 1]}`));

  const overrides = buildOverrideMap(calendarRows, roomType);
  const nightly = calcNightlyPrices(nights, overrides, roomType);
  const totalPrice = nightly.reduce((s, n) => s + n.price, 0);
  const realRemaining = Math.max(0, rooms.length - occupying.length);
  const remaining = 0; // TODO: 日历房功能启动后改为 realRemaining

  // 会员价
  let memberPrice: any = undefined;
  let memberLevel: string | undefined;
  const miniUserId = (() => { try { return getMiniUser(c).miniUserId; } catch { return undefined; } })();
  if (miniUserId) {
    const [customer] = await db.select({ memberLevel: pmsBuiCustomers.memberLevel })
      .from(pmsBuiCustomers).where(and(eq(pmsBuiCustomers.storeId, storeId), eq(pmsBuiCustomers.miniUserId, miniUserId))).limit(1);
    if (customer && customer.memberLevel !== 'regular') {
      const [cfg] = await db.select({ memberDiscounts: pmsBuiMiniStoreConfig.memberDiscounts })
        .from(pmsBuiMiniStoreConfig).where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1);
      const rate = getDiscountRate(customer.memberLevel, cfg?.memberDiscounts as any);
      if (rate < 100) { memberLevel = customer.memberLevel; memberPrice = applyMemberDiscount(nightly, rate); }
    }
  }

  return c.json({ success: true, data: {
    id: roomType.id, name: roomType.name,
    images: (roomType as any).images ?? [],
    bedType: (roomType as any).bedType, area: (roomType as any).area, maxGuests: (roomType as any).maxGuests,
    nights: nightly, totalPrice, remaining, available: false, // TODO: 日历房功能启动后改为 remaining > 0
    memberLevel, memberPrice,
  }});
});

export default route;
