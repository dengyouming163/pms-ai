import { z } from 'zod';

// ============ 子模型 ============

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  color: z.string(),
  todayOrders: z.number(),
  todayRevenue: z.number(),
  account: z.string(),
  balance: z.number(),
  status: z.enum(['connected', 'disconnected', 'syncing']),
  syncStatus: z.string(),
  lastSync: z.string(),
  features: z.array(z.string()),
  description: z.string(),
}).describe('渠道');

export const ChannelSummarySchema = z.object({
  total: z.number(),
  connected: z.number(),
  todayOrders: z.number(),
  monthOrders: z.number(),
  monthRevenue: z.number(),
  avgCommission: z.number(),
}).describe('渠道汇总');

export const ReviewSchema = z.object({
  id: z.string(),
  channelName: z.string(),
  channelIcon: z.string(),
  guestName: z.string(),
  roomType: z.string(),
  rating: z.number(),
  content: z.string(),
  replyContent: z.string().optional(),
  replyStatus: z.enum(['replied', 'pending', 'ignored']),
  reviewTime: z.string(),
  tags: z.array(z.string()),
}).describe('评价');

// ============ 查询参数 ============

export const ChannelQuerySchema = z.object({
  type: z.enum(['mappings', 'sync', 'inventory', 'reviews']).optional().describe('查询类型'),
}).describe('渠道查询参数');

// ============ 路由定义 ============

export const getChannels = {
  method: 'get' as const,
  path: '/',
  summary: '获取渠道数据',
  description: '返回渠道列表+汇总，或评价/同步等子数据',
  tags: ['渠道管理'],
  request: { query: ChannelQuerySchema },
  responses: {
    200: { description: '渠道数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const postChannels = {
  method: 'post' as const,
  path: '/',
  summary: '渠道操作',
  description: '同步渠道/回复评价等写操作',
  tags: ['渠道管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '操作成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};
