import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index';
import {
  pmsBuiPricingRules,
  pmsBuiPricingCalendar,
  pmsBuiPromotions,
  pmsBuiAiSuggestions,
  pmsBuiChannels,
  pmsBuiRoomTypes,
  pmsBuiRooms,
  pmsBuiOrders,
} from '../db/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { getTenantScope, tenantWhere } from '../utils/tenant';
import type { TenantScope } from '../utils/tenant';
import { requirePermission } from '../middleware/permission-guard.js';

const route = new Hono();

// ---------------------------------------------------------------------------
// Helper: 从 DB 真实数据构建 CalendarDay[]（渠道加价率 / 房间数 / 房型名称）
// ---------------------------------------------------------------------------
async function buildCalendarDays(calendarRows: any[], scope: TenantScope) {
  // 从渠道表读取真实加价率
  const channels = await db
    .select()
    .from(pmsBuiChannels)
    .where(and(...tenantWhere(scope, pmsBuiChannels)));
  const channelMarkup: Record<string, number> = {};
  channels.forEach((ch) => {
    channelMarkup[ch.name] = 1 + (Number(ch.commissionRate) || 10) / 100;
  });
  // 确保直营渠道有默认值
  if (!channelMarkup['直营']) channelMarkup['直营'] = 1.0;

  // 从房型表读取真实房型数据
  const roomTypesFromDb = await db
    .select()
    .from(pmsBuiRoomTypes)
    .where(and(...tenantWhere(scope, pmsBuiRoomTypes)));

  // 从房间表统计每个房型的真实房间数量 + 不可用房间数（维修/锁房）
  const allRooms = await db
    .select()
    .from(pmsBuiRooms)
    .where(and(...tenantWhere(scope, pmsBuiRooms)));
  const roomCountByType: Record<string, number> = {};
  // 维修/锁房的房间在任何日期都不可用
  const unavailableByType: Record<string, number> = {};
  allRooms.forEach((r) => {
    roomCountByType[r.roomTypeId] =
      (roomCountByType[r.roomTypeId] || 0) + 1;
    if (r.status === 'maintenance' || r.status === 'locked') {
      unavailableByType[r.roomTypeId] =
        (unavailableByType[r.roomTypeId] || 0) + 1;
    }
  });

  // ---- 确定日历日期范围，查询该范围内的订单 ----
  let dateRangeStart: string;
  let dateRangeEnd: string;
  if (calendarRows.length > 0) {
    dateRangeStart = String(calendarRows[0].date);
    dateRangeEnd = String(calendarRows[calendarRows.length - 1].date);
  } else {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    dateRangeStart = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    dateRangeEnd = `${year}-${String(month + 1).padStart(2, '0')}-${new Date(year, month + 1, 0).getDate()}`;
  }

  const ordersInRange = await db
    .select()
    .from(pmsBuiOrders)
    .where(
      and(
        ...tenantWhere(scope, pmsBuiOrders),
        sql`${pmsBuiOrders.checkIn} <= ${dateRangeEnd}`,
        sql`${pmsBuiOrders.checkOut} >= ${dateRangeStart}`,
        sql`${pmsBuiOrders.status} IN ('checked_in', 'confirmed')`,
      ),
    );

  /** 计算指定日期某房型的真实可售数 = 总房间 - 维修/锁房 - 当天被订单占用的房间 */
  function calcAvailable(roomTypeId: string, roomTypeName: string, dateStr: string): number {
    const total = roomCountByType[roomTypeId] || 0;
    const unavail = unavailableByType[roomTypeId] || 0;
    const dayOccupied = ordersInRange.filter(
      (o) =>
        o.roomType === roomTypeName &&
        o.checkIn <= dateStr &&
        o.checkOut > dateStr,
    ).length;
    return Math.max(0, total - unavail - dayOccupied);
  }

  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];

  // 节假日名称硬编码作为 fallback
  const holidayNames: Record<string, string> = {
    '2026-01-01': '元旦',
    '2026-05-01': '劳动节',
    '2026-05-02': '劳动节',
    '2026-05-03': '劳动节',
    '2026-06-19': '端午节',
    '2026-06-20': '端午节',
    '2026-06-21': '端午节',
    '2026-09-25': '中秋节',
    '2026-10-01': '国庆节',
    '2026-10-02': '国庆节',
    '2026-10-03': '国庆节',
  };

  /** 为指定日期生成房型列表（含真实价格和可售数） */
  function buildRoomTypes(dateStr: string, overrideMap?: Map<string, any>) {
    return roomTypesFromDb.map((rt) => {
      const override = overrideMap?.get(rt.name) || overrideMap?.get(rt.id);
      const price =
        override?.price != null ? Number(override.price) : rt.basePrice;
      const channelPrices: Record<string, number> = {};
      for (const [ch, markup] of Object.entries(channelMarkup)) {
        channelPrices[ch] = Math.round(price * markup);
      }
      return {
        name: rt.name,
        basePrice: rt.basePrice,
        finalPrice: price,
        plan: '基础价',
        channelPrices,
        available: calcAvailable(rt.id, rt.name, dateStr),
        total: roomCountByType[rt.id] || 0,
        aiSuggestedPrice: override?.aiSuggestedPrice ?? null,
        aiReason: override?.aiReason || '',
        aiConfidence: override?.aiConfidence ?? 0,
        competitorAvg: override?.competitorAvg ?? 0,
        isBelowMin: override?.isBelowMin ?? false,
      };
    });
  }

  // ---- 价格日历为空时生成当月空数据（兜底） ----
  if (calendarRows.length === 0) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const rows = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dateObj = new Date(ds);
      const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
      rows.push({
        date: ds,
        weekday: weekdayNames[dateObj.getDay()],
        isWeekend,
        isHoliday: false,
        holidayName: holidayNames[ds] || '',
        roomTypes: buildRoomTypes(ds),
      });
    }
    return rows;
  }

  // ---- 有日历记录：用 DB 真实数据覆盖价格，可售数从实时数据计算 ----
  return calendarRows.map((row) => {
    const dateStr = String(row.date);
    const d = new Date(dateStr);
    // 日历记录中的 roomTypes 可能包含用户手动调整的价格
    const rawRoomTypes = Array.isArray(row.roomTypes) ? row.roomTypes : [];
    // 构建覆盖映射（仅价格覆盖，available 仍从实时数据计算）
    const overrideMap = new Map<string, any>();
    rawRoomTypes.forEach((r: any) => {
      if (r.name) overrideMap.set(r.name, r);
      if (r.roomTypeId) overrideMap.set(r.roomTypeId, r);
    });

    return {
      date: dateStr,
      weekday: weekdayNames[d.getDay()],
      isWeekend: row.isWeekend ?? (d.getDay() === 0 || d.getDay() === 6),
      isHoliday: row.isHoliday ?? false,
      holidayName: row.holidayName || holidayNames[dateStr] || '',
      roomTypes: buildRoomTypes(dateStr, overrideMap),
    };
  });
}

