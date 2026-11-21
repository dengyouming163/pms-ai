<script setup lang="ts">
// 统计卡片 — 4卡2x2网格，匹配 pms-web 风格
interface Props {
  occupancyRate: string  // 出租率（含%号），如 "75%"
  occupied: number       // 已入住
  booked: number         // 已预订
  available: number      // 可售房
}
defineProps<Props>()
</script>

<template>
  <view class="stat-bar">
    <view class="stat-card stat-green">
      <text class="stat-icon">📈</text>
      <text class="stat-value">{{ occupancyRate }}</text>
      <text class="stat-label">出租率</text>
    </view>
    <view class="stat-card stat-orange">
      <text class="stat-icon">👥</text>
      <text class="stat-value">{{ occupied }}</text>
      <text class="stat-label">已入住</text>
    </view>
    <view class="stat-card stat-blue">
      <text class="stat-icon">📅</text>
      <text class="stat-value">{{ booked }}</text>
      <text class="stat-label">已预订</text>
    </view>
    <view class="stat-card stat-green">
      <text class="stat-icon">🏨</text>
      <text class="stat-value">{{ available }}</text>
      <text class="stat-label">可售房</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.stat-bar {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16rpx;
  padding: 20rpx 24rpx;
  margin: 24rpx;
  background: #F5F6FA;
}

.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24rpx 16rpx;
  border-radius: 24rpx;
  background: #fff;
  box-shadow: $shadow-card;
}

.stat-icon { font-size: 40rpx; margin-bottom: 8rpx; }

.stat-value {
  font-size: 40rpx;
  font-weight: 700;
  color: $text-primary;
  margin-bottom: 4rpx;
}

.stat-label {
  font-size: 22rpx;
  color: $text-tertiary;
}

// 左侧色条装饰（通过伪元素不好做，用左边缘代替）
.stat-green  { border-left: 6rpx solid $primary-green; }
.stat-orange { border-left: 6rpx solid $warning-orange; }
.stat-blue   { border-left: 6rpx solid $info-blue; }
</style>
