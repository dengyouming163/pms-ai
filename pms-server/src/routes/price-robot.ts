// pms-server/src/routes/price-robot.ts
// 自动收益管家 — 路由（Web/移动端 JWT；客户端 sk- store_key 鉴权）
import { Hono } from 'hono';
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  pmsPriceRobotConfig, pmsPriceRobotAuth, pmsPriceRobotTasks, pmsPriceRobotLogs, pmsPriceRobotPlans,
} from '../db/schema/price-robot.js';
import { pmsBuiRoomTypes, pmsBuiRooms, pmsBuiOrders } from '../db/schema/index.js';
import { getTenantScope } from '../utils/tenant.js';
import type { AuthUser } from '../middleware/auth.js';
import { otaAuthMiddleware } from '../middleware/ota-auth.js';
import { requirePermission } from '../middleware/permission-guard.js';
import {
  buildSlotTargets, forecastOccupancy, calcRemainingRooms, countBookedOnDate,
  SLOT_STRATEGIES, DEFAULT_CAP_RATIO, DEFAULT_SLOTS,
} from '../services/price-robot/engine.js';

const BJ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间 = UTC+8

const route = new Hono<{ Variables: { authUser?: AuthUser; storeId?: string; deviceId?: string } }>();

// 客户端端点走 sk- store_key 鉴权（全局 authMiddleware 已放行 sk- token）
route.use('/tasks/pending', otaAuthMiddleware);
route.use('/tasks/:id/report', otaAuthMiddleware);

// 商户端点仅接受 JWT 登录（sk- store_key 只允许访问客户端端点，防止跨租户越权）
route.use('*', async (c, next) => {
  const path = c.req.path;
  if (path.endsWith('/tasks/pending') || path.endsWith('/report')) return next();
  if (!c.get('authUser')) return c.json({ success: false, error: '未授权' }, 401);
  return next();
});

function todayStr(): string { return new Date(Date.now() + BJ_OFFSET_MS).toISOString().split('T')[0]; }

/** 北京时间（东八区）当天日期 */
function todayBj(): string { return new Date(Date.now() + BJ_OFFSET_MS).toISOString().split('T')[0]; }

/** 下一个半点（北京时间），如 09:23 → 09:30 */
function nextHalfHour(): string {
  const bj = new Date(Date.now() + BJ_OFFSET_MS);
  bj.setUTCMinutes(bj.getUTCMinutes() + 30 - (bj.getUTCMinutes() % 30), 0, 0);
  return `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`;
}

/** 计算某北京时间时点的执行窗口结束时刻（slot + 15 分钟，ISO 时间戳） */
function slotWindowEndsAt(slot: string): string {
  const [h, m] = slot.split(':').map(Number);
  const nowBj = new Date(Date.now() + BJ_OFFSET_MS);
  const dayStartUtc = Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate());
  const slotStart = dayStartUtc - BJ_OFFSET_MS + (h * 3600 + m * 60) * 1000;
  return new Date(slotStart + 15 * 60_000).toISOString();
}

/** 可选数值字段解析：未传返回 undefined；显式传入但非有限数字返回 NaN 供调用方拒绝 */
function parseOptionalNumber(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 门店哨兵：storeless（未选门店）商户用 'default_store'，避免空串写库 / 熔断误判 404 */
function resolveStoreId(scope: any): string {
  return scope.storeId !== '*' ? scope.storeId : 'default_store';
}

// —— GET /api/price-robot/config —— 读取机器人配置（含默认档位）
route.get('/config', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  let rows = await db.select().from(pmsPriceRobotConfig)
    .where(eq(pmsPriceRobotConfig.storeId, storeId));
  if (rows.length === 0) {
    // 无配置时按现有房型给默认值
    const roomTypes = await db.select().from(pmsBuiRoomTypes)
      .where(eq(pmsBuiRoomTypes.storeId, storeId));
    rows = roomTypes.map(rt => ({
      id: `cfg_${storeId}_${rt.id}`, merchantId: scope.merchantId, storeId,
      roomTypeId: rt.id, enabled: true,
      channels: ['携程', '美团'], strategy: 'standard',
      slots: [...DEFAULT_SLOTS], futureDays: 14,
      floorCapRatio: '1.5', maxDeviationPct: 30,
      createdAt: new Date(), updatedAt: new Date(),
    } as any));
  }
  return c.json({ success: true, data: rows, meta: { strategies: SLOT_STRATEGIES, defaultCapRatio: DEFAULT_CAP_RATIO } });
});

