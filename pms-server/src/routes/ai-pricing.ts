import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiRoomTypes, pmsBuiRooms, pmsBuiChannels, pmsBuiAiSuggestions, pmsBuiCompetitorConfig, pmsBuiAiPricingRecords, pmsBuiPricingRules, pmsBuiPricingCalendar } from '../db/schema/index.js';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { calculatePricing, PricingAdvice, isHoliday, checkWeatherGood } from '../services/pricing-engine.js';

const route = new Hono();

// POST /api/ai-pricing/analyze — 对指定房型和渠道执行六维定价分析
route.post('/analyze', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const { roomTypeId, channelId, date } = body as { roomTypeId?: string; channelId?: string; date?: string };

  // 获取房型列表
  let roomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  if (roomTypeId) roomTypes = roomTypes.filter(rt => rt.id === roomTypeId);

  // 获取当前房态
  const allRooms = await db.select().from(pmsBuiRooms)
    .where(and(...tenantWhere(scope, pmsBuiRooms)));

  // 获取激活的渠道
  let channels = await db.select().from(pmsBuiChannels)
    .where(and(...tenantWhere(scope, pmsBuiChannels), eq(pmsBuiChannels.status, 'active')));
  if (channelId) channels = channels.filter(ch => ch.id === channelId);

  const targetDate = date ? new Date(date) : new Date();
  const isWeekend = targetDate.getDay() === 0 || targetDate.getDay() === 6;
  const daysToCheckin = Math.max(1, Math.ceil((targetDate.getTime() - Date.now()) / 86400000));
  const weatherGood = await checkWeatherGood(); // 实时天气查询

  const results: PricingAdvice[] = [];

  for (const rt of roomTypes) {
    const rtRooms = allRooms.filter(r => r.roomTypeId === rt.id);
    const totalRooms = rtRooms.length || rt.roomCount || 10;
    const occupied = rtRooms.filter(r => r.status === 'occupied').length;
    const occupancyRate = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 50;
    const basePrice = rt.weekdayPrice || rt.basePrice || 298;

    for (const ch of channels) {
      const commission = Number(ch.commissionRate) || 10;
      // 竞品价：优先从竞品配置表读取真实抓取/手动价格，无数据则用佣金率估算
      const [compConfig] = await db.select().from(pmsBuiCompetitorConfig)
        .where(and(eq(pmsBuiCompetitorConfig.ourRoomTypeId, rt.id), eq(pmsBuiCompetitorConfig.status, 'active')))
        .limit(1);
      const competitorPrice = compConfig?.lastPrice
        || Math.round(basePrice * (1 + (commission - 10) / 100));

      const advice = calculatePricing({
        basePrice,
        occupancyRate,
        daysToCheckin,
        isWeekend,
        isHoliday: isHoliday(targetDate.toISOString().split('T')[0]),
        commissionRate: commission,
        competitorPrice,
        weatherGood,
        hasLocalEvent: false,
        totalRooms,
        occupiedRooms: occupied,
      });

      advice.roomType = rt.name;
      advice.channel = ch.name;
      results.push(advice);
    }
  }

  return c.json({ success: true, data: results, meta: { analyzedAt: new Date().toISOString(), roomTypes: results.filter(r => r.roomType === results[0]?.roomType).length || 0, totalAdvices: results.length } });
});

