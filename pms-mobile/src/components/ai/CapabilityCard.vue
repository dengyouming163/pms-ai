<script setup lang="ts">
import type { CapabilityCard } from '@/types/ai'

interface Props { card: CapabilityCard; compact?: boolean }
const props = withDefaults(defineProps<Props>(), { compact: false })
const emit = defineEmits<{ select: [card: CapabilityCard] }>()
function handleClick() { emit('select', props.card) }
</script>

<template>
  <view :class="['cap-card', { compact }]" @click="handleClick">
    <view v-if="!compact" class="cc-icon-wrap">
      <text class="cc-icon">{{ card.icon }}</text>
    </view>
    <text v-if="compact" class="cc-dot">•</text>
    <text class="cc-label">{{ card.label }}</text>
    <text v-if="!compact" class="cc-desc">{{ card.description }}</text>
  </view>
</template>

<style lang="scss" scoped>
.cap-card {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 20rpx 10rpx; background: #fff; border-radius: 24rpx;
  box-shadow: 0 2rpx 16rpx rgba(0,0,0,0.04);
  aspect-ratio: 1; box-sizing: border-box;
  &:active { transform: scale(0.96); background: #F0FAF4; }
  /* compact 问题标签：横向小标签 pill，大幅省空间 */
  &.compact {
    display: inline-flex; flex-direction: row; align-items: center;
    justify-content: flex-start; gap: 8rpx;
    padding: 12rpx 24rpx;
    background: #F4F7F6; border-radius: 999rpx;
    aspect-ratio: auto; box-shadow: none;
    &:active { transform: scale(0.97); background: #E8F5EE; }
  }
}
.cc-icon-wrap {
  width: 72rpx; height: 72rpx; border-radius: 20rpx;
  background: linear-gradient(135deg, rgba(7,193,96,0.12) 0%, rgba(7,193,96,0.06) 100%);
  display: flex; align-items: center; justify-content: center; margin-bottom: 12rpx;
}
.cc-icon { font-size: 36rpx; line-height: 1; }
.cc-dot { font-size: 20rpx; color: #07C160; line-height: 1; flex-shrink: 0; }
.cc-label {
  font-size: 24rpx; font-weight: 600; color: #191919; text-align: center;
  line-height: 1.3; margin-bottom: 4rpx;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.cap-card.compact .cc-label {
  -webkit-line-clamp: 1; white-space: nowrap; margin-bottom: 0; color: #374151; font-weight: 500;
}
.cc-desc {
  font-size: 20rpx; color: #999; text-align: center; line-height: 1.3;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  padding: 0 4rpx;
}
</style>
