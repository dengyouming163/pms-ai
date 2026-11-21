<script setup lang="ts">
import type { CapabilitySection, CapabilityCard as CardType } from '@/types/ai'
import CapabilityCard from './CapabilityCard.vue'

interface Props { section: CapabilitySection }
defineProps<Props>()

const emit = defineEmits<{ select: [card: CardType] }>()
</script>

<template>
  <view class="cap-subgroup">
    <view class="subgroup-header">
      <text class="subgroup-title">{{ section.title }}</text>
    </view>
    <view class="cap-grid">
      <CapabilityCard
        v-for="card in section.items"
        :key="card.id"
        :card="card"
        compact
        @select="emit('select', $event)"
      />
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.cap-subgroup { margin-bottom: 28rpx; }
.subgroup-header {
  margin-bottom: 20rpx;
  padding-left: 8rpx;
  position: relative;
  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 6rpx;
    height: 28rpx;
    background: $gradient-primary;
    border-radius: 3rpx;
  }
}
.subgroup-title { font-size: 28rpx; font-weight: 600; color: $text-primary; }
.cap-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}
.cap-grid > view {
  flex: none;
  min-width: 0;
}
</style>