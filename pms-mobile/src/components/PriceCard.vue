<script setup lang="ts">
import { computed } from 'vue'
import type { PriceSuggestion } from '@/api/modules/ai'

interface Props {
  suggestion: PriceSuggestion
}

const props = defineProps<Props>()

const emit = defineEmits<{
  adopt: [suggestion: PriceSuggestion]
  ignore: [suggestion: PriceSuggestion]
}>()

const priceDiff = computed(() => props.suggestion.suggestedPrice - props.suggestion.currentPrice)
const pricePercent = computed(() => (priceDiff.value / props.suggestion.currentPrice * 100).toFixed(1))
const priceTag = computed(() => priceDiff.value >= 0 ? `+${pricePercent.value}%` : `${pricePercent.value}%`)
const isUp = computed(() => priceDiff.value >= 0)

function handleAdopt() {
  emit('adopt', props.suggestion)
}

function handleIgnore() {
  emit('ignore', props.suggestion)
}
</script>

<template>
  <view class="price-card">
    <!-- 头部：房型 + 置信度 -->
    <view class="card-header">
      <text class="room-type">{{ suggestion.roomType }}</text>
      <view class="confidence-badge" :class="{ high: suggestion.confidence >= 80 }">
        <text class="confidence-value">AI {{ suggestion.confidence }}%</text>
      </view>
    </view>

    <!-- 价格对比 -->
    <view class="price-comparison">
      <view class="price-block current">
        <text class="price-label">当前价格</text>
        <text class="price-number">¥{{ suggestion.currentPrice }}</text>
      </view>

      <view class="price-arrow">
        <image class="price-arrow-icon" src="/static/icon/price-arrow.png" mode="aspectFit" />
      </view>

      <view class="price-block suggested">
        <text class="price-label">建议价格</text>
        <view class="price-number-row">
          <text class="price-number" :class="{ up: isUp, down: !isUp }">¥{{ suggestion.suggestedPrice }}</text>
          <text class="price-change" :class="{ up: isUp, down: !isUp }">{{ priceTag }}</text>
        </view>
      </view>
    </view>

    <!-- 理由 -->
    <view class="reason-section">
      <view class="reason-header">
        <image class="reason-info-icon" src="/static/icon/price-info.png" mode="aspectFit" />
        <text class="reason-label">建议理由</text>
      </view>
      <text class="reason-text">{{ suggestion.reason }}</text>
    </view>

    <!-- 竞品参考 -->
    <view v-if="suggestion.competitorAvg" class="competitor-ref">
      <text>竞品均价 ¥{{ suggestion.competitorAvg }}</text>
    </view>

    <!-- 操作 -->
    <view class="card-actions">
      <view class="action-btn primary" @click="handleAdopt">
        <text>采纳建议</text>
      </view>
      <view class="action-btn secondary" @click="handleIgnore">
        <text>忽略</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.price-card {
  background: #FFFFFF;
  border-radius: 28rpx;
  padding: 28rpx 24rpx;
  margin-bottom: 20rpx;
  border: 1rpx solid #F0F1F4;
  box-shadow: 0 1rpx 4rpx rgba(29, 42, 58, 0.03);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24rpx;
}

.room-type {
  font-size: 30rpx;
  font-weight: 600;
  color: #1D2A3A;
}

.confidence-badge {
  padding: 4rpx 14rpx;
  border-radius: 20rpx;
  background: rgba(155, 168, 181, 0.1);
  font-size: 20rpx;
  color: #6B7C8E;

  &.high {
    background: rgba(200, 169, 110, 0.1);
    color: #C8A96E;
  }
}

.confidence-value {
  font-weight: 500;
}

.price-comparison {
  display: flex;
  align-items: center;
  padding: 24rpx 20rpx;
  background: #F8F9FB;
  border-radius: 20rpx;
  margin-bottom: 20rpx;
}

.price-block {
  flex: 1;
  text-align: center;

  &.current {
    .price-number {
      color: #6B7C8E;
    }
  }
}

.price-label {
  font-size: 22rpx;
  color: #9BA8B5;
  margin-bottom: 8rpx;
  display: block;
}

.price-number {
  font-size: 36rpx;
  font-weight: 600;
  color: #1D2A3A;

  &.up { color: #D35A5A; }
  &.down { color: #6B9B7A; }
}

.price-number-row {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6rpx;
}

.price-change {
  font-size: 22rpx;
  font-weight: 500;

  &.up { color: #D35A5A; }
  &.down { color: #6B9B7A; }
}

.price-arrow {
  padding: 0 16rpx;
  color: #C8A96E;
}

.price-arrow-icon {
  width: 40rpx;
  height: 40rpx;
}

.reason-section {
  margin-bottom: 16rpx;
}

.reason-header {
  display: flex;
  align-items: center;
  gap: 6rpx;
  margin-bottom: 8rpx;
}

.reason-label {
  font-size: 24rpx;
  color: #6B7C8E;
  font-weight: 500;
}

.reason-info-icon {
  width: 32rpx;
  height: 32rpx;
}

.reason-text {
  font-size: 26rpx;
  color: #1D2A3A;
  line-height: 1.5;
}

.competitor-ref {
  display: flex;
  align-items: center;
  gap: 8rpx;
  padding: 12rpx 16rpx;
  background: rgba(91, 127, 165, 0.04);
  border-radius: 12rpx;
  margin-bottom: 20rpx;

  text {
    font-size: 24rpx;
    color: #5B7FA5;
  }
}

.card-actions {
  display: flex;
  gap: 16rpx;
}

.action-btn {
  flex: 1;
  padding: 20rpx 0;
  border-radius: 20rpx;
  text-align: center;
  font-size: 28rpx;
  font-weight: 500;
  transition: opacity 0.15s;

  &:active {
    opacity: 0.85;
  }

  &.primary {
    background: #3C5068;
    color: #FFFFFF;
  }

  &.secondary {
    background: #F6F7F9;
    color: #6B7C8E;
  }
}
</style>
