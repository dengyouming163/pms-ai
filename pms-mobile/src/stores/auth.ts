import { defineStore } from 'pinia'
import type { UserInfo, Store, LoginParams } from '@/types/user'
import { passwordLogin, getUserInfo, logout as logoutApi } from '@/api/modules/auth'
import { getStores } from '@/api/modules/user'
import { getRoleName, isTenantAdminRole } from '@/utils/role'

interface AuthState {
  token: string
  userInfo: UserInfo | null
  stores: Store[]
  currentStore: Store | null
  isLoggedIn: boolean
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: uni.getStorageSync('token') || '',
    userInfo: uni.getStorageSync('userInfo') || null,
    stores: uni.getStorageSync('stores') || [],
    currentStore: uni.getStorageSync('currentStore') || null,
    isLoggedIn: false
  }),
  
  getters: {
    hasStore: (state) => !!state.currentStore,
    isTenantAdmin: (state) => isTenantAdminRole(state.userInfo),
    canViewAllStores: (state) => isTenantAdminRole(state.userInfo) || ['品牌经理', '超级管理员'].includes(getRoleName(state.userInfo))
  },
  
  actions: {
    async login(params: LoginParams) {
      const result = await passwordLogin(params)
      this.token = result.token
      this.userInfo = result.userInfo
      // 服务端 staff.stores 可能为空，回退调 GET /api/stores 拉全部门店
      let stores = result.stores || []
      if (stores.length === 0) {
        try { stores = await getStores() } catch { /* 静默失败 */ }
      }
      this.stores = stores
      this.currentStore = stores[0] || null
      this.isLoggedIn = true

      const { useAppStore } = await import('./app')
      const appStore = useAppStore()
      if (this.currentStore) {
        appStore.setCurrentStore(this.currentStore)
      }

      uni.setStorageSync('token', result.token)
      uni.setStorageSync('userInfo', result.userInfo)
      uni.setStorageSync('stores', stores)
      if (this.currentStore) {
        uni.setStorageSync('currentStore', this.currentStore)
      }
    },
    
    switchStore(store: Store) {
      this.currentStore = store
      uni.setStorageSync('currentStore', store)
    },
    
    async logout() {
      try {
        await logoutApi()
      } catch (e) {
        // 忽略错误
      }
      this.token = ''
      this.userInfo = null
      this.stores = []
      this.currentStore = null
      this.isLoggedIn = false
      
      uni.removeStorageSync('token')
      uni.removeStorageSync('userInfo')
      uni.removeStorageSync('stores')
      uni.removeStorageSync('currentStore')
      
      uni.reLaunch({ url: '/pages/login/index' })
    },
    
    checkAuth() {
      if (!this.token) {
        uni.reLaunch({ url: '/pages/login/index' })
        return false
      }
      return true
    },
    
    initFromStorage() {
      this.isLoggedIn = !!this.token && !!this.userInfo
    }
  }
})
