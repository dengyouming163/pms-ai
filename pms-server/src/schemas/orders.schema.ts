import { z } from 'zod';

// ============ 子模型 ============

export const OrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  channel: z.string(),
  channelColor: z.string(),
  icon: z.string().optional(),
  guestName: z.string(),
  guestPhone: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  roomType: z.string(),
  roomTypeId: z.string(),
  roomNumber: z.string(),
  nights: z.number(),
  roomCount: z.number(),
  totalPrice: z.number(),
  status: z.enum(['pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'pending_confirm']),
  paymentStatus: z.string(),
  source: z.string().optional(),
  channelOrderId: z.string().optional(),
  confirmedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  remark: z.string().optional(),
  createdAt: z.string(),
}).describe('订单');

export const OrderStatsSchema = z.object({
  total: z.number(),
  pending: z.number(),
  otaPending: z.number(),
  urgent: z.number(),
  todayCheckin: z.number(),
  todayCheckout: z.number(),
  channelBreakdown: z.array(z.object({
    channel: z.string(),
    name: z.string(),
    color: z.string(),
    icon: z.string(),
    count: z.number(),
  })),
  statusBreakdown: z.record(z.string(), z.number()),
}).describe('订单统计');

export const ChannelPendingOrderSchema = z.object({
  id: z.string(),
  orderNo: z.string(),
  channel: z.string(),
  channelColor: z.string(),
  icon: z.string().optional(),
  channelOrderId: z.string().optional(),
  guestName: z.string(),
  guestPhone: z.string(),
  roomType: z.string(),
  roomTypeId: z.string(),
  roomNumber: z.string(),
  nights: z.number(),
  roomCount: z.number(),
  totalPrice: z.number(),
  status: z.string(),
  paymentStatus: z.string(),
  source: z.string().optional(),
  confirmedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  cancelReason: z.string().optional(),
  remark: z.string(),
}).describe('渠道待处理订单');

// ============ 查询参数 ============

export const OrderQuerySchema = z.object({
  type: z.enum(['list', 'stats', 'channel-pending', 'detail']).optional().describe('查询类型'),
  id: z.string().optional().describe('订单ID'),
  channel: z.string().optional().describe('渠道筛选'),
  status: z.string().optional().describe('状态筛选'),
  keyword: z.string().optional().describe('关键词搜索'),
}).describe('订单查询参数');

// ============ 请求 ============

export const ConfirmOrderRequestSchema = z.object({
  ids: z.array(z.string()).describe('要确认的订单ID列表'),
}).describe('确认订单请求');

export const CancelOrderRequestSchema = z.object({
  id: z.string().describe('订单ID'),
  reason: z.string().optional().describe('取消原因'),
}).describe('取消订单请求');

// ============ 路由定义 ============

export const getOrders = {
  method: 'get' as const,
  path: '/',
  summary: '获取订单数据',
  description: '根据type参数返回订单列表/统计/渠道待处理/详情',
  tags: ['订单管理'],
  request: { query: OrderQuerySchema },
  responses: {
    200: { description: '订单数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const confirmOrder = {
  method: 'post' as const,
  path: '/',
  summary: '确认/批量确认订单',
  description: '确认或批量确认渠道待处理订单',
  tags: ['订单管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '确认成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};

export const cancelOrder = {
  method: 'put' as const,
  path: '/',
  summary: '取消订单',
  description: '取消指定订单',
  tags: ['订单管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '取消成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};
