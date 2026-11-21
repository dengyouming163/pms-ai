// 微信入住订单智能录入路由
// 公开接口（H5 员工端，靠 storeId 定位门店）：POST /parse、POST /orders
// 平台端接口（JWT + merchantId 租户过滤）：GET /orders
import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { eq, and, or, like, desc, count, inArray, sql, sum, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiStores, pmsBuiCheckinOrders, pmsBuiStaff } from '../../db/schema/index.js';
import { parseCheckinText } from '../../services/checkin-parser.js';
import { serverError } from '../../lib/http-error.js';
import type { AuthUser } from '../../middleware/auth.js';

const route = new Hono<{ Variables: { authUser?: AuthUser } }>();
import { toDateOrNull } from '../../services/checkin-order/date-normalize.js';

async function resolveStore(storeId: string) {
  if (!storeId) return null;
  const [store] = await db
    .select({ id: pmsBuiStores.id, merchantId: pmsBuiStores.merchantId, name: pmsBuiStores.name })
    .from(pmsBuiStores)
    .where(eq(pmsBuiStores.id, storeId))
    .limit(1);
  return store || null;
}

// POST /api/checkin-h5/parse — 解析微信文本（公开，靠 storeId）
route.post('/parse', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { storeId, text } = body || {};
    const store = await resolveStore(String(storeId || ''));
    if (!store) return c.json({ success: false, error: '门店不存在' }, 404);
    const result = parseCheckinText(String(text || ''));
    return c.json({ success: true, storeName: store.name, ...result });
  } catch (err: any) {
    return serverError(c, err, '解析失败');
  }
});

// POST /api/checkin-h5/orders — 入库（公开，靠 storeId）
// 重复校验：未带 force 时，若存在「完全一样」的订单（姓名/电话/房型/入住/退房/晚数全部一致），
// 不入库并返回 duplicate + existing，由前端二次确认后带 force 再提交。
route.post('/orders', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { storeId, fields, rawText, force } = body || {};
    const store = await resolveStore(String(storeId || ''));
    if (!store) return c.json({ success: false, error: '门店不存在' }, 404);
    const f = fields || {};
    if (!f.guestName) return c.json({ success: false, error: '姓名必填' }, 400);

    // 日期列已改为 date 类型：空值必须落 NULL 而不是空串（date 列不接受 ''）。
    // 语义与改造前一致：原先 `= ''` 匹配「日期为空串的行」，现在 `IS NULL` 匹配「日期为 NULL 的行」。
    // 无年份脏值（如「10月18日」）的补年锚点显式取 UTC 年，与模块内 build()/nightsBetween() 的 UTC 口径保持一致。
    const fallbackYear = new Date().getUTCFullYear();
    const dupCheckIn = toDateOrNull(f.checkInDate, fallbackYear);
    const dupCheckOut = toDateOrNull(f.checkOutDate, fallbackYear);

    if (!force) {
      const [dup] = await db
        .select({ id: pmsBuiCheckinOrders.id, createdAt: pmsBuiCheckinOrders.createdAt })
        .from(pmsBuiCheckinOrders)
        .where(
          and(
            eq(pmsBuiCheckinOrders.storeId, store.id),
            eq(pmsBuiCheckinOrders.guestName, String(f.guestName || '')),
            eq(pmsBuiCheckinOrders.guestPhone, String(f.guestPhone || '')),
            eq(pmsBuiCheckinOrders.roomType, String(f.roomType || '')),
            dupCheckIn ? eq(pmsBuiCheckinOrders.checkInDate, dupCheckIn) : isNull(pmsBuiCheckinOrders.checkInDate),
            dupCheckOut ? eq(pmsBuiCheckinOrders.checkOutDate, dupCheckOut) : isNull(pmsBuiCheckinOrders.checkOutDate),
            eq(pmsBuiCheckinOrders.nights, Number(f.nights) || 1),
          ),
        )
        .limit(1);
      if (dup) {
        return c.json({
          success: true,
          duplicate: true,
          existing: { id: dup.id, createdAt: dup.createdAt },
        });
      }
    }

    const id = `checkin_${randomUUID()}`;
    await db.insert(pmsBuiCheckinOrders).values({
      id,
      merchantId: store.merchantId || 'default',
      storeId: store.id,
      guestName: String(f.guestName || ''),
      guestPhone: String(f.guestPhone || ''),
      adultCount: Number(f.adultCount) || 1,
      childCount: Number(f.childCount) || 0,
      roomType: String(f.roomType || ''),
      checkInDate: dupCheckIn,
      checkOutDate: dupCheckOut,
      nights: Number(f.nights) || 1,
      rawText: String(rawText || ''),
      staffName: String(f.staffName || ''),
    });
    return c.json({ success: true, id });
  } catch (err: any) {
    return serverError(c, err, '提交失败');
  }
});

