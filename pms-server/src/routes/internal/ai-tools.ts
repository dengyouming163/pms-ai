import { Hono } from 'hono';
import { db } from '../../db/index.js';
import {
  pmsBuiRooms, pmsBuiRoomTypes, pmsBuiOrders, pmsBuiCustomers,
  pmsBuiStores, pmsBuiChannels, pmsBuiTransactions,
} from '../../db/schema/index.js';
import { eq, and, sql, desc, or, like, not, type SQL } from 'drizzle-orm';

const tools = new Hono();

function getScope(c: any) {
  return {
    merchantId: c.req.header('X-Merchant-Id') || 'default',
    storeId: c.req.header('X-Store-Id') || 'default_store',
  };
}

function tenantConditions(scope: { merchantId: string; storeId: string }, table: any): SQL[] {
  const conditions: SQL[] = [];
  if ('merchantId' in table) {
    conditions.push(eq(table.merchantId, scope.merchantId));
  }
  if (scope.storeId && scope.storeId !== '*' && 'storeId' in table) {
    conditions.push(eq(table.storeId, scope.storeId));
  }
  return conditions;
}

// ====== 读工具 ======

// --- 房态 ---
tools.get('/rooms/status', async (c) => {
  const scope = getScope(c);
  const date = c.req.query('date') || new Date().toISOString().slice(0, 10);
  const rooms = await db.select().from(pmsBuiRooms).where(and(...tenantConditions(scope, pmsBuiRooms)));
  const activeOrders = await db.select().from(pmsBuiOrders).where(
    and(
      ...tenantConditions(scope, pmsBuiOrders),
      sql`${pmsBuiOrders.checkIn} <= ${date}`,
      sql`${pmsBuiOrders.checkOut} > ${date}`,
      sql`${pmsBuiOrders.status} IN ('checked_in', 'confirmed')`
    )
  );
  const orderMap: Record<string, any> = {};
  activeOrders.forEach(o => { if (o.roomNumber) orderMap[o.roomNumber] = o; });
  const enriched = rooms.map(r => ({
    ...r,
    hasGuest: !!orderMap[r.roomNumber],
    orderInfo: orderMap[r.roomNumber] ? {
      guestName: orderMap[r.roomNumber].guestName,
      checkIn: orderMap[r.roomNumber].checkIn,
      checkOut: orderMap[r.roomNumber].checkOut,
      channel: orderMap[r.roomNumber].channel,
    } : null,
  }));
  const statusCounts: Record<string, number> = {};
  enriched.forEach(r => { statusCounts[r.status] = (statusCounts[r.status] || 0) + 1; });
  return c.json({
    date, rooms: enriched,
    summary: {
      total: enriched.length,
      available: statusCounts['available'] || 0,
      occupied: statusCounts['occupied'] || 0,
      booked: statusCounts['booked'] || 0,
      dirty: statusCounts['dirty'] || 0,
      maintenance: statusCounts['maintenance'] || 0,
      occupancyRate: enriched.length > 0
        ? Math.round(((statusCounts['occupied'] || 0) + (statusCounts['booked'] || 0)) / enriched.length * 100) : 0,
    },
  });
});

tools.get('/rooms/housekeeping-queue', async (c) => {
  const scope = getScope(c);
  const dirtyRooms = await db.select().from(pmsBuiRooms).where(
    and(...tenantConditions(scope, pmsBuiRooms), eq(pmsBuiRooms.status, 'dirty'))
  );
  return c.json({ count: dirtyRooms.length, rooms: dirtyRooms });
});

// --- 订单 ---
tools.get('/orders', async (c) => {
  const scope = getScope(c);
  const status = c.req.query('status');
  const dateFrom = c.req.query('date_from');
  const dateTo = c.req.query('date_to');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const conditions: SQL[] = [...tenantConditions(scope, pmsBuiOrders)];
  if (status) conditions.push(eq(pmsBuiOrders.status, status));
  if (dateFrom) conditions.push(sql`${pmsBuiOrders.createdAt}::date >= ${dateFrom}::date`);
  if (dateTo) conditions.push(sql`${pmsBuiOrders.createdAt}::date <= ${dateTo}::date`);
  const whereClause = and(...conditions);
  const orders = await db.select().from(pmsBuiOrders).where(whereClause)
    .orderBy(desc(pmsBuiOrders.createdAt)).limit(limit).offset((page - 1) * limit);
  const countResult = await db.select({ count: sql`count(*)` }).from(pmsBuiOrders).where(whereClause);
  return c.json({ orders, pagination: { page, limit, total: Number(countResult[0].count) } });
});

tools.get('/orders/:id', async (c) => {
  const scope = getScope(c);
  const id = c.req.param('id');
  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, id), ...tenantConditions(scope, pmsBuiOrders))).limit(1);
  if (!order) return c.json({ error: '订单不存在' }, 404);
  return c.json(order);
});

