// src/utils/role.ts
// 角色工具：后端登录返回的 userInfo.role 是对象 { id, name, scope, permissions }，
// 本模块统一从该结构提取角色名/权限，避免各处把对象当字符串比较（历史 bug）。

/** 从 userInfo 提取角色名（中文，如 超级管理员/酒店经理/店长）；兼容字符串 role 与 roleName 兜底 */
export function getRoleName(userInfo: any): string {
  if (!userInfo) return ''
  const r = userInfo.role
  if (r && typeof r === 'object') return r.name || ''
  if (typeof r === 'string') return r
  return userInfo.roleName || ''
}

/** 从 userInfo 提取角色权限数组 */
export function getRolePermissions(userInfo: any): string[] {
  const r = userInfo?.role
  if (r && typeof r === 'object' && Array.isArray(r.permissions)) return r.permissions
  return []
}

/** 管理岗：角色权限含 assets:manage / all，或中文角色名属管理岗 */
export function isManagerRole(userInfo: any): boolean {
  const perms = getRolePermissions(userInfo)
  if (perms.includes('all') || perms.includes('*') || perms.includes('assets:manage')) return true
  const name = getRoleName(userInfo)
  return ['超级管理员', '酒店经理', '店长', '品牌经理'].includes(name)
}

/** 平台/租户管理员（可看所有门店）：权限含 all，或角色为超级管理员/品牌经理 */
export function isTenantAdminRole(userInfo: any): boolean {
  const perms = getRolePermissions(userInfo)
  if (perms.includes('all') || perms.includes('*')) return true
  return ['超级管理员', '品牌经理'].includes(getRoleName(userInfo))
}