// —— PUT /api/price-robot/config —— 更新配置（全量替换该门店配置）
route.put('/config', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body = await c.req.json();
  const list: any[] = Array.isArray(body) ? body : [body];
  const ids: string[] = [];
  for (const item of list) {
    if (!item.roomTypeId) continue;
    const id = item.id || `cfg_${storeId}_${item.roomTypeId}`;
    ids.push(id);
    await db.insert(pmsPriceRobotConfig).values({
      id, merchantId: scope.merchantId, storeId, roomTypeId: item.roomTypeId,
      enabled: item.enabled ?? true,
      channels: item.channels || ['携程', '美团'],
      strategy: item.strategy || 'standard',
      slots: item.slots || [...DEFAULT_SLOTS],
      futureDays: item.futureDays ?? 14,
      floorCapRatio: String(item.floorCapRatio ?? DEFAULT_CAP_RATIO),
      maxDeviationPct: item.maxDeviationPct ?? 30,
      createdAt: new Date(), updatedAt: new Date(),
    } as any)
      .onConflictDoUpdate({ target: pmsPriceRobotConfig.id, set: {
        enabled: item.enabled ?? true,
        channels: item.channels || ['携程', '美团'],
        strategy: item.strategy || 'standard',
        slots: item.slots || [...DEFAULT_SLOTS],
        futureDays: item.futureDays ?? 14,
        floorCapRatio: String(item.floorCapRatio ?? DEFAULT_CAP_RATIO),
        maxDeviationPct: item.maxDeviationPct ?? 30,
        updatedAt: new Date(),
      } as any });
  }
  return c.json({ success: true, data: { updated: ids.length } });
});

// —— GET /api/price-robot/settings —— 门店级设置（autoConfirm + globalFloor）
route.get('/settings', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const [row] = await db.select().from(pmsPriceRobotConfig)
    .where(and(eq(pmsPriceRobotConfig.storeId, storeId), eq(pmsPriceRobotConfig.roomTypeId, '*')))
    .limit(1);
  return c.json({
    success: true, data: {
      autoConfirm: row?.autoConfirm ?? false,
      globalFloor: row?.globalFloor ?? null,
    },
  });
});

// —— PUT /api/price-robot/settings —— 更新门店级设置
route.put('/settings', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body = await c.req.json() as any;
  const autoConfirm = body.autoConfirm === true;
  const globalFloor = body.globalFloor === undefined || body.globalFloor === null || body.globalFloor === ''
    ? null : Number(body.globalFloor);
  const id = `cfg_${storeId}_*`;
  await db.insert(pmsPriceRobotConfig).values({
    id, merchantId: scope.merchantId, storeId, roomTypeId: '*',
    autoConfirm, globalFloor,
    enabled: true, channels: ['携程', '美团'], strategy: 'standard',
    slots: [...DEFAULT_SLOTS], futureDays: 14,
    floorCapRatio: String(DEFAULT_CAP_RATIO), maxDeviationPct: 30,
    createdAt: new Date(), updatedAt: new Date(),
  } as any).onConflictDoUpdate({ target: pmsPriceRobotConfig.id, set: {
    autoConfirm, globalFloor, updatedAt: new Date(),
  } as any });
  return c.json({ success: true, data: { autoConfirm, globalFloor } });
});

