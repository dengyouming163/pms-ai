import { defineStore } from 'pinia'
import { getDailyRooms, getMonthlyRooms, roomAction } from '@/api/modules/rooms'
import type { DailyData, DailyRoom, MonthlyData, MonthlyAggregatedDay } from '@/types/room'

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

export const useRoomsStore = defineStore('rooms', {
  state: () => ({
    // 视图
    viewMode: 'daily' as 'daily' | 'monthly',
    groupBy: 'floor' as 'floor' | 'roomType',

    // 日房态
    selectedDate: formatDate(new Date()),
    dailyData: null as DailyData | null,
    dailyLoading: false,
    dailyError: '',

    // 月房态
    monthlyStart: formatDate(new Date()),
    monthlyData: null as MonthlyData | null,
    monthlyLoading: false,
    monthlyError: '',

    // ActionSheet
    actionSheetRoom: null as DailyRoom | null,
    actionSheetShow: false,

    // 房间详情
    currentRoom: null as DailyRoom | null,
  }),

  getters: {
    // 日房态统计
    dailySummary: (state) => state.dailyData?.summary || null,

    // 日房态按楼层分组
    roomsByFloor: (state) => {
      const g: Record<string, DailyRoom[]> = {}
      const rooms = state.dailyData?.rooms
      if (!Array.isArray(rooms)) return g
      rooms.forEach(r => {
        if (!r) return
        const floor = String(r.floor ?? '?')
        if (!g[floor]) g[floor] = []
        g[floor].push(r)
      })
      return g
    },

    // 日房态按房型分组
    roomsByType: (state) => {
      const g: Record<string, DailyRoom[]> = {}
      const rooms = state.dailyData?.rooms
      if (!Array.isArray(rooms)) return g
      rooms.forEach(r => {
        if (!r || !r.roomTypeName) return
        if (!g[r.roomTypeName]) g[r.roomTypeName] = []
        g[r.roomTypeName].push(r)
      })
      return g
    },

    // 月房态聚合日历（全店汇总）
    monthlyAggregatedDays: (state): MonthlyAggregatedDay[] => {
      if (!state.monthlyData?.roomTypes) return []
      const dayMap: Record<string, MonthlyAggregatedDay> = {}
      state.monthlyData.roomTypes.forEach(rt => {
        rt.dailyStatus.forEach(d => {
          if (!dayMap[d.date]) {
            dayMap[d.date] = {
              date: d.date, day: d.day, total: 0, available: 0,
              occupied: 0, booked: 0, occupancyRate: 0,
              isWeekend: d.isWeekend, isPast: d.isPast, isToday: d.isToday,
            }
          }
          dayMap[d.date].total += d.total
          dayMap[d.date].available += d.available
          dayMap[d.date].occupied += d.occupied
          dayMap[d.date].booked += d.booked
        })
      })
      return Object.values(dayMap).map(d => ({
        ...d,
        occupancyRate: d.total > 0 ? Math.round((d.occupied + d.booked) / d.total * 100) : 0,
      })).sort((a, b) => a.date.localeCompare(b.date))
    },

    // 月房态统计
    monthlySummary: (state) => state.monthlyData?.monthSummary || null,

    // 兼容旧接口
    totalRooms: (state) => state.dailyData?.summary?.total || 0,
  },

  actions: {
    // === 日房态 ===
    async fetchDailyData() {
      this.dailyLoading = true
      this.dailyError = ''
      try {
        const result: any = await getDailyRooms(this.selectedDate)
        // 兼容多种响应格式：DailyData / {rooms: [...]} / 数组 / {list: [...]}
        let rawRooms: any[] = []
        if (!result) {
          this.dailyData = null
          return
        } else if (Array.isArray(result)) {
          rawRooms = result
        } else if (Array.isArray(result.rooms)) {
          rawRooms = result.rooms
        } else if (Array.isArray(result.list)) {
          rawRooms = result.list
        } else if (Array.isArray(result.data)) {
          rawRooms = result.data
        } else if (result.data && Array.isArray(result.data.rooms)) {
          rawRooms = result.data.rooms
        }
        const rooms = rawRooms.map(r => this._normalizeRoom(r)).filter(Boolean) as DailyRoom[]
        this.dailyData = {
          date: (result && (result.date || result.data?.date)) || this.selectedDate,
          rooms,
          floors: (result && (result.floors || result.data?.floors)) || [],
          summary: rooms.length ? this._calcSummary(rooms) : this._calcSummary([]),
        }
      } catch (err: any) {
        this.dailyData = null
        this.dailyError = err?.message || '加载房态失败'
      } finally {
        this.dailyLoading = false
      }
    },

    _normalizeRoom(r: any): DailyRoom | null {
      if (!r || typeof r !== 'object') return null
      const roomNo = r.roomNumber || r.roomNo || r.number || ''
      const roomTypeId = r.roomTypeId || r.room_type_id || ''
      const roomTypeName = r.roomTypeName || r.room_type_name || r.typeName || ''
      let floor: number
      if (typeof r.floor === 'number') floor = r.floor
      else if (typeof r.floor === 'string') floor = parseInt(r.floor) || 0
      else if (r.floor && typeof r.floor === 'object') floor = r.floor.id || r.floor.no || 0
      else if (typeof r.floorNo === 'number') floor = r.floorNo
      else floor = 0
      const status = r.status || 'available'
      const price = r.price || r.basePrice || 0
      const guest = r.guestName || r.guest || undefined
      const checkIn = r.checkInDate || r.checkIn || undefined
      const checkOut = r.checkOutDate || r.checkOut || undefined
      return {
        id: String(r.id || r.roomId || roomNo),
        roomTypeId, roomTypeName,
        roomNumber: roomNo,
        floor, status, price,
        guest, checkIn, checkOut,
        orderNo: r.orderNo || undefined,
      }
    },

    _calcSummary(rooms: DailyRoom[]) {
      const s = { total: 0, available: 0, booked: 0, occupied: 0, dirty: 0, maintenance: 0, locked: 0, occupancyRate: 0 }
      rooms.forEach(r => {
        if (!r) return
        s.total++
        if (s[r.status] !== undefined) s[r.status]++
      })
      s.occupancyRate = s.total > 0 ? Math.round((s.occupied + s.booked) / s.total * 100) : 0
      return s
    },

    navigateDate(offset: number) {
      const d = new Date(this.selectedDate)
      d.setDate(d.getDate() + offset)
      this.selectedDate = formatDate(d)
      this.fetchDailyData()
    },

    goToday() {
      this.selectedDate = formatDate(new Date())
      this.fetchDailyData()
    },

    setDate(date: string) {
      this.selectedDate = date
      this.fetchDailyData()
    },

    // === 月房态 ===
    async fetchMonthlyData() {
      this.monthlyLoading = true
      this.monthlyError = ''
      try {
        const result = await getMonthlyRooms(this.monthlyStart, 7)
        this.monthlyData = result || null
      } catch (err: any) {
        this.monthlyData = null
        this.monthlyError = err?.message || '加载月房态失败'
      } finally {
        this.monthlyLoading = false
      }
    },

    // 周视图导航：每次移动7天
    navigateMonth(offset: number) {
      const d = new Date(this.monthlyStart)
      d.setDate(d.getDate() + offset * 7)
      this.monthlyStart = formatDate(d)
      this.fetchMonthlyData()
    },

    // 回到本周（对齐到周一）
    goThisMonth() {
      const d = new Date()
      const day = d.getDay()
      const mondayOffset = day === 0 ? -6 : 1 - day
      d.setDate(d.getDate() + mondayOffset)
      this.monthlyStart = formatDate(d)
      this.fetchMonthlyData()
    },

    // === 视图切换 ===
    setViewMode(mode: 'daily' | 'monthly') {
      this.viewMode = mode
      if (mode === 'daily' && !this.dailyData) this.fetchDailyData()
      if (mode === 'monthly' && !this.monthlyData) this.fetchMonthlyData()
    },

    setGroupBy(mode: 'floor' | 'roomType') {
      this.groupBy = mode
    },

    // === ActionSheet ===
    showActionSheet(room: DailyRoom) {
      this.actionSheetRoom = room
      this.actionSheetShow = true
    },

    hideActionSheet() {
      this.actionSheetShow = false
    },

    // === 房间操作 ===
    async executeAction(action: string, room: DailyRoom, extraParams: Record<string, any> = {}): Promise<boolean> {
      try {
        await roomAction(action, { roomId: room.id, ...extraParams })
        this.hideActionSheet()
        // 操作成功后刷新数据
        await this.fetchDailyData()
        if (this.monthlyData) this.fetchMonthlyData()
        return true
      } catch (err: any) {
        return false
      }
    },

    // === 房间详情 ===
    fetchRoomDetail(id: string) {
      // 从已有的 dailyData 或 monthlyData 中查找
      if (this.dailyData?.rooms) {
        const found = this.dailyData.rooms.find(r => r.id === id)
        if (found) { this.currentRoom = found; return }
      }
      // 如果找不到，设为 null
      this.currentRoom = null
    },

    // === 兼容旧接口 ===
    fetchRooms() { return this.fetchDailyData() },
  },
})
