import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index';
import { pmsBuiRooms, pmsBuiRoomTypes, pmsBuiOrders, pmsBuiStores, pmsBuiCustomers } from '../db/schema';
import { eq, and, or, sql, desc } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { getTenantScope, tenantWhere } from '../utils/tenant';

const route = new Hono();

route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const type = c.req.query('type');
  const date = c.req.query('date');
  const year = c.req.query('year');
  const month = c.req.query('month');

  if (type === 'daily') {
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Get all rooms with tenant filtering
    const rooms = await db.select().from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));

    // Get active orders for this date to enrich room data
    const activeOrders = await db.select().from(pmsBuiOrders).where(
      and(
        ...tenantWhere(scope, pmsBuiOrders),
        sql`${pmsBuiOrders.checkIn} <= ${targetDate}`,
        sql`${pmsBuiOrders.checkOut} > ${targetDate}`,
        sql`${pmsBuiOrders.status} IN ('checked_in', 'confirmed')`
      )
    );

    const orderMap = Object.fromEntries(activeOrders.map(o => [o.roomNumber, o]));

    const enrichedRooms = rooms.map(r => {
      const order = orderMap[r.roomNumber || ''];
      // 根据订单日期范围推断房间在该日期的实际状态
      let effectiveStatus = r.status || 'available';
      if (order) {
        // 有订单覆盖该日期 → 根据订单状态判断
        effectiveStatus = order.status === 'checked_in' ? 'occupied' : 'booked';
      }
      return {
        ...r,
        status: effectiveStatus,
        guest: r.guestName || order?.guestName || undefined,
        guestPhone: r.guestPhone || order?.guestPhone || undefined,
        checkIn: r.checkInDate || order?.checkIn || undefined,
        checkOut: r.checkOutDate || order?.checkOut || undefined,
        orderNo: r.bookingId || order?.orderNo || undefined,
        source: order?.channel || undefined,
        price: r.price || order?.totalPrice || 0,
      };
    });

    const statusCounts: Record<string, number> = {};
    enrichedRooms.forEach(r => {
      statusCounts[r.status || 'available'] = (statusCounts[r.status || 'available'] || 0) + 1;
    });

    // 修复 floor 排序: 数字优先，字符串兜底
    const floors = [...new Set(enrichedRooms.map(r => r.floor).filter(Boolean))].sort((a, b) => {
      const na = parseInt(String(a)); const nb = parseInt(String(b));
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a || '').localeCompare(String(b || ''));
    });
    const total = enrichedRooms.length;

    return c.json({
      date: targetDate,
      rooms: enrichedRooms,
      floors,
      summary: {
        total,
        available: statusCounts['available'] || 0,
        booked: statusCounts['booked'] || 0,
        occupied: statusCounts['occupied'] || 0,
        dirty: statusCounts['dirty'] || 0,
        maintenance: statusCounts['maintenance'] || 0,
        locked: statusCounts['locked'] || 0,
        occupancyRate: total > 0 ? Math.round(((statusCounts['occupied'] || 0) + (statusCounts['booked'] || 0)) / total * 100) : 0,
      },
    });
  }

  if (type === 'monthly') {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const startDate = c.req.query('start'); // 滚动窗口起始日

    let rangeStart: Date, rangeEnd: Date;
    if (startDate) {
      rangeStart = new Date(startDate);
      const days = parseInt(c.req.query('days') || '30');
      rangeEnd = new Date(rangeStart); rangeEnd.setDate(rangeEnd.getDate() + days - 1);
    } else {
      const targetYear = year ? parseInt(year) : now.getFullYear();
      const targetMonth = month ? parseInt(month) - 1 : now.getMonth();
      rangeStart = new Date(targetYear, targetMonth, 1);
      rangeEnd = new Date(targetYear, targetMonth + 1, 0);
    }

    const daysInRange = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / 86400000) + 1;
    const rangeStartStr = rangeStart.toISOString().split('T')[0];
    const rangeEndStr = rangeEnd.toISOString().split('T')[0];

    const roomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
    const allRooms = await db.select().from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));
    const actualRoomCounts: Record<string, number> = {};
    allRooms.forEach(r => { actualRoomCounts[r.roomTypeId] = (actualRoomCounts[r.roomTypeId] || 0) + 1; });

    const rangeOrders = await db.select().from(pmsBuiOrders).where(
      and(
        ...tenantWhere(scope, pmsBuiOrders),
        sql`${pmsBuiOrders.checkIn} <= ${rangeEndStr}`,
        sql`${pmsBuiOrders.checkOut} >= ${rangeStartStr}`,
        sql`${pmsBuiOrders.status} IN ('checked_in', 'confirmed', 'checked_out')`
      )
    );

    const summary = roomTypes.map(rt => {
      const totalForType = actualRoomCounts[rt.id] || 0;
      const dailyStatus = [];
      for (let d = 0; d < daysInRange; d++) {
        const dateObj = new Date(rangeStart); dateObj.setDate(dateObj.getDate() + d);
        const dateStr = dateObj.toISOString().split('T')[0];
        const dayOfWeek = dateObj.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isPast = dateStr < todayStr;
        const isToday = dateStr === todayStr;

        const dayOccupied = rangeOrders.filter(o =>
          o.roomType === rt.name && o.checkIn <= dateStr && o.checkOut > dateStr
        ).length;

        dailyStatus.push({
          date: dateStr, day: d, total: totalForType,
          occupied: dayOccupied,
          available: totalForType - dayOccupied,
          booked: 0,
          blocked: 0,
          isWeekend, isPast, isToday,
        });
      }

      return {
        roomTypeId: rt.id,
        roomTypeName: rt.name,
        totalRooms: totalForType,
        basePrice: rt.basePrice,
        dailyStatus,
      };
    });

    const totalRooms = summary.reduce((acc, rt) => acc + rt.totalRooms, 0);
    const todayData = summary.map(rt => rt.dailyStatus.find(d => d.date === todayStr));
    const todayOccupied = todayData.reduce((acc, d) => acc + (d?.occupied || 0), 0);
    const totalOccupied = summary.reduce((acc, rt) => acc + rt.dailyStatus.reduce((s, d) => s + d.occupied, 0), 0);
    const avgOcc = totalRooms > 0 && daysInRange > 0
      ? Math.round((totalOccupied / (totalRooms * daysInRange)) * 100)
      : 0;

    return c.json({
      year: rangeStart.getFullYear(),
      month: rangeStart.getMonth() + 1,
      daysInMonth: daysInRange,
      roomTypes: summary,
      monthSummary: {
        totalRooms,
        todayOccupied,
        todayBooked: 0,
        todayAvailable: totalRooms - todayOccupied,
        todayOccupancyRate: totalRooms > 0 ? Math.round(todayOccupied / totalRooms * 100) : 0,
        avgOccupancyRate: avgOcc,
      },
    });
  }

  if (type === 'bookings') {
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Get all rooms with tenant filtering
    const rooms = await db.select().from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));
    const availableRooms = rooms.filter(r => r.status === 'available');
    const bookedRooms = rooms.filter(r => r.status === 'booked');

    // Get channel orders for this date with tenant filtering
    const channelOrders = await db.select().from(pmsBuiOrders).where(
      and(
        ...tenantWhere(scope, pmsBuiOrders),
        sql`${pmsBuiOrders.status} IN ('pending', 'confirmed')`,
        sql`${pmsBuiOrders.checkIn} >= ${targetDate}`
      )
    );

    const preBookings = bookedRooms.map(r => ({
      id: r.id,
      roomNumber: r.roomNumber,
      roomTypeName: r.roomTypeName || '',
      floor: r.floor,
      price: r.price || 0,
      source: 'booking' as const,
      channelLabel: '预定',
    }));

    const walkInRooms = availableRooms.map(r => ({
      id: r.id,
      roomNumber: r.roomNumber,
      roomTypeName: r.roomTypeName || '',
      floor: r.floor,
      price: r.price || 0,
      source: 'walkin' as const,
      channelLabel: '散客',
    }));

    return c.json({
      date: targetDate,
      preBookings,
      channelOrders: channelOrders.map(o => ({ ...o, source: 'channel', channelLabel: o.channel })),
      walkInRooms,
      summary: {
        preBookingCount: preBookings.length,
        channelOrderCount: channelOrders.length,
        walkInCount: walkInRooms.length,
      },
    });
  }

  // Default: return daily room status with tenant filtering
  const rooms = await db.select().from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));
  return c.json(rooms);
});

