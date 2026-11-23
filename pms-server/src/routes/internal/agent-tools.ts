import { Hono } from 'hono';
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiPricingCalendar,
  pmsBuiRoomTypes,
  pmsBuiRooms,
  pmsBuiOrders,
  pmsBuiChannels,
  pmsBuiCompetitorConfig,
  pmsBuiReviews,
  pmsBuiSettings,
} from '../../db/schema/index.js';
import { getTenantScope, tenantWhere } from '../../utils/tenant.js';
import { checkPriceAdjustment } from '../../services/price-guard.js';

/**
 * Agent 工具端点（挂载于 /api/internal/agent-tools/*）：9 个只读 GET（含 guest 知识检索、OTA 渠道同步状态、日营收），
 * 加唯一经人审的写端点 POST /price-adjust（乐观并发 + 业务护栏）。
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
  // 业务日按上海时区计算，与 pms-agent 的日期口径一致；
  // 直接 toISOString 用 UTC 日界，北京时间 00:00-08:00 会差一天。
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
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

/** 两个 YYYY-MM-DD 相差的天数（to - from），按 UTC 日界计算 */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );
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

// ====== 纯函数：评价汇总 ======

/** 评价汇总输入行（pms_bui_reviews 的只读投影） */
export interface ReviewSummaryRow {
  id: string;
  channelName: string;
  rating: number;
  content: string | null;
  reviewTime: string;
  replyStatus: string;
}

export interface ReviewsSummary {
  total: number;
  avgRating: number;
  lowRatingCount: number;
  pendingReplyCount: number;
  items: ReviewSummaryRow[];
}

/** 明细最多回显条数（聚合按全量计算，仅明细截断） */
export const REVIEWS_ITEMS_LIMIT = 20;

/**
 * 汇总评价（纯函数，不访问数据库）。
 *
 * 口径：
 * - avgRating = 全量评分均值，保留 2 位小数；无数据返回 0（不是 NaN）；
 * - lowRatingCount = rating <= 3 的条数（低分风险）；
 * - pendingReplyCount = replyStatus === 'pending' 的条数（待回复）；
 * - items 截断为前 20 条（调用方已按 reviewTime 倒序传入）。
 */
