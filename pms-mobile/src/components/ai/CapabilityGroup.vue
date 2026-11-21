<script setup lang="ts">
import type { CapabilityGroup, CapabilityCard as CardType } from '@/types/ai'
import CapabilityCard from './CapabilityCard.vue'
import CapabilitySubGroup from './CapabilitySubGroup.vue'

interface Props { group: CapabilityGroup }
defineProps<Props>()

const emit = defineEmits<{ select: [card: CardType] }>()
function handleCardSelect(card: CardType) { emit('select', card) }
</script>

<template>
  <view class="cap-group">
    <view class="group-header">
      <text class="group-title">{{ group.title }}</text>
      <text class="group-desc">{{ group.description }}</text>
    </view>
    <view class="group-body">
      <template v-if="group.sections.length > 1">
        <CapabilitySubGroup
          v-for="section in group.sections"
          :key="section.title"
          :section="section"
          @select="handleCardSelect"
        />
      </template>
      <template v-else>
        <view class="cap-grid">
          <CapabilityCard
            v-for="card in group.sections[0].items"
            :key="card.id"
            :card="card"
            compact
            @select="handleCardSelect"
          />
        </view>
      </template>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.cap-group {
  background: $bg-card;
  border-radius: $radius-xl;
  padding: 24rpx 20rpx;
  margin-bottom: 20rpx;
}
.group-header {
  display: flex;
  flex-direction: column;
  margin-bottom: 20rpx;
  padding-bottom: 16rpx;
  border-bottom: 1rpx solid rgba(0,0,0,0.04);
}
.group-title { font-size: 32rpx; font-weight: 700; color: $text-primary; display: block; margin-bottom: 4rpx; }
.group-desc { font-size: 26rpx; color: $text-tertiary; display: block; }
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