// --- 客户 ---
tools.get('/customers/:id/profile', async (c) => {
  const scope = getScope(c);
  const id = c.req.param('id');
  const [customer] = await db.select().from(pmsBuiCustomers)
    .where(and(eq(pmsBuiCustomers.id, id), ...tenantConditions(scope, pmsBuiCustomers))).limit(1);
  if (!customer) return c.json({ error: '客户不存在' }, 404);
  const orders = await db.select().from(pmsBuiOrders)
    .where(and(...tenantConditions(scope, pmsBuiOrders), eq(pmsBuiOrders.guestPhone, customer.phone)))
    .orderBy(desc(pmsBuiOrders.createdAt)).limit(20);
  return c.json({ profile: customer, orderHistory: orders, orderCount: orders.length });
});

tools.get('/customers/search', async (c) => {
  const scope = getScope(c);
  const keyword = c.req.query('keyword') || '';
  if (keyword.length < 2) return c.json({ customers: [] });
  const customers = await db.select().from(pmsBuiCustomers).where(
    and(...tenantConditions(scope, pmsBuiCustomers),
      or(like(pmsBuiCustomers.name, `%${keyword}%`), like(pmsBuiCustomers.phone, `%${keyword}%`)))
  ).limit(20);
  return c.json({ customers });
});

// --- 客户统计 ---
tools.get('/customers/stats', async (c) => {
  const scope = getScope(c);
  const customers = await db.select().from(pmsBuiCustomers).where(and(...tenantConditions(scope, pmsBuiCustomers)));
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86400000).toISOString().split('T')[0];

  const newThisMonth = customers.filter(c => {
    const d = new Date(c.createdAt);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  }).length;

  const vipCount = customers.filter(c => c.memberLevel === 'diamond' || c.memberLevel === 'gold').length;

  const dormantCount = customers.filter(c => {
    if (!c.lastStayDate) return false;
    return c.lastStayDate < ninetyDaysAgo;
  }).length;

  const { pmsBuiCareReminders } = await import('../../db/schema/customers.js');
  const carePending = await db.select({ count: sql`count(*)` })
    .from(pmsBuiCareReminders)
    .where(and(...tenantConditions(scope, pmsBuiCareReminders), eq(pmsBuiCareReminders.status, 'pending')));

  return c.json({
    total: customers.length,
    vipCount,
    dormantCount,
    newThisMonth,
    carePending: Number(carePending[0].count),
  });
});

