<script setup lang="ts">
import { computed } from 'vue'
import type { Order } from '@/types/order'

const props = withDefaults(defineProps<{
  order: Order
  showChannel?: boolean
  showCheckbox?: boolean
  checked?: boolean
}>(), {
  showChannel: false,
  showCheckbox: false,
  checked: false,
})

const emit = defineEmits<{
  (e: 'click', order: Order): void
  (e: 'check', orderId: string): void
}>()

// 渠道图标映射（emoji回退）
const channelIcons: Record<string, string> = {
  '携程': '✈️', '美团': '🍔', '飞猪': '🐷',
  'Booking': '🌍', '爱彼迎': '🏠', '抖音': '🎵',
  '途家': '🏢', '直营': '🏨', '去哪儿': '🔍',
  '到店': '🚶', 'walk-in': '🚶', '到店散客': '🚶',
  '电话预订': '📞', '企业协议': '🏢', '小红书': '📕',
  '微信直营': '💬',
}

// 显示图标（优先用 order.icon，不存在用映射，最后用默认值）
const displayIcon = computed(() => {
  if (props.order.icon) return props.order.icon
  return channelIcons[props.order.channel] || '📋'
})

// 状态标签配置
const statusConfig = computed(() => {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    pending: { label: '待确认', color: '#FF9500', bg: 'rgba(255,149,0,0.1)' },
    pending_confirm: { label: '待确认', color: '#FF9500', bg: 'rgba(255,149,0,0.1)' },
    confirmed: { label: '已确认', color: '#576B95', bg: 'rgba(87,107,149,0.1)' },
    checked_in: { label: '已入住', color: '#07C160', bg: 'rgba(7,193,96,0.1)' },
    checked_out: { label: '已退房', color: '#888888', bg: 'rgba(136,136,136,0.1)' },
    cancelled: { label: '已取消', color: '#FA5151', bg: 'rgba(250,81,81,0.1)' },
    no_show: { label: '未到店', color: '#FF9500', bg: 'rgba(255,149,0,0.1)' },
  }
  return map[props.order.status] || { label: props.order.status, color: '#888', bg: 'rgba(136,136,136,0.1)' }
})

// 支付状态标签配置
const paymentConfig = computed(() => {
  const map: Record<string, { label: string; color: string }> = {
    paid: { label: '已支付', color: '#07C160' },
    unpaid: { label: '未支付', color: '#FF9500' },
    partial: { label: '部分支付', color: '#576B95' },
    refunded: { label: '已退款', color: '#FA5151' },
  }
  return map[props.order.paymentStatus] || { label: props.order.paymentStatus || '未支付', color: '#888' }
})

