import { get, post } from '../request'
import type {
  Order,
  OrderStats,
  OrderListResponse,
  ChannelPendingResponse,
  CreateOrderParams
} from '@/types/order'

/** 获取订单列表 —— GET /api/orders */
export function getOrders(params: {
  page?: number
  limit?: number
  status?: string
  channel?: string
  keyword?: string
} = {}): Promise<OrderListResponse> {
  return get('/api/orders', params)
}

/** 获取订单统计 —— GET /api/orders?type=stats */
export function getOrderStats(): Promise<OrderStats> {
  return get('/api/orders', { type: 'stats' })
}

/** 获取渠道待确认订单 —— GET /api/orders?type=channel-pending */
export function getChannelPendingOrders(channel?: string): Promise<ChannelPendingResponse> {
  const params: Record<string, string> = { type: 'channel-pending' }
  if (channel) params.channel = channel
  return get('/api/orders', params)
}

/** 获取订单详情 —— GET /api/orders?type=detail&id=xxx */
export function getOrderDetail(id: string): Promise<Order> {
  return get('/api/orders', { type: 'detail', id })
}

/** 确认订单 —— POST /api/orders { action: 'confirm', orderId } */
export function confirmOrder(orderId: string): Promise<{ success: boolean }> {
  return post('/api/orders', { action: 'confirm', orderId })
}

/** 取消订单 —— POST /api/orders { action: 'cancel', orderId, reason } */
export function cancelOrder(orderId: string, reason?: string): Promise<{ success: boolean }> {
  return post('/api/orders', { action: 'cancel', orderId, reason })
}

/** 批量确认订单 —— POST /api/orders { action: 'batchConfirm', orderIds } */
export function batchConfirmOrders(orderIds: string[]): Promise<{ success: boolean }> {
  return post('/api/orders', { action: 'batchConfirm', orderIds })
}

/** 批量取消订单 —— POST /api/orders { action: 'batchCancel', orderIds, reason } */
export function batchCancelOrders(orderIds: string[], reason?: string): Promise<{ success: boolean }> {
  return post('/api/orders', { action: 'batchCancel', orderIds, reason })
}

/** 创建订单 —— POST /api/orders { action: 'create', ... } */
export function createOrder(params: CreateOrderParams): Promise<{ success: boolean; message?: string; data?: { orderNo?: string } }> {
  return post('/api/orders', { action: 'create', ...params })
}

/** 按平台订单反查已转化住宿订单 —— GET /api/orders?type=byPlatformOrder&platformOrderId= */
export function getStayOrderByPlatformOrder(platformOrderId: string): Promise<Order> {
  return get('/api/orders', { type: 'byPlatformOrder', platformOrderId })
}
