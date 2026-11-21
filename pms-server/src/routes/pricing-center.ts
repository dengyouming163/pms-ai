// 定价中心路由：今日推荐 / 采纳 / 撤销 / 重试 / 设置 / 价格一览 / 每日仪式
import { Hono } from 'hono';
import { db } from '../db/index.js';
import { pmsBuiRoomTypes, pmsBuiDailyPrice, pmsPriceRobotTasks, pmsBuiHolidays, pmsPriceRobotConfig } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { requirePermission } from '../middleware/permission-guard.js';
import { calcDefaultPrice } from '../services/pricing-center/engine.js';
import { buildTodayData, todayStr, isWeekend, resolveStoreId, getStoreConfig } from '../services/pricing-center/recommend.js';

const route = new Hono<{ Variables: { authUser?: any } }>();

route.get('/today', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  return c.json({ success: true, data: await buildTodayData(storeId) });
});

// 采纳：写每日卖价 + 为每个渠道生成 OTA 同步任务（即时执行由 ota-client 轮询）
route.post('/adopt', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body: any = await c.req.json();
  const roomTypeId: string = String(body.roomTypeId || '');
  const price: number = Number(body.price);
  if (!roomTypeId) return c.json({ success: false, error: '缺少房型' }, 400);
  if (!Number.isInteger(price) || price <= 0) return c.json({ success: false, error: '价格非法' }, 400);

  const [rt] = await db.select().from(pmsBuiRoomTypes)
    .where(and(...tenantWhere(scope, pmsBuiRoomTypes), eq(pmsBuiRoomTypes.id, roomTypeId))).limit(1);
  if (!rt) return c.json({ success: false, error: '房型不存在' }, 404);
  // 最低卖价护栏
  if (rt.minPrice && price < rt.minPrice) {
    return c.json({ success: false, error: `价格低于最低卖价 ¥${rt.minPrice}` }, 400);
  }

  const date = todayStr();
  const id = `dp_${storeId}_${roomTypeId}_${date}`;
  await db.insert(pmsBuiDailyPrice).values({
    id, merchantId: scope.merchantId, storeId, roomTypeId, roomTypeName: rt.name,
    date, price, source: 'adopt', updatedAt: new Date(),
  } as any).onConflictDoUpdate({
    target: [pmsBuiDailyPrice.storeId, pmsBuiDailyPrice.roomTypeId, pmsBuiDailyPrice.date],
    set: { price, source: 'adopt', updatedAt: new Date() } as any,
  });

  // 生成 OTA 同步任务（每渠道一条 pending；slot=当前时刻，targetDate=今天）
  const cfg = await getStoreConfig(storeId);
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const slot = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const taskBase = `prt_${storeId}_${date}_${slot}_${roomTypeId}`;
  for (const ch of cfg.channels) {
    const taskId = `${taskBase}_${ch}`;
    await db.insert(pmsPriceRobotTasks).values({
      id: taskId, date, targetDate: date, slot,
      merchantId: scope.merchantId, storeId,
      roomTypeId, roomTypeName: rt.name,
      channel: ch, targetPrice: String(price), status: 'pending',
      createdAt: new Date(),
    } as any).onConflictDoUpdate({
      // 同分钟 adopt→undo 会命中同一条任务键：以最后写入的 targetPrice 为准（最后写入生效）
      target: [pmsPriceRobotTasks.date, pmsPriceRobotTasks.slot, pmsPriceRobotTasks.storeId, pmsPriceRobotTasks.roomTypeId, pmsPriceRobotTasks.channel, pmsPriceRobotTasks.targetDate],
      set: { targetPrice: String(price), status: 'pending' } as any,
    });
  }

  return c.json({ success: true, data: { date, roomTypeId, price, channels: cfg.channels } });
});