export function summarizeReviews(reviews: ReviewSummaryRow[]): ReviewsSummary {
  const total = reviews.length;
  const ratingSum = reviews.reduce((sum, row) => sum + toNumber(row.rating), 0);
  return {
    total,
    avgRating: total > 0 ? round2(ratingSum / total) : 0,
    lowRatingCount: reviews.filter((row) => toNumber(row.rating) <= 3).length,
    pendingReplyCount: reviews.filter((row) => row.replyStatus === 'pending').length,
    items: reviews.slice(0, REVIEWS_ITEMS_LIMIT),
  };
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

/** 价格日历 roomTypes JSONB 单项的真实载荷（与 seed / pricing 写入口径一致：不含 basePrice，基准价另查房型表） */
interface PricingCalendarItem {
  roomTypeId?: string;
  name?: string;
  price?: number;
  available?: number;
}

// ====== 纯函数：知识库检索 ======

/** 知识库条目（pms_bui_settings.category='kb_guide' 的只读投影） */
export interface KbEntry {
  id: string;
  title: string;
  content: string;
  guideType: string;
  metadata: Record<string, unknown> | null;
}

/**
 * 按关键词检索知识库条目（纯函数，不访问数据库）。
 *
 * 口径：任一关键词出现在 title 或 content 即命中（OR，大小写不敏感），
 * 按命中关键词数量降序排序；同分保持入参顺序（调用方已按 updatedAt 倒序传入），
 * 最多返回 limit 条。无关键词或全不命中返回空数组——调用方据此转人工，绝不编造。
 */
export function searchKbEntries(entries: KbEntry[], tokens: string[], limit = 5): KbEntry[] {
  const normalized = tokens.map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return [];
  const scored = entries
    .map((entry) => {
      const haystack = `${entry.title}\n${entry.content}`.toLowerCase();
      const score = normalized.filter((token) => haystack.includes(token)).length;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((item) => item.entry);
}

// ====== 纯函数：渠道同步状态 ======

/** 渠道同步原始行（pms_bui_channels 的只读投影） */
export interface ChannelSyncRow {
  channel: string;
  status: string;
  autoSync: boolean;
  syncInterval: number;
  lastSyncAt: string | null;
}

export interface ChannelSyncItem extends ChannelSyncRow {
  overdue: boolean;
  minutesSinceSync: number | null;
}

export interface ChannelSyncSummary {
  items: ChannelSyncItem[];
  overdueCount: number;
  abnormalCount: number;
}

/** 健康状态：兼容 seed 的 connected 与历史数据的 active */
const HEALTHY_CHANNEL_STATUSES = new Set(['connected', 'active']);

/**
 * 评估渠道同步状态（纯函数，不访问数据库）。
 *
 * 口径：
 * - 开启自动同步（autoSync）且「从未同步」或「距上次同步超过 2 倍同步周期」→ overdue；
 * - 关闭自动同步的渠道不参与超时判断（如直客渠道）；
 * - status 不在 connected/active 内 → abnormalCount +1，与超时分开计数。
 */
export function evaluateChannelSync(rows: ChannelSyncRow[], nowMs: number): ChannelSyncSummary {
  const items: ChannelSyncItem[] = rows.map((row) => {
    const interval = toNumber(row.syncInterval);
    const last = row.lastSyncAt ? new Date(row.lastSyncAt).getTime() : null;
    const minutesSinceSync = last != null && Number.isFinite(last)
      ? Math.max(0, Math.floor((nowMs - last) / 60000))
      : null;
    const overdue = Boolean(row.autoSync)
      && (minutesSinceSync == null || (interval > 0 && minutesSinceSync > interval * 2));
    return { ...row, overdue, minutesSinceSync };
  });
  return {
    items,
    overdueCount: items.filter((item) => item.overdue).length,
    abnormalCount: items.filter((item) => !HEALTHY_CHANNEL_STATUSES.has(item.status)).length,
  };
}

// ====== GET /pricing-calendar —— 当日各房型价格与基准价 ======
tools.get('/pricing-calendar', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const date = (c.req.query('date') || todayStr()).trim();
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

    // row.roomTypes 是 jsonb → unknown，用一次安全断言收敛到具名接口，不使用 any
    const calendarItems = (calendar.roomTypes ?? []) as PricingCalendarItem[];
    const items = calendarItems
      .map((item) => {
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
    const date = (c.req.query('date') || todayStr()).trim();
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
    const date = (c.req.query('date') || todayStr()).trim();
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
    const to = (c.req.query('to') || todayStr()).trim();
    const from = (c.req.query('from') || addDays(to, -29)).trim();
    if (!isValidDate(from) || !isValidDate(to)) {
      return c.json({ ok: false, error: 'from/to 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }
    if (from > to) {
      return c.json({ ok: false, error: 'from 不能晚于 to', latency_ms: Date.now() - started }, 400);
    }
    if (daysBetween(from, to) > 90) {
      return c.json({ ok: false, error: '日期区间不能超过 90 天', latency_ms: Date.now() - started }, 400);
    }

    // 聚合在内存完成（demo 数据量小），区间已限 90 天防止无界拉取；后续可下推 SQL 优化
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
    const month = (c.req.query('month') || todayStr().slice(0, 7)).trim();
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

// ====== GET /reviews-summary —— 近 N 天评价汇总（晨报体检） ======
tools.get('/reviews-summary', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const rawDays = (c.req.query('days') || '30').trim();
    // 只接受纯数字：拦掉 1.5 / abc / 空串等，避免 parseInt 静默截断
    if (!/^\d+$/.test(rawDays)) {
      return c.json({ ok: false, error: 'days 必须为 1..90 的整数', latency_ms: Date.now() - started }, 400);
    }
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return c.json({ ok: false, error: 'days 必须为 1..90 的整数', latency_ms: Date.now() - started }, 400);
    }
    // from 含当天：days=1 表示只看今天
    const from = addDays(todayStr(), -(days - 1));

    // reviewTime 是 varchar（YYYY-MM-DD），字典序即日期序，直接比较即可
    const rows = await db.select({
      id: pmsBuiReviews.id,
      channelName: pmsBuiReviews.channelName,
      rating: pmsBuiReviews.rating,
      content: pmsBuiReviews.content,
      reviewTime: pmsBuiReviews.reviewTime,
      replyStatus: pmsBuiReviews.replyStatus,
    }).from(pmsBuiReviews)
      .where(and(
        ...tenantWhere(scope, pmsBuiReviews),
        gte(pmsBuiReviews.reviewTime, from),
      ))
      .orderBy(desc(pmsBuiReviews.reviewTime));

    return c.json({
      ok: true,
      data: { days, from, ...summarizeReviews(rows) },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] reviews-summary 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /kb-search —— 住中客服知识检索（只读） ======
tools.get('/kb-search', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const q = (c.req.query('q') || '').trim();
    if (!q) {
      return c.json({ ok: false, error: 'q 不能为空', latency_ms: Date.now() - started }, 400);
    }
    if (q.length > 100) {
      return c.json({ ok: false, error: 'q 长度不能超过 100', latency_ms: Date.now() - started }, 400);
    }
    const rawLimit = (c.req.query('limit') || '5').trim();
    if (!/^\d+$/.test(rawLimit)) {
      return c.json({ ok: false, error: 'limit 必须为 1..10 的整数', latency_ms: Date.now() - started }, 400);
    }
    const limit = Math.min(Math.max(Number(rawLimit), 1), 10);
    // 关键词按空白/中英文逗号顿号切分，最多 6 个，避免超长 OR 匹配
    const tokens = q.toLowerCase().split(/[\s,，、]+/).filter(Boolean).slice(0, 6);

    // 只检索已发布的知识条目：草稿是后台待审内容，不能直接答复住客
    const rows = await db.select({
      id: pmsBuiSettings.id,
      value: pmsBuiSettings.value,
    }).from(pmsBuiSettings)
      .where(and(
        ...tenantWhere(scope, pmsBuiSettings),
        eq(pmsBuiSettings.category, 'kb_guide'),
        sql`${pmsBuiSettings.value}->>'status' = 'published'`,
      ))
      .orderBy(desc(pmsBuiSettings.updatedAt));

    const entries: KbEntry[] = rows.map((row) => {
      const value = (row.value ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        title: String(value.title ?? ''),
        content: String(value.content ?? ''),
        guideType: String(value.guide_type ?? ''),
        metadata: (value.metadata as Record<string, unknown> | undefined) ?? null,
      };
    });

    const items = searchKbEntries(entries, tokens, limit);
    return c.json({
      ok: true,
      data: { q, tokens, items, count: items.length },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] kb-search 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /channel-status —— 渠道同步状态（OTA 体检） ======
tools.get('/channel-status', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const rows = await db.select({
      name: pmsBuiChannels.name,
      status: pmsBuiChannels.status,
      autoSync: pmsBuiChannels.autoSync,
      syncInterval: pmsBuiChannels.syncInterval,
      lastSyncAt: pmsBuiChannels.lastSyncAt,
    }).from(pmsBuiChannels)
      .where(and(...tenantWhere(scope, pmsBuiChannels)))
      .orderBy(desc(pmsBuiChannels.updatedAt));

    const summary = evaluateChannelSync(
      rows.map((row) => ({
        channel: row.name,
        status: row.status || 'unknown',
        autoSync: row.autoSync !== false,
        syncInterval: toNumber(row.syncInterval),
        lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
      })),
      Date.now(),
    );

    return c.json({ ok: true, data: summary, latency_ms: Date.now() - started });
  } catch (err) {
    console.error('[agent-tools] channel-status 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== GET /daily-revenue —— 某日实际营收（归因 T+7 回填） ======
tools.get('/daily-revenue', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const date = (c.req.query('date') || '').trim();
    if (!isValidDate(date)) {
      return c.json({ ok: false, error: 'date 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }
    const rows = await db.select({
      status: pmsBuiOrders.status,
      totalPrice: pmsBuiOrders.totalPrice,
    }).from(pmsBuiOrders).where(and(
      ...tenantWhere(scope, pmsBuiOrders),
      eq(pmsBuiOrders.checkIn, date),
    ));

    const valid = rows.filter((order) => !NON_REVENUE_STATUSES.has(order.status));
    const revenue = round2(valid.reduce((sum, order) => sum + toNumber(order.totalPrice), 0));
    return c.json({
      ok: true,
      data: { date, revenue, orderCount: valid.length },
      latency_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('[agent-tools] daily-revenue 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

// ====== POST /price-adjust —— 调价写入（乐观并发 + 业务护栏）======
// 单次调价幅度上限（百分比）。暂为常量，后续可下沉为环境变量或租户级配置。
const DEFAULT_MAX_DELTA_PCT = 30;
// 房型未配置 minPrice 时，以 basePrice 乘该比例作为兜底底价（保守下限）。
const MIN_PRICE_FALLBACK_RATIO = 0.5;

/** 事务内权威价格校验失败时抛出：触发事务回滚，外层 catch 转 409 price_conflict。 */
class PriceConflictError extends Error {}

tools.post('/price-adjust', async (c) => {
  const started = Date.now();
  try {
    const scope = getTenantScope(c);
    const body = (await c.req.json()) as Record<string, unknown> | null;
    const { storeId, roomTypeId, date, expectedCurrentPrice, nextPrice, reason, approvalId } = body ?? {};

    // 1. 校验 approvalId 非空（调价需有审批单号留痕；审计落盘为后续任务，本任务仅做必填校验）
    if (typeof approvalId !== 'string' || !approvalId.trim()) {
      return c.json({ ok: false, error: 'approvalId 不能为空', latency_ms: Date.now() - started }, 400);
    }
    // 其余必填字段校验（调价理由 reason 也必填，审计落盘为后续任务，此处仅校验非空）
    if (typeof storeId !== 'string' || !storeId.trim()
      || typeof roomTypeId !== 'string' || !roomTypeId.trim()
      || typeof date !== 'string' || !date.trim()
      || typeof reason !== 'string' || !reason.trim()) {
      return c.json({ ok: false, error: 'storeId/roomTypeId/date/reason 必填', latency_ms: Date.now() - started }, 400);
    }
    if (!isValidDate(date)) {
      return c.json({ ok: false, error: 'date 格式非法，应为 YYYY-MM-DD', latency_ms: Date.now() - started }, 400);
    }
    // 价格必须为整数（schema basePrice/minPrice/price 均为 integer）；缺省/null 也在此拦截
    if (expectedCurrentPrice == null || nextPrice == null
      || !Number.isInteger(Number(expectedCurrentPrice)) || !Number.isInteger(Number(nextPrice))) {
      return c.json({ ok: false, error: 'expectedCurrentPrice/nextPrice 必须为整数', latency_ms: Date.now() - started }, 400);
    }
    const expected = Number(expectedCurrentPrice);
    const next = Number(nextPrice);

    // 防止带 X-Store-Id:A 却 body 写 B 的静默写错门店：scope 非通配时 body.storeId 必须一致
    if (scope.storeId && scope.storeId !== '*' && storeId !== scope.storeId) {
      return c.json({ ok: false, error: 'storeId 与请求门店上下文不一致', latency_ms: Date.now() - started }, 400);
    }

    // 2. 查询当前日历价格行（按租户隔离；scope.storeId 为 '*' 时用 body.storeId 精确定位日历行）
    const conditions: SQL[] = [
      ...tenantWhere(scope, pmsBuiPricingCalendar),
      eq(pmsBuiPricingCalendar.date, date),
    ];
    if (!scope.storeId || scope.storeId === '*') {
      conditions.push(eq(pmsBuiPricingCalendar.storeId, storeId));
    }
    const [calendar] = await db.select().from(pmsBuiPricingCalendar)
      .where(and(...conditions))
      .limit(1);
    if (!calendar) {
      return c.json({ ok: false, error: '日历数据不存在', latency_ms: Date.now() - started }, 404);
    }

    // 从 roomTypes JSONB 中定位目标房型，取当前价
    const items = (calendar.roomTypes ?? []) as PricingCalendarItem[];
    const item = items.find((it) => String(it?.roomTypeId ?? '') === roomTypeId);
    if (!item) {
      return c.json({ ok: false, error: '日历中未找到该房型', latency_ms: Date.now() - started }, 404);
    }
    const currentPrice = toNumber(item.price);

    // 3. 乐观并发预校验（快速失败；权威校验在事务内加行锁后重做，消除 TOCTOU 丢失更新）
    if (currentPrice !== expected) {
      return c.json({ ok: false, error: 'price_conflict', latency_ms: Date.now() - started }, 409);
    }

    // 查房型取 minPrice / basePrice（按租户隔离）；房型不存在 → 404，不静默回落 minPrice=0。
    const [roomType] = await db.select().from(pmsBuiRoomTypes)
      .where(and(
        ...tenantWhere(scope, pmsBuiRoomTypes),
        eq(pmsBuiRoomTypes.id, roomTypeId),
      ))
      .limit(1);
    if (!roomType) {
      return c.json({ ok: false, error: '房型不存在', latency_ms: Date.now() - started }, 404);
    }
    // minPrice 为 null 时回退 basePrice × MIN_PRICE_FALLBACK_RATIO 作为兜底底价（房型未配置最低价时的保守下限）
    const basePrice = toNumber(roomType.basePrice);
    const minPrice = roomType.minPrice != null ? toNumber(roomType.minPrice) : Math.round(basePrice * MIN_PRICE_FALLBACK_RATIO);

    // 4. 业务护栏校验，不通过 → 422
    const guard = checkPriceAdjustment({ currentPrice, nextPrice: next, minPrice, maxDeltaPct: DEFAULT_MAX_DELTA_PCT });
    if (!guard.ok) {
      return c.json({ ok: false, error: guard.reason ?? '调价被护栏拒绝', latency_ms: Date.now() - started }, 422);
    }

    // 5. 事务内对日历行加行锁（SELECT ... FOR UPDATE），重读价格做权威校验后写入：
    //    并发请求在该行锁上串行，后到者读到先到者已改的价格 → 与 expected 不符 → 抛错回滚 → 409，
    //    杜绝「读-比对-写」三条独立 await 导致的丢失更新。
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(pmsBuiPricingCalendar)
        .where(eq(pmsBuiPricingCalendar.id, calendar.id))
        .limit(1)
        .for('update');
      const lockedItems = (locked?.roomTypes ?? []) as PricingCalendarItem[];
      const lockedPrice = toNumber(
        lockedItems.find((it) => String(it?.roomTypeId ?? '') === roomTypeId)?.price,
      );
      // 权威校验：加锁后重读价格仍等于期望值才写入，否则回滚（外层转 409）
      if (lockedPrice !== expected) {
        throw new PriceConflictError();
      }
      const newItems = lockedItems.map((it) =>
        String(it?.roomTypeId ?? '') === roomTypeId ? { ...it, price: next } : it,
      );
      await tx.update(pmsBuiPricingCalendar)
        .set({ roomTypes: newItems, updatedAt: new Date() })
        .where(eq(pmsBuiPricingCalendar.id, calendar.id));
      return { before: lockedPrice, after: next, deltaPct: guard.deltaPct };
    });

    // 6. 返回调价前后与幅度
    return c.json({
      ok: true,
      data: result,
      latency_ms: Date.now() - started,
    }, 200);
  } catch (err) {
    if (err instanceof PriceConflictError) {
      return c.json({ ok: false, error: 'price_conflict', latency_ms: Date.now() - started }, 409);
    }
    console.error('[agent-tools] price-adjust 失败:', err);
    return c.json({ ok: false, error: '内部错误', latency_ms: Date.now() - started }, 500);
  }
});

export default tools;