// --- 客户列表（分页） ---
tools.get('/customers', async (c) => {
  const scope = getScope(c);
  const keyword = c.req.query('keyword') || '';
  const level = c.req.query('level') || '';
  const tag = c.req.query('tag') || '';
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [...tenantConditions(scope, pmsBuiCustomers)];
  if (keyword) {
    conditions.push(or(
      like(pmsBuiCustomers.name, `%${keyword}%`),
      like(pmsBuiCustomers.phone, `%${keyword}%`),
    ) as SQL);
  }

  // 特殊处理："dormant" 表示超过90天未入住的客户，不是真实的会员等级
  let dormantFilter = false;
  if (level === 'dormant') {
    dormantFilter = true;
  } else if (level) {
    conditions.push(eq(pmsBuiCustomers.memberLevel, level));
  }

  const whereClause = and(...conditions);
  const countResult = await db.select({ count: sql`count(*)` }).from(pmsBuiCustomers).where(whereClause);
  const total = Number(countResult[0].count);

  let customers = await db.select().from(pmsBuiCustomers)
    .where(whereClause).orderBy(desc(pmsBuiCustomers.createdAt)).limit(limit).offset(offset);

  // 沉睡客户过滤：超过90天未入住
  if (dormantFilter) {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoff = ninetyDaysAgo.toISOString().split('T')[0];
    customers = customers.filter(c => !c.lastStayDate || c.lastStayDate < cutoff);
    return c.json({ customers: customers.map(c => ({ ...c, phone: c.phone ? c.phone.slice(0, 3) + '****' + c.phone.slice(7) : '' })), pagination: { page, limit, total: customers.length, totalPages: Math.ceil(customers.length / limit) } });
  }

  if (tag) {
    customers = customers.filter(c => {
      const tags: string[] = Array.isArray(c.tags) ? c.tags as string[] : [];
      return tags.includes(tag);
    });
    // 标签过滤后重新计算分页
    return c.json({ customers: customers.map(c => ({ ...c, phone: c.phone ? c.phone.slice(0, 3) + '****' + c.phone.slice(7) : '' })), pagination: { page, limit, total: customers.length, totalPages: Math.ceil(customers.length / limit) } });
  }

  return c.json({ customers: customers.map(c => ({ ...c, phone: c.phone ? c.phone.slice(0, 3) + '****' + c.phone.slice(7) : '' })), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// --- 运营日报 ---
tools.get('/ops/daily-briefing', async (c) => {
  const scope = getScope(c);
  const today = new Date().toISOString().split('T')[0];

  const rooms = await db.select().from(pmsBuiRooms).where(and(...tenantConditions(scope, pmsBuiRooms)));
  const todayCheckins = rooms.filter(r => r.checkInDate === today && r.status === 'booked');
  const todayCheckouts = rooms.filter(r => r.checkOutDate === today && r.status === 'occupied');
  const occupied = rooms.filter(r => r.status === 'occupied');
  const dirtyRooms = rooms.filter(r => r.status === 'dirty');
  const problemRooms = rooms.filter(r => r.status === 'maintenance' || r.status === 'locked');

  const { pmsBuiOrders } = await import('../../db/schema/orders.js');
  const urgentTime = new Date(Date.now() + 3600000);
  const otaPending = await db.select().from(pmsBuiOrders)
    .where(and(...tenantConditions(scope, pmsBuiOrders), eq(pmsBuiOrders.source, 'ota'), eq(pmsBuiOrders.status, 'pending_confirm'))); // 超时 OTA 单 = 待接单超时（新单状态为 pending_confirm）
  const overdueOrders = [...otaPending].filter(o => {
    if (!o.otaTimeout) return false;
    return new Date(o.otaTimeout).getTime() < urgentTime.getTime();
  });

  return c.json({
    todayCheckins: todayCheckins.map(r => ({ roomId: r.id, roomNumber: r.roomNumber, guestName: r.guestName, guestPhone: r.guestPhone, checkOutDate: r.checkOutDate })),
    todayCheckouts: todayCheckouts.map(r => ({ roomId: r.id, roomNumber: r.roomNumber, guestName: r.guestName })),
    occupiedRooms: occupied.map(r => ({ roomId: r.id, roomNumber: r.roomNumber, guestName: r.guestName, checkOutDate: r.checkOutDate })),
    dirtyRooms: dirtyRooms.map(r => ({ roomId: r.id, roomNumber: r.roomNumber, roomTypeName: r.roomTypeName })),
    problemRooms: problemRooms.map(r => ({ roomId: r.id, roomNumber: r.roomNumber, status: r.status, reason: r.lockReason || r.dirtyType })),
    overdueOrders: overdueOrders.map(o => ({ orderId: o.id, orderNo: o.orderNo, channel: o.channel, guestName: o.guestName, roomType: o.roomType, otaTimeout: o.otaTimeout ? new Date(o.otaTimeout).toISOString() : '' })),
    summary: {
      checkinCount: todayCheckins.length, checkoutCount: todayCheckouts.length,
      occupiedCount: occupied.length, dirtyCount: dirtyRooms.length,
      problemCount: problemRooms.length, overdueOrderCount: overdueOrders.length,
    },
  });
});

// --- 定价 ---
tools.get('/pricing/calendar', async (c) => {
  const scope = getScope(c);
  const from = c.req.query('from');
  const to = c.req.query('to');
  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantConditions(scope, pmsBuiRoomTypes)));
  return c.json({ roomTypes: roomTypes.map(rt => ({ id: rt.id, name: rt.name, basePrice: rt.basePrice, roomCount: rt.roomCount })) });
});

// --- 财务 ---
tools.get('/finance/summary', async (c) => {
  const scope = getScope(c);
  const period = c.req.query('period') || 'this_month';
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const monthOrders = await db.select().from(pmsBuiOrders).where(
    and(...tenantConditions(scope, pmsBuiOrders),
      sql`${pmsBuiOrders.createdAt}::date >= ${monthStart}::date`,
      sql`${pmsBuiOrders.status} != 'cancelled'`)
  );
  const revenue = monthOrders.reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  const today = now.toISOString().slice(0, 10);
  const todayOrders = monthOrders.filter(o => o.createdAt && new Date(o.createdAt).toISOString().slice(0, 10) === today);
  const todayRevenue = todayOrders.reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  return c.json({ period, monthRevenue: revenue, todayRevenue, orderCount: monthOrders.length, todayOrderCount: todayOrders.length });
});

// --- 渠道 ---
tools.get('/channels/stats', async (c) => {
  const scope = getScope(c);
  const channels = await db.select().from(pmsBuiChannels).where(and(...tenantConditions(scope, pmsBuiChannels)));
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const monthOrders = await db.select().from(pmsBuiOrders).where(
    and(...tenantConditions(scope, pmsBuiOrders), sql`${pmsBuiOrders.createdAt}::date >= ${monthStart}::date`)
  );
  const channelStats = channels.map(ch => ({
    name: ch.name, status: ch.status,
    orderCount: monthOrders.filter(o => o.channel === ch.name).length,
    revenue: monthOrders.filter(o => o.channel === ch.name).reduce((sum, o) => sum + Number(o.totalPrice || 0), 0),
  }));
  return c.json({ channels: channelStats });
});

// --- 经营 KPI ---
tools.get('/kpi/dashboard', async (c) => {
  const scope = getScope(c);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const rooms = await db.select().from(pmsBuiRooms).where(and(...tenantConditions(scope, pmsBuiRooms)));
  const totalRooms = rooms.length;
  const occupiedCount = rooms.filter(r => r.status === 'occupied').length;
  const todayOrders = await db.select().from(pmsBuiOrders).where(
    and(...tenantConditions(scope, pmsBuiOrders), sql`${pmsBuiOrders.createdAt}::date = ${todayStr}::date`)
  );
  const todayRevenue = todayOrders.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + Number(o.totalPrice || 0), 0);
  const stores = await db.select().from(pmsBuiStores).where(and(...tenantConditions(scope, pmsBuiStores)));
  const channels = await db.select().from(pmsBuiChannels).where(and(...tenantConditions(scope, pmsBuiChannels)));
  return c.json({
    todayRevenue,
    occupancyRate: totalRooms > 0 ? Math.round((occupiedCount / totalRooms) * 100) : 0,
    todayOrderCount: todayOrders.length,
    activeStoreCount: stores.filter(s => s.status === 'active').length,
    connectedChannelCount: channels.filter(ch => ch.status === 'connected').length,
    totalRooms,
  });
});

// --- Memory 端点 ---
tools.post('/memory/sync', async (c) => {
  const body = await c.req.json();
  const { pmsBuiAiMemory } = await import('../../db/schema/ai.js');
  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await db.insert(pmsBuiAiMemory).values({
    id,
    merchantId: body.merchant_id || 'default',
    userId: body.user_id || '',
    memoryType: body.memory_type,
    key: body.key,
    value: body.value,
    importance: String(body.importance || '0.50'),
    accessCount: 0,
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: [pmsBuiAiMemory.merchantId, pmsBuiAiMemory.key],
    set: { value: body.value, importance: String(body.importance || '0.50') },
  });

  return c.json({ success: true, id });
});

tools.get('/memory/load', async (c) => {
  const { pmsBuiAiMemory } = await import('../../db/schema/ai.js');
  const merchantId = c.req.query('merchant_id') || 'default';
  const memoryType = c.req.query('memory_type');
  const key = c.req.query('key');
  const limit = parseInt(c.req.query('limit') || '20');

  const conditions: any[] = [eq(pmsBuiAiMemory.merchantId, merchantId)];
  if (memoryType) conditions.push(eq(pmsBuiAiMemory.memoryType, memoryType));
  if (key) conditions.push(eq(pmsBuiAiMemory.key, key));

  const memories = await db.select().from(pmsBuiAiMemory)
    .where(and(...conditions))
    .orderBy(desc(pmsBuiAiMemory.importance))
    .limit(limit);

  for (const m of memories) {
    await db.update(pmsBuiAiMemory)
      .set({ accessCount: (m.accessCount || 0) + 1, lastAccessedAt: new Date() })
      .where(eq(pmsBuiAiMemory.id, m.id));
  }

  return c.json({ memories });
});

// ====== 写工具 ======

tools.post('/pricing/adjust', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { new_price, reason, action_level, room_type } = body;
  const [roomType] = await db.select().from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.name, room_type), ...tenantConditions(scope, pmsBuiRoomTypes)))
    .limit(1);
  if (!roomType) return c.json({ success: false, error: '房型不存在' }, 404);
  const oldPrice = roomType.basePrice || 0;
  const pctChange = oldPrice > 0 ? ((new_price - oldPrice) / oldPrice) * 100 : 0;
  if (Math.abs(pctChange) > 30) {
    return c.json({ success: false, error: `价格调整 ${pctChange.toFixed(1)}% 超出 ±30% 硬边界` }, 400);
  }
  await db.update(pmsBuiRoomTypes)
    .set({ basePrice: new_price, updatedAt: new Date() } as any)
    .where(eq(pmsBuiRoomTypes.id, roomType.id));
  return c.json({ success: true, data: { room_type: roomType.name, old_price: oldPrice, new_price, pct_change: Math.round(pctChange * 10) / 10 } });
});