// —— GET /api/price-robot/suggestion —— 今日各房型建议底价 + 预测入住率 + 剩余房量
route.get('/suggestion', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const date = c.req.query('date') || todayStr();

  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.storeId, storeId));
  const rooms = await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId));
  const orders = await db.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.storeId, storeId)) as any[];
  const configs = await db.select().from(pmsPriceRobotConfig).where(eq(pmsPriceRobotConfig.storeId, storeId));

  const suggestions = roomTypes.map(rt => {
    const rtRooms = rooms.filter(r => r.roomTypeId === rt.id);
    const total = rtRooms.length || rt.roomCount || 10;
    const occupied = rtRooms.filter(r => r.status === 'occupied').length;
    // 按房型过滤订单再计已订，避免整店合并导致各房型剩余/入住率失真
    const booked = countBookedOnDate(orders.filter(o => o.roomTypeId === rt.id), date);
    const remaining = calcRemainingRooms(total, booked, occupied);
    const occupancy = forecastOccupancy(total, booked, occupied);
    // AI 建议底价：取定价规则基准（周中/周末），若今日剩余多则建议下调
    const isWeekend = new Date(date).getDay() === 0 || new Date(date).getDay() === 6;
    const basePrice = Number((isWeekend ? rt.weekendPrice : rt.weekdayPrice) || rt.basePrice || 0);
    const floor = remaining >= total * 0.5 ? Math.round(basePrice * 0.85) : basePrice;
    const cfg = configs.find(cc => cc.roomTypeId === rt.id);
    return {
      roomTypeId: rt.id, roomType: rt.name, basePrice,
      suggestedFloor: floor, remaining, total, occupancy,
      strategy: cfg?.strategy || 'standard', enabled: cfg?.enabled ?? true,
    };
  });

  return c.json({ success: true, data: { date, suggestions } });
});

// —— POST /api/price-robot/auth —— 提交今日授权单（底价 + 策略 + 一键确认）
route.post('/auth', requirePermission('pricing:edit'), async (c) => {
  // 已由 /pricing-center 替代，v1 下线
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body = await c.req.json();
  const date = body.date || todayStr();
  const list: any[] = Array.isArray(body.rooms) ? body.rooms : [body];

  const results: string[] = [];
  for (const item of list) {
    if (!item.roomTypeId || item.floorPrice == null) continue;
    const strategy = item.strategy || 'standard';
    const floorPrice = Number(item.floorPrice);
    if (!(floorPrice > 0)) continue;
    const authId = `pra_${storeId}_${date}_${item.roomTypeId}`;
    const expireAt = new Date(`${date}T22:00:00+08:00`); // 与授权日期对齐（东八区 22:00 失效），避免依赖服务器本地时区
    const slotPlans = buildSlotTargets(floorPrice, strategy, 0); // 展示用计划（执行时重算浮动）
    const plans: Record<string, number> = {};
    for (const [slot, p] of Object.entries(slotPlans)) plans[slot] = p.targetPrice;

    await db.insert(pmsPriceRobotAuth).values({
      id: authId, date, merchantId: scope.merchantId, storeId,
      roomTypeId: item.roomTypeId, floorPrice: String(floorPrice),
      strategy, slotPlans: plans, authBy: c.get('authUser')?.userId || '',
      authAt: new Date(), expireAt, status: 'confirmed',
    } as any).onConflictDoUpdate({
      target: pmsPriceRobotAuth.id,
      set: { floorPrice: String(floorPrice), strategy, slotPlans: plans, authBy: c.get('authUser')?.userId || '', authAt: new Date(), expireAt, status: 'confirmed' } as any,
    });
    results.push(authId);
  }
  return c.json({ success: true, data: { confirmed: results.length } });
});

// —— GET /api/price-robot/auth/today —— 今日授权状态（含熔断）
route.get('/auth/today', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const date = c.req.query('date') || todayStr();
  const rows = await db.select().from(pmsPriceRobotAuth)
    .where(and(eq(pmsPriceRobotAuth.storeId, storeId), eq(pmsPriceRobotAuth.date, date)));
  return c.json({ success: true, data: rows });
});