// POST /api/ai-pricing/batch — 批量生成14天×渠道定价矩阵
route.post('/batch', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const { roomTypeId, days = 14 } = body as { roomTypeId?: string; days?: number };

  let roomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  if (roomTypeId) roomTypes = roomTypes.filter(rt => rt.id === roomTypeId);

  const allRooms = await db.select().from(pmsBuiRooms)
    .where(and(...tenantWhere(scope, pmsBuiRooms)));
  const channels = await db.select().from(pmsBuiChannels)
    .where(and(...tenantWhere(scope, pmsBuiChannels), eq(pmsBuiChannels.status, 'active')));

  const weatherGood = await checkWeatherGood();

  // 生成未来N天的日期列表
  const dateList: Array<{ date: string; isWeekend: boolean; daysToCheckin: number }> = [];
  for (let i = 0; i < Math.min(days, 14); i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dow = d.getDay();
    dateList.push({
      date: d.toISOString().split('T')[0],
      isWeekend: dow === 0 || dow === 6,
      daysToCheckin: Math.max(1, i),
    });
  }

  // 生成矩阵：date × roomType × channel
  const matrix: any[] = [];
  for (const dl of dateList) {
    const row: any = { date: dl.date, isWeekend: dl.isWeekend, channels: {} };
    for (const ch of channels) {
      const chName = ch.name;
      let minPrice = Infinity, maxPrice = -Infinity, sumPrice = 0, count = 0;
      const roomAdvices: any[] = [];

      for (const rt of roomTypes) {
        const rtRooms = allRooms.filter(r => r.roomTypeId === rt.id);
        const totalRooms = rtRooms.length || rt.roomCount || 10;
        const occupied = rtRooms.filter(r => r.status === 'occupied').length;
        const occupancyRate = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 50;
        const basePrice = (dl.isWeekend ? rt.weekendPrice : rt.weekdayPrice) || rt.basePrice || 298;
        const commission = Number(ch.commissionRate) || 10;
        const competitorPrice = Math.round(basePrice * (1 + (commission - 10) / 100));

        const advice = calculatePricing({
          basePrice, occupancyRate, daysToCheckin: dl.daysToCheckin,
          isWeekend: dl.isWeekend, isHoliday: isHoliday(dl.date),
          commissionRate: commission, competitorPrice,
          weatherGood, hasLocalEvent: false,
          totalRooms, occupiedRooms: occupied,
        });
        advice.roomType = rt.name;
        advice.channel = ch.name;
        roomAdvices.push({ roomType: rt.name, suggestedPrice: advice.suggestedPrice, confidence: advice.confidence, totalAdjust: advice.totalAdjust });

        if (advice.suggestedPrice < minPrice) minPrice = advice.suggestedPrice;
        if (advice.suggestedPrice > maxPrice) maxPrice = advice.suggestedPrice;
        sumPrice += advice.suggestedPrice;
        count++;
      }
      row.channels[chName] = {
        icon: ch.icon || '📌',
        avgPrice: count > 0 ? Math.round(sumPrice / count) : 0,
        minPrice: minPrice === Infinity ? 0 : minPrice,
        maxPrice: maxPrice === -Infinity ? 0 : maxPrice,
        advices: roomAdvices,
      };
    }
    matrix.push(row);
  }

  return c.json({
    success: true,
    data: { channels: channels.map(ch => ({ name: ch.name, icon: ch.icon, commission: Number(ch.commissionRate) })), matrix },
    meta: { days, roomTypes: roomTypes.map(rt => rt.name), channels: channels.length, generatedAt: new Date().toISOString() },
  });
});

// GET /api/ai-pricing/history — 查询采纳历史
route.get('/history', async (c) => {
  const scope = getTenantScope(c);
  // 从 ai_suggestions 表读取采纳记录
  const suggestions = await db.select().from(pmsBuiAiSuggestions)
    .where(and(...tenantWhere(scope, pmsBuiAiSuggestions)))
    .orderBy(desc(pmsBuiAiSuggestions.createdAt))
    .limit(20);
  return c.json({
    success: true,
    data: suggestions.map(s => ({
      id: s.id, roomType: s.roomType, channel: s.type,
      currentPrice: s.currentPrice, suggestedPrice: s.suggestedPrice,
      confidence: Math.round(Number(s.confidence) * 100),
      reason: s.reason, status: s.status,
      adoptedAt: s.createdAt,
    })),
  });
});

// POST /api/ai-pricing/adopt — 采纳定价建议
route.post('/adopt', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const { roomType, channel, currentPrice, suggestedPrice, confidence } = body as any;

  const id = `aps_${Date.now()}`;
  await db.insert(pmsBuiAiSuggestions).values({
    id, merchantId: scope.merchantId,
    roomType: roomType || 'unknown',
    type: channel || 'unknown',
    currentPrice: currentPrice || 0,
    suggestedPrice: suggestedPrice || 0,
    confidence: String(((confidence || 80) / 100).toFixed(2)),
    reason: `AI六维引擎建议: ${channel || ''}渠道定价优化`,
    status: 'pending',
    createdAt: new Date(),
    competitorAvg: 0,
  } as any);

  return c.json({ success: true, data: { id }, message: '已采纳，7天后可查看实际效果对比' });
});

// GET /api/ai-pricing/anomaly — 异常检测
route.get('/anomaly', async (c) => {
  const scope = getTenantScope(c);
  const roomTypes = await db.select().from(pmsBuiRoomTypes)
    .where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  const allRooms = await db.select().from(pmsBuiRooms)
    .where(and(...tenantWhere(scope, pmsBuiRooms)));

  const alerts: any[] = [];
  for (const rt of roomTypes) {
    const rtRooms = allRooms.filter(r => r.roomTypeId === rt.id);
    const total = rtRooms.length || rt.roomCount || 10;
    const occupied = rtRooms.filter(r => r.status === 'occupied').length;
    const occRate = total > 0 ? Math.round((occupied / total) * 100) : 50;

    if (occRate < 30) {
      alerts.push({
        level: 'urgent', roomType: rt.name,
        message: `${rt.name}入住率仅${occRate}%，远低于正常水平`,
        suggestion: `建议降价${Math.round((50-occRate)*0.5)}%促销，预计可提升入住率至${Math.min(80, occRate+20)}%`,
        currentOccRate: occRate,
      });
    } else if (occRate < 50) {
      alerts.push({
        level: 'warning', roomType: rt.name,
        message: `${rt.name}入住率${occRate}%偏低`,
        suggestion: '建议监控竞品动态，适时推出限时优惠',
        currentOccRate: occRate,
      });
    }
  }
  return c.json({ success: true, data: { alerts, totalRoomTypes: roomTypes.length, checkedAt: new Date().toISOString() } });
});

// POST /api/ai-pricing/sandbox — 定价沙箱模拟
route.post('/sandbox', async (c) => {
  const body = await c.req.json();
  const { basePrice, occupancyRate, daysToCheckin, isWeekend, commissionRate, competitorPrice, manualAdjust } = body as any;

  const params = {
    basePrice: basePrice || 328,
    occupancyRate: Math.max(0, Math.min(100, occupancyRate || 50)),
    daysToCheckin: Math.max(0, daysToCheckin || 7),
    isWeekend: !!isWeekend,
    isHoliday: false,
    commissionRate: commissionRate || 10,
    competitorPrice: competitorPrice || basePrice * 1.05,
    weatherGood: true,
    hasLocalEvent: false,
    totalRooms: 10,
    occupiedRooms: Math.round((occupancyRate || 50) / 100 * 10),
  };

  // 不需要manualAdjust的场景
  const advice = calculatePricing(params);

  // 如果用户手动拖动了调整，叠加到最终价格
  if (manualAdjust !== undefined) {
    const manualPrice = Math.round(params.basePrice * (1 + manualAdjust / 100));
    return c.json({
      success: true,
      data: {
        originalAdvice: advice,
        manualPrice,
        manualAdjust,
        riskLevel: manualAdjust > 20 ? 'high' : manualAdjust > 10 ? 'medium' : 'low',
        riskNote: manualAdjust > 20 ? '⚠️ 提价幅度过大可能导致入住率下降' : manualAdjust < -15 ? '⚠️ 降价过多可能影响收益' : '✅ 调整在合理范围内',
      },
    });
  }

  return c.json({ success: true, data: { advice, originalAdvice: advice } });
});

// POST /api/ai-pricing/generate-all — 全量生成：所有房型×所有渠道×14天
route.post('/generate-all', async (c) => {
  const scope = getTenantScope(c);
  const weatherGood = await checkWeatherGood();
  const storeId = scope.storeId !== '*' ? scope.storeId : 'default_store';

  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(and(...tenantWhere(scope, pmsBuiRoomTypes)));
  const allRooms = await db.select().from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));
  const channels = await db.select().from(pmsBuiChannels).where(and(...tenantWhere(scope, pmsBuiChannels), eq(pmsBuiChannels.status, 'active')));

  // 先清除旧数据再批量插入，确保无重复
  await db.delete(pmsBuiAiPricingRecords).where(eq(pmsBuiAiPricingRecords.storeId, storeId) as any);

  let total = 0;
  for (let i = 0; i < 14; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const daysToCheckin = Math.max(1, i);

    for (const rt of roomTypes) {
      const rtRooms = allRooms.filter(r => r.roomTypeId === rt.id);
      const totalRooms = rtRooms.length || rt.roomCount || 10;
      const occupied = rtRooms.filter(r => r.status === 'occupied').length;
      const occupancyRate = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 50;
      const basePrice = (isWeekend ? rt.weekendPrice : rt.weekdayPrice) || rt.basePrice || 298;

      const [compConfig] = await db.select().from(pmsBuiCompetitorConfig)
        .where(and(eq(pmsBuiCompetitorConfig.ourRoomTypeId, rt.id), eq(pmsBuiCompetitorConfig.status, 'active'))).limit(1);

      for (const ch of channels) {
        const commission = Number(ch.commissionRate) || 10;
        const competitorPrice = compConfig?.lastPrice || Math.round(basePrice * (1 + (commission - 10) / 100));
        const advice = calculatePricing({ basePrice, occupancyRate, daysToCheckin, isWeekend, isHoliday: isHoliday(dateStr), commissionRate: commission, competitorPrice, weatherGood, hasLocalEvent: false, totalRooms, occupiedRooms: occupied });

        const id = `pr_${storeId}_${dateStr}_${rt.id}_${ch.id}`;
        await db.insert(pmsBuiAiPricingRecords).values({
          id, merchantId: scope.merchantId, storeId, date: dateStr,
          roomType: rt.name, channel: ch.name,
          basePrice, suggestedPrice: advice.suggestedPrice,
          totalAdjust: String(advice.totalAdjust) as any, confidence: advice.confidence,
          factors: advice.factors as any,
          expectedRevenue: advice.expectedRevenue, monthlyImpact: advice.monthlyImpact,
        } as any);
        total++;
      }
    }
  }
  return c.json({ success: true, data: { total, storeId, dateRange: `${new Date().toISOString().split('T')[0]} ~ 14天`, roomTypes: roomTypes.length, channels: channels.length } });
});

