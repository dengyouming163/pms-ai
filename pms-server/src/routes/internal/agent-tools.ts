import { Hono } from 'hono';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiPricingCalendar,
  pmsBuiRoomTypes,
  pmsBuiRooms,
  pmsBuiOrders,
  pmsBuiChannels,
  pmsBuiCompetitorConfig,
} from '../../db/schema/index.js';
import { getTenantScope, tenantWhere } from '../../utils/tenant.js';

/**
 * Agent 专用只读工具端点（挂载于 /api/internal/agent-tools/*）。
 *
 * 鉴权与脱敏由 index.ts 对 /api/internal/* 统一挂载的 internalAuthMiddleware +
 * dataMaskMiddleware 负责，本文件不重复实现。
 *
 * ⚠️ dataMaskMiddleware 会把响应对象中键名恰为 `name` 的字符串当作 PII 脱敏，
 * 因此这里的响应统一使用 roomTypeName / hotelName / channel 等键名，避免房型名、竞品名被误打码。
 */

const tools = new Hono();

// ====== 通用工具 ======

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 订单状态中不计入营收的口径（与 /api/internal/ai-tools/finance/summary 保持一致） */
const NON_REVENUE_STATUSES = new Set(['cancelled', 'no_show']);

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** 按 UTC 加减天数，返回 YYYY-MM-DD */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 月份边界：start=YYYY-MM-01，end=当月最后一天，days=当月天数 */
function monthBounds(month: string): { start: string; end: string; days: number } {
  const [year, mon] = month.split('-').map(Number);
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, '0')}`, days };
}

/** numeric/varchar 列统一转数字；非法值（NaN/Infinity）回落 0 */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ====== 纯函数：入住率快照 ======

export interface PricingSnapshotInput {
  date: string;
  rooms: { status: string }[];
}

export interface PricingSnapshot {
  date: string;
  total: number;
  available: number;
  occupied: number;
  booked: number;
  dirty: number;
  maintenance: number;
  occupancyRate: number;
}

/**
 * 计算某日入住率快照（纯函数，不访问数据库）。
 *
 * 口径（按 Task 5 规格，与 /api/internal/ai-tools/rooms/status 保持一致）：
 * - available = status === 'available' 的数量；
 * - occupied = status === 'occupied'（已入住），booked = status === 'booked'（已预订未入住）；
 * - 入住率（售出入住率）= round((occupied + booked) / total * 100)，
 *   total 为 0 时返回 0（不是 NaN）；
 * - dirty / maintenance 仅计数回显，不参与分子。
 */
export function buildPricingSnapshot(input: PricingSnapshotInput): PricingSnapshot {
  const rooms = input.rooms ?? [];
  const total = rooms.length;
  const count = (s: string) => rooms.filter((r) => r.status === s).length;
  const available = count('available');
  const occupied = count('occupied');
  const booked = count('booked');
  const dirty = count('dirty');
  const maintenance = count('maintenance');
  const occupancyRate = total > 0 ? Math.round(((occupied + booked) / total) * 100) : 0;
  return { date: input.date, total, available, occupied, booked, dirty, maintenance, occupancyRate };
}

// ====== GET /pricing-calendar —— 当日各房型价格与基准价 ======
tools.get('/pricing-calendar', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const date = c.req.query('date') || todayStr();
    if (!isValidDate(date)) {
      return c.json({ ok: false, error: 'date 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }
    const roomTypeId = (c.req.query('roomTypeId') || '').trim();

    const [calendar] = await db.select().from(pmsBuiPricingCalendar)
      .where(and(...tenantWhere(scope, pmsBuiPricingCalendar), eq(pmsBuiPricingCalendar.date, date)))
      .limit(1);
    // 规格：无数据返回空数组而非 404
    if (!calendar) {
      const isWeekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
      return c.json({
        ok: true,
        data: { date, isWeekend, isHoliday: false, items: [] },
        latency_ms: Date.now() - started,
      });
    }

    // 价格日历 roomTypes 是 JSONB [{ roomTypeId?, name, price, available }]，
    // 基准价/周末价需要从房型表补查（按 roomTypeId 优先、name 兜底，与 utils/mini-price.ts 口径一致）。
    const roomTypes = await db.select().from(pmsBuiRoomTypes)
      .where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
    const byId = new Map(roomTypes.map((rt) => [rt.id, rt]));
    const byName = new Map(roomTypes.map((rt) => [rt.name, rt]));

    const calendarItems = Array.isArray(calendar.roomTypes) ? (calendar.roomTypes as any[]) : [];
    const items = calendarItems
      .map((item: any) => {
        const rt = (item?.roomTypeId ? byId.get(String(item.roomTypeId)) : undefined)
          || (item?.name ? byName.get(String(item.name)) : undefined);
        return {
          roomTypeId: String(item?.roomTypeId ?? rt?.id ?? ''),
          roomTypeName: String(item?.name ?? rt?.name ?? ''),
          price: toNumber(item?.price),
          basePrice: toNumber(rt?.basePrice),
          weekendPrice: rt?.weekendPrice ?? null,
          available: item?.available != null ? toNumber(item.available) : null,
        };
      })
      .filter((item) => !roomTypeId || item.roomTypeId === roomTypeId);

    // roomTypeId 过滤后无匹配也返回空数组（规格：无数据返回空数组而非 404）
    return c.json({
      ok: true,
      data: { date, isWeekend: calendar.isWeekend, isHoliday: calendar.isHoliday, items },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] pricing-calendar 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /occupancy —— 房间状态汇总与入住率 ======
tools.get('/occupancy', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const date = c.req.query('date') || todayStr();
    if (!isValidDate(date)) {
      return c.json({ ok: false, error: 'date 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }

    // 房间表只有实时状态快照（无历史房态表），date 仅回显，不参与过滤。
    const rooms = await db.select({ status: pmsBuiRooms.status }).from(pmsBuiRooms)
      .where(and(...tenantWhere(scope, pmsBuiRooms)));

    const snapshot = buildPricingSnapshot({ date, rooms });
    const statusCounts: Record<string, number> = {};
    for (const room of rooms) {
      const key = room.status || 'unknown';
      statusCounts[key] = (statusCounts[key] || 0) + 1;
    }

    return c.json({
      ok: true,
      data: { ...snapshot, statusCounts },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] occupancy 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /competitor-prices —— 竞对价列表与均值 ======
tools.get('/competitor-prices', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const date = c.req.query('date') || todayStr();
    if (!isValidDate(date)) {
      return c.json({ ok: false, error: 'date 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }
    const roomTypeId = (c.req.query('roomTypeId') || '').trim();

    const conditions: SQL[] = [
      ...tenantWhere(scope, pmsBuiCompetitorConfig),
      eq(pmsBuiCompetitorConfig.status, 'active'),
    ];
    if (roomTypeId) conditions.push(eq(pmsBuiCompetitorConfig.ourRoomTypeId, roomTypeId));

    // 表内能力降级：pms_bui_competitor_config 只保留最近一次爬取价（lastPrice + lastCrawledAt），
    // 没有按日期的价格列，因此 date 仅校验并回显，不参与过滤（避免按默认日期过滤后恒为空）。
    const configs = await db.select().from(pmsBuiCompetitorConfig).where(and(...conditions));

    const items = configs
      .filter((cfg) => cfg.lastPrice != null)
      .map((cfg) => ({
        competitorId: cfg.id,
        hotelName: cfg.hotelName,
        platform: cfg.platform,
        competitorRoomType: cfg.competitorRoomType || '',
        price: toNumber(cfg.lastPrice),
        lastCrawledAt: cfg.lastCrawledAt ? new Date(cfg.lastCrawledAt).toISOString() : null,
      }));

    const avgPrice = items.length > 0
      ? round2(items.reduce((sum, item) => sum + item.price, 0) / items.length)
      : 0;

    return c.json({
      ok: true,
      data: { date, roomTypeId: roomTypeId || null, items, avgPrice, count: items.length },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] competitor-prices 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /channel-performance —— 各渠道订单量/成交额/佣金/超时数 ======
tools.get('/channel-performance', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const to = c.req.query('to') || todayStr();
    const from = c.req.query('from') || addDays(to, -29);
    if (!isValidDate(from) || !isValidDate(to)) {
      return c.json({ ok: false, error: 'from/to 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }
    if (from > to) {
      return c.json({ ok: false, error: 'from 不能晚于 to', latency_ms: Date.now() - started }, 400);
    }

    const orders = await db.select({
      channel: pmsBuiOrders.channel,
      status: pmsBuiOrders.status,
      totalPrice: pmsBuiOrders.totalPrice,
      otaTimeout: pmsBuiOrders.otaTimeout,
    }).from(pmsBuiOrders).where(and(
      ...tenantWhere(scope, pmsBuiOrders),
      sql`${pmsBuiOrders.createdAt}::date >= ${from}::date`,
      sql`${pmsBuiOrders.createdAt}::date <= ${to}::date`,
    ));

    // 订单表没有佣金列，佣金按渠道表的 commission_rate（百分比）估算：
    // commission = 成交额 × commission_rate / 100。
    const channels = await db.select({
      name: pmsBuiChannels.name,
      commissionRate: pmsBuiChannels.commissionRate,
    }).from(pmsBuiChannels).where(and(...tenantWhere(scope, pmsBuiChannels)));
    const rateByChannel = new Map(channels.map((ch) => [ch.name, toNumber(ch.commissionRate)]));

    const now = Date.now();
    const rows = new Map<string, {
      channel: string; orderCount: number; revenue: number; commission: number; timeoutCount: number;
    }>();

    for (const order of orders) {
      const channel = order.channel || '未知渠道';
      let row = rows.get(channel);
      if (!row) {
        row = { channel, orderCount: 0, revenue: 0, commission: 0, timeoutCount: 0 };
        rows.set(channel, row);
      }
      row.orderCount += 1;
      if (!NON_REVENUE_STATUSES.has(order.status)) {
        row.revenue += toNumber(order.totalPrice);
      }
      // 超时口径：ota_timeout 已过当前时间（即已错过接单时限）。
      if (order.otaTimeout && new Date(order.otaTimeout).getTime() < now) {
        row.timeoutCount += 1;
      }
    }

    const items = [...rows.values()].map((row) => {
      const rate = rateByChannel.get(row.channel) ?? 0;
      return {
        channel: row.channel,
        orderCount: row.orderCount,
        revenue: round2(row.revenue),
        commissionRate: round2(rate),
        commission: round2((row.revenue * rate) / 100),
        timeoutCount: row.timeoutCount,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    return c.json({
      ok: true,
      data: {
        from,
        to,
        items,
        orderCount: items.reduce((sum, item) => sum + item.orderCount, 0),
        revenue: round2(items.reduce((sum, item) => sum + item.revenue, 0)),
        commission: round2(items.reduce((sum, item) => sum + item.commission, 0)),
        timeoutCount: items.reduce((sum, item) => sum + item.timeoutCount, 0),
      },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] channel-performance 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /finance-summary —— 当月营收/ADR/RevPAR ======
tools.get('/finance-summary', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const month = c.req.query('month') || todayStr().slice(0, 7);
    if (!MONTH_RE.test(month)) {
      return c.json({ ok: false, error: 'month 格式非法，应为 YYYY-MM', latency_ms: Date.now() - started }, 400);
    }
    const { start, end, days } = monthBounds(month);
    const nextStart = addDays(end, 1);

    const orders = await db.select({
      status: pmsBuiOrders.status,
      totalPrice: pmsBuiOrders.totalPrice,
      nights: pmsBuiOrders.nights,
    }).from(pmsBuiOrders).where(and(
      ...tenantWhere(scope, pmsBuiOrders),
      sql`${pmsBuiOrders.createdAt}::date >= ${start}::date`,
      sql`${pmsBuiOrders.createdAt}::date < ${nextStart}::date`,
    ));

    const validOrders = orders.filter((o) => !NON_REVENUE_STATUSES.has(o.status));
    const revenue = round2(validOrders.reduce((sum, o) => sum + toNumber(o.totalPrice), 0));
    const nights = validOrders.reduce((sum, o) => sum + toNumber(o.nights), 0);

    // 可售房数 = 门店在库房间数 × 当月天数（房间表即物理房量）
    const roomCountResult = await db.select({ count: sql<number>`count(*)` })
      .from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));
    const roomCount = toNumber(roomCountResult[0]?.count);

    const adr = nights > 0 ? round2(revenue / nights) : 0;
    const revpar = roomCount > 0 ? round2(revenue / (roomCount * days)) : 0;

    return c.json({
      ok: true,
      data: {
        month,
        revenue,
        adr,
        revpar,
        orderCount: validOrders.length,
        nights,
        roomCount,
        daysInMonth: days,
      },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] finance-summary 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

export default tools;
