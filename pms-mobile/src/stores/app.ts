import { defineStore } from 'pinia'
import type { Store } from '@/types/user'
import { getStores as fetchStoresApi } from '@/api/modules/user'

interface AppState {
  currentStore: Store | null
  stores: Store[]
  isLoading: boolean
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({
    currentStore: uni.getStorageSync('currentStore') || null,
    stores: uni.getStorageSync('stores') || [],
    isLoading: false
  }),
  getters: {
    storeId: (state) => state.currentStore?.id || null,
    storeName: (state) => state.currentStore?.name || ''
  },
  actions: {
    async fetchStores() {
      if (this.stores.length > 0) return this.stores
      this.isLoading = true
      try {
        const data = await fetchStoresApi()
        const list: Store[] = Array.isArray(data) ? data : (data?.list || [])
        this.stores = list
        uni.setStorageSync('stores', list)
        return list
      } finally {
        this.isLoading = false
      }
    },
    setCurrentStore(store: Store) {
      this.currentStore = store
      uni.setStorageSync('currentStore', store)
    },
    clearCurrentStore() {
      this.currentStore = null
      try { uni.removeStorageSync('currentStore') } catch {}
    },
    setLoading(loading: boolean) { this.isLoading = loading }
  }
})