// GET /api/ai-pricing/records — 查询持久化定价记录
route.get('/records', async (c) => {
  const scope = getTenantScope(c);
  const date = c.req.query('date');
  const roomType = c.req.query('roomType');
  const storeId = scope.storeId !== '*' ? scope.storeId : 'default_store';

  const conditions: any[] = [eq(pmsBuiAiPricingRecords.storeId, storeId) as any];
  if (date) conditions.push(eq(pmsBuiAiPricingRecords.date, date) as any);
  if (roomType) conditions.push(eq(pmsBuiAiPricingRecords.roomType, roomType) as any);

  const records = await db.select().from(pmsBuiAiPricingRecords)
    .where(and(...conditions))
    .orderBy(pmsBuiAiPricingRecords.date, pmsBuiAiPricingRecords.channel);
  return c.json({ success: true, data: records, meta: { storeId, date, roomType, count: records.length } });
});

// POST /api/ai-pricing/adopt-record — 采纳定价并同步到SaaS价格管理
route.post('/adopt-record', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const { recordId } = body as { recordId: string };

  const [record] = await db.select().from(pmsBuiAiPricingRecords).where(eq(pmsBuiAiPricingRecords.id, recordId));
  if (!record) return c.json({ success: false, error: '记录不存在' }, 404);

  // 1. 标记已采纳
  await db.update(pmsBuiAiPricingRecords).set({ adopted: true } as any).where(eq(pmsBuiAiPricingRecords.id, recordId));

  // 2. 同步到定价规则表（更新对应房型的渠道价格）
  const [rule] = await db.select().from(pmsBuiPricingRules)
    .where(and(eq(pmsBuiPricingRules.roomType, record.roomType), eq(pmsBuiPricingRules.merchantId, scope.merchantId)))
    .limit(1);

  if (rule) {
    const isWeekend = new Date(record.date).getDay() === 0 || new Date(record.date).getDay() === 6;
    await db.update(pmsBuiPricingRules).set({
      ...(isWeekend ? { weekendPrice: record.suggestedPrice } : { weekdayPrice: record.suggestedPrice }),
      updatedAt: new Date() as any,
    } as any).where(eq(pmsBuiPricingRules.id, rule.id));
  }

  // 3. 同步到价格日历（更新对应日期的渠道价）
  const [calEntry] = await db.select().from(pmsBuiPricingCalendar)
    .where(and(eq(pmsBuiPricingCalendar.date, record.date), eq(pmsBuiPricingCalendar.storeId, record.storeId)))
    .limit(1);

  if (calEntry) {
    const roomTypes = (calEntry.roomTypes || []) as any[];
    const idx = roomTypes.findIndex((rt: any) => rt.name === record.roomType);
    if (idx >= 0) {
      roomTypes[idx].finalPrice = record.suggestedPrice;
      roomTypes[idx].channelPrices = { ...(roomTypes[idx].channelPrices || {}), [record.channel]: record.suggestedPrice };
      await db.update(pmsBuiPricingCalendar).set({ roomTypes, updatedAt: new Date() } as any)
        .where(eq(pmsBuiPricingCalendar.id, calEntry.id));
    }
  }

  return c.json({ success: true, message: `已采纳并同步 ${record.channel} 价格 ¥${record.suggestedPrice}` });
});

export default route;
