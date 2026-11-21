<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'

import { getStores } from '@/api/modules/user'
import type { Store } from '@/types/user'

const authStore = useAuthStore()
const appStore = useAppStore()

const loading = ref(true)
const stores = ref<Store[]>([])

/** 判断是否为当前门店 */
function isCurrentStore(store: Store): boolean {
  return store.id === authStore.currentStore?.id
}

/** 切换门店 */
function handleSwitchStore(store: Store) {
  if (isCurrentStore(store)) return
  uni.showModal({
    title: '切换门店',
    content: `确定切换到「${store.name}」吗？`,
    success: (res) => {
      if (res.confirm) {
        authStore.switchStore(store)
        appStore.setCurrentStore(store)
        uni.showToast({ title: '已切换门店', icon: 'success' })
      }
    },
  })
}

onMounted(async () => {
  loading.value = true
  try {
    const data = await getStores()
    stores.value = Array.isArray(data) ? data : []
  } catch {
    uni.showToast({ title: '加载失败', icon: 'none' })
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <view class="stores-page">
    <scroll-view class="page-scroll" scroll-y :show-scrollbar="false">
      <!-- 加载状态 -->
      <view v-if="loading" class="empty-state">
        <text class="empty-text">加载中...</text>
      </view>

      <!-- 空状态 -->
      <view v-else-if="stores.length === 0" class="empty-state">
        <text class="empty-icon">🏨</text>
        <text class="empty-text">暂无门店数据</text>
      </view>

      <!-- 门店卡片列表 -->
      <view v-else class="store-list">
        <view
          v-for="store in stores"
          :key="store.id"
          :class="['store-card', { 'current-store': isCurrentStore(store) }]"
          @click="handleSwitchStore(store)"
        >
          <view class="store-card-header">
            <text class="store-card-name">{{ store.name }}</text>
            <view v-if="isCurrentStore(store)" class="current-badge">
              <text class="current-badge-text">当前</text>
            </view>
          </view>
          <view class="store-card-info">
            <view v-if="store.address" class="store-info-item">
              <text class="store-info-icon">📍</text>
              <text class="store-info-text">{{ store.address }}</text>
            </view>
            <view v-if="store.phone" class="store-info-item">
              <text class="store-info-icon">📞</text>
              <text class="store-info-text">{{ store.phone }}</text>
            </view>
            <view class="store-info-item">
              <text class="store-info-icon">🛏️</text>
              <text class="store-info-text">{{ store.roomCount || 0 }} 间客房</text>
            </view>
          </view>
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<style lang="scss" scoped>
.stores-page {
  min-height: 100vh;
  background: #F5F6FA;
}

.page-scroll {
  padding: 24rpx;
  box-sizing: border-box;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 120rpx 0;
  gap: 16rpx;
}

.empty-icon {
  font-size: 72rpx;
}

.empty-text {
  font-size: 28rpx;
  color: #888888;
}

/* 门店列表 */
.store-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.store-card {
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
  border: 2rpx solid transparent;

  &.current-store {
    border-color: #07C160;
  }

  &:active {
    background: rgba(0, 0, 0, 0.02);
  }
}

.store-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16rpx;
}

.store-card-name {
  font-size: 32rpx;
  font-weight: 600;
  color: #191919;
}

.current-badge {
  padding: 6rpx 16rpx;
  background: rgba(7, 193, 96, 0.1);
  border-radius: 8rpx;
}

.current-badge-text {
  font-size: 22rpx;
  color: #07C160;
  font-weight: 500;
}

.store-card-info {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.store-info-item {
  display: flex;
  align-items: center;
  gap: 8rpx;
}

.store-info-icon {
  font-size: 24rpx;
  flex-shrink: 0;
}

.store-info-text {
  font-size: 24rpx;
  color: #888888;
}
</style>
