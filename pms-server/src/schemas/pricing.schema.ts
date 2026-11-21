import { z } from 'zod';

// ============ 子模型 ============

export const BasePricingSchema = z.object({
  id: z.string(),
  roomType: z.string(),
  basePrice: z.number(),
  weekdayPrice: z.number(),
  weekendPrice: z.number(),
  holidayPrice: z.number(),
  minPrice: z.number(),
  priceHistory: z.array(z.object({
    date: z.string(),
    price: z.number(),
  })),
}).describe('基础房价');

export const PromotionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  discount: z.number(),
  startDate: z.string(),
  endDate: z.string(),
  roomTypes: z.array(z.string()),
  status: z.enum(['active', 'inactive', 'expired']),
  description: z.string(),
}).describe('限时特价');

export const PricingCalendarDaySchema = z.object({
  date: z.string(),
  weekday: z.string(),
  isWeekend: z.boolean(),
  isHoliday: z.boolean(),
  holidayName: z.string().optional(),
  roomTypes: z.array(z.object({
    roomTypeId: z.string(),
    roomTypeName: z.string(),
    price: z.number(),
    inventory: z.number(),
    booked: z.number(),
    aiSuggestedPrice: z.number().optional(),
    aiReason: z.string().optional(),
    aiConfidence: z.number().optional(),
    competitorAvg: z.number().optional(),
    isBelowMin: z.boolean().optional(),
  })),
}).describe('价格日历某天');

export const PricingSummarySchema = z.object({
  avgPrice: z.number(),
  minPrice: z.number(),
  maxPrice: z.number(),
  totalPromotions: z.number(),
  activePromotions: z.number(),
}).describe('价格汇总');

export const ChannelPricingSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  commissionRate: z.number(),
  priceMatrix: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  roomTypes: z.array(z.string()),
}).describe('渠道价格');

export const AIHintSchema = z.object({
  id: z.string(),
  roomType: z.string(),
  date: z.string(),
  currentPrice: z.number(),
  suggestedPrice: z.number(),
  reason: z.string(),
  confidence: z.number(),
  competitorAvg: z.number().optional(),
}).describe('AI定价建议');

// ============ 查询参数 ============

export const PricingQuerySchema = z.object({
  type: z.enum(['calendar', 'rules', 'channel-pricing', 'promotions', 'ai']).optional().describe('查询类型'),
}).describe('价格查询参数');

// ============ 路由定义 ============

export const getPricing = {
  method: 'get' as const,
  path: '/',
  summary: '获取价格数据',
  description: '根据type参数返回基础房价/价格日历/渠道价格/AI建议',
  tags: ['价格管理'],
  request: { query: PricingQuerySchema },
  responses: {
    200: { description: '价格数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const updatePricing = {
  method: 'post' as const,
  path: '/',
  summary: '更新价格',
  description: '修改房型价格或创建促销活动',
  tags: ['价格管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '更新成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};