// 撤销：删除今日卖价行 → 回落默认价 → 为各渠道生成"改回默认价"任务
route.post('/undo', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body: any = await c.req.json();
  const roomTypeId: string = String(body.roomTypeId || '');
  if (!roomTypeId) return c.json({ success: false, error: '缺少房型' }, 400);
  const date = todayStr();

  await db.delete(pmsBuiDailyPrice)
    .where(and(eq(pmsBuiDailyPrice.storeId, storeId), eq(pmsBuiDailyPrice.roomTypeId, roomTypeId), eq(pmsBuiDailyPrice.date, date)));

  // 计算回落默认价
  const [rt] = await db.select().from(pmsBuiRoomTypes)
    .where(and(...tenantWhere(scope, pmsBuiRoomTypes), eq(pmsBuiRoomTypes.id, roomTypeId))).limit(1);
  if (!rt) return c.json({ success: false, error: '房型不存在' }, 404);
  const holidays = await db.select().from(pmsBuiHolidays);
  const wend = isWeekend(date);
  const isHol = holidays.some(h => h.date === date);
  const cfg = await getStoreConfig(storeId);
  const fallback = rt ? calcDefaultPrice({
    isWeekend: wend, isHoliday: isHol, holidayMarkupPct: cfg.holidayMarkupPct,
    baseWeekday: rt.weekdayPrice || rt.basePrice, baseWeekend: rt.weekendPrice || rt.basePrice,
    basePrice: rt.basePrice,
  }) : null;

  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const slot = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  for (const ch of cfg.channels) {
    await db.insert(pmsPriceRobotTasks).values({
      id: `prt_${storeId}_${date}_${slot}_${roomTypeId}_${ch}`, date, targetDate: date, slot,
      merchantId: scope.merchantId, storeId,
      roomTypeId, roomTypeName: rt?.name ?? '', channel: ch,
      targetPrice: String(fallback ?? 0), status: 'pending', createdAt: new Date(),
    } as any).onConflictDoUpdate({
      // 同分钟 adopt→undo 命中同一条任务键：更新为回落默认价，让 ota-client 最终同步回落
      target: [pmsPriceRobotTasks.date, pmsPriceRobotTasks.slot, pmsPriceRobotTasks.storeId, pmsPriceRobotTasks.roomTypeId, pmsPriceRobotTasks.channel, pmsPriceRobotTasks.targetDate],
      set: { targetPrice: String(fallback ?? 0), status: 'pending' } as any,
    });
  }

  return c.json({ success: true, data: { date, roomTypeId, fallbackPrice: fallback } });
});

// 渠道同步失败重试：将任务重置为 pending，ota-client 下轮轮询会重新执行
route.post('/tasks/:id/retry', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const taskId = c.req.param('id') as string;
  const [task] = await db.select().from(pmsPriceRobotTasks)
    .where(and(eq(pmsPriceRobotTasks.id, taskId), eq(pmsPriceRobotTasks.storeId, storeId))).limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);
  if (task.status === 'pending' || task.status === 'success') {
    return c.json({ success: false, error: '任务无需重试' }, 400);
  }
  await db.update(pmsPriceRobotTasks).set({ status: 'pending', error: null } as any)
    .where(eq(pmsPriceRobotTasks.id, taskId));
  return c.json({ success: true, data: { id: taskId, status: 'pending' } });
});

// 设置读取：基础房价 + 节假日加价% + 渠道 + 最低卖价 + 推荐开关
route.get('/settings', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const cfg = await getStoreConfig(storeId);
  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  return c.json({
    success: true,
    data: {
      holidayMarkupPct: cfg.holidayMarkupPct,
      recommendationEnabled: cfg.recommendationEnabled,
      channels: cfg.channels,
      basePrices: roomTypes.filter(rt => rt.status === 'active').map(rt => ({
        roomTypeId: rt.id, roomTypeName: rt.name,
        basePrice: rt.basePrice, weekdayPrice: rt.weekdayPrice, weekendPrice: rt.weekendPrice,
        minPrice: rt.minPrice,
      })),
    },
  });
});

