import { get } from '@/api/request'
import type { CustomerInfo, CustomerListResponse } from '@/types/customer'

/** 获取客户列表（含分页、统计） */
export function getCustomerList(params?: {
  page?: number
  limit?: number
  keyword?: string
  tag?: string
  level?: string
}): Promise<CustomerListResponse> {
  return get('/api/customers', params)
}

/** 获取客户详情 */
export function getCustomerDetail(id: string): Promise<CustomerInfo> {
  return get('/api/customers', { type: 'detail', id })
}
