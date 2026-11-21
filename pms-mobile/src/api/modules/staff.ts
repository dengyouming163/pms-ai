import { get, post } from '@/api/request'
import type { StaffListResponse } from '@/types/user'

/** 获取员工列表（含分页、统计） */
export function getStaffList(params?: {
  page?: number
  limit?: number
  keyword?: string
}): Promise<StaffListResponse> {
  return get('/api/staff', params)
}

/** 获取角色列表 */
export async function getRoles(): Promise<Array<{ id: string; name: string; code: string }>> {
  const result: any = await get('/api/staff', { type: 'roles' })
  return result?.roles || result || []
}

/** 切换员工状态（启用/禁用） */
export function toggleStaff(staffId: string): Promise<{ success: boolean; status: string }> {
  return post('/api/staff', { action: 'toggle_staff', staffId })
}

/** 创建员工 */
export function createStaff(data: {
  name: string
  phone: string
  roleId: string
  roleName: string
  scope: string
  stores: Array<{ id: string; name: string }>
}): Promise<{ success: boolean; staffId: string }> {
  return post('/api/staff', { action: 'create_staff', data })
}

/** 编辑员工 */
export function editStaff(staffId: string, data: {
  name: string
  phone: string
  roleId: string
  roleName: string
  scope: string
  stores: Array<{ id: string; name: string }>
}): Promise<{ success: boolean }> {
  return post('/api/staff', { action: 'edit_staff', staffId, data })
}

/** 重置员工密码（默认 888888） */
export function resetStaffPassword(staffId: string): Promise<{ success: boolean }> {
  return post('/api/staff', { action: 'reset_password', staffId })
}
