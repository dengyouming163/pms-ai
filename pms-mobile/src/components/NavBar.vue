<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface Props { title?: string; showBack?: boolean; transparent?: boolean }
const props = withDefaults(defineProps<Props>(), { title: '', showBack: false, transparent: false })
const statusBarHeight = ref(20)

onMounted(() => {
  try { statusBarHeight.value = uni.getSystemInfoSync().statusBarHeight || 20 } catch {}
})

function goBack() {
  const pages = getCurrentPages()
  if (pages.length > 1) uni.navigateBack()
  else uni.switchTab({ url: '/pages/profile/index' })
}
</script>

<template>
  <view :class="['nav-bar', { transparent }]"
        :style="{ paddingTop: statusBarHeight + 'px' }">
    <view class="nav-content">
      <view class="nav-left">
        <slot name="left">
          <view v-if="showBack" class="nav-back" @click="goBack">
            <text class="back-icon">←</text>
          </view>
          <view v-else class="nav-placeholder" />
        </slot>
      </view>
      <view class="nav-title">
        <slot name="title">
          <text>{{ title }}</text>
        </slot>
      </view>
      <view class="nav-right"><slot name="right" /></view>
    </view>
  </view>
  <view :style="{ height: (statusBarHeight + 44) + 'px' }" />
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.nav-bar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 999;
  background: #fff; transition: all 0.3s ease;
  &.transparent {
    background: rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(20rpx); -webkit-backdrop-filter: blur(20rpx);
  }
  padding-bottom: 10rpx;
}
.nav-content { display: flex; align-items: center; justify-content: space-between; height: 88rpx; padding: 12rpx 28rpx 10rpx; }
.nav-left { flex: 1; min-width: 0; display: flex; align-items: center; }
.nav-back { width: 64rpx; height: 64rpx; display: flex; align-items: center; justify-content: center; }
.back-icon { font-size: 40rpx; color: $text-primary; }
.nav-title { flex: none; text-align: center; font-size: 32rpx; font-weight: 600; color: $text-primary; padding: 0 16rpx; white-space: nowrap; }
.nav-right { display: flex; align-items: center; justify-content: flex-end; gap: 16rpx; }
.nav-placeholder { width: 64rpx; }
</style>