// Zod 请求体验证 schema
const roomsActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('updateRoomStatus'),
    roomId: z.string().min(1, '房间ID不能为空'),
    status: z.string().min(1, '状态不能为空'),
  }),
  z.object({
    action: z.literal('batchUpdateStatus'),
    roomIds: z.array(z.string()).min(1, '房间ID列表不能为空'),
    status: z.string().min(1, '状态不能为空'),
  }),
  z.object({
    action: z.literal('checkIn'),
    roomId: z.string().min(1, '房间ID不能为空'),
    guestName: z.string().min(1, '客人姓名不能为空'),
    guestPhone: z.string().optional(),
    checkInDate: z.string().optional(),
    checkOutDate: z.string().optional(),
    deposit: z.number().optional(),
    remark: z.string().optional(),
    guestCount: z.number().optional(),
    paymentMethod: z.string().optional(),
    source: z.string().optional(),
    guestIdCard: z.string().optional(),
    bookingRef: z.string().optional(),
    createOrder: z.boolean().optional(),
    multiGuests: z.array(z.record(z.string(), z.any())).optional(),
  }),
  z.object({
    action: z.literal('checkOut'),
    roomId: z.string().min(1, '房间ID不能为空'),
    extraCharges: z.number().optional(),
    refundMethod: z.string().optional(),
    checkoutMode: z.string().optional(),
    invoiceNeeded: z.boolean().optional(),
    invoiceType: z.string().optional(),
    invoiceTitle: z.string().optional(),
    invoiceTaxId: z.string().optional(),
    checkoutItems: z.array(z.record(z.string(), z.any())).optional(),
    remark: z.string().optional(),
  }),
  z.object({
    action: z.literal('book'),
    roomId: z.string().min(1, '房间ID不能为空'),
    guestName: z.string().min(1, '客人姓名不能为空'),
    guestPhone: z.string().optional(),
    checkInDate: z.string().optional(),
    checkOutDate: z.string().optional(),
    remark: z.string().optional(),
  }),
  z.object({
    action: z.literal('lock'),
    roomId: z.string().min(1, '房间ID不能为空'),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('unlock'),
    roomId: z.string().min(1, '房间ID不能为空'),
  }),
  z.object({
    action: z.literal('extendStay'),
    roomId: z.string().min(1, '房间ID不能为空'),
    checkOutDate: z.string().min(1, '新房期不能为空'),
  }),
  z.object({
    action: z.literal('changeRoom'),
    fromRoomId: z.string().min(1, '源房间ID不能为空'),
    toRoomId: z.string().min(1, '目标房间ID不能为空'),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('cancelBook'),
    roomId: z.string().min(1, '房间ID不能为空'),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('modifyBook'),
    roomId: z.string().min(1, '房间ID不能为空'),
    guestName: z.string().optional(),
    guestPhone: z.string().optional(),
    checkInDate: z.string().optional(),
    checkOutDate: z.string().optional(),
  }),
  z.object({
    action: z.literal('markClean'),
    roomId: z.string().min(1, '房间ID不能为空'),
  }),
  z.object({
    action: z.literal('markDirty'),
    roomId: z.string().min(1, '房间ID不能为空'),
  }),
  z.object({
    action: z.literal('setMaintenance'),
    roomId: z.string().min(1, '房间ID不能为空'),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('restoreAvailable'),
    roomId: z.string().min(1, '房间ID不能为空'),
  }),
]);

