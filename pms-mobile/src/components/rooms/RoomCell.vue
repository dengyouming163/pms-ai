<script setup lang="ts">
import { computed } from 'vue'
import type { DailyRoom } from '@/types/room'
import { roomStatusConfig } from '@/constants/room'

interface Props { room: DailyRoom }
const props = defineProps<Props>()
const emit = defineEmits<{ tap: [room: DailyRoom] }>()

const config = computed(() => roomStatusConfig[props.room.status] || roomStatusConfig.available)
</script>

<template>
  <view class="room-cell" :style="{ borderLeftColor: config.color }" @click="emit('tap', room)">
    <text class="room-number">{{ room.roomNumber }}</text>
    <!-- 房型名称 -->
    <text v-if="room.roomTypeName" class="room-type-name">{{ room.roomTypeName }}</text>
    <text class="room-status" :style="{ color: config.color }">{{ config.label }}</text>
    <text v-if="room.guest" class="room-guest">{{ room.guest }}</text>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.room-cell {
  background: #fff; border-radius: 12rpx; padding: 16rpx 8rpx;
  text-align: center; border-left: 6rpx solid; box-shadow: 0 2rpx 8rpx rgba(0,0,0,0.04);
  display: flex; flex-direction: column; align-items: center; gap: 4rpx;
}
.room-number { font-size: 28rpx; font-weight: 700; color: $text-primary; }
.room-type-name { font-size: 18rpx; color: $text-tertiary; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.room-status { font-size: 20rpx; }
.room-guest { font-size: 18rpx; color: $text-tertiary; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
