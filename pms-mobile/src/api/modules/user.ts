import { get, post } from '@/api/request'
import type { Store, RoomTypeInfo, RoomInfo } from '@/types/user'

/** 获取可切换的门店列表 */
export function getStores(): Promise<Store[]> {
  return get('/api/stores')
}

/** 获取门店详情 */
export function getStoreDetail(storeId: string): Promise<Store> {
  return get('/api/stores', { type: 'storeDetail', storeId })
}

/** 获取房型列表（可选按门店过滤） */
export function getRoomTypes(storeId?: string): Promise<RoomTypeInfo[]> {
  return get('/api/stores', { type: 'roomTypes', storeId: storeId || '' })
}

/** 获取房间列表（可选按门店过滤） */
export function getRooms(storeId?: string): Promise<RoomInfo[]> {
  return get('/api/stores', { type: 'rooms', storeId: storeId || '' })
}

/** 修改密码（旧密码方式） */
export function changePassword(oldPwd: string, newPwd: string): Promise<any> {
  return post('/api/auth/change-password', { oldPassword: oldPwd, newPassword: newPwd })
}

/** 发送短信验证码 */
export function sendSms(phone: string): Promise<any> {
  return post('/api/auth/send-sms', { phone })
}

/** 短信验证码重置密码 */
export function resetPassword(phone: string, code: string, newPwd: string): Promise<any> {
  return post('/api/auth/reset-password', { phone, code, newPassword: newPwd })
}

/** 获取未读通知数 */
export function getUnreadCount(): Promise<{ count: number }> {
  return get('/api/notifications/unread')
}

/** 获取通知列表 */
export function getNotifications(params?: { page?: number; pageSize?: number }): Promise<{
  list: Array<{ id: string; title: string; content: string; isRead: boolean; createdAt: string }>
  total: number
}> {
  return get('/api/notifications', params)
}

/** 标记通知已读 */
export function markNotificationRead(notificationId: string): Promise<void> {
  return post('/api/notifications/read', { id: notificationId })
}

/** 提交反馈 */
export function submitFeedback(params: { content: string; contact?: string; images?: string[] }): Promise<void> {
  return post('/api/feedback', params)
}

// ========== 房型 CRUD ==========

/** 新增房型 */
export function addRoomType(data: {
  storeId: string
  name: string
  bedType?: string
  area?: number
  maxGuests?: number
  basePrice?: number
  roomCount?: number
  facilities?: string[]
  images?: string[]
}): Promise<any> {
  return post('/api/stores', { action: 'addRoomType', ...data })
}

/** 编辑房型 */
export function editRoomType(id: string, data: {
  storeId?: string
  name?: string
  bedType?: string
  area?: number
  maxGuests?: number
  basePrice?: number
  roomCount?: number
  facilities?: string[]
  images?: string[]
}): Promise<any> {
  return post('/api/stores', { action: 'editRoomType', id, ...data })
}

// ========== 房间 CRUD ==========

/** 新增房间 */
export function addRoom(data: {
  storeId: string
  roomTypeId: string
  roomTypeName: string
  roomNumber: string
  floor?: number
  price?: number
  attributes?: string[]
}): Promise<any> {
  return post('/api/stores', { action: 'addRoom', ...data })
}

/** 编辑房间 */
export function editRoom(id: string, data: {
  roomNumber?: string
  floor?: number
  status?: string
  price?: number
  attributes?: string[]
}): Promise<any> {
  return post('/api/stores', { action: 'editRoom', id, ...data })
}

/** 删除房间 */
export function deleteRoom(id: string): Promise<any> {
  return post('/api/stores', { action: 'deleteRoom', id })
}

// ========== 素材库 ==========

/** 获取素材列表 */
export function getAssets(params?: { category?: string; page?: number; pageSize?: number }): Promise<{
  list: Array<{ id: string; url: string; name: string; category: string; createdAt: string }>
  total: number
}> {
  return get('/api/assets', params)
}