tools.post('/pricing/promotion', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const id = `promo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { pmsBuiAiSuggestions } = await import('../../db/schema/ai.js');
  await db.insert(pmsBuiAiSuggestions).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId,
    type: 'promotion', roomType: (body.room_types || []).join(','),
    currentPrice: body.discount_pct,
    reason: JSON.stringify({ name: body.name, date_from: body.date_from, date_to: body.date_to }),
    status: 'pending', createdAt: new Date(),
  });
  return c.json({ success: true, data: { id, name: body.name } });
});

tools.post('/customers/tag', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const [customer] = await db.select().from(pmsBuiCustomers)
    .where(and(eq(pmsBuiCustomers.id, body.customer_id), ...tenantConditions(scope, pmsBuiCustomers)))
    .limit(1);
  if (!customer) return c.json({ success: false, error: '客户不存在' }, 404);
  const existingTags = (customer as any).tags || [];
  const newTags = [...new Set([...existingTags, ...body.tags])];
  await db.update(pmsBuiCustomers)
    .set({ tags: newTags, updatedAt: new Date() } as any)
    .where(eq(pmsBuiCustomers.id, body.customer_id));
  return c.json({ success: true, data: { customer_id: body.customer_id, tags: newTags } });
});

tools.post('/customers/coupon', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const id = `coupon_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { pmsBuiAiSuggestions } = await import('../../db/schema/ai.js');
  await db.insert(pmsBuiAiSuggestions).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId,
    type: 'coupon', roomType: body.customer_id, currentPrice: body.amount,
    reason: body.reason || '', status: 'pending', createdAt: new Date(),
  });
  return c.json({ success: true, data: { id, customer_id: body.customer_id, amount: body.amount } });
});