// 设置保存：基础价/最低价写 room_types；节假日%/渠道/推荐开关写 config 门店行
route.post('/settings', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body: any = await c.req.json();

  if (Array.isArray(body.basePrices)) {
    for (const b of body.basePrices) {
      if (!b?.roomTypeId) continue;
      // 数值校验：NaN/Infinity/负数拒绝，避免写入 integer 列触发 DB 错误或产生无意义价格
      for (const field of ['basePrice', 'weekdayPrice', 'weekendPrice', 'minPrice'] as const) {
        if (b[field] == null) continue;
        const v = Number(b[field]);
        if (!Number.isFinite(v) || v < 0) return c.json({ success: false, error: `${field} 需为≥0的数字` }, 400);
      }
      const patch: any = { updatedAt: new Date() };
      if (b.basePrice != null) patch.basePrice = Number(b.basePrice);
      if (b.weekdayPrice != null) patch.weekdayPrice = Number(b.weekdayPrice);
      if (b.weekendPrice != null) patch.weekendPrice = Number(b.weekendPrice);
      if (b.minPrice != null) patch.minPrice = Number(b.minPrice);
      await db.update(pmsBuiRoomTypes).set(patch)
        .where(and(...tenantWhere(scope, pmsBuiRoomTypes), eq(pmsBuiRoomTypes.id, b.roomTypeId)));
    }
  }

  const [cfg] = await db.select().from(pmsPriceRobotConfig)
    .where(and(eq(pmsPriceRobotConfig.storeId, storeId), eq(pmsPriceRobotConfig.roomTypeId, '*'))).limit(1);
  const patch: any = { updatedAt: new Date() };
  // 节假日加价% 范围校验：0-100，避免 calcDefaultPrice 产生荒谬价格
  if (body.holidayMarkupPct != null) {
    const v = Number(body.holidayMarkupPct);
    if (!Number.isFinite(v) || v < 0 || v > 100) return c.json({ success: false, error: '节假日加价%需在 0-100 之间' }, 400);
    patch.holidayMarkupPct = v;
  }
  if (body.recommendationEnabled != null) patch.recommendationEnabled = body.recommendationEnabled === true;
  if (Array.isArray(body.channels) && body.channels.length) patch.channels = body.channels;

  if (cfg) {
    await db.update(pmsPriceRobotConfig).set(patch).where(eq(pmsPriceRobotConfig.id, cfg.id));
  } else {
    await db.insert(pmsPriceRobotConfig).values({
      id: `cfg_${storeId}_*`, merchantId: scope.merchantId, storeId, roomTypeId: '*',
      channels: body.channels ?? ['携程', '美团'],
      holidayMarkupPct: body.holidayMarkupPct ?? 20,
      recommendationEnabled: body.recommendationEnabled ?? true,
      enabled: true, strategy: 'standard', slots: ['17:00', '19:00', '21:00'],
      futureDays: 14, maxDeviationPct: 30, autoConfirm: false,
      createdAt: new Date(), updatedAt: new Date(),
    } as any);
  }
  return c.json({ success: true, data: {} });
});

// 价格一览（只读）：未来 N 天每房型生效价（采纳价 > 节假日默认价 > 基础价）
route.get('/overview', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const days = Math.min(Math.max(Number(c.req.query('days') || 7), 1), 30);
  const cfg = await getStoreConfig(storeId);
  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  const holidays = await db.select().from(pmsBuiHolidays);

  const dates: string[] = [];
  const base = new Date(Date.now() + 8 * 3600 * 1000);
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    dates.push(d.toISOString().slice(0, 10));
  }
  const daily = await db.select().from(pmsBuiDailyPrice)
    .where(and(eq(pmsBuiDailyPrice.storeId, storeId), eq(pmsBuiDailyPrice.date, dates[0])));

  const rows = dates.map((date) => {
    const wend = isWeekend(date);
    const hol = holidays.find(h => h.date === date);
    return {
      date,
      label: hol ? hol.name : (wend ? '周末' : ''),
      roomTypes: roomTypes.filter(rt => rt.status === 'active').map(rt => {
        const dailyRow = daily.find(d => d.roomTypeId === rt.id && d.date === date);
        const def = calcDefaultPrice({
          isWeekend: wend, isHoliday: !!hol, holidayMarkupPct: cfg.holidayMarkupPct,
          baseWeekday: rt.weekdayPrice || rt.basePrice, baseWeekend: rt.weekendPrice || rt.basePrice,
          basePrice: rt.basePrice,
        });
        return { roomTypeId: rt.id, price: dailyRow ? dailyRow.price : def, adopted: !!dailyRow };
      }),
    };
  });
  return c.json({ success: true, data: { days: rows } });
});

// 每日仪式查询：今日是否有价格变化（供前端/未来推送轮询）
route.get('/ritual/today', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const data = await buildTodayData(storeId);
  const changes = data.rooms.filter(r => r.suggestedPrice !== null);
  return c.json({
    success: true,
    data: {
      date: data.date,
      hasChange: changes.length > 0,
      changes: changes.map(r => ({ roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName, from: r.currentPrice, to: r.suggestedPrice, reasons: r.reasons })),
    },
  });
});

export default route;
