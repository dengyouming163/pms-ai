// 订单状态枚举（与 pms-server 对齐）
export type OrderStatusType =
  | 'pending'          // 待确认
  | 'pending_confirm'  // 渠道待确认
  | 'confirmed'        // 已确认
  | 'checked_in'       // 已入住
  | 'checked_out'      // 已退房
  | 'cancelled'        // 已取消
  | 'no_show'          // 未到店

// 订单来源渠道（pms-server 使用中文渠道名）
export type OrderChannelType = string

// 支付状态
export type PaymentStatusType = 'paid' | 'unpaid' | 'partial' | 'refunded'

// 状态信息标签
export interface StatusInfo {
  label: string
  color: string
}

// 渠道信息
export interface ChannelInfo {
  color: string
  icon: string
}

// 操作时间线节点
export interface OrderTimeline {
  time: string
  label: string
  desc: string
}

// 额外费用项
export interface OrderExtra {
  name: string
  amount: number
}

// 订单（与 pms-server formatOrder 返回的字段对齐）
export interface Order {
  id: string
  orderNo: string
  channel: string
  channelColor: string
  icon: string
  channelOrderId?: string
  guestName: string
  guestPhone: string
  guestId?: string
  checkIn: string
  checkOut: string
  roomType: string
  roomTypeId: string
  roomNumber: string
  roomId?: string
  nights: number
  source?: string
  amount: number
  originalAmount: number
  discount?: string
  extras: OrderExtra[]
  paymentMethod: string
  paymentStatus: PaymentStatusType
  paymentStatusInfo: StatusInfo
  status: OrderStatusType
  statusInfo: StatusInfo
  remark: string
  otaTimeout?: string
  otaOrderId?: string
  platformOrderId?: string
  platformOrderNo?: string
  verifyCode?: string
  confirmedAt?: string
  cancelledAt?: string
  cancelReason?: string
  channelInfo: ChannelInfo
  createdAt: string
  timeline?: OrderTimeline[]
}

// 订单统计
export interface OrderStats {
  total: number
  pending: number
  otaPending: number
  urgent: number
  todayCheckin: number
  todayCheckout: number
  channelBreakdown: ChannelBreakdown[]
  channels?: string[]
  statusBreakdown: StatusBreakdown[]
}

// 渠道分布
export interface ChannelBreakdown {
  name: string
  count: number
  color: string
}

// 状态分布
export interface StatusBreakdown {
  key: string
  label: string
  count: number
}

// 渠道待确认分组
export interface ChannelPendingGroup {
  name: string
  color: string
  icon: string
  count: number
  urgentCount: number
  orders: Order[]
}

// 渠道待确认响应
export interface ChannelPendingResponse {
  channels: ChannelPendingGroup[]
}

// 分页信息
export interface PaginationInfo {
  page: number
  limit: number
  total: number
  totalPages: number
}

// 订单列表响应
export interface OrderListResponse {
  orders: Order[]
  pagination: PaginationInfo
  stats?: OrderStats
  channels?: ChannelPendingGroup[]
}

// 订单筛选参数
export interface OrderFilters {
  status?: string
  channel?: string
  keyword?: string
}

// 创建订单参数（与 pms-server orderActionSchema create 对齐）
export interface CreateOrderParams {
  guestName: string
  guestPhone: string
  roomId?: string
  channel?: string
  checkIn?: string
  checkOut?: string
  roomType?: string
  roomTypeId?: string
  roomNumber?: string
  amount?: number | string
  source?: string
  paymentMethod?: string
  remark?: string
}