// GET /api/checkin-h5/orders — 平台端列表（JWT 鉴权；无 merchantId 时返回全量，供平台运营查看全部商户）
route.get('/orders', async (c) => {
  try {
    const authUser = c.get('authUser');
    const merchantId = authUser?.merchantId || c.req.query().merchantId;
    const headerStoreId = c.req.header('X-Store-Id') || authUser?.homeStoreId;
    const { storeId, keyword, startDate, endDate, status, limit: limitRaw, offset: offsetRaw } = c.req.query();
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 200);
    const offset = Math.max(Number(offsetRaw) || 0, 0);

    const conditions: any[] = [];
    if (merchantId) conditions.push(eq(pmsBuiCheckinOrders.merchantId, merchantId));
    const effectiveStore = storeId || headerStoreId;
    if (effectiveStore && effectiveStore !== 'default_store') {
      conditions.push(eq(pmsBuiCheckinOrders.storeId, String(effectiveStore)));
    }
    if (keyword) {
      conditions.push(or(
        like(pmsBuiCheckinOrders.guestName, `%${keyword}%`),
        like(pmsBuiCheckinOrders.guestPhone, `%${keyword}%`),
      ));
    }
    if (status) conditions.push(eq(pmsBuiCheckinOrders.status, String(status)));
    if (startDate) conditions.push(sql`${pmsBuiCheckinOrders.checkInDate} >= ${startDate}`);
    if (endDate) conditions.push(sql`${pmsBuiCheckinOrders.checkInDate} <= ${endDate}`);

    const rows = await db.select().from(pmsBuiCheckinOrders)
      .where(and(...conditions))
      .orderBy(desc(pmsBuiCheckinOrders.createdAt))
      .limit(limit).offset(offset);
    const [totalRow] = await db.select({ c: count() }).from(pmsBuiCheckinOrders).where(and(...conditions));

    const storeIds = [...new Set(rows.map((r) => r.storeId).filter(Boolean))];
    let storeMap: Record<string, string> = {};
    if (storeIds.length) {
      const ss = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
        .from(pmsBuiStores).where(inArray(pmsBuiStores.id, storeIds));
      storeMap = Object.fromEntries(ss.map((s) => [s.id, s.name || s.id]));
    }
    const list = rows.map((r) => ({ ...r, storeName: storeMap[r.storeId] || r.storeId }));
    return c.json({ success: true, list, total: totalRow?.c || 0 });
  } catch (err: any) {
    return serverError(c, err, '订单查询失败');
  }
});

// GET /api/checkin-h5/stats — 门店「预计待结算/已结算」统计（员工 H5 公开，靠 storeId）
// 口径：pending = booked（待入住）+ checked_in（已入住），settled = completed（已结算）；
// 金额 = 结算金额合计（空值不参与金额、但计入订单数）。
route.get('/stats', async (c) => {
  try {
    const { storeId } = c.req.query();
    if (!storeId) return c.json({ success: false, error: '门店缺失' }, 400);
    const rows = await db
      .select({
        status: pmsBuiCheckinOrders.status,
        amount: sum(pmsBuiCheckinOrders.settlementAmount),
        cnt: count(),
      })
      .from(pmsBuiCheckinOrders)
      .where(and(
        eq(pmsBuiCheckinOrders.storeId, String(storeId)),
        // 待入住(booked) 与在住(checked_in) 同属「预计待结算」：booked 是平台端录入新增的初始态，
        // 若不纳入则这类订单在员工 H5 的统计卡片里完全不可见（口径落空）。
        inArray(pmsBuiCheckinOrders.status, ['booked', 'checked_in', 'completed']),
      ))
      .groupBy(pmsBuiCheckinOrders.status);
    let pending = { amount: 0, count: 0 };
    let settled = { amount: 0, count: 0 };
    for (const r of rows) {
      if (r.status === 'booked' || r.status === 'checked_in') {
        pending = { amount: (pending.amount + (Number(r.amount) || 0)), count: pending.count + (Number(r.cnt) || 0) };
      } else if (r.status === 'completed') {
        settled = { amount: Number(r.amount) || 0, count: Number(r.cnt) || 0 };
      }
    }
    return c.json({ success: true, pending, settled });
  } catch (err: any) {
    return serverError(c, err, '统计查询失败');
  }
});

