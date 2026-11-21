// 用户信息
export interface UserInfo {
  id: string
  name: string
  phone: string
  avatar?: string
  role: UserRole
  storeId?: string
  storeName?: string
  brandId?: string
  brandName?: string
}

// 用户角色枚举
export enum UserRole {
  TENANT_ADMIN = 'tenant_admin',     // 租户管理员
  BRAND_MANAGER = 'brand_manager',  // 品牌经理
  STORE_MANAGER = 'store_manager',   // 店长
  FINANCIAL = 'financial',           // 财务
  FRONT_DESK = 'front_desk',        // 前台
  CLEANING = 'cleaning',            // 保洁
  MAINTENANCE = 'maintenance'        // 维修
}

// 门店信息
export interface Store {
  id: string
  name: string
  address: string
  phone: string
  brandId: string
  brandName: string
  roomCount: number
  managerId: string
  managerName: string
}

// 登录参数
export interface LoginParams {
  phone: string
  password: string
}

// 登录响应
export interface LoginResponse {
  token: string
  userInfo: UserInfo
  stores: Store[]
}

// 登录结果（与 LoginResponse 等价，api 层使用）
export type LoginResult = LoginResponse

// 员工信息（与 UserInfo 等价）
export type EmployeeInfo = UserInfo

// ========== 新增类型 ==========

/** 员工信息（来自 /api/staff） */
export interface StaffInfo {
  id: string
  name: string
  phone: string
  email?: string
  avatar?: string
  department?: string
  position?: string
  roleId?: string
  roleName?: string
  scope?: string
  stores?: Array<{ id: string; name: string }>
  status: 'active' | 'disabled'
  merchantId?: string
  joinDate?: string
  createdAt?: string
  updatedAt?: string
}

/** 员工统计数据 */
export interface StaffStats {
  total: number
  active: number
  disabled: number
  onlineToday: number
}

/** 员工列表分页 */
export interface StaffPagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

/** 员工列表完整响应 */
export interface StaffListResponse {
  staff: StaffInfo[]
  pagination: StaffPagination
  stats: StaffStats
}

/** 房型信息 */
export interface RoomTypeInfo {
  id: string
  name: string
  storeId?: string
  merchantId?: string
  bedType?: string
  area?: number | string
  maxGuests?: number
  facilities?: string[]
  roomCount?: number
  basePrice?: number
  images?: string[]
  description?: string
  status?: string
  createdAt?: string
  updatedAt?: string
}

/** 房间信息 */
export interface RoomInfo {
  id: string
  roomNumber: string
  roomTypeId: string
  roomTypeName?: string
  storeId?: string
  merchantId?: string
  floor?: number
  status: string
  price?: number
  attributes?: string[]
  createdAt?: string
  updatedAt?: string
}

/** 价格规则 */
export interface PriceRule {
  id: string
  roomType: string
  roomTypeId: string
  storeId?: string
  merchantId?: string
  basePrice: number
  weekdayPrice: number
  weekendPrice: number
  holidayPrice?: number
  minPrice?: number
  status: string
  createdAt?: string
  updatedAt?: string
}

/** 通知项 */
export interface NotificationItem {
  id: string
  title: string
  content: string
  isRead?: boolean
  read?: boolean
  type?: string
  createdAt: string
  data?: any
}
