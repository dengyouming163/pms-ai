import { defineStore } from 'pinia'
import type { StaffInfo, StaffStats, PriceRule, RoomTypeInfo, RoomInfo, Store } from '@/types/user'
import type { CustomerInfo, CustomerStats } from '@/types/customer'
import { getStaffList } from '@/api/modules/staff'
import { getCustomerList } from '@/api/modules/customers'
import { getPricingRules, getPricingCalendar } from '@/api/modules/pricing'
import { getRoomTypes, getRooms, getStores } from '@/api/modules/user'

interface ProfileState {
  /** 员工列表 */
  staffList: StaffInfo[]
  /** 员工统计 */
  staffStats: StaffStats | null
  /** 客户列表 */
  customerList: CustomerInfo[]
  /** 客户统计 */
  customerStats: CustomerStats | null
  /** 定价规则 */
  pricingRules: PriceRule[]
  /** 价格日历 */
  pricingCalendar: any[]
  /** 房型列表 */
  roomTypes: RoomTypeInfo[]
  /** 房间列表 */
  rooms: RoomInfo[]
  /** 门店列表 */
  stores: Store[]
  /** 加载状态 */
  loading: boolean
}

export const useProfileStore = defineStore('profile', {
  state: (): ProfileState => ({
    staffList: [],
    staffStats: null,
    customerList: [],
    customerStats: null,
    pricingRules: [],
    pricingCalendar: [],
    roomTypes: [],
    rooms: [],
    stores: [],
    loading: false,
  }),

  actions: {
    /** 获取员工列表 */
    async fetchStaff(params?: { page?: number; limit?: number; keyword?: string }) {
      this.loading = true
      try {
        const result = await getStaffList(params)
        this.staffList = result.staff || []
        this.staffStats = result.stats || null
        return result
      } finally {
        this.loading = false
      }
    },

    /** 获取客户列表 */
    async fetchCustomers(params?: { page?: number; limit?: number; keyword?: string; tag?: string; level?: string }) {
      this.loading = true
      try {
        const result = await getCustomerList(params)
        this.customerList = result.customers || []
        this.customerStats = result.stats || null
        return result
      } finally {
        this.loading = false
      }
    },

    /** 获取定价规则 */
    async fetchPricing() {
      this.loading = true
      try {
        const rules = await getPricingRules()
        this.pricingRules = Array.isArray(rules) ? rules : []
        return this.pricingRules
      } finally {
        this.loading = false
      }
    },

    /** 获取价格日历 */
    async fetchPricingCalendar() {
      this.loading = true
      try {
        const calendar = await getPricingCalendar()
        this.pricingCalendar = Array.isArray(calendar) ? calendar : []
        return this.pricingCalendar
      } finally {
        this.loading = false
      }
    },

    /** 获取房型列表 */
    async fetchRoomTypes(storeId?: string) {
      this.loading = true
      try {
        const types = await getRoomTypes(storeId)
        this.roomTypes = Array.isArray(types) ? types : []
        return this.roomTypes
      } finally {
        this.loading = false
      }
    },

    /** 获取房间列表 */
    async fetchRooms(storeId?: string) {
      this.loading = true
      try {
        const rooms = await getRooms(storeId)
        this.rooms = Array.isArray(rooms) ? rooms : []
        return this.rooms
      } finally {
        this.loading = false
      }
    },

    /** 获取门店列表 */
    async fetchStores() {
      this.loading = true
      try {
        const stores = await getStores()
        this.stores = Array.isArray(stores) ? stores : []
        return this.stores
      } finally {
        this.loading = false
      }
    },
  },
})