// —— POST /api/price-robot/auth/:id/fuse —— 一键熔断（当日作废）
route.post('/auth/:id/fuse', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const { id } = c.req.param();
  const [auth] = await db.select().from(pmsPriceRobotAuth).where(eq(pmsPriceRobotAuth.id, id));
  if (!auth || auth.storeId !== storeId) return c.json({ success: false, error: '授权单不存在' }, 404);
  // 熔断今日全部授权（该门店当日所有房型），避免其余房型在后续时点继续改价
  await db.update(pmsPriceRobotAuth).set({ status: 'fused' })
    .where(and(eq(pmsPriceRobotAuth.storeId, auth.storeId), eq(pmsPriceRobotAuth.date, auth.date)));
  // 作废该门店当日所有 pending 任务
  await db.update(pmsPriceRobotTasks).set({ status: 'skipped', error: '熔断' })
    .where(and(eq(pmsPriceRobotTasks.storeId, auth.storeId), eq(pmsPriceRobotTasks.date, auth.date), eq(pmsPriceRobotTasks.status, 'pending')));
  return c.json({ success: true, message: '已熔断今日自动改价' });
});

// —— GET /api/price-robot/tasks —— 今日任务时间轴（前端展示）
route.get('/tasks', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const date = c.req.query('date') || todayStr();
  const rows = await db.select().from(pmsPriceRobotTasks)
    .where(and(eq(pmsPriceRobotTasks.storeId, storeId), eq(pmsPriceRobotTasks.date, date)))
    .orderBy(pmsPriceRobotTasks.slot);
  // targetPrice 统一转为 Number，与 /tasks/pending 返回形状一致
  return c.json({ success: true, data: rows.map(r => ({ ...r, targetPrice: Number(r.targetPrice) })) });
});

// —— GET /api/price-robot/stats —— 今日效果（执行数 / 平均价 / 今日售出）
route.get('/stats', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const date = todayStr();
  const [tasks, auths] = await Promise.all([
    db.select().from(pmsPriceRobotTasks).where(and(eq(pmsPriceRobotTasks.storeId, storeId), eq(pmsPriceRobotTasks.date, date))),
    db.select().from(pmsPriceRobotAuth).where(and(eq(pmsPriceRobotAuth.storeId, storeId), eq(pmsPriceRobotAuth.date, date))),
  ]);
  const executed = tasks.filter(t => t.status === 'success');
  const avgPrice = executed.length > 0
    ? Math.round(executed.reduce((s, t) => s + Number(t.targetPrice || 0), 0) / executed.length)
    : 0;
  const orders = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.storeId, storeId), eq(pmsBuiOrders.channel, 'mini'))) as any[];
  const soldToday = orders.filter(o => o.status === 'confirmed' && o.checkIn === date).length;
  const fused = auths.some(a => a.status === 'fused');
  return c.json({ success: true, data: { date, executedCount: executed.length, avgPrice, soldToday, fused, confirmed: auths.length } });
});

// —— GET /api/price-robot/tasks/pending —— 客户端心跳拉取待执行任务（sk-）
route.get('/tasks/pending', async (c) => {
  const storeId = c.get('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少门店上下文' }, 401);
  const date = todayStr();
  const rows = await db.select().from(pmsPriceRobotTasks)
    .where(and(eq(pmsPriceRobotTasks.storeId, storeId), eq(pmsPriceRobotTasks.date, date), eq(pmsPriceRobotTasks.status, 'pending')))
    .orderBy(pmsPriceRobotTasks.slot);
  return c.json({ success: true, data: rows.map(r => ({
    id: r.id, slot: r.slot, roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName,
    channel: r.channel, targetPrice: Number(r.targetPrice), date: r.date,
    targetDate: r.targetDate ?? null, // 写价目标日期（二期未来窗；null 表示写当日）
    windowEndsAt: slotWindowEndsAt(r.slot), // 执行窗口结束时刻，客户端据此判断是否过期
  })) });
});