tools.post('/notifications/send', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const { pmsBuiAiInsights } = await import('../../db/schema/ai.js');
  await db.insert(pmsBuiAiInsights).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId,
    agent: 'system', type: 'alert', title: body.title, content: body.content,
    priority: body.priority || 3, status: 'active', createdAt: new Date(),
  });
  return c.json({ success: true, data: { id } });
});

// --- 活跃租户查询 ---
tools.get('/tenants/active', async (c) => {
  const { pmsBuiTenantModeConfig } = await import('../../db/schema/ai.js');
  const tenants = await db.select().from(pmsBuiTenantModeConfig)
    .where(not(eq(pmsBuiTenantModeConfig.systemMode, 'saas')));
  return c.json({ tenants: tenants.map(t => ({ merchant_id: t.merchantId, store_id: 'default_store' })) });
});

// --- Metrics 同步 ---
tools.post('/metrics/sync', async (c) => {
  const body = await c.req.json();
  const { pmsBuiAiMetrics } = await import('../../db/schema/ai.js');
  const id = `metric_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(pmsBuiAiMetrics).values({
    id, merchantId: body.merchant_id, agent: body.agent, crew: body.crew,
    operation: 'cron', latencyMs: body.latency_ms, tokensPrompt: body.tokens_prompt,
    tokensCompletion: body.tokens_completion, model: body.model || 'unknown',
    insightGenerated: body.insight_generated || false, createdAt: new Date(),
  });
  return c.json({ success: true, id });
});

// --- 热点话题保存 ---
tools.post('/hot-topics/save', async (c) => {
  const body = await c.req.json();
  const { date, scene, topics } = body as { date: string; scene?: string; topics: any[] };
  if (!date || !topics?.length) return c.json({ success: false, error: '缺少 date/topics' }, 400);

  const { pmsBuiHotTopics } = await import('../../db/schema/promotion.js');
  // 删除当天该场景旧数据
  if (scene) {
    await db.execute(sql`DELETE FROM pms_bui_hot_topics WHERE date = ${date} AND scene = ${scene}`);
  } else {
    await db.execute(sql`DELETE FROM pms_bui_hot_topics WHERE date = ${date}`);
  }
  // 批量插入
  for (const t of topics) {
    await db.insert(pmsBuiHotTopics).values({
      id: t.id, date: t.date, scene: t.scene || scene || 'short_video',
      label: t.label, icon: t.icon, prompt: t.prompt, style: t.style, source: t.source,
      sortOrder: t.sort_order || 0,
    } as any);
  }
  return c.json({ success: true, count: topics.length });
});

// --- 客户升级 VIP ---
tools.post('/customers/upgrade-vip', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { customer_id, new_level } = body;

  const validLevels = ['regular', 'silver', 'gold', 'diamond'];
  if (!validLevels.includes(new_level)) {
    return c.json({ success: false, error: `无效会员等级: ${new_level}` }, 400);
  }

  const [customer] = await db.select().from(pmsBuiCustomers)
    .where(and(eq(pmsBuiCustomers.id, customer_id), ...tenantConditions(scope, pmsBuiCustomers)))
    .limit(1);
  if (!customer) return c.json({ success: false, error: '客户不存在' }, 404);

  const levelRank: Record<string, number> = { regular: 0, silver: 1, gold: 2, diamond: 3 };
  if (levelRank[new_level] <= levelRank[customer.memberLevel]) {
    return c.json({ success: false, error: '只能升级不能降级' }, 400);
  }

  const levelNameMap: Record<string, string> = { diamond: '钻石会员', gold: '金卡会员', silver: '银卡会员', regular: '普通会员' };
  const levelIconMap: Record<string, string> = { diamond: '💎', gold: '🥇', silver: '🥈', regular: '🎫' };
  const discountMap: Record<string, number> = { diamond: 75, gold: 85, silver: 92, regular: 100 };

  await db.update(pmsBuiCustomers).set({
    memberLevel: new_level, memberLevelName: levelNameMap[new_level],
    memberLevelIcon: levelIconMap[new_level], memberLevelDiscount: discountMap[new_level],
    updatedAt: new Date(),
  } as any).where(eq(pmsBuiCustomers.id, customer_id));

  return c.json({ success: true, data: { customer_id, old_level: customer.memberLevel, new_level } });
});

// --- 客户关怀提醒 ---
tools.post('/customers/care', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { customer_id, type, content, priority } = body;

  const { pmsBuiCareReminders } = await import('../../db/schema/customers.js');
  const [customer] = await db.select().from(pmsBuiCustomers)
    .where(and(eq(pmsBuiCustomers.id, customer_id), ...tenantConditions(scope, pmsBuiCustomers)))
    .limit(1);
  if (!customer) return c.json({ success: false, error: '客户不存在' }, 404);

  const id = `care_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(pmsBuiCareReminders).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    customerId: customer_id, customerName: customer.name,
    type: type || 'rebuy', content: content || '',
    priority: priority || 'medium', status: 'pending',
    dueDate: new Date().toISOString().split('T')[0],
    createdAt: new Date(), updatedAt: new Date(),
  } as any);

  return c.json({ success: true, data: { id, customer_name: customer.name, type } });
});

