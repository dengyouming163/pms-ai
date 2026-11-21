<script setup lang="ts">
// 日期导航栏 — 左右箭头 + 今天按钮 + 日期标签 + 今天指示器
interface Props {
  label: string
  showToday?: boolean
  /** 当前显示的是否为今天（日期视图）/ 包含今天（周视图） */
  isToday?: boolean
}
withDefaults(defineProps<Props>(), { showToday: true, isToday: false })
const emit = defineEmits<{ prev: []; next: []; today: [] }>()
</script>

<template>
  <view class="date-nav">
    <view class="nav-btn" @click="emit('prev')"><text class="arrow">&#8249;</text></view>
    <view v-if="showToday" class="today-btn" @click="emit('today')"><text>今天</text></view>
    <view class="date-label">
      <text>{{ label }}</text>
      <!-- 今天指示器徽章 -->
      <text v-if="isToday" class="today-badge">今天</text>
    </view>
    <view class="nav-btn" @click="emit('next')"><text class="arrow">&#8250;</text></view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.date-nav {
  display: flex; align-items: center; justify-content: center; gap: 20rpx;
  padding: 16rpx 24rpx; background: #fff; border-radius: 24rpx;
  margin: 0 24rpx 16rpx; box-shadow: $shadow-card;
}
.nav-btn {
  width: 56rpx; height: 56rpx;
  display: flex; align-items: center; justify-content: center;
}
.arrow { font-size: 36rpx; color: $primary-green; }
.today-btn {
  padding: 6rpx 20rpx; background: rgba(7, 193, 96, 0.1);
  border-radius: 20rpx;
}
.today-btn text { font-size: 22rpx; color: $primary-green; }
.date-label {
  min-width: 280rpx; text-align: center;
  display: flex; align-items: center; justify-content: center; gap: 10rpx;
}
.date-label text { font-size: 28rpx; font-weight: 600; color: $text-primary; }
.today-badge {
  display: inline-block;
  padding: 2rpx 12rpx;
  background: $primary-green;
  color: #fff !important;
  font-size: 18rpx !important;
  font-weight: 500 !important;
  border-radius: 12rpx;
  line-height: 1.6;
}
</style>