// 入住订单允许的订单状态（平台端编辑用；与前端下拉一致）
const ORDER_STATUSES = ['checked_in', 'checked_out', 'completed', 'cancelled', 'refunded'] as const;
// 订单来源渠道（source 字段，默认 wechat）
const ORDER_SOURCES = ['wechat', 'douyin', 'meituan', 'ctrip', 'xiaohongshu', 'private_mini', 'other'] as const;
// 支付方式：online=线上支付 / offline=线下支付
const PAYMENT_METHODS = ['online', 'offline'] as const;

// PATCH /api/checkin-h5/orders/:id — 平台端编辑订单（状态/间夜数/订单总金额/结算金额/归属人/退款金额）
// 退款场景：前端同时传 refundAmount + settlementAmount（退款后结算金额）+ status='refunded'，一次更新完成部分退款。
route.patch('/orders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const { status, nights, totalAmount, settlementAmount, refundAmount, staffName, source, paymentMethod } = body || {};

    const [order] = await db
      .select({ id: pmsBuiCheckinOrders.id })
      .from(pmsBuiCheckinOrders)
      .where(eq(pmsBuiCheckinOrders.id, id))
      .limit(1);
    if (!order) return c.json({ success: false, error: '订单不存在' }, 404);

    const updates: Record<string, any> = { updatedAt: new Date() };

    if (status !== undefined) {
      if (!(ORDER_STATUSES as readonly string[]).includes(String(status))) {
        return c.json({ success: false, error: '非法的订单状态' }, 400);
      }
      updates.status = String(status);
    }
    if (nights !== undefined) {
      const n = Number(nights);
      if (!Number.isInteger(n) || n < 0) {
        return c.json({ success: false, error: '间夜数须为非负整数' }, 400);
      }
      updates.nights = n;
    }
    // 金额字段（元，numeric(10,2)）：空值回落 null
    if (totalAmount !== undefined) {
      updates.totalAmount = totalAmount === '' || totalAmount === null ? null : String(totalAmount);
    }
    if (settlementAmount !== undefined) {
      updates.settlementAmount = settlementAmount === '' || settlementAmount === null ? null : String(settlementAmount);
    }
    if (refundAmount !== undefined) {
      updates.refundAmount = refundAmount === '' || refundAmount === null ? null : String(refundAmount);
    }
    if (staffName !== undefined) {
      updates.staffName = String(staffName || '');
    }
    // 订单来源渠道（校验枚举）
    if (source !== undefined && source !== '' && source !== null) {
      if (!(ORDER_SOURCES as readonly string[]).includes(String(source))) {
        return c.json({ success: false, error: '非法的订单来源' }, 400);
      }
      updates.source = String(source);
    }
    // 支付方式（online/offline，可为空）
    if (paymentMethod !== undefined) {
      if (paymentMethod !== '' && paymentMethod !== null && !(PAYMENT_METHODS as readonly string[]).includes(String(paymentMethod))) {
        return c.json({ success: false, error: '非法的支付方式' }, 400);
      }
      updates.paymentMethod = paymentMethod === '' || paymentMethod === null ? null : String(paymentMethod);
    }

    await db.update(pmsBuiCheckinOrders).set(updates).where(eq(pmsBuiCheckinOrders.id, id));
    return c.json({ success: true });
  } catch (err: any) {
    return serverError(c, err, '订单更新失败');
  }
});

