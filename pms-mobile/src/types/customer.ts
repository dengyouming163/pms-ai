/** 会员等级映射 */
export interface MemberLevel {
  key: string
  name: string
  discount: number
  icon: string
}

/** 客户信息（来自 /api/customers） */
export interface CustomerInfo {
  id: string
  name: string
  phone: string
  gender?: string
  birthday?: string
  idCard?: string
  avatar?: string
  source?: string
  memberLevel?: string | MemberLevel
  tags?: string[]
  totalSpent?: number
  stayCount?: number
  nights?: number
  avgPrice?: number
  lastStayDate?: string
  valueScore?: number
  remark?: string
  merchantId?: string
  storeId?: string
  createdAt?: string
  updatedAt?: string
}

/** 客户查询参数 */
export interface CustomerQueryParams {
  keyword?: string
  tag?: string
  level?: string
  page?: number
  limit?: number
  type?: string
  id?: string
}

/** 客户统计数据 */
export interface CustomerStats {
  total: number
  newThisMonth: number
  vipCount: number
  regularCount: number
  carePending: number
  avgValueScore: number
}

/** 客户分页 */
export interface CustomerPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

/** 客户列表完整响应 */
export interface CustomerListResponse {
  customers: CustomerInfo[]
  pagination: CustomerPagination
  stats: CustomerStats
}

// 保留旧接口兼容
export interface Customer {
  id: string
  name: string
  phone: string
  idCard?: string
  avatar?: string
  level?: 'VIP' | 'regular' | 'new'
  totalOrders?: number
  totalAmount?: number
  lastVisitDate?: string
  remark?: string
}

export interface CustomerQueryParams2 {
  keyword?: string
  level?: string
  page?: number
  pageSize?: number
}