// --- 入住登记 ---
tools.post('/rooms/check-in', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, guest_name, guest_phone, check_out_date, source } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status === 'occupied') return c.json({ success: false, error: '房间已有人入住' }, 400);

  const now = new Date();
  const orderNo = `ORD${Date.now().toString().slice(-8)}`;
  const checkIn = now.toISOString().split('T')[0];

  // 与 SaaS rooms.ts checkIn 保持一致: status='occupied', paymentStatus='paid', channel='自来客'
  await db.update(pmsBuiRooms).set({
    status: 'occupied', guestName: guest_name, guestPhone: guest_phone || '',
    checkInDate: checkIn, checkOutDate: check_out_date || '', bookingId: orderNo,
    lockReason: null, updatedAt: now,
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  await db.insert(pmsBuiOrders).values({
    id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    orderNo, channel: source || '自来客', guestName: guest_name, guestPhone: guest_phone || '',
    checkIn, checkOut: check_out_date || '', roomType: room.roomTypeName || '',
    roomNumber: room.roomNumber || '', roomId: room.id || '',
    totalPrice: room.price || 0, status: 'checked_in', paymentStatus: 'paid',
    merchantId: scope.merchantId, storeId: room.storeId || scope.storeId,
    createdAt: now, updatedAt: now,
  } as any);

  // 与 SaaS 一致: 自动创建/更新客户档案
  const guestPhoneStr = guest_phone || '';
  if (guestPhoneStr) {
    const [existingCust] = await db.select().from(pmsBuiCustomers)
      .where(and(eq(pmsBuiCustomers.phone, guestPhoneStr), ...tenantConditions(scope, pmsBuiCustomers)))
      .limit(1);
    if (existingCust) {
      await db.update(pmsBuiCustomers).set({
        lastStayDate: checkIn, stayCount: (existingCust.stayCount || 0) + 1,
        totalSpent: (existingCust.totalSpent || 0) + (room.price || 0), updatedAt: new Date(),
      } as any).where(eq(pmsBuiCustomers.id, existingCust.id));
    } else {
      await db.insert(pmsBuiCustomers).values({
        id: `cust_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        merchantId: scope.merchantId, storeId: room.storeId || scope.storeId,
        name: guest_name, phone: guestPhoneStr, gender: '', birthday: '',
        source: source || 'walk-in', memberLevel: 'regular', tags: [source || 'walk-in'],
        totalSpent: room.price || 0, stayCount: 1, lastStayDate: checkIn,
        valueScore: 30, createdAt: now, updatedAt: now,
      } as any);
    }
  }

  return c.json({ success: true, data: { orderNo, roomId: room_id, roomNumber: room.roomNumber, guestName: guest_name, checkIn } });
});

// --- 退房 ---
tools.post('/rooms/check-out', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status !== 'occupied') return c.json({ success: false, error: `房间当前状态为 ${room.status}，无法退房` }, 400);

  const now = new Date();
  await db.update(pmsBuiRooms).set({
    status: 'dirty', guestName: null, guestPhone: null,
    checkInDate: null, checkOutDate: null, lockReason: null, updatedAt: now,
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  const [order] = await db.select().from(pmsBuiOrders).where(
    and(or(eq(pmsBuiOrders.roomId, room.id), eq(pmsBuiOrders.roomNumber, room.roomNumber || '')),
      ...tenantConditions(scope, pmsBuiOrders))
  );
  if (order) {
    await db.update(pmsBuiOrders).set({
      status: 'checked_out', checkOut: now.toISOString().split('T')[0],
    } as any).where(eq(pmsBuiOrders.id, order.id));
  }

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber, checkoutTime: now.toISOString() } });
});

// --- 预订房间 ---
tools.post('/rooms/book', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, guest_name, guest_phone, check_in, check_out } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status !== 'available') return c.json({ success: false, error: `房间当前状态为 ${room.status}，无法预订` }, 400);

  const orderNo = `BK${Date.now().toString().slice(-8)}`;
  await db.update(pmsBuiRooms).set({
    status: 'booked', guestName: guest_name, guestPhone: guest_phone || '',
    checkInDate: check_in, checkOutDate: check_out, bookingId: orderNo,
    lockReason: null, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { orderNo, roomId: room_id, roomNumber: room.roomNumber } });
});

// --- 维修/锁房 ---
tools.post('/rooms/maintenance', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, reason } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status === 'occupied') return c.json({ success: false, error: '房间有人入住，无法标记维修' }, 400);

  await db.update(pmsBuiRooms).set({
    status: 'maintenance', lockReason: reason || '维修中', updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber, reason } });
});

// --- 换房 ---
tools.post('/rooms/change-room', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, to_room_id, reason } = body;

  const [fromRoom] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!fromRoom) return c.json({ success: false, error: '源房间不存在' }, 404);

  const [toRoom] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, to_room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!toRoom) return c.json({ success: false, error: '目标房间不存在' }, 404);
  if (toRoom.status === 'occupied') return c.json({ success: false, error: '目标房间已有人入住' }, 400);
  if (toRoom.status === 'maintenance') return c.json({ success: false, error: '目标房间维修中' }, 400);

  // 把客人迁到目标房间
  await db.update(pmsBuiRooms).set({
    status: 'occupied', guestName: fromRoom.guestName, guestPhone: fromRoom.guestPhone,
    checkInDate: fromRoom.checkInDate, checkOutDate: fromRoom.checkOutDate,
    bookingId: fromRoom.bookingId, lockReason: null, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, to_room_id), ...tenantConditions(scope, pmsBuiRooms)));

  // 释放源房间
  await db.update(pmsBuiRooms).set({
    status: 'dirty', guestName: null, guestPhone: null,
    checkInDate: null, checkOutDate: null, bookingId: null,
    lockReason: null, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { fromRoomId: room_id, toRoomId: to_room_id, reason } });
});

// --- 锁房 ---
tools.post('/rooms/lock', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, reason } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status === 'occupied') return c.json({ success: false, error: '房间有住客，无法锁房' }, 400);

  await db.update(pmsBuiRooms).set({
    status: 'locked', lockReason: reason || '暂停售卖', updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber, reason } });
});

// --- 开房 / 解锁 ---
tools.post('/rooms/unlock', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);

  await db.update(pmsBuiRooms).set({
    status: 'available', lockReason: null, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber } });
});

// --- 续住 ---
tools.post('/rooms/extend-stay', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, new_check_out_date } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status !== 'occupied') return c.json({ success: false, error: '该房间无住客，无法续住' }, 400);

  await db.update(pmsBuiRooms).set({
    checkOutDate: new_check_out_date, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  // 同步更新订单
  const [order] = await db.select().from(pmsBuiOrders).where(
    and(or(eq(pmsBuiOrders.roomId, room.id), eq(pmsBuiOrders.roomNumber, room.roomNumber || '')),
      ...tenantConditions(scope, pmsBuiOrders))
  );
  if (order) {
    await db.update(pmsBuiOrders).set({ checkOut: new_check_out_date } as any)
      .where(eq(pmsBuiOrders.id, order.id));
  }

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber, newCheckOutDate: new_check_out_date } });
});

// --- 标记干净 ---
tools.post('/rooms/mark-clean', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);

  await db.update(pmsBuiRooms).set({
    status: 'available', guestName: null, guestPhone: null,
    checkInDate: null, checkOutDate: null, bookingId: null,
    dirtyType: null, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber } });
});

// --- 标记脏房 ---
tools.post('/rooms/mark-dirty', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);

  await db.update(pmsBuiRooms).set({
    status: 'dirty', updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber } });
});

// --- 确认订单 ---
tools.post('/orders/confirm', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { order_id } = body;

  const now = new Date();
  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, order_id), ...tenantConditions(scope, pmsBuiOrders)))
    .limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  if (order.status !== 'pending_confirm' && order.status !== 'pending') return c.json({ success: false, error: `订单当前状态为 ${order.status}，无法确认` }, 400);

  await db.update(pmsBuiOrders).set({ status: 'confirmed', confirmedAt: now })
    .where(and(eq(pmsBuiOrders.id, order_id), ...tenantConditions(scope, pmsBuiOrders)));

  return c.json({ success: true, data: { orderId: order_id, orderNo: order.orderNo, status: 'confirmed' } });
});

// --- 取消订单 ---
tools.post('/orders/cancel', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { order_id, reason } = body;

  const now = new Date();
  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, order_id), ...tenantConditions(scope, pmsBuiOrders)))
    .limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  if (order.status === 'checked_in' || order.status === 'checked_out') return c.json({ success: false, error: `订单已${order.status === 'checked_in' ? '入住' : '退房'}，无法取消` }, 400);

  await db.update(pmsBuiOrders).set({
    status: 'cancelled', cancelledAt: now, cancelReason: reason || '',
  } as any).where(and(eq(pmsBuiOrders.id, order_id), ...tenantConditions(scope, pmsBuiOrders)));

  return c.json({ success: true, data: { orderId: order_id, orderNo: order.orderNo, status: 'cancelled', reason } });
});

// --- 取消预订 ---
tools.post('/rooms/cancel-book', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, reason } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status !== 'booked') return c.json({ success: false, error: `房间当前状态为 ${room.status}，无法取消预订` }, 400);

  await db.update(pmsBuiRooms).set({
    status: 'available', guestName: null, guestPhone: null,
    checkInDate: null, checkOutDate: null, bookingId: null,
    lockReason: null, updatedAt: new Date(),
  } as any).where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  // 取消关联订单
  const [order] = await db.select().from(pmsBuiOrders).where(
    and(eq(pmsBuiOrders.roomId, room.id), ...tenantConditions(scope, pmsBuiOrders))
  );
  if (order && order.status !== 'checked_in' && order.status !== 'checked_out') {
    await db.update(pmsBuiOrders).set({
      status: 'cancelled', cancelledAt: new Date(), cancelReason: reason || 'AI取消预订',
    } as any).where(eq(pmsBuiOrders.id, order.id));
  }

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber, reason } });
});

// --- 修改预订 ---
tools.post('/rooms/modify-book', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, guest_name, guest_phone, check_in, check_out } = body;

  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);
  if (room.status !== 'booked' && room.status !== 'occupied') return c.json({ success: false, error: `房间当前状态为 ${room.status}，无法修改预订` }, 400);

  const setData: any = { updatedAt: new Date() };
  if (guest_name !== undefined) setData.guestName = guest_name;
  if (guest_phone !== undefined) setData.guestPhone = guest_phone;
  if (check_in !== undefined) setData.checkInDate = check_in;
  if (check_out !== undefined) setData.checkOutDate = check_out;
  await db.update(pmsBuiRooms).set(setData)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { roomId: room_id, roomNumber: room.roomNumber, ...setData } });
});

// --- 创建客房任务 ---
tools.post('/housekeeping/create', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { room_id, task_type, priority } = body;

  const { pmsBuiHousekeepingTasks } = await import('../../db/schema/housekeeping.js');
  const [room] = await db.select().from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.id, room_id), ...tenantConditions(scope, pmsBuiRooms)))
    .limit(1);
  if (!room) return c.json({ success: false, error: '房间不存在' }, 404);

  const taskId = `hkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date();
  await db.insert(pmsBuiHousekeepingTasks).values({
    id: taskId, merchantId: scope.merchantId,
    storeId: room.storeId || (scope.storeId === '*' ? 'default_store' : scope.storeId),
    roomId: room_id, roomNumber: room.roomNumber, roomTypeName: room.roomTypeName || '',
    floor: room.floor || 1, status: 'pending',
    taskType: task_type || '退房清洁', priority: priority || 'normal',
    createdAt: now, updatedAt: now,
  } as any);

  return c.json({ success: true, data: { taskId, roomNumber: room.roomNumber, taskType: task_type } });
});

// --- 分配客房任务 ---
tools.post('/housekeeping/assign', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { task_id, assignee_id, assignee_name } = body;

  const { pmsBuiHousekeepingTasks } = await import('../../db/schema/housekeeping.js');
  const [task] = await db.select().from(pmsBuiHousekeepingTasks)
    .where(and(eq(pmsBuiHousekeepingTasks.id, task_id), ...tenantConditions(scope, pmsBuiHousekeepingTasks)))
    .limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);

  await db.update(pmsBuiHousekeepingTasks).set({
    status: 'assigned', assigneeId: assignee_id, assigneeName: assignee_name || '',
    updatedAt: new Date(),
  }).where(and(eq(pmsBuiHousekeepingTasks.id, task_id), ...tenantConditions(scope, pmsBuiHousekeepingTasks)));

  return c.json({ success: true, data: { taskId: task_id, assigneeName: assignee_name } });
});

// --- 完成客房任务 ---
tools.post('/housekeeping/complete', async (c) => {
  const scope = getScope(c);
  const body = await c.req.json();
  const { task_id } = body;

  const { pmsBuiHousekeepingTasks } = await import('../../db/schema/housekeeping.js');
  const [task] = await db.select().from(pmsBuiHousekeepingTasks)
    .where(and(eq(pmsBuiHousekeepingTasks.id, task_id), ...tenantConditions(scope, pmsBuiHousekeepingTasks)))
    .limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);
  if (task.status === 'completed' || task.status === 'inspected') return c.json({ success: false, error: '任务已完成' }, 400);

  const now = new Date();
  await db.update(pmsBuiHousekeepingTasks).set({
    status: 'completed', completedAt: now, updatedAt: now,
  }).where(and(eq(pmsBuiHousekeepingTasks.id, task_id), ...tenantConditions(scope, pmsBuiHousekeepingTasks)));

  await db.update(pmsBuiRooms).set({
    status: 'available', guestName: null, guestPhone: null,
    checkInDate: null, checkOutDate: null, bookingId: null,
    dirtyType: null, updatedAt: now,
  } as any).where(and(eq(pmsBuiRooms.id, task.roomId), ...tenantConditions(scope, pmsBuiRooms)));

  return c.json({ success: true, data: { taskId: task_id, roomId: task.roomId, roomNumber: task.roomNumber } });
});

export default tools;
