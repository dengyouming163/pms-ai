<script setup lang="ts">
import { computed } from 'vue'
import type { Room } from '@/types/room'

interface Props {
  room: Room
  showGuest?: boolean
  actionable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showGuest: true,
  actionable: true
})

const emit = defineEmits<{
  click: [room: Room]
}>()

const statusConfig = computed(() => {
  const map: Record<string, { label: string; bg: string; color: string; icon: string }> = {
    available: { label: '空闲', bg: 'rgba(107,155,122,.08)', color: '#6B9B7A', icon: 'circle' },
    booked: { label: '预订', bg: 'rgba(91,127,165,.08)', color: '#5B7FA5', icon: 'circle' },
    occupied: { label: '在住', bg: 'rgba(196,149,90,.08)', color: '#C4955A', icon: 'circle' },
    dirty: { label: '脏房', bg: 'rgba(211,90,90,.08)', color: '#D35A5A', icon: 'circle' },
    maintenance: { label: '维修', bg: 'rgba(139,123,155,.08)', color: '#8B7B9B', icon: 'circle' },
    locked: { label: '锁房', bg: 'rgba(155,168,181,.08)', color: '#9BA8B5', icon: 'circle' }
  }
  return map[props.room.status] || map.available
})

function handleClick() {
  emit('click', props.room)
}
</script>

<template>
  <view class="room-card" @click="handleClick">
    <!-- 房间号 + 状态标签 -->
    <view class="room-header">
      <text class="room-no">{{ room.roomNo }}</text>
      <view class="room-status" :style="{ background: statusConfig.bg, color: statusConfig.color }">
        <text class="status-dot" :style="{ background: statusConfig.color }"></text>
        <text>{{ statusConfig.label }}</text>
      </view>
    </view>

    <!-- AI 建议徽标 -->
    <view v-if="room.aiSuggestion" class="ai-badge">
      <image class="ai-badge-icon" src="/static/icon/room-check.png" mode="aspectFit" />
      <text class="ai-badge-text">{{ room.aiSuggestion }}</text>
    </view>

    <!-- 客人名 -->
    <text v-if="showGuest" class="guest-name">
      {{ room.guestName || '—' }}
    </text>

    <!-- 房型标签 -->
    <text class="room-type-tag">{{ room.roomTypeName }}</text>

    <!-- 操作入口 -->
    <view v-if="actionable && room.status === 'dirty'" class="room-action clean-action">
      <text>标记清洁</text>
    </view>
    <view v-else-if="actionable && room.status === 'occupied'" class="room-action checkout-action">
      <text>办理退房</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.room-card {
  background: #FFFFFF;
  border-radius: 20rpx;
  padding: 24rpx 20rpx;
  border: 1rpx solid #F0F1F4;
  box-shadow: 0 1rpx 4rpx rgba(29, 42, 58, 0.03);
  display: flex;
  flex-direction: column;
  gap: 10rpx;
  transition: box-shadow 0.15s, transform 0.15s;
  position: relative;

  &:active {
    transform: translateY(-1rpx);
    box-shadow: 0 4rpx 16rpx rgba(29, 42, 58, 0.06);
  }
}

.room-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.room-no {
  font-size: 30rpx;
  font-weight: 600;
  color: #1D2A3A;
}

.room-status {
  display: flex;
  align-items: center;
  gap: 6rpx;
  padding: 4rpx 12rpx;
  border-radius: 20rpx;
  font-size: 20rpx;
  font-weight: 500;
}

.status-dot {
  width: 8rpx;
  height: 8rpx;
  border-radius: 50%;
  flex-shrink: 0;
}

.ai-badge {
  display: flex;
  align-items: center;
  gap: 4rpx;
  padding: 4rpx 10rpx;
  background: rgba(200, 169, 110, 0.1);
  border-radius: 10rpx;
  color: #C8A96E;
}

.ai-badge-icon {
  width: 24rpx;
  height: 24rpx;
}

.ai-badge-text {
  font-size: 20rpx;
  color: #B8956A;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guest-name {
  font-size: 26rpx;
  color: #1D2A3A;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.room-type-tag {
  font-size: 22rpx;
  color: #9BA8B5;
}

.room-action {
  margin-top: 4rpx;
  padding: 10rpx 0;
  border-radius: 14rpx;
  text-align: center;
  font-size: 22rpx;
  font-weight: 500;

  &.clean-action {
    background: rgba(107, 155, 122, 0.08);
    color: #6B9B7A;
  }

  &.checkout-action {
    background: rgba(184, 149, 106, 0.08);
    color: #B8956A;
  }
}
</style>
