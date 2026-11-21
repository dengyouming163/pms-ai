<script setup lang="ts">
import NavBar from '@/components/NavBar.vue'
import StoreSelector from '@/components/StoreSelector.vue'

interface Props {
  transparent?: boolean
  showBack?: boolean
}
withDefaults(defineProps<Props>(), { transparent: true, showBack: false })

/** 返回上一页；无上级页时回工作台 */
function goBack() {
  const pages = getCurrentPages()
  if (pages.length > 1) uni.navigateBack()
  else uni.switchTab({ url: '/pages/index/index' })
}
</script>

<template>
  <view class="page-header">
    <!-- 自定义导航栏 -->
    <NavBar :transparent="transparent">
      <template #left>
        <view v-if="showBack" class="ph-back" @click="goBack">
          <text class="ph-back-icon">←</text>
        </view>
        <StoreSelector />
      </template>
      <template #title>
        <slot name="title">
          <text class="nav-title-placeholder">&nbsp;</text>
        </slot>
      </template>
      <template #right>
        <slot name="right" />
      </template>
    </NavBar>

    <!-- 下方Tab栏插槽 -->
    <slot name="tabs" />
  </view>
</template>

<style lang="scss" scoped>
.page-header {
  flex-shrink: 0;
  background: #F5F6FA;
  z-index: 100;
}

.nav-title-placeholder {
  font-size: 32rpx;
  font-weight: 600;
  color: #191919;
}

.ph-back { width: 64rpx; height: 64rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-right: 4rpx; }
.ph-back-icon { font-size: 40rpx; color: #191919; }
</style>