// POST: Room operations
route.post('/', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const validation = await validateBody(body, roomsActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;

  // Update room status (generic)
  if (data.action === 'updateRoomStatus') {
    const { roomId, status } = data;
    await db.update(pmsBuiRooms).set({ status, updatedAt: new Date() } as any)
      .where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '状态已更新' });
  }

  // Batch update status
  if (data.action === 'batchUpdateStatus') {
    const { roomIds, status } = data;
    for (const roomId of roomIds) {
      await db.update(pmsBuiRooms).set({ status, updatedAt: new Date() } as any)
        .where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    }
    return c.json({ success: true, message: '批量更新成功' });
  }

  // Check-in: 入住 — 支持多人入住、自动创建订单
  if (data.action === 'checkIn') {
    const {
      roomId, guestName, guestPhone, checkInDate, checkOutDate,
      deposit, remark, guestCount, paymentMethod, source,
      guestIdCard, bookingRef, createOrder, multiGuests,
    } = data;
    const now = new Date();
    const orderNo = `ORD${Date.now().toString().slice(-8)}`;
    const checkIn = checkInDate || now.toISOString().split('T')[0];

    const [room] = await db.select().from(pmsBuiRooms).where(
      and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms))
    );
    if (!room) return c.json({ success: false, error: '房间不存在' }, 400);

    await db.update(pmsBuiRooms).set({
      status: 'occupied',
      guestName,
      guestPhone,
      checkInDate: checkIn,
      checkOutDate: checkOutDate || null,
      bookingId: orderNo,
      lockReason: null,
      updatedAt: now,
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));

    // 自动创建/更新客户档案
    const guestPhoneStr = guestPhone || '';
    const guestNameStr = guestName || '';
    if (guestPhoneStr) {
      const [existingCustomer] = await db.select().from(pmsBuiCustomers)
        .where(and(eq(pmsBuiCustomers.phone, guestPhoneStr), ...tenantWhere(scope, pmsBuiCustomers)))
        .limit(1);
      if (existingCustomer) {
        // 老客户：更新消费记录
        await db.update(pmsBuiCustomers).set({
          lastStayDate: checkIn,
          stayCount: (existingCustomer.stayCount || 0) + 1,
          totalSpent: (existingCustomer.totalSpent || 0) + (room.price || 0),
          updatedAt: new Date(),
        } as any).where(eq(pmsBuiCustomers.id, existingCustomer.id));
      } else if (guestNameStr) {
        // 新客户：自动创建档案
        const custNow = new Date();
        await db.insert(pmsBuiCustomers).values({
          id: `cust_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
          merchantId: scope.merchantId,
          storeId: room.storeId || (scope.storeId === '*' ? 'default_store' : scope.storeId),
          name: guestNameStr,
          phone: guestPhoneStr,
          gender: '',
          birthday: '',
          source: source || 'walk-in',
          memberLevel: 'regular',
          tags: [source || 'walk-in'],
          totalSpent: room.price || 0,
          stayCount: 1,
          lastStayDate: checkIn,
          valueScore: 30,
          createdAt: custNow,
          updatedAt: custNow,
        } as any);
      }
    }

    // 自动创建订单 — storeId 从 room 表获取，确认字段名正确
    if (createOrder !== false) {
      await db.insert(pmsBuiOrders).values({
        id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        orderNo,
        channel: '自来客',
        guestName,
        guestPhone: guestPhone || '',
        checkIn,
        checkOut: checkOutDate || '',
        roomType: room.roomTypeName || '',
        roomTypeId: room.roomTypeId || '',
        roomNumber: room.roomNumber || '',
        roomId: room.id || '',
        merchantId: scope.merchantId,
        totalPrice: room.price || 0,
        status: 'checked_in',
        paymentStatus: 'paid',
        storeId: room.storeId || scope.storeId,
        createdAt: now,
      } as any);
    }

    return c.json({
      success: true, message: '入住成功', orderNo,
      data: { orderNo, roomId, guestName, roomNumber: room.roomNumber, checkIn },
    });
  }

  // Check-out: 退房 — 支持附加费用、退房模式、账单处理
  if (data.action === 'checkOut') {
    const {
      roomId, extraCharges, refundMethod, checkoutMode,
      invoiceNeeded, invoiceType, invoiceTitle, invoiceTaxId,
      checkoutItems, remark: checkoutRemark,
    } = data;
    const now = new Date();

    const [room] = await db.select().from(pmsBuiRooms).where(
      and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms))
    );
    if (!room) return c.json({ success: false, error: '房间不存在' }, 400);

    await db.update(pmsBuiRooms).set({
      status: 'dirty',
      guestName: null,
      guestPhone: null,
      checkInDate: null,
      checkOutDate: null,
      lockReason: null,
      updatedAt: now,
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));

    // 修复: 关联订单匹配 — 用 room.bookingId 匹配 orderNo，再按 roomId/roomNumber 兜底
    const [order] = await db.select().from(pmsBuiOrders).where(
      and(
        or(
          eq(pmsBuiOrders.orderNo, room.bookingId || ''),
          eq(pmsBuiOrders.roomId, room.id),
          eq(pmsBuiOrders.roomNumber, room.roomNumber || '')
        ),
        ...tenantWhere(scope, pmsBuiOrders)
      )
    );
    if (order) {
      await db.update(pmsBuiOrders).set({
        status: 'checked_out',
        checkOut: now.toISOString().split('T')[0],
      } as any).where(eq(pmsBuiOrders.id, order.id));
    }

    return c.json({
      success: true, message: '退房成功',
      data: { roomId, roomNumber: room.roomNumber, checkoutMode: checkoutMode || 'normal', checkoutTime: now.toISOString() },
    });
  }

  // Book room: set room to booked with guest info
  if (data.action === 'book') {
    const { roomId, guestName, guestPhone, checkInDate, checkOutDate, remark } = data;
    const orderNo = `BK${Date.now().toString().slice(-8)}`;
    await db.update(pmsBuiRooms).set({
      status: 'booked',
      guestName,
      guestPhone,
      checkInDate,
      checkOutDate,
      bookingId: orderNo,
      lockReason: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '预订成功', orderNo });
  }

  // Lock room
  if (data.action === 'lock') {
    const { roomId, reason } = data;
    await db.update(pmsBuiRooms).set({
      status: 'locked',
      lockReason: reason || null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '锁房成功' });
  }

  // Unlock room
  if (data.action === 'unlock') {
    const { roomId } = data;
    await db.update(pmsBuiRooms).set({
      status: 'available',
      lockReason: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '解锁成功' });
  }

  // Extend stay：更新房间离店日期 + 关联订单离店日期和金额
  if (data.action === 'extendStay') {
    const { roomId, checkOutDate } = data;

    // 获取当前房间信息
    const [room] = await db.select().from(pmsBuiRooms).where(
      and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms))
    );
    if (!room) return c.json({ success: false, error: '房间不存在' }, 400);

    const oldCheckOut = room.checkOutDate;
    const pricePerNight = room.price || 0;

    // 计算续住天数和额外费用
    let extraNights = 0, extraAmount = 0;
    if (oldCheckOut) {
      const d1 = new Date(oldCheckOut).getTime();
      const d2 = new Date(checkOutDate).getTime();
      extraNights = Math.max(0, Math.round((d2 - d1) / 86400000));
      extraAmount = extraNights * pricePerNight;
    }

    // 更新房间离店日期
    await db.update(pmsBuiRooms).set({
      checkOutDate,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));

    // 更新关联订单（通过 bookingId/orderNo 匹配）
    if (room.bookingId) {
      const [order] = await db.select().from(pmsBuiOrders).where(
        and(eq(pmsBuiOrders.orderNo, room.bookingId), ...tenantWhere(scope, pmsBuiOrders))
      );
      if (order) {
        const newTotal = (order.totalPrice || 0) + extraAmount;
        const newNights = (order.nights || 0) + extraNights;
        await db.update(pmsBuiOrders).set({
          checkOut: checkOutDate,
          nights: newNights,
          totalPrice: newTotal,
          totalAmount: newTotal,
          updatedAt: new Date(),
        } as any).where(eq(pmsBuiOrders.id, order.id));
      }
    }

    return c.json({
      success: true, message: '续住成功',
      data: { roomId, checkOutDate, extraNights, extraAmount },
    });
  }

  // Change room
  if (data.action === 'changeRoom') {
    const { fromRoomId, toRoomId, reason } = data;

    // Get source room info
    const [sourceRoom] = await db.select().from(pmsBuiRooms).where(
      and(eq(pmsBuiRooms.id, fromRoomId), ...tenantWhere(scope, pmsBuiRooms))
    );
    if (!sourceRoom) return c.json({ success: false, error: '源房间不存在' }, 400);

    // 修复: 检查目标房间状态
    const [toRoom] = await db.select().from(pmsBuiRooms).where(
      and(eq(pmsBuiRooms.id, toRoomId), ...tenantWhere(scope, pmsBuiRooms))
    );
    if (!toRoom) return c.json({ success: false, error: '目标房间不存在' }, 400);
    if (toRoom.status === 'occupied') return c.json({ success: false, error: '目标房间已有人入住' }, 400);
    if (toRoom.status === 'maintenance') return c.json({ success: false, error: '目标房间维修中' }, 400);

    // Move guest to target room
    await db.update(pmsBuiRooms).set({
      status: 'occupied',
      guestName: sourceRoom.guestName,
      guestPhone: sourceRoom.guestPhone,
      checkInDate: sourceRoom.checkInDate,
      checkOutDate: sourceRoom.checkOutDate,
      bookingId: sourceRoom.bookingId,
      lockReason: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, toRoomId), ...tenantWhere(scope, pmsBuiRooms)));

    // Free source room
    await db.update(pmsBuiRooms).set({
      status: 'dirty',
      guestName: null,
      guestPhone: null,
      checkInDate: null,
      checkOutDate: null,
      bookingId: null,
      lockReason: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, fromRoomId), ...tenantWhere(scope, pmsBuiRooms)));

    return c.json({ success: true, message: '换房成功' });
  }

  // Cancel booking
  if (data.action === 'cancelBook') {
    const { roomId, reason } = data;
    await db.update(pmsBuiRooms).set({
      status: 'available',
      guestName: null,
      guestPhone: null,
      checkInDate: null,
      checkOutDate: null,
      bookingId: null,
      lockReason: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '预订已取消' });
  }

  // Modify booking
  if (data.action === 'modifyBook') {
    const { roomId, guestName, guestPhone, checkInDate, checkOutDate } = data;
    await db.update(pmsBuiRooms).set({
      guestName,
      guestPhone,
      checkInDate,
      checkOutDate,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '修改成功' });
  }

  // Mark clean (dirty → available)
  if (data.action === 'markClean') {
    const { roomId } = data;
    await db.update(pmsBuiRooms).set({
      status: 'available',
      guestName: null,
      guestPhone: null,
      checkInDate: null,
      checkOutDate: null,
      bookingId: null,
      dirtyType: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '已标记为干净' });
  }
  if (data.action === 'markDirty') {
    await db.update(pmsBuiRooms).set({ status: 'dirty' } as any).where(eq(pmsBuiRooms.id, data.roomId));
    return c.json({ success: true, message: '已设为脏房' });
  }

  // Set maintenance
  if (data.action === 'setMaintenance') {
    const { roomId, reason } = data;
    await db.update(pmsBuiRooms).set({
      status: 'maintenance',
      lockReason: reason || '维修中',
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '已标记为维修' });
  }

  // Restore to available
  if (data.action === 'restoreAvailable') {
    const { roomId } = data;
    await db.update(pmsBuiRooms).set({
      status: 'available',
      guestName: null,
      guestPhone: null,
      checkInDate: null,
      checkOutDate: null,
      bookingId: null,
      lockReason: null,
      dirtyType: null,
      updatedAt: new Date(),
    } as any).where(and(eq(pmsBuiRooms.id, roomId), ...tenantWhere(scope, pmsBuiRooms)));
    return c.json({ success: true, message: '已恢复为可用' });
  }

  return c.json({ success: true });
});

export default route;