// GET /api/checkin-h5/staff — 平台端「归属人」下拉：全平台 active 员工（运营中心跨商户作业，可指派任意商户员工）
route.get('/staff', async (c) => {
  try {
    const staff = await db
      .select({ id: pmsBuiStaff.id, name: pmsBuiStaff.name })
      .from(pmsBuiStaff)
      .where(eq(pmsBuiStaff.status, 'active'))
      .orderBy(desc(pmsBuiStaff.createdAt))
      .limit(200);
    return c.json({ success: true, list: staff });
  } catch (err: any) {
    return serverError(c, err, '员工查询失败');
  }
});

// 报表维度：订单来源渠道中文名映射（与前端 SOURCE_OPTIONS 一致）
const REPORT_SOURCE_NAMES: Record<string, string> = {
  wechat: '微信', douyin: '抖音', meituan: '美团', ctrip: '携程',
  xiaohongshu: '小红书', private_mini: '私域小程序', other: '其他',
};

// GET /api/checkin-h5/reports/settlement — 结算报表（按门店汇总）
// 口径：排除已取消(cancelled)作废单；结算金额按状态四拆为「待入住 / 在住 / 已离店待结算 / 已结算」；
// 「未结算金额」= 待入住 + 在住 + 已离店；退款金额单列、不参与结算口径。
route.get('/reports/settlement', async (c) => {
  try {
    const authUser = c.get('authUser');
    const merchantId = authUser?.merchantId || c.req.query().merchantId;
    const { startDate, endDate, storeId } = c.req.query();

    const conditions: any[] = [sql`${pmsBuiCheckinOrders.status} <> 'cancelled'`];
    if (merchantId) conditions.push(eq(pmsBuiCheckinOrders.merchantId, merchantId));
    if (storeId) conditions.push(eq(pmsBuiCheckinOrders.storeId, String(storeId)));
    if (startDate) conditions.push(sql`${pmsBuiCheckinOrders.checkInDate} >= ${startDate}`);
    if (endDate) conditions.push(sql`${pmsBuiCheckinOrders.checkInDate} <= ${endDate}`);

    const rows = await db
      .select({
        storeId: pmsBuiCheckinOrders.storeId,
        orderCount: count(),
        nights: sum(pmsBuiCheckinOrders.nights),
        settlementAmount: sum(pmsBuiCheckinOrders.settlementAmount),
        // 「未结算金额」：待入住 + 在住 + 已离店（改造前口径是 checked_in 单项，故此处语义扩展，
        // 前端卡片标签同步改为「未结算金额」）
        pendingSettlementAmount: sql<string>`coalesce(sum(${pmsBuiCheckinOrders.settlementAmount}) filter (where ${pmsBuiCheckinOrders.status} in ('booked','checked_in','checked_out')), 0)`,
        // 三拆明细：让新状态在报表里不落空（规格 §9）
        bookedAmount: sql<string>`coalesce(sum(${pmsBuiCheckinOrders.settlementAmount}) filter (where ${pmsBuiCheckinOrders.status} = 'booked'), 0)`,
        bookedOrderCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'booked')`,
        inHouseAmount: sql<string>`coalesce(sum(${pmsBuiCheckinOrders.settlementAmount}) filter (where ${pmsBuiCheckinOrders.status} = 'checked_in'), 0)`,
        inHouseOrderCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'checked_in')`,
        awaitingAmount: sql<string>`coalesce(sum(${pmsBuiCheckinOrders.settlementAmount}) filter (where ${pmsBuiCheckinOrders.status} = 'checked_out'), 0)`,
        awaitingOrderCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'checked_out')`,
        settledAmount: sql<string>`coalesce(sum(${pmsBuiCheckinOrders.settlementAmount}) filter (where ${pmsBuiCheckinOrders.status} = 'completed'), 0)`,
        settledOrderCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'completed')`,
        refundAmount: sum(pmsBuiCheckinOrders.refundAmount),
        refundOrderCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.refundAmount} is not null)`,
      })
      .from(pmsBuiCheckinOrders)
      .where(and(...conditions))
      .groupBy(pmsBuiCheckinOrders.storeId);

    const storeIds = rows.map((r) => r.storeId).filter(Boolean);
    let storeMap: Record<string, string> = {};
    if (storeIds.length) {
      const ss = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
        .from(pmsBuiStores).where(inArray(pmsBuiStores.id, storeIds));
      storeMap = Object.fromEntries(ss.map((s) => [s.id, s.name || s.id]));
    }

    const list = rows.map((r) => ({
      storeId: r.storeId,
      storeName: storeMap[r.storeId] || r.storeId,
      orderCount: Number(r.orderCount) || 0,
      nights: Number(r.nights) || 0,
      settlementAmount: Number(r.settlementAmount) || 0,
      pendingSettlementAmount: Number(r.pendingSettlementAmount) || 0,
      bookedAmount: Number(r.bookedAmount) || 0,
      bookedOrderCount: Number(r.bookedOrderCount) || 0,
      inHouseAmount: Number(r.inHouseAmount) || 0,
      inHouseOrderCount: Number(r.inHouseOrderCount) || 0,
      awaitingAmount: Number(r.awaitingAmount) || 0,
      awaitingOrderCount: Number(r.awaitingOrderCount) || 0,
      settledAmount: Number(r.settledAmount) || 0,
      settledOrderCount: Number(r.settledOrderCount) || 0,
      refundAmount: Number(r.refundAmount) || 0,
      refundOrderCount: Number(r.refundOrderCount) || 0,
    }));
    list.sort((a, b) => b.settlementAmount - a.settlementAmount);

    const summary = {
      storeCount: list.length,
      orderCount: list.reduce((a, x) => a + x.orderCount, 0),
      nights: list.reduce((a, x) => a + x.nights, 0),
      settlementAmount: list.reduce((a, x) => a + x.settlementAmount, 0),
      pendingSettlementAmount: list.reduce((a, x) => a + x.pendingSettlementAmount, 0),
      bookedAmount: list.reduce((a, x) => a + x.bookedAmount, 0),
      bookedOrderCount: list.reduce((a, x) => a + x.bookedOrderCount, 0),
      inHouseAmount: list.reduce((a, x) => a + x.inHouseAmount, 0),
      inHouseOrderCount: list.reduce((a, x) => a + x.inHouseOrderCount, 0),
      awaitingAmount: list.reduce((a, x) => a + x.awaitingAmount, 0),
      awaitingOrderCount: list.reduce((a, x) => a + x.awaitingOrderCount, 0),
      settledAmount: list.reduce((a, x) => a + x.settledAmount, 0),
      settledOrderCount: list.reduce((a, x) => a + x.settledOrderCount, 0),
      refundAmount: list.reduce((a, x) => a + x.refundAmount, 0),
      refundOrderCount: list.reduce((a, x) => a + x.refundOrderCount, 0),
    };
    return c.json({ success: true, list, summary });
  } catch (err: any) {
    return serverError(c, err, '结算报表查询失败');
  }
});

// GET /api/checkin-h5/reports/operation — 内部运营报表（按维度汇总）
// dimension: time=按入住日 / store=按门店 / source=按来源渠道
route.get('/reports/operation', async (c) => {
  try {
    const authUser = c.get('authUser');
    const merchantId = authUser?.merchantId || c.req.query().merchantId;
    const { dimension = 'time', startDate, endDate, storeId, source } = c.req.query();
    const dim = ['time', 'store', 'source'].includes(String(dimension)) ? String(dimension) : 'time';

    const conditions: any[] = [sql`${pmsBuiCheckinOrders.status} <> 'cancelled'`];
    if (merchantId) conditions.push(eq(pmsBuiCheckinOrders.merchantId, merchantId));
    if (storeId) conditions.push(eq(pmsBuiCheckinOrders.storeId, String(storeId)));
    if (source) conditions.push(eq(pmsBuiCheckinOrders.source, String(source)));
    if (startDate) conditions.push(sql`${pmsBuiCheckinOrders.checkInDate} >= ${startDate}`);
    if (endDate) conditions.push(sql`${pmsBuiCheckinOrders.checkInDate} <= ${endDate}`);

    const groupKey = dim === 'time' ? pmsBuiCheckinOrders.checkInDate
      : dim === 'source' ? pmsBuiCheckinOrders.source
      : pmsBuiCheckinOrders.storeId;

    const rows = await db
      .select({
        key: groupKey,
        orderCount: count(),
        nights: sum(pmsBuiCheckinOrders.nights),
        totalAmount: sum(pmsBuiCheckinOrders.totalAmount),
        settlementAmount: sum(pmsBuiCheckinOrders.settlementAmount),
        refundAmount: sum(pmsBuiCheckinOrders.refundAmount),
        refundOrderCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.refundAmount} is not null)`,
        bookedCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'booked')`,
        checkedInCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'checked_in')`,
        checkedOutCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'checked_out')`,
        completedCount: sql<number>`count(*) filter (where ${pmsBuiCheckinOrders.status} = 'completed')`,
      })
      .from(pmsBuiCheckinOrders)
      .where(and(...conditions))
      .groupBy(groupKey);

    let labelMap: Record<string, string> = {};
    if (dim === 'store') {
      const ids = rows.map((r) => String(r.key)).filter(Boolean);
      if (ids.length) {
        const ss = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
          .from(pmsBuiStores).where(inArray(pmsBuiStores.id, ids));
        labelMap = Object.fromEntries(ss.map((s) => [s.id, s.name || s.id]));
      }
    }

    const list = rows.map((r) => {
      const key = String(r.key || '');
      const orderCount = Number(r.orderCount) || 0;
      const totalAmount = Number(r.totalAmount) || 0;
      const settlementAmount = Number(r.settlementAmount) || 0;
      const refundAmount = Number(r.refundAmount) || 0;
      const grossProfit = totalAmount - settlementAmount;
      const grossMargin = totalAmount > 0 ? (grossProfit / totalAmount) * 100 : 0;
      const label = dim === 'time' ? key
        : dim === 'source' ? (REPORT_SOURCE_NAMES[key] || key)
        : (labelMap[key] || key);
      return {
        key, label, orderCount, nights: Number(r.nights) || 0,
        totalAmount, settlementAmount, grossProfit,
        grossMargin: Math.round(grossMargin * 100) / 100,
        refundAmount, refundOrderCount: Number(r.refundOrderCount) || 0,
        bookedCount: Number(r.bookedCount) || 0,
        checkedInCount: Number(r.checkedInCount) || 0,
        checkedOutCount: Number(r.checkedOutCount) || 0,
        completedCount: Number(r.completedCount) || 0,
        avgOrderValue: orderCount > 0 ? Math.round((totalAmount / orderCount) * 100) / 100 : 0,
      };
    });
    list.sort((a, b) => b.totalAmount - a.totalAmount);

    const summary: Record<string, number> = {
      orderCount: list.reduce((a, x) => a + x.orderCount, 0),
      nights: list.reduce((a, x) => a + x.nights, 0),
      totalAmount: list.reduce((a, x) => a + x.totalAmount, 0),
      settlementAmount: list.reduce((a, x) => a + x.settlementAmount, 0),
      grossProfit: list.reduce((a, x) => a + x.grossProfit, 0),
      refundAmount: list.reduce((a, x) => a + x.refundAmount, 0),
      refundOrderCount: list.reduce((a, x) => a + x.refundOrderCount, 0),
      bookedCount: list.reduce((a, x) => a + x.bookedCount, 0),
      checkedInCount: list.reduce((a, x) => a + x.checkedInCount, 0),
      checkedOutCount: list.reduce((a, x) => a + x.checkedOutCount, 0),
      completedCount: list.reduce((a, x) => a + x.completedCount, 0),
    };
    summary.grossMargin = summary.totalAmount > 0 ? Math.round((summary.grossProfit / summary.totalAmount) * 10000) / 100 : 0;
    summary.avgOrderValue = summary.orderCount > 0 ? Math.round((summary.totalAmount / summary.orderCount) * 100) / 100 : 0;

    return c.json({ success: true, dimension: dim, list, summary });
  } catch (err: any) {
    return serverError(c, err, '运营报表查询失败');
  }
});

export default route;
