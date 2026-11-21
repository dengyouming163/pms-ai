<script setup lang="ts">
import type { Room } from '@/types/room'
import StatusBadge from '@/components/common/StatusBadge.vue'

interface Props { room: Room }
defineProps<Props>()

const emit = defineEmits<{ tap: [] }>()

const borderColors: Record<string, string> = {
  available: '#07C160', booked: '#576B95', occupied: '#FF9500',
  dirty: '#FA5151', locked: '#999999', maintenance: '#FA5151'
}
</script>

<template>
  <view class="room-card" :style="{ borderLeftColor: borderColors[room.status] }" @click="emit('tap')">
    <view class="card-header">
      <view class="room-info">
        <text class="room-number">{{ room.roomNo }}</text>
        <text class="room-type">{{ room.roomTypeName }}</text>
      </view>
      <StatusBadge :status="room.status" type="room" />
    </view>
    <view class="card-body">
      <text v-if="room.status === 'occupied'" class="status-note">🧑 已入住</text>
      <text v-else-if="room.status === 'available'" class="status-note">✨ 可售</text>
      <text v-else-if="room.status === 'booked'" class="status-note">📅 已预订</text>
      <text v-else-if="room.status === 'dirty'" class="status-note">🧹 待清洁</text>
      <text v-else-if="room.status === 'locked'" class="status-note">🔒 已锁定</text>
      <text v-else-if="room.status === 'maintenance'" class="status-note">🔧 维修中</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.room-card { background: #fff; border-radius: 24rpx; padding: 24rpx; margin-bottom: 16rpx; box-shadow: $shadow-card; border-left: 8rpx solid; }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16rpx; }
.room-info { display: flex; align-items: baseline; gap: 12rpx; }
.room-number { font-size: 32rpx; font-weight: 600; color: $text-primary; }
.room-type { font-size: 24rpx; color: $text-tertiary; }
.card-body { display: flex; align-items: center; gap: 24rpx; }
.status-note { font-size: 26rpx; color: $text-secondary; }
</style>
