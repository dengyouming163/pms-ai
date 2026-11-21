import { get, post, put } from '../request'

/** 平台套餐订单（民宿端视角，转发 pms-server → pms-platform） */
export interface StoreProductOrder {
  id: string
  orderNo: string
  storeId: string
  productId: string
  productName: string | null
  guestName: string
  guestPhone: string
  roomNights: number | null
  quantity: number | null
  totalAmount: string
  status: string              // platform_approved / store_accepted / used / refunded
  paymentStatus: string
  mode: string | null         // A=订金 B=全款
  depositAmount: string | null
  balanceAmount: string | null
  balancePaidAt: string | null
  cancelPolicy: string | null
  reservationStatus: string | null
  reservationDate: string | null
  storeAcceptedAt: string | null
  usedAt: string | null
  refundedAt: string | null
  createdAt: string
  remark: string | null
}

/** 民宿端套餐订单列表 —— GET /api/store/product-orders
 *  scope: 'pending' 待处理（待接单+已接单）/ 'done' 已处理（已核销+已退款+已取消）；
 *  不传 scope 保持预约可见性（现有扫码单查兼容）
 */
export function getStoreProductOrders(params: {
  keyword?: string
  status?: string
  scope?: 'pending' | 'done'
  page?: number
  limit?: number
} = {}): Promise<any> {
  return get('/api/store/product-orders', params)
}

/** 套餐订单详情 —— GET /api/store/product-orders/:id */
export function getStoreProductOrderDetail(id: string): Promise<StoreProductOrder> {
  return get(`/api/store/product-orders/${id}`)
}

/** 民宿接单 —— POST /api/store/product-orders/:id/accept */
export function acceptStoreProductOrder(id: string): Promise<{ success: boolean }> {
  return post(`/api/store/product-orders/${id}/accept`, {})
}

/** 民宿拒单 —— POST /api/store/product-orders/:id/reject */
export function rejectStoreProductOrder(id: string, reason?: string): Promise<{ success: boolean }> {
  return post(`/api/store/product-orders/${id}/reject`, { reason: reason || '民宿拒单' })
}

/** 核销 —— PUT /api/store/product-orders/:id/use（模式A需先补尾款；verifyCode 为客人核销码，可选，商家输入后透传平台校验） */
export function useStoreProductOrder(id: string, verifyCode?: string): Promise<{ success: boolean }> {
  return put(`/api/store/product-orders/${id}/use`, { verifyCode: verifyCode || undefined })
}

/** 补尾款 —— PUT /api/store/product-orders/:id/pay-balance（仅模式A） */
export function payBalanceStoreProductOrder(id: string): Promise<{ success: boolean }> {
  return put(`/api/store/product-orders/${id}/pay-balance`, {})
}
