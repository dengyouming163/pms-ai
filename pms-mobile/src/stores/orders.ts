import { defineStore } from 'pinia'
import {
  getOrders,
  getOrderStats,
  getChannelPendingOrders,
  getOrderDetail,
  confirmOrder as confirmOrderApi,
  cancelOrder as cancelOrderApi,
  batchConfirmOrders as batchConfirmOrdersApi,
  batchCancelOrders as batchCancelOrdersApi,
} from '@/api/modules/orders'
import type {
  Order,
  OrderStats,
  OrderFilters,
  ChannelPendingGroup,
  PaginationInfo,
} from '@/types/order'

export const useOrdersStore = defineStore('orders', {
  state: () => ({
    // 订单列表
    orders: [] as Order[],
    // 加载状态
    loading: false,
    // 当前查看的订单详情
    currentOrder: null as Order | null,
    // 统计信息
    stats: null as OrderStats | null,
    // 渠道待确认分组数据
    channelPending: [] as ChannelPendingGroup[],
    // 筛选条件
    filters: {
      status: 'all',
      channel: '',
      keyword: '',
    } as OrderFilters,
    // 分页信息
    pagination: {
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    } as PaginationInfo,
    // 批量操作选中的订单ID集合
    selectedIds: [] as string[],
  }),

  getters: {
    /** 根据筛选条件过滤后的订单（客户端侧） */
    filteredOrders: (state) => {
      let result = state.orders
      if (state.filters.status && state.filters.status !== 'all') {
        // 兼容 pending 和 pending_confirm 两种待确认状态
        if (state.filters.status === 'pending') {
          result = result.filter(o => o.status === 'pending' || o.status === 'pending_confirm')
        } else {
          result = result.filter(o => o.status === state.filters.status)
        }
      }
      if (state.filters.channel) {
        result = result.filter(o => o.channel === state.filters.channel)
      }
      if (state.filters.keyword) {
        const kw = state.filters.keyword.toLowerCase()
        result = result.filter(o =>
          o.guestName.toLowerCase().includes(kw) ||
          o.orderNo.toLowerCase().includes(kw) ||
          o.guestPhone.includes(kw)
        )
      }
      return result
    },

    /** 待确认订单列表 */
    pendingOrders: (state) => state.orders.filter(
      o => o.status === 'pending' || o.status === 'pending_confirm'
    ),

    /** 渠道列表（去重） */
    availableChannels: (state) => {
      const channels = new Map<string, string>()
      state.orders.forEach(o => {
        if (!channels.has(o.channel)) {
          channels.set(o.channel, o.channel)
        }
      })
      return Array.from(channels.keys())
    },
  },

  actions: {
    /** 获取订单列表 */
    async fetchOrders(params?: { page?: number; limit?: number }) {
      this.loading = true
      try {
        const page = params?.page || this.pagination.page
        const limit = params?.limit || this.pagination.limit
        const result = await getOrders({
          page,
          limit,
          status: this.filters.status !== 'all' ? this.filters.status : undefined,
          channel: this.filters.channel || undefined,
          keyword: this.filters.keyword || undefined,
        })
        this.orders = result.orders || []
        this.pagination = result.pagination || { page: 1, limit: 20, total: 0, totalPages: 0 }
        if (result.stats) {
          this.stats = result.stats
        }
        if (result.channels) {
          this.channelPending = result.channels
        }
      } catch {
        this.orders = []
      } finally {
        this.loading = false
      }
    },

    /** 获取订单统计 */
    async fetchStats() {
      try {
        const stats = await getOrderStats()
        this.stats = stats
      } catch {
        // 统计获取失败不影响主流程
      }
    },

    /** 获取渠道待确认订单 */
    async fetchChannelPending(channel?: string) {
      this.loading = true
      try {
        const result = await getChannelPendingOrders(channel)
        this.channelPending = result.channels || []
      } catch {
        this.channelPending = []
      } finally {
        this.loading = false
      }
    },

    /** 获取订单详情（调用API而非本地查找） */
    async fetchOrderDetail(id: string) {
      this.loading = true
      try {
        const order = await getOrderDetail(id)
        this.currentOrder = order
        return order
      } catch {
        this.currentOrder = null
        return null
      } finally {
        this.loading = false
      }
    },

    /** 确认单个订单 */
    async confirmOrder(orderId: string) {
      await confirmOrderApi(orderId)
      // 从列表中移除该订单
      this.orders = this.orders.filter(o => o.id !== orderId)
      this.channelPending = this.channelPending.map(group => ({
        ...group,
        orders: group.orders.filter(o => o.id !== orderId),
        count: group.count - 1,
      })).filter(group => group.count > 0)
    },

    /** 取消单个订单 */
    async cancelOrder(orderId: string, reason?: string) {
      await cancelOrderApi(orderId, reason)
      // 刷新订单列表
      await this.fetchOrders()
    },

    /** 批量确认订单 */
    async batchConfirm(orderIds: string[]) {
      await batchConfirmOrdersApi(orderIds)
      // 清除选中状态并刷新
      this.selectedIds = []
      await this.fetchChannelPending()
    },

    /** 设置筛选条件并重新查询 */
    async setFilter(filter: Partial<OrderFilters>) {
      Object.assign(this.filters, filter)
      this.pagination.page = 1
      await this.fetchOrders()
    },

    /** 切换选中状态（渠道待确认订单） */
    selectOrder(orderId: string) {
      const index = this.selectedIds.indexOf(orderId)
      if (index > -1) {
        this.selectedIds.splice(index, 1)
      } else {
        this.selectedIds.push(orderId)
      }
    },

    /** 全选/取消全选某个渠道下的所有订单 */
    selectAllChannel(channelName: string) {
      const group = this.channelPending.find(g => g.name === channelName)
      if (!group) return

      const channelOrderIds = group.orders.map(o => o.id)
      const allSelected = channelOrderIds.every(id => this.selectedIds.includes(id))

      if (allSelected) {
        // 取消全选
        this.selectedIds = this.selectedIds.filter(id => !channelOrderIds.includes(id))
      } else {
        // 全选
        const existing = new Set(this.selectedIds)
        channelOrderIds.forEach(id => existing.add(id))
        this.selectedIds = Array.from(existing)
      }
    },

    /** 清除所有选中 */
    clearSelection() {
      this.selectedIds = []
    },

    /** 重置分页到第一页 */
    resetPagination() {
      this.pagination = { page: 1, limit: 20, total: 0, totalPages: 0 }
    },
  },
})
