<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { getStores } from '@/api/modules/user'
import type { Store } from '@/types/user'

const appStore = useAppStore()
const showDropdown = ref(false)
const searchKeyword = ref('')
const loading = ref(false)

const currentStore = computed(() => appStore.currentStore)
const stores = computed(() => appStore.stores)

const filteredStores = computed(() => {
  if (!searchKeyword.value) return stores.value
  const kw = searchKeyword.value.toLowerCase()
  return stores.value.filter(s =>
    s.name.toLowerCase().includes(kw) ||
    (s.brandName && s.brandName.toLowerCase().includes(kw))
  )
})

async function fetchStores() {
  if (stores.value.length > 0) return
  loading.value = true
  try {
    await appStore.fetchStores()
  } catch (e) {
    console.error('Failed to fetch stores:', e)
  } finally {
    loading.value = false
  }
}

function toggleDropdown() {
  showDropdown.value = !showDropdown.value
  if (showDropdown.value) {
    fetchStores()
  }
}

function selectStore(store: Store) {
  appStore.setCurrentStore(store)
  showDropdown.value = false
  searchKeyword.value = ''
}

function closeDropdown() {
  showDropdown.value = false
}

// #ifdef H5
function onDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest('.store-selector')) {
    closeDropdown()
  }
}
// #endif

onMounted(() => {
  // #ifdef H5
  document.addEventListener('click', onDocumentClick)
  // #endif
})

onUnmounted(() => {
  // #ifdef H5
  document.removeEventListener('click', onDocumentClick)
  // #endif
})

function stopPropagation(e: Event) {
  e.stopPropagation()
}
</script>

<template>
  <view class="store-selector" @click.stop="stopPropagation">
    <!-- 触发按钮 -->
    <view
      :class="['store-trigger', { active: showDropdown }]"
      @click="toggleDropdown"
    >
      <text class="trigger-icon">🏨</text>
      <text class="trigger-name">{{ currentStore?.name || '请选择门店' }}</text>
      <text :class="['trigger-arrow', { up: showDropdown }]">▾</text>
    </view>

    <!-- 下拉菜单 -->
    <view v-if="showDropdown" class="store-dropdown" @click.stop>
      <!-- 搜索框 -->
      <view class="dropdown-search">
        <text class="search-icon">🔍</text>
        <input
          v-model="searchKeyword"
          class="search-input"
          placeholder="搜索门店"
          placeholder-class="search-placeholder"
        />
      </view>

      <!-- 加载中 -->
      <view v-if="loading" class="dropdown-loading">
        <text class="loading-text">加载门店列表中...</text>
      </view>

      <!-- 空状态 -->
      <view v-else-if="filteredStores.length === 0" class="dropdown-empty">
        <text class="empty-text">暂无门店</text>
      </view>

      <!-- 门店列表 -->
      <scroll-view v-else class="dropdown-list" scroll-y>
        <view
          v-for="store in filteredStores"
          :key="store.id"
          :class="['dropdown-item', { selected: store.id === currentStore?.id }]"
          @click="selectStore(store)"
        >
          <view class="item-info">
            <text class="item-name">{{ store.name }}</text>
            <text v-if="store.brandName" class="item-brand">{{ store.brandName }}</text>
          </view>
          <text v-if="store.id === currentStore?.id" class="item-check">✓</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.store-selector {
  position: relative;
  display: inline-flex;
}

.store-trigger {
  display: flex;
  align-items: center;
  gap: 10rpx;
  padding: 16rpx 28rpx;
  background: $bg-main;
  border-radius: 40rpx;
  transition: all 0.2s ease;
  cursor: pointer;
  max-width: 360rpx;
  &.active {
    background: rgba(7,193,96,0.08);
    border: 2rpx solid rgba(7,193,96,0.2);
  }
}

.trigger-icon { font-size: 32rpx; }
.trigger-name {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240rpx;
}
.trigger-arrow {
  font-size: 40rpx;
  color: $text-tertiary;
  transition: transform 0.2s ease;
  &.up { transform: rotate(180deg); }
}

.store-dropdown {
  position: absolute;
  top: calc(100% + 12rpx);
  left: 0;
  min-width: 400rpx;
  background: #fff;
  border-radius: $radius-lg;
  box-shadow: $shadow-modal;
  z-index: 1000;
  overflow: hidden;
  animation: dropdownFadeIn 0.2s ease;
}

@keyframes dropdownFadeIn {
  from { opacity: 0; transform: translateY(-8rpx); }
  to { opacity: 1; transform: translateY(0); }
}

.dropdown-search {
  display: flex;
  align-items: center;
  gap: 10rpx;
  padding: 20rpx 24rpx;
  border-bottom: 1rpx solid rgba(0,0,0,0.06);
}
.search-icon { font-size: 24rpx; }
.search-input {
  flex: 1;
  font-size: 26rpx;
  color: $text-primary;
  background: transparent;
  border: none;
  outline: none;
}
.search-placeholder { color: $text-tertiary; }

.dropdown-loading, .dropdown-empty {
  padding: 40rpx 24rpx;
  text-align: center;
}
.loading-text, .empty-text { font-size: 26rpx; color: $text-tertiary; }

.dropdown-list {
  max-height: 600rpx;
}

.dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24rpx 32rpx;
  border-bottom: 1rpx solid rgba(0,0,0,0.04);
  transition: background 0.15s ease;
  &:last-child { border-bottom: none; }
  &.selected {
    background: rgba(7,193,96,0.08);
    border-left: 3rpx solid $primary-green;
  }
  &:active { background: $bg-main; }
}

.item-info {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
  flex: 1;
  min-width: 0;
}
.item-name {
  font-size: 28rpx;
  font-weight: 500;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-brand { font-size: 22rpx; color: $text-tertiary; }
.item-check { color: $primary-green; font-size: 28rpx; font-weight: 600; }
</style>