// —— POST /api/price-robot/tasks/:id/report —— 客户端上报执行结果（sk-）
route.post('/tasks/:id/report', async (c) => {
  const storeId = c.get('storeId');
  const { id } = c.req.param();
  const body = await c.req.json();
  const [task] = await db.select().from(pmsPriceRobotTasks).where(eq(pmsPriceRobotTasks.id, id));
  if (!task || task.storeId !== storeId) return c.json({ success: false, error: '任务不存在' }, 404);

  const status = body.status; // success/failed/rolled_back/skipped
  if (!['success', 'failed', 'rolled_back', 'skipped'].includes(status)) {
    return c.json({ success: false, error: '非法状态' }, 400);
  }

  // 状态守卫：仅 pending 任务可上报，终态任务禁止重复上报（防 success 被覆盖为 failed、重复追加日志）
  if (task.status !== 'pending') {
    return c.json({ success: false, error: '任务已终态，不可重复上报' }, 409);
  }

  // 校验可选数值字段（金额/耗时/次数），显式传入但非有限数字则拒绝
  const beforePrice = parseOptionalNumber(body.beforePrice);
  const afterPrice = parseOptionalNumber(body.afterPrice);
  const verifiedPrice = parseOptionalNumber(body.verifiedPrice);
  const latencyMs = parseOptionalNumber(body.latencyMs);
  const attempts = parseOptionalNumber(body.attempts);
  if ([beforePrice, afterPrice, verifiedPrice, latencyMs, attempts].some(v => Number.isNaN(v))) {
    return c.json({ success: false, error: '金额/耗时字段非法' }, 400);
  }

  await db.update(pmsPriceRobotTasks).set({
    status,
    verifiedPrice: verifiedPrice != null ? String(verifiedPrice) : task.verifiedPrice,
    error: body.error || null,
    executedAt: new Date(),
    latencyMs: latencyMs != null ? latencyMs : task.latencyMs,
  } as any).where(eq(pmsPriceRobotTasks.id, id));

  // 写执行日志
  await db.insert(pmsPriceRobotLogs).values({
    id: `prl_${id}_${Date.now()}`,
    taskId: id,
    beforePrice: beforePrice != null ? String(beforePrice) : null,
    afterPrice: afterPrice != null ? String(afterPrice) : null,
    readBackPrice: verifiedPrice != null ? String(verifiedPrice) : null,
    attempts: attempts ?? 1,
    browserSnapshot: body.browserSnapshot || null,
    operator: c.get('deviceId') || '',
    createdAt: new Date(),
  } as any);

  return c.json({ success: true });
});

// —— GET /api/price-robot/plan —— 未来价格日历（默认今天起 14 天）
route.get('/plan', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const start = c.req.query('start') || todayBj();
  const days = Number(c.req.query('days') || 14);
  // 校验 days / start，非法入参返回 400，避免日期解析抛错导致 500
  if (!Number.isFinite(days) || days <= 0 || days > 90) return c.json({ success: false, error: 'days 参数非法' }, 400);
  if (c.req.query('start') && Number.isNaN(Date.parse(start + 'T00:00:00Z'))) {
    return c.json({ success: false, error: 'start 参数非法' }, 400);
  }
  const end = new Date(new Date(start + 'T00:00:00Z').getTime() + days * 86400000).toISOString().split('T')[0];
  const rows = await db.select().from(pmsPriceRobotPlans)
    .where(and(eq(pmsPriceRobotPlans.storeId, storeId), gte(pmsPriceRobotPlans.planDate, start), lt(pmsPriceRobotPlans.planDate, end)))
    .orderBy(pmsPriceRobotPlans.planDate);
  return c.json({ success: true, data: rows.map(r => ({
    ...r, price: Number(r.price), basePrice: Number(r.basePrice),
  })) });
});