// ---------------------------------------------------------------------------
// Helper: 格式化促销数据（保持原有逻辑不变）
// ---------------------------------------------------------------------------
function formatPromotion(p: any) {
  const discountOff = Number(p.discount) || 0;
  const discountDisplay = 100 - discountOff;

  const conditions: string[] = [];
  if (p.type === 'early_bird') {
    conditions.push('提前7天以上预订');
  } else if (p.type === 'long_stay') {
    conditions.push('连住3晚及以上');
  } else if (p.type === 'last_minute') {
    conditions.push('当日18:00后预订');
  }
  if (Array.isArray(p.channels) && p.channels.length > 0) {
    conditions.push(`${p.channels.join('、')}渠道`);
  }

  return {
    id: p.id,
    name: p.name,
    type: p.type,
    description: p.description || '',
    discount: `${discountDisplay}折`,
    discountValue: discountDisplay,
    discountUnit: 'percent',
    condition: conditions.length > 0 ? conditions.join('，') : '无',
    roomTypes: Array.isArray(p.roomTypes) ? (p.roomTypes as string[]) : [],
    validFrom: p.startDate,
    validTo: p.endDate,
    usageCount: 0,
    usageLimit: 100,
    status: p.status,
    priority: 3,
  };
}

// ===========================================================================
// GET / — 价格管理页面初始化 & 各子数据查询
// ===========================================================================
route.get('/', requirePermission('pricing:view'), async (c) => {
  const scope = getTenantScope(c);
  const type = c.req.query('type');

  // ---- 价格日历（含渠道加价） ----
  if (type === 'calendar') {
    const calendarRows = await db
      .select()
      .from(pmsBuiPricingCalendar)
      .where(and(...tenantWhere(scope, pmsBuiPricingCalendar)))
      .orderBy(pmsBuiPricingCalendar.date);
    const calendar = await buildCalendarDays(calendarRows, scope);
    return c.json(calendar);
  }

  // ---- 定价规则 ----
  if (type === 'rules') {
    const dbRules = await db
      .select()
      .from(pmsBuiPricingRules)
      .where(and(...tenantWhere(scope, pmsBuiPricingRules)));
    // 补齐缺失房型的默认规则
    const roomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
    const covered = new Set(dbRules.map(r => r.roomTypeId));
    const missing = roomTypes.filter(rt => !covered.has(rt.id));
    const virtual = missing.map(rt => ({
      id: `rule-default-${rt.id}`, roomType: rt.name, roomTypeId: rt.id,
      storeId: rt.storeId || scope.storeId, merchantId: rt.merchantId || scope.merchantId,
      basePrice: rt.basePrice || 298, weekdayPrice: rt.basePrice || 298,
      weekendPrice: Math.round((rt.basePrice || 298) * 1.2), holidayPrice: Math.round((rt.basePrice || 298) * 1.5),
      status: 'active', createdAt: new Date(), updatedAt: new Date(),
    }));
    const rules = [...dbRules, ...(virtual as any)];
    return c.json(rules);
  }

  // ---- 渠道定价 ----
  if (type === 'channel-pricing') {
    const channels = await db
      .select()
      .from(pmsBuiChannels)
      .where(and(...tenantWhere(scope, pmsBuiChannels), eq(pmsBuiChannels.status, 'active')));
    const rules = await db
      .select()
      .from(pmsBuiPricingRules)
      .where(and(...tenantWhere(scope, pmsBuiPricingRules)));
    return c.json({
      channels: channels.map((ch) => ({
        name: ch.name,
        markup: Number(ch.commissionRate) || 10,
        rules: rules.slice(0, 2),
      })),
    });
  }

  // ---- 促销列表 ----
  if (type === 'promotions') {
    const promotions = await db
      .select()
      .from(pmsBuiPromotions)
      .where(and(...tenantWhere(scope, pmsBuiPromotions)))
      .orderBy(desc(pmsBuiPromotions.startDate));
    return c.json({ promotions: promotions.map((p) => formatPromotion(p)) });
  }

  // ---- AI 定价建议 ----
  if (type === 'ai') {
    const suggestions = await db
      .select()
      .from(pmsBuiAiSuggestions)
      .where(
        and(
          eq(pmsBuiAiSuggestions.type, 'pricing'),
          ...tenantWhere(scope, pmsBuiAiSuggestions),
        ),
      )
      .orderBy(desc(pmsBuiAiSuggestions.createdAt));

    const history = suggestions
      .filter((s) => s.status === 'adopted' || s.status === 'ignored')
      .map((s) => ({
        id: s.id,
        date: s.createdAt
          ? new Date(s.createdAt).toLocaleDateString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
            })
          : '',
        roomType: s.roomType,
        before: s.currentPrice,
        after: s.suggestedPrice,
        reason: s.reason,
        operator: s.status === 'adopted' ? '已采纳' : '已忽略',
      }));

    return c.json({
      suggestions: suggestions.map((s) => ({
        id: s.id,
        roomType: s.roomType,
        currentPrice: s.currentPrice,
        suggestedPrice: s.suggestedPrice,
        reason: s.reason,
        confidence: Number(s.confidence) || 0,
        status: s.status,
        competitorAvg: s.competitorAvg,
      })),
      history,
    });
  }

  // ---- 默认：首页初始化（基础规则 + 促销 + 汇总） ----
  const dbRules = await db
    .select()
    .from(pmsBuiPricingRules)
    .where(and(...tenantWhere(scope, pmsBuiPricingRules)));
  // 补齐缺失房型的默认规则
  const allRoomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  const coveredRt = new Set(dbRules.map(r => r.roomTypeId));
  const missingRt = allRoomTypes.filter(rt => !coveredRt.has(rt.id));
  const virtualRules = missingRt.map(rt => ({
    id: `rule-default-${rt.id}`,
    roomType: rt.name,
    roomTypeId: rt.id,
      storeId: rt.storeId || scope.storeId,
      merchantId: rt.merchantId || scope.merchantId,
      basePrice: rt.basePrice || 298,
      weekdayPrice: rt.basePrice || 298,
      weekendPrice: Math.round((rt.basePrice || 298) * 1.2),
      holidayPrice: Math.round((rt.basePrice || 298) * 1.5),
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  const rules = [...dbRules, ...virtualRules];
  const promotions = await db
    .select()
    .from(pmsBuiPromotions)
    .where(and(...tenantWhere(scope, pmsBuiPromotions)))
    .orderBy(desc(pmsBuiPromotions.startDate));
  const channels = await db
    .select()
    .from(pmsBuiChannels)
    .where(and(...tenantWhere(scope, pmsBuiChannels)));

  const activePromotions = promotions.filter((p) => p.status === 'active');
  // 计算真实平均佣金
  const commissions = channels
    .map((c) => Number(c.commissionRate) || 0)
    .filter((v) => v > 0);
  const avgCommission =
    commissions.length > 0
      ? commissions.reduce((a, b) => a + b, 0) / commissions.length
      : 0;
  const avgCommissionDisplay =
    avgCommission > 0 ? avgCommission.toFixed(1) + '%' : '0%';

  return c.json({
    base: rules,
    promotions: promotions.map((p) => formatPromotion(p)),
    summary: {
      activePlans: rules.filter((r) => r.status === 'active').length,
      activePromotions: activePromotions.length,
      channelCount: channels.length,
      avgCommission: avgCommissionDisplay,
    },
  });
});

// ===========================================================================
// POST 请求体校验 schema
// ===========================================================================
const pricingActionSchema = z.discriminatedUnion('action', [
  // 单日调价
  z.object({
    action: z.literal('updatePrice'),
    roomTypeId: z.string().min(1),
    date: z.string().min(1),
    price: z.number().min(1),
  }),
  // 批量调价
  z.object({
    action: z.literal('batchUpdate'),
    roomTypeId: z.string().min(1),
    dateFrom: z.string().min(1),
    dateTo: z.string().min(1),
    price: z.number().min(1),
  }),
  // 批量日历调价
  z.object({
    action: z.literal('batchPriceCalendar'),
    dateFrom: z.string().min(1),
    dateTo: z.string().min(1),
    roomTypeIds: z.array(z.string()).min(1),
    mode: z.enum(['percentage', 'fixed']),
    value: z.number(),
    dayType: z.enum(['all', 'weekday', 'weekend']).default('all'),
  }),
  // 更新定价规则
  z.object({
    action: z.literal('updateRule'),
    ruleId: z.string().min(1, '规则ID不能为空'),
  }).passthrough(),
  // 批量更新定价规则
  z.object({
    action: z.literal('batchUpdateRules'),
    updates: z.array(z.object({
      ruleId: z.string().min(1),
      basePrice: z.number().optional(),
      weekdayPrice: z.number().optional(),
      weekendPrice: z.number().optional(),
      holidayPrice: z.number().optional(),
      minPrice: z.number().optional(),
    })),
  }),
  // 新增促销
  z.object({
    action: z.literal('addPromotion'),
    storeId: z.string().optional(),
    name: z.string().min(1, '促销名称不能为空'),
    type: z.string().optional(),
    discount: z.number().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    roomTypes: z.array(z.string()).optional(),
    channels: z.array(z.string()).optional(),
  }),
  // 编辑促销
  z.object({
    action: z.literal('editPromotion'),
    promotionId: z.string().min(1, '促销ID不能为空'),
    name: z.string().optional(),
    type: z.string().optional(),
    discount: z.number().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    roomTypes: z.array(z.string()).optional(),
    channels: z.array(z.string()).optional(),
    description: z.string().optional(),
  }),
  // 启用/停用促销
  z.object({
    action: z.literal('togglePromotion'),
    promotionId: z.string().min(1, '促销ID不能为空'),
    status: z.string().min(1, '状态不能为空'),
  }),
  // 采纳 AI 建议
  z.object({
    action: z.literal('adoptSuggestion'),
    suggestionId: z.string().min(1, '建议ID不能为空'),
  }),
  // 忽略 AI 建议
  z.object({
    action: z.literal('ignoreSuggestion'),
    suggestionId: z.string().min(1, '建议ID不能为空'),
  }),
]);

// ===========================================================================
// POST / — 价格管理操作入口
// ===========================================================================
route.post('/', requirePermission('pricing:edit'), async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const validation = await validateBody(body, pricingActionSchema);
  if (!validation.success) {
    return c.json(
      { success: false, error: `参数校验失败: ${validation.error}` },
      400,
    );
  }
  const { data } = validation;

  // ---- 单日调价 ----
  if (data.action === 'updatePrice') {
    // 根据 roomTypeId 查找房型名称（用于匹配 JSONB 中的 roomTypes 数组）
    const [roomType] = await db
      .select({ name: pmsBuiRoomTypes.name })
      .from(pmsBuiRoomTypes)
      .where(eq(pmsBuiRoomTypes.id, data.roomTypeId))
      .limit(1);
    if (!roomType) {
      return c.json({ success: false, error: '房型不存在' }, 404);
    }

    const [existing] = await db
      .select()
      .from(pmsBuiPricingCalendar)
      .where(
        and(
          eq(pmsBuiPricingCalendar.date, data.date),
          ...tenantWhere(scope, pmsBuiPricingCalendar),
        ),
      )
      .limit(1);

    if (existing) {
      // 更新现有日历记录的 roomTypes JSONB 数组
      const currRoomTypes = Array.isArray(existing.roomTypes)
        ? [...existing.roomTypes]
        : [];
      const idx = currRoomTypes.findIndex(
        (rt: any) =>
          rt.name === roomType.name || rt.roomTypeId === data.roomTypeId,
      );
      if (idx >= 0) {
        currRoomTypes[idx] = { ...currRoomTypes[idx], price: data.price };
      } else {
        currRoomTypes.push({
          name: roomType.name,
          price: data.price,
          roomTypeId: data.roomTypeId,
        });
      }
      await db
        .update(pmsBuiPricingCalendar)
        .set({ roomTypes: currRoomTypes } as any)
        .where(eq(pmsBuiPricingCalendar.id, existing.id));
    } else {
      // 创建新日历记录
      const id = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      await db.insert(pmsBuiPricingCalendar).values({
        id,
        date: data.date,
        roomTypes: [
          {
            name: roomType.name,
            price: data.price,
            roomTypeId: data.roomTypeId,
          },
        ],
        isWeekend: [0, 6].includes(new Date(data.date).getDay()),
        isHoliday: false,
        merchantId: scope.merchantId,
        storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
      } as any);
    }
    return c.json({ success: true });
  }

  // ---- 批量调价 ----
  if (data.action === 'batchUpdate') {
    const [roomType] = await db
      .select({ name: pmsBuiRoomTypes.name })
      .from(pmsBuiRoomTypes)
      .where(eq(pmsBuiRoomTypes.id, data.roomTypeId))
      .limit(1);
    if (!roomType) {
      return c.json({ success: false, error: '房型不存在' }, 404);
    }

    const start = new Date(data.dateFrom);
    const end = new Date(data.dateTo);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      const [existing] = await db
        .select()
        .from(pmsBuiPricingCalendar)
        .where(
          and(
            eq(pmsBuiPricingCalendar.date, ds),
            ...tenantWhere(scope, pmsBuiPricingCalendar),
          ),
        )
        .limit(1);

      if (existing) {
        const currRoomTypes = Array.isArray(existing.roomTypes)
          ? [...existing.roomTypes]
          : [];
        const idx = currRoomTypes.findIndex(
          (rt: any) =>
            rt.name === roomType.name || rt.roomTypeId === data.roomTypeId,
        );
        if (idx >= 0) {
          currRoomTypes[idx] = { ...currRoomTypes[idx], price: data.price };
        } else {
          currRoomTypes.push({
            name: roomType.name,
            price: data.price,
            roomTypeId: data.roomTypeId,
          });
        }
        await db
          .update(pmsBuiPricingCalendar)
          .set({ roomTypes: currRoomTypes } as any)
          .where(eq(pmsBuiPricingCalendar.id, existing.id));
      } else {
        const id = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await db.insert(pmsBuiPricingCalendar).values({
          id,
          date: ds,
          roomTypes: [
            {
              name: roomType.name,
              price: data.price,
              roomTypeId: data.roomTypeId,
            },
          ],
          isWeekend: [0, 6].includes(new Date(ds).getDay()),
          isHoliday: false,
          merchantId: scope.merchantId,
          storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
        } as any);
      }
    }
    return c.json({ success: true });
  }

  // ---- 批量日历调价 ----
  if (data.action === 'batchPriceCalendar') {
    const { dateFrom, dateTo, roomTypeIds, mode, value, dayType } = data;
    // 获取所有目标房型
    const roomTypes = await db.select().from(pmsBuiRoomTypes)
      .where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
    const targetTypes = roomTypes.filter(rt => roomTypeIds.includes(rt.id));
    if (targetTypes.length === 0) {
      return c.json({ success: false, error: '未找到目标房型' }, 400);
    }

    let updatedCount = 0;
    const start = new Date(dateFrom);
    const end = new Date(dateTo);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().split('T')[0];
      const dayOfWeek = d.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      // 检查日期类型过滤
      if (dayType === 'weekday' && isWeekend) continue;
      if (dayType === 'weekend' && !isWeekend) continue;

      for (const rt of targetTypes) {
        const basePrice = rt.basePrice || 298;
        // 根据模式计算价格
        let newPrice: number;
        if (mode === 'fixed') {
          newPrice = value;
        } else {
          // 百分比模式：基于房型基础价计算
          newPrice = Math.round(basePrice * (1 + value / 100));
        }
        if (newPrice < 1) newPrice = 1;

        const [existing] = await db.select().from(pmsBuiPricingCalendar)
          .where(and(eq(pmsBuiPricingCalendar.date, ds), ...tenantWhere(scope, pmsBuiPricingCalendar)))
          .limit(1);

        if (existing) {
          const currRoomTypes = Array.isArray(existing.roomTypes) ? [...existing.roomTypes] : [];
          const idx = currRoomTypes.findIndex((r: any) => r.name === rt.name || r.roomTypeId === rt.id);
          if (idx >= 0) {
            currRoomTypes[idx] = { ...currRoomTypes[idx], price: newPrice };
          } else {
            currRoomTypes.push({ name: rt.name, price: newPrice, roomTypeId: rt.id });
          }
          await db.update(pmsBuiPricingCalendar).set({ roomTypes: currRoomTypes } as any)
            .where(eq(pmsBuiPricingCalendar.id, existing.id));
        } else {
          const calId = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          await db.insert(pmsBuiPricingCalendar).values({
            id: calId, date: ds,
            roomTypes: [{ name: rt.name, price: newPrice, roomTypeId: rt.id }],
            isWeekend, isHoliday: false,
            merchantId: scope.merchantId,
            storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
          } as any);
        }
        updatedCount++;
      }
    }
    return c.json({ success: true, updatedCount, affectedTypes: targetTypes.length });
  }

  // ---- 更新定价规则（无则创建）----
  if (data.action === 'updateRule') {
    const { action, ruleId, ...updates } = data;
    const existing = await db.select().from(pmsBuiPricingRules)
      .where(and(eq(pmsBuiPricingRules.id, ruleId), ...tenantWhere(scope, pmsBuiPricingRules)));
    if (existing.length > 0) {
      await db.update(pmsBuiPricingRules).set(updates as any)
        .where(and(eq(pmsBuiPricingRules.id, ruleId), ...tenantWhere(scope, pmsBuiPricingRules)));
    } else {
      // 缺少必要字段时从房型表补充
      let roomTypeId = (updates as any).roomTypeId || '';
      let roomType = (updates as any).roomType || '';
      if (!roomTypeId || !roomType) {
        const rtId = roomTypeId || ruleId.replace('rule-default-', '') || '';
        const [rt] = await db.select().from(pmsBuiRoomTypes)
          .where(and(eq(pmsBuiRoomTypes.id, rtId), ...tenantWhere(scope, pmsBuiRoomTypes))).limit(1);
        if (rt) { roomTypeId = rt.id; roomType = rt.name; }
      }
      // upsert：虚拟规则 id（rule-default-rt-<房型id>）可能已在库但因 store 上下文不同未命中 existing 查询
      // → 直接 INSERT 会主键冲突；用 onConflictDoUpdate 按主键 id 归置为当前门店并更新价格
      const storeId = scope.storeId === '*' ? 'default_store' : scope.storeId;
      await db.insert(pmsBuiPricingRules).values({
        id: ruleId, roomTypeId, roomType,
        merchantId: scope.merchantId, ...updates as any,
        storeId, status: 'active',
      } as any).onConflictDoUpdate({
        target: pmsBuiPricingRules.id,
        set: {
          roomTypeId, roomType,
          merchantId: scope.merchantId, ...updates as any,
          storeId, status: 'active', updatedAt: new Date(),
        } as any,
      });
    }
    return c.json({ success: true });
  }

  // ---- 批量更新定价规则 ----
  if (data.action === 'batchUpdateRules') {
    const results: Array<{ ruleId: string; success: boolean; error?: string }> = [];
    for (const update of data.updates) {
      try {
        const { ruleId, ...fields } = update;
        const existing = await db.select().from(pmsBuiPricingRules)
          .where(and(eq(pmsBuiPricingRules.id, ruleId), ...tenantWhere(scope, pmsBuiPricingRules)));
        if (existing.length > 0) {
          await db.update(pmsBuiPricingRules).set(fields as any)
            .where(and(eq(pmsBuiPricingRules.id, ruleId), ...tenantWhere(scope, pmsBuiPricingRules)));
        } else {
          // 补全缺失字段后创建（upsert：虚拟规则 id 可能已在库因 store 上下文未命中 → 按主键归置当前门店）
          let roomTypeId = (fields as any).roomTypeId || '';
          let roomTypeName = (fields as any).roomType || '';
          if (!roomTypeId || !roomTypeName) {
            const rtId = roomTypeId || ruleId.replace('rule-default-', '') || '';
            const [rt] = await db.select().from(pmsBuiRoomTypes)
              .where(and(eq(pmsBuiRoomTypes.id, rtId), ...tenantWhere(scope, pmsBuiRoomTypes))).limit(1);
            if (rt) { roomTypeId = rt.id; roomTypeName = rt.name; }
          }
          const storeId = scope.storeId === '*' ? 'default_store' : scope.storeId;
          await db.insert(pmsBuiPricingRules).values({
            id: ruleId, roomTypeId, roomType: roomTypeName,
            merchantId: scope.merchantId, ...fields as any,
            storeId, status: 'active',
          } as any).onConflictDoUpdate({
            target: pmsBuiPricingRules.id,
            set: {
              roomTypeId, roomType: roomTypeName,
              merchantId: scope.merchantId, ...fields as any,
              storeId, status: 'active', updatedAt: new Date(),
            } as any,
          });
        }
        results.push({ ruleId, success: true });
      } catch (e: any) {
        results.push({ ruleId: update.ruleId, success: false, error: e.message });
      }
    }
    return c.json({ success: true, results });
  }

  // ---- 新增促销 ----
  if (data.action === 'addPromotion') {
    const {
      storeId,
      name,
      type,
      discount,
      startDate,
      endDate,
      roomTypes,
      channels,
    } = data;
    const id = `promo-${Date.now()}`;
    const result = await db
      .insert(pmsBuiPromotions)
      .values({
        id,
        storeId: storeId || (scope.storeId === '*' ? 'default_store' : scope.storeId),
        merchantId: scope.merchantId,
        name,
        type: type || '',
        discount: discount || 0,
        startDate: startDate || '',
        endDate: endDate || '',
        roomTypes: roomTypes || [],
        channels: channels || [],
        status: 'active',
      } as any)
      .returning();
    return c.json(result[0], 201);
  }

  // ---- 编辑促销 ----
  if (data.action === 'editPromotion') {
    const {
      promotionId,
      name,
      type,
      discount,
      startDate,
      endDate,
      roomTypes,
      channels,
      description,
    } = data;
    await db
      .update(pmsBuiPromotions)
      .set({
        name,
        type,
        discount: discount || 0,
        startDate,
        endDate,
        roomTypes: roomTypes || [],
        channels: channels || [],
        description: description || '',
      } as any)
      .where(
        and(
          eq(pmsBuiPromotions.id, promotionId),
          ...tenantWhere(scope, pmsBuiPromotions),
        ),
      );
    return c.json({ success: true });
  }

  // ---- 启用/停用促销 ----
  if (data.action === 'togglePromotion') {
    const { promotionId, status } = data;
    await db
      .update(pmsBuiPromotions)
      .set({ status } as any)
      .where(
        and(
          eq(pmsBuiPromotions.id, promotionId),
          ...tenantWhere(scope, pmsBuiPromotions),
        ),
      );
    return c.json({ success: true });
  }

  // ---- 采纳 AI 建议 ----
  if (data.action === 'adoptSuggestion') {
    const { suggestionId } = data;

    const [suggestion] = await db
      .select()
      .from(pmsBuiAiSuggestions)
      .where(
        and(
          eq(pmsBuiAiSuggestions.id, suggestionId),
          ...tenantWhere(scope, pmsBuiAiSuggestions),
        ),
      )
      .limit(1);

    if (!suggestion) return c.json({ error: 'Suggestion not found' }, 404);

    await db
      .update(pmsBuiAiSuggestions)
      .set({ status: 'adopted' } as any)
      .where(
        and(
          eq(pmsBuiAiSuggestions.id, suggestionId),
          ...tenantWhere(scope, pmsBuiAiSuggestions),
        ),
      );

    // 更新对应的定价规则
    const matchingRules = await db
      .select()
      .from(pmsBuiPricingRules)
      .where(
        and(
          eq(pmsBuiPricingRules.roomType, suggestion.roomType as string),
          ...tenantWhere(scope, pmsBuiPricingRules),
        ),
      );

    if (matchingRules.length > 0) {
      await db
        .update(pmsBuiPricingRules)
        .set({
          basePrice: suggestion.suggestedPrice as number,
          weekdayPrice: suggestion.suggestedPrice as number,
        } as any)
        .where(
          and(
            eq(pmsBuiPricingRules.roomType, suggestion.roomType as string),
            ...tenantWhere(scope, pmsBuiPricingRules),
          ),
        );
    }

    return c.json({ success: true, updatedPrice: suggestion.suggestedPrice });
  }

  // ---- 忽略 AI 建议 ----
  if (data.action === 'ignoreSuggestion') {
    const { suggestionId } = data;

    await db
      .update(pmsBuiAiSuggestions)
      .set({ status: 'ignored' } as any)
      .where(
        and(
          eq(pmsBuiAiSuggestions.id, suggestionId),
          ...tenantWhere(scope, pmsBuiAiSuggestions),
        ),
      );

    return c.json({ success: true });
  }

  return c.json({ success: true });
});

export default route;
