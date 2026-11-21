import { get, post, put } from '../request'
import type { DailyData, MonthlyData } from '@/types/room'
import type { Order, CreateOrderParams } from '@/types/order'

/** 获取日房态 */
export function getDailyRooms(date: string, storeId?: string): Promise<DailyData> {
  return get('/api/rooms', { type: 'daily', date, store_id: storeId })
}

/** 获取月房态 — 修复参数为 start + days（与 pms-web 后端对齐） */
export function getMonthlyRooms(start: string, days: number = 30, storeId?: string): Promise<MonthlyData> {
  return get('/api/rooms', { type: 'monthly', start, days, store_id: storeId })
}

/** 房间操作（通用）— 与 pms-web 的 roomApi 对齐 */
export function roomAction(action: string, params: Record<string, any> = {}): Promise<any> {
  return post('/api/rooms', { action, ...params })
}

/** 入住 */
export function checkIn(params: {
  roomId: string
  guestName: string
  guestPhone: string
  idCard?: string
  checkInDate: string
  checkOutDate: string
  deposit?: number
  paymentStatus?: string
  amountPaid?: number
  paymentMethod?: string
  source?: string
  remark?: string
}): Promise<Order> {
  return roomAction('checkIn', params)
}

/** 退房 */
export function checkOut(roomId: string): Promise<void> {
  return roomAction('checkOut', { roomId })
}

/** 预订 */
export function bookRoom(params: {
  roomId: string
  guestName: string
  guestPhone: string
  checkInDate: string
  checkOutDate: string
  remark?: string
}): Promise<Order> {
  return roomAction('book', params)
}

/** 锁房 */
export function lockRoom(roomId: string, reason: string): Promise<void> {
  return roomAction('lock', { roomId, reason })
}

/** 解锁 */
export function unlockRoom(roomId: string): Promise<void> {
  return roomAction('unlock', { roomId })
}

/** 标记脏房 */
export function markDirty(roomId: string): Promise<void> {
  return roomAction('markDirty', { roomId })
}

/** 标记干净 */
export function markClean(roomId: string): Promise<void> {
  return roomAction('markClean', { roomId })
}

/** 设为维修 */
export function setMaintenance(roomId: string, reason: string): Promise<void> {
  return roomAction('setMaintenance', { roomId, reason })
}

/** 恢复可用 */
export function restoreAvailable(roomId: string): Promise<void> {
  return roomAction('restoreAvailable', { roomId })
}

/** 续住 */
export function extendStay(roomId: string, checkOutDate: string): Promise<void> {
  return roomAction('extendStay', { roomId, checkOutDate })
}

/** 换房 */
export function changeRoom(fromRoomId: string, toRoomId: string, reason: string): Promise<void> {
  return roomAction('changeRoom', { fromRoomId, toRoomId, reason })
}

/** 取消预订 */
export function cancelBook(roomId: string, reason: string): Promise<void> {
  return roomAction('cancelBook', { roomId, reason })
}

/** 修改预订 */
export function modifyBook(params: {
  roomId: string
  guestName: string
  guestPhone: string
  checkInDate: string
  checkOutDate: string
}): Promise<void> {
  return roomAction('modifyBook', params)
}

/** 更新房间状态（保留兼容） */
export function updateRoomStatus(roomId: string, status: string, remark?: string): Promise<void> {
  return put('/api/rooms', { action: 'updateRoomStatus', roomId, status, remark })
}

/** 创建订单（保留兼容） */
export function createBooking(params: CreateOrderParams): Promise<Order> {
  return post('/api/orders', { action: 'create', ...params })
}
