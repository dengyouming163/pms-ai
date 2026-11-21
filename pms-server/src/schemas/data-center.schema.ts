import { z } from 'zod';

// ============ AI Dashboard ============

export const AIDashboardKpiSchema = z.object({
  todayRevenue: z.number(),
  monthRevenue: z.number(),
  revenueChange: z.number(),
  monthRevenueChange: z.number(),
  occupancyRate: z.number(),
  occupancyChange: z.number(),
  adr: z.number(),
  adrChange: z.number(),
  revpar: z.number(),
  revparChange: z.number(),
  todayCheckins: z.number(),
  todayCheckouts: z.number(),
  tomorrowReservations: z.number(),
}).describe('AI助手KPI');

export const WeekComparisonSchema = z.object({
  thisWeek: z.object({ revenue: z.number(), occupancy: z.number(), adr: z.number() }),
  lastWeek: z.object({ revenue: z.number(), occupancy: z.number(), adr: z.number() }),
  changes: z.object({ revenue: z.number(), occupancy: z.number(), adr: z.number() }),
}).describe('周对比');

export const AIDashboardResponseSchema = z.object({
  kpi: AIDashboardKpiSchema,
  weekComparison: WeekComparisonSchema,
  revenueTrend: z.array(z.any()),
  channelDistribution: z.array(z.any()),
  storeComparison: z.array(z.any()),
  roomTypeRanking: z.array(z.any()),
  occupancyTrend: z.array(z.any()),
}).describe('AI智能助手数据');

// ============ AI Revenue ============

export const AIRevenueResponseSchema = z.object({
  aiSuggestions: z.array(z.any()),
  pricingCalendar: z.array(z.any()),
  competitorMonitor: z.array(z.any()),
  priceHistory: z.array(z.any()),
}).describe('AI收益助手数据');

// ============ AI Diagnosis ============

export const AIDiagnosisResponseSchema = z.object({
  overallScore: z.number(),
  dimensions: z.array(z.any()),
  recommendations: z.array(z.any()),
}).describe('AI经营诊断数据');

// ============ 查询参数 ============

export const DataCenterQuerySchema = z.object({
  type: z.enum(['dashboard', 'revenue', 'diagnosis']).describe('查询类型'),
}).describe('AI助手查询参数');

// ============ 路由定义 ============

export const getDataCenter = {
  method: 'get' as const,
  path: '/',
  summary: '获取AI助手数据',
  description: '返回AI经营概览/收益分析/经营诊断',
  tags: ['AI助手'],
  request: { query: DataCenterQuerySchema },
  responses: {
    200: { description: 'AI数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const postDataCenter = {
  method: 'post' as const,
  path: '/',
  summary: 'AI对话',
  description: '发送AI对话消息',
  tags: ['AI助手'],
  request: {
    body: { content: { 'application/json': { schema: z.object({ message: z.string() }) } } },
  },
  responses: {
    200: { description: 'AI响应', content: { 'application/json': { schema: z.any() } } },
  },
};
