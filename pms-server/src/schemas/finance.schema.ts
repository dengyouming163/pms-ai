import { z } from 'zod';

// ============ 子模型 ============

export const TransactionSchema = z.object({
  id: z.string(),
  type: z.enum(['income', 'expense']),
  category: z.string(),
  amount: z.number(),
  channel: z.string().optional(),
  orderNo: z.string().optional(),
  guestName: z.string().optional(),
  storeName: z.string().optional(),
  paymentMethod: z.string(),
  createdAt: z.string(),
  status: z.enum(['completed', 'pending', 'failed']),
  remark: z.string().optional(),
}).describe('收支流水');

export const ReconciliationSummarySchema = z.object({
  totalOrders: z.number(),
  totalAmount: z.number(),
  matchedOrders: z.number(),
  unmatchedOrders: z.number(),
  missingSystemOrders: z.number(),
  missingChannelOrders: z.number(),
  unmatchedAmount: z.number(),
  lastSyncAt: z.string(),
  nextSyncAt: z.string(),
}).describe('对账汇总');

export const ReconciliationAlertSchema = z.object({
  id: z.string(),
  type: z.string(),
  channel: z.string(),
  title: z.string(),
  description: z.string(),
  count: z.number(),
  amount: z.number(),
  time: z.string(),
}).describe('对账预警');

export const ReconciliationDetailSchema = z.object({
  id: z.string(),
  channelName: z.string(),
  orderNo: z.string(),
  guestName: z.string(),
  systemAmount: z.number(),
  channelAmount: z.number(),
  difference: z.number(),
  status: z.enum(['matched', 'unmatched', 'missing_system', 'missing_channel']),
  orderDate: z.string(),
}).describe('对账明细');

export const ChannelStatSchema = z.object({
  id: z.string(),
  channel: z.string(),
  monthOrders: z.number(),
  monthRevenue: z.number(),
  commissionRate: z.number(),
  commission: z.number(),
  settled: z.number(),
  pending: z.number(),
  totalOrders: z.number(),
  matchedOrders: z.number(),
  unmatchedOrders: z.number(),
}).describe('渠道统计');

// ============ 查询参数 ============

export const FinanceQuerySchema = z.object({
  type: z.enum(['transactions', 'reconciliation', 'report']).describe('查询类型'),
}).describe('收支查询参数');

// ============ 路由定义 ============

export const getFinance = {
  method: 'get' as const,
  path: '/',
  summary: '获取收支数据',
  description: '根据type返回收支流水/对账提醒/报表',
  tags: ['收支明细'],
  request: { query: FinanceQuerySchema },
  responses: {
    200: { description: '收支数据', content: { 'application/json': { schema: z.any() } } },
  },
};