// 剩余确认时间（渠道待确认订单）
const remainingTime = computed(() => {
  if (!props.order.otaTimeout) return ''
  const timeout = new Date(props.order.otaTimeout).getTime()
  const now = Date.now()
  const diff = timeout - now
  if (diff <= 0) return '已超时'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `剩${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  return `剩${hours}小时`
})

// 是否紧急（小于1小时）
const isUrgent = computed(() => {
  if (!props.order.otaTimeout) return false
  const timeout = new Date(props.order.otaTimeout).getTime()
  return timeout - Date.now() < 3600000 && timeout > Date.now()
})

/** 格式化日期显示 */
function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  // 如果已经是 YYYY-MM-DD 格式，截取 MM-DD
  const parts = dateStr.split('-')
  if (parts.length === 3) return `${parts[1]}/${parts[2]}`
  return dateStr
}
</script>

<template>
  <view
    :class="['order-card', { 'order-card--urgent': isUrgent }]"
    @click="emit('click', order)"
  >
    <!-- 渠道待确认的紧急边框 -->
    <view v-if="isUrgent" class="urgent-border" />

    <view class="card-left">
      <!-- 复选框（渠道待确认模式） -->
      <view v-if="showCheckbox" class="checkbox-area" @click.stop="emit('check', order.id)">
        <view :class="['checkbox', { 'checkbox--checked': checked }]">
          <text v-if="checked" class="checkbox-icon">✓</text>
        </view>
      </view>

      <!-- 渠道图标 -->
      <view class="channel-icon" :style="{ background: order.channelColor ? order.channelColor.replace('bg-', '#') : '#E8F8EF' }">
        <text class="channel-emoji">{{ displayIcon }}</text>
      </view>
    </view>

    <view class="card-body">
      <!-- 头部：订单号 + 状态标签 -->
      <view class="card-header">
        <view class="header-left">
          <text class="order-no">{{ order.orderNo }}</text>
          <text v-if="showChannel" class="channel-name">{{ order.channel }}</text>
        </view>
        <view
          class="status-tag"
          :style="{ color: statusConfig.color, background: statusConfig.bg }"
        >
          {{ statusConfig.label }}
        </view>
      </view>

      <!-- 客人信息 -->
      <view class="guest-row">
        <text class="guest-name">{{ order.guestName }}</text>
        <text v-if="order.guestPhone" class="guest-phone">{{ order.guestPhone }}</text>
      </view>

      <!-- 房间信息 -->
      <view class="room-row">
        <text class="room-type">{{ order.roomType }}</text>
        <text v-if="order.roomNumber" class="room-number">{{ order.roomNumber }}</text>
      </view>

      <!-- 日期 + 天数 -->
      <view class="date-row">
        <text class="date-text">{{ formatDate(order.checkIn) }} → {{ formatDate(order.checkOut) }}</text>
        <text class="nights-text">{{ order.nights }}晚</text>
      </view>

      <!-- 底部：金额 + 支付状态 + 剩余时间 -->
      <view class="card-footer">
        <view class="amount-area">
          <text class="amount-symbol">￥</text>
          <text class="amount-value">{{ order.amount }}</text>
          <text
            class="payment-tag"
            :style="{ color: paymentConfig.color }"
          >
            {{ paymentConfig.label }}
          </text>
        </view>
        <view v-if="remainingTime" class="timeout-area">
          <text :class="['timeout-text', { 'timeout-text--urgent': isUrgent }]">
            {{ remainingTime }}
          </text>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.order-card {
  position: relative;
  display: flex;
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
  overflow: hidden;

  &--urgent {
    box-shadow: 0 2rpx 16rpx rgba(250, 81, 81, 0.15);
  }
}

.urgent-border {
  position: absolute;
  top: 0;
  left: 0;
  width: 6rpx;
  height: 100%;
  background: #FA5151;
  border-radius: 24rpx 0 0 24rpx;
}

.card-left {
  display: flex;
  align-items: flex-start;
  margin-right: 16rpx;
  flex-shrink: 0;
}

.checkbox-area {
  margin-right: 12rpx;
  display: flex;
  align-items: center;
  padding-top: 8rpx;
}

.checkbox {
  width: 40rpx;
  height: 40rpx;
  border-radius: 50%;
  border: 2rpx solid #D0D0D0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;

  &--checked {
    background: #07C160;
    border-color: #07C160;
  }
}

.checkbox-icon {
  color: #fff;
  font-size: 24rpx;
  font-weight: 700;
}

.channel-icon {
  width: 80rpx;
  height: 80rpx;
  border-radius: 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.channel-emoji {
  font-size: 36rpx;
  line-height: 1;
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12rpx;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}

.order-no {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

.channel-name {
  font-size: 20rpx;
  color: #888888;
}

.status-tag {
  display: inline-flex;
  align-items: center;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
  font-size: 20rpx;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.guest-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 6rpx;
}

.guest-name {
  font-size: 28rpx;
  color: #191919;
  font-weight: 500;
}

.guest-phone {
  font-size: 24rpx;
  color: #888888;
}

.room-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 6rpx;
}

.room-type {
  font-size: 24rpx;
  color: #888888;
}

.room-number {
  font-size: 24rpx;
  color: #576B95;
  background: rgba(87, 107, 149, 0.08);
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

.date-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 12rpx;
}

.date-text {
  font-size: 24rpx;
  color: #888888;
}

.nights-text {
  font-size: 22rpx;
  color: #888888;
  background: #F5F6FA;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 12rpx;
  border-top: 1rpx solid #EDEDED;
}

.amount-area {
  display: flex;
  align-items: baseline;
  gap: 2rpx;
}

.amount-symbol {
  font-size: 24rpx;
  font-weight: 600;
  color: #191919;
}

.amount-value {
  font-size: 32rpx;
  font-weight: 700;
  color: #191919;
}

.payment-tag {
  font-size: 20rpx;
  margin-left: 8rpx;
}

.timeout-area {
  display: flex;
  align-items: center;
}

.timeout-text {
  font-size: 22rpx;
  color: #FF9500;
  background: rgba(255, 149, 0, 0.1);
  padding: 4rpx 12rpx;
  border-radius: 8rpx;

  &--urgent {
    color: #FA5151;
    background: rgba(250, 81, 81, 0.1);
    font-weight: 500;
  }
}

// 点击态
.order-card:active {
  opacity: 0.85;
  transform: scale(0.98);
}
</style>
