// 房间状态枚举 — 与后端对齐（occupied/maintenance）
export enum RoomStatus {
  AVAILABLE = 'available',
  BOOKED = 'booked',
  OCCUPIED = 'occupied',
  DIRTY = 'dirty',
  MAINTENANCE = 'maintenance',
  LOCKED = 'locked',
}

// 房型
export interface RoomType {
  id: string
  name: string
  bedType: string
  capacity: number
  area?: number
  facilities: string[]
  images: string[]
}

// 房间（基础）
export interface Room {
  id: string
  roomNo: string
  floor: number
  roomTypeId: string
  roomTypeName: string
  status: RoomStatus
  remark?: string
}

// 日房态房间（含住客信息）
export interface DailyRoom {
  id: string
  roomTypeId: string
  roomTypeName: string
  roomNumber: string
  floor: number
  status: RoomStatus
  price: number
  guest?: string
  checkIn?: string
  checkOut?: string
  orderNo?: string
}

// 日房态统计
export interface DailySummary {
  total: number
  available: number
  booked: number
  occupied: number
  dirty: number
  maintenance: number
  locked: number
  occupancyRate: number
}

// 日房态响应
export interface DailyData {
  date: string
  rooms: DailyRoom[]
  floors: number[]
  summary: DailySummary
}

// 月房态每日状态（按房型）
export interface MonthlyDayStatus {
  date: string
  day: number
  total: number
  available: number
  booked: number
  occupied: number
  blocked: number
  isWeekend: boolean
  isPast: boolean
  isToday: boolean
}

// 月房态房型
export interface MonthlyRoomType {
  roomTypeId: string
  roomTypeName: string
  totalRooms: number
  basePrice: number
  dailyStatus: MonthlyDayStatus[]
}

// 月房态统计
export interface MonthlySummary {
  totalRooms: number
  todayOccupied: number
  todayBooked: number
  todayAvailable: number
  todayOccupancyRate: number
  avgOccupancyRate: number
}

// 月房态响应
export interface MonthlyData {
  year: number
  month: number
  daysInMonth: number
  roomTypes: MonthlyRoomType[]
  monthSummary: MonthlySummary
}

// 月房态聚合日（全店汇总，前端计算）
export interface MonthlyAggregatedDay {
  date: string
  day: number
  total: number
  available: number
  occupied: number
  booked: number
  occupancyRate: number
  isWeekend: boolean
  isPast: boolean
  isToday: boolean
}

// 入住信息（保留兼容）
export interface CheckInInfo {
  orderId: string
  guestName: string
  guestPhone: string
  idCard: string
  checkInDate: string
  checkOutDate: string
  roomId: string
  roomNo: string
  roomTypeName: string
  price: number
  remark?: string
}
