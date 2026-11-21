<script setup lang="ts">
import { computed } from 'vue'

interface Props { status: string; type?: 'room' | 'order' }
const props = withDefaults(defineProps<Props>(), { type: 'room' })

const config = computed(() => {
  if (props.type === 'room') {
    const m: Record<string, any> = {
      available: { label: '可售', color: '#07C160', bg: 'rgba(7, 193, 96, 0.1)' },
      booked: { label: '预订', color: '#576B95', bg: 'rgba(87, 107, 149, 0.1)' },
      occupied: { label: '在住', color: '#FF9500', bg: 'rgba(255, 149, 0, 0.1)' },
      dirty: { label: '脏房', color: '#FA5151', bg: 'rgba(250, 81, 81, 0.1)' },
      locked: { label: '锁房', color: '#999', bg: 'rgba(153, 153, 153, 0.1)' },
      maintenance: { label: '维修', color: '#FA5151', bg: 'rgba(250, 81, 81, 0.1)' }
    }
    return m[props.status] || { label: props.status, color: '#999', bg: 'rgba(153, 153, 153, 0.1)' }
  } else {
    const m: Record<string, any> = {
      pending: { label: '待确认', color: '#FA5151', bg: 'rgba(250, 81, 81, 0.1)' },
      confirmed: { label: '已确认', color: '#576B95', bg: 'rgba(87, 107, 149, 0.1)' },
      checkin: { label: '已入住', color: '#07C160', bg: 'rgba(7, 193, 96, 0.1)' },
      checkout: { label: '已退房', color: '#999', bg: 'rgba(153, 153, 153, 0.1)' },
      cancelled: { label: '已取消', color: '#999', bg: 'rgba(153, 153, 153, 0.1)' }
    }
    return m[props.status] || { label: props.status, color: '#999', bg: 'rgba(153, 153, 153, 0.1)' }
  }
})
</script>

<template>
  <view class="status-badge" :style="{ color: config.color, background: config.bg }">
    <text class="badge-text">{{ config.label }}</text>
  </view>
</template>

<style lang="scss" scoped>
.status-badge { display: inline-flex; align-items: center; padding: 6rpx 16rpx; border-radius: 8rpx; font-size: 22rpx; font-weight: 500; }
.badge-text { font-size: 22rpx; }
</style>