// —— PUT /api/price-robot/plan —— 逐日改计划价（编辑后重置 pending 需重新确认）
route.put('/plan', requirePermission('pricing:edit'), async (c) => {
  // 已由 /pricing-center 替代，v1 下线
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body = await c.req.json();
  const { planDate, roomTypeId, price } = body as { planDate?: string; roomTypeId?: string; price?: number };
  if (!planDate || !roomTypeId || !(Number(price) > 0)) return c.json({ success: false, error: '参数非法' }, 400);
  const id = `prp_${storeId}_${planDate}_${roomTypeId}`;
  const [existing] = await db.select().from(pmsPriceRobotPlans).where(eq(pmsPriceRobotPlans.id, id)).limit(1);
  if (!existing) return c.json({ success: false, error: '计划不存在，请先运行生成' }, 404);
  // 编辑已 confirmed/applied 的行会重置为 pending（需重新确认）
  await db.update(pmsPriceRobotPlans).set({ price: String(price), status: 'pending', updatedAt: new Date() } as any).where(eq(pmsPriceRobotPlans.id, id));
  return c.json({ success: true });
});

// —— POST /api/price-robot/plan/confirm —— 确认计划 → 为近端 3 天 confirmed 行生成写价任务
route.post('/plan/confirm', requirePermission('pricing:edit'), async (c) => {
  // 已由 /pricing-center 替代，v1 下线
  const scope = getTenantScope(c);
  const storeId = resolveStoreId(scope);
  const body = await c.req.json();
  const dates: string[] = Array.isArray(body.dates) ? body.dates : [];
  const today = todayBj();
  // 近端 3 天（今天起未来 3 天）
  const nearDates = [0, 1, 2].map(i => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().split('T')[0]; });
  const targetDates = dates.length > 0 ? dates : nearDates; // 默认确认近端 3 天

  let confirmed = 0, tasksGenerated = 0;
  const slot = nextHalfHour();
  for (const planDate of targetDates) {
    const isNear = nearDates.includes(planDate); // 是否近端 3 天（仅近端 3 天生成任务）
    // 重新确认前作废该目标日的旧 pending 任务（防止旧价任务残留执行），须在生成新任务之前逐日执行一次
    if (isNear) {
      await db.update(pmsPriceRobotTasks).set({ status: 'skipped', error: '计划更新，重新确认' })
        .where(and(eq(pmsPriceRobotTasks.storeId, storeId), eq(pmsPriceRobotTasks.targetDate, planDate), eq(pmsPriceRobotTasks.status, 'pending')));
    }
    const rows = await db.select().from(pmsPriceRobotPlans)
      .where(and(eq(pmsPriceRobotPlans.storeId, storeId), eq(pmsPriceRobotPlans.planDate, planDate)));
    for (const row of rows) {
      if (row.status === 'applied') continue;
      await db.update(pmsPriceRobotPlans).set({ status: 'confirmed', updatedAt: new Date() } as any).where(eq(pmsPriceRobotPlans.id, row.id));
      confirmed++;
      if (!isNear) continue; // 仅近端 3 天生成任务
      const [cfg] = await db.select().from(pmsPriceRobotConfig)
        .where(and(eq(pmsPriceRobotConfig.storeId, storeId), eq(pmsPriceRobotConfig.roomTypeId, row.roomTypeId))).limit(1);
      const channels: string[] = cfg?.channels || ['携程', '美团'];
      for (const ch of channels) {
        const taskId = `prt_${storeId}_${today}_${slot}_${row.roomTypeId}_${ch}_${planDate}`;
        await db.insert(pmsPriceRobotTasks).values({
          id: taskId, date: today, slot, merchantId: row.merchantId, storeId,
          roomTypeId: row.roomTypeId, roomTypeName: row.roomTypeName,
          channel: ch, targetDate: planDate, targetPrice: String(row.price), status: 'pending',
          createdAt: new Date(),
        } as any).onConflictDoNothing();
        tasksGenerated++;
      }
    }
  }
  return c.json({ success: true, data: { confirmed, tasksGenerated } });
});

export default route;
