import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { ROLE_PERMISSIONS, MENU_CONFIG, MenuItem } from '@/constants/permissions'
import { getRoleName } from '@/utils/role'

export function usePermission() {
  const authStore = useAuthStore()
  // 注意：本 composable 为遗留代码（0 调用），ROLE_PERMISSIONS/MENU_CONFIG 使用旧英文角色 key，
  // 与后端中文角色名不匹配，仅修正 role 提取逻辑保持一致。
  const currentRole = computed(() => getRoleName(authStore.userInfo))

  const hasPermission = (permission: string): boolean => {
    const permissions = ROLE_PERMISSIONS[currentRole.value] || []
    return permissions.includes(permission)
  }

  const currentMenus = computed((): MenuItem[] => {
    return MENU_CONFIG[currentRole.value] || []
  })

  const canAccessPath = (path: string): boolean => {
    const menus = currentMenus.value
    return menus.some(menu => menu.path === path) || path.includes('/pages/login')
  }

  return {
    hasPermission,
    currentMenus,
    canAccessPath
  }
}
