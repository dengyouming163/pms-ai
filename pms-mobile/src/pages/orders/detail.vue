<script setup lang="ts">
import { computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useOrdersStore } from '@/stores/orders'

import type { Order } from '@/types/order'

const store = useOrdersStore()

onLoad((options: { id?: string }) => {
  const id = options?.id || ''
  if (id) {
    store.fetchOrderDetail(id)
  }
})

// 当前订单
const order = computed(() => store.currentOrder)

// 状态横幅配置
const bannerConfig = computed(() => {
  const map: Record<string, { bg: string; label: string; icon: string }> = {
    pending: { bg: 'linear-gradient(135deg, #FF9500, #FF6B00)', label: '待确认', icon: '⏳' },
    pending_confirm: { bg: 'linear-gradient(135deg, #FF9500, #FF6B00)', label: '渠道待确认', icon: '⏳' },
    confirmed: { bg: 'linear-gradient(135deg, #576B95, #4A5D82)', label: '已确认', icon: '✅' },
    checked_in: { bg: 'linear-gradient(135deg, #07C160, #06AD56)', label: '已入住', icon: '🏨' },
    checked_out: { bg: 'linear-gradient(135deg, #888888, #666666)', label: '已退房', icon: '👋' },
    cancelled: { bg: 'linear-gradient(135deg, #FA5151, #D94545)', label: '已取消', icon: '❌' },
    no_show: { bg: 'linear-gradient(135deg, #FF9500, #E68600)', label: '未到店', icon: '🚫' },
  }
  return map[order.value?.status || ''] || { bg: 'linear-gradient(135deg, #888, #666)', label: '未知', icon: '📋' }
})

// 动作按钮配置
const actions = computed(() => {
  if (!order.value) return []
  const s = order.value.status
  if (s === 'pending' || s === 'pending_confirm') {
    return [
      { label: '取消订单', type: 'cancel', style: 'danger' },
      { label: '确认入住', type: 'confirm', style: 'primary' },
    ]
  }
  if (s === 'confirmed') {
    return [
      { label: '取消订单', type: 'cancel', style: 'danger' },
      { label: '办理入住', type: 'checkin', style: 'primary' },
    ]
  }
  if (s === 'checked_in') {
    return [
      { label: '办理退房', type: 'checkout', style: 'primary' },
    ]
  }
  return []
})

// ========== 操作处理 ==========
async function handleConfirm() {
  if (!order.value) return
  uni.showModal({
    title: '确认入住', content: `确认客人${order.value.guestName}入住？`,
    success: async (res) => {
      if (!res.confirm) return
      uni.showLoading({ title: '确认中...' })
      try { await store.confirmOrder(order.value!.id); uni.showToast({ title: '已确认入住', icon: 'success' }); await store.fetchOrderDetail(order.value!.id) }
      catch { uni.showToast({ title: '操作失败', icon: 'none' }) }
      finally { uni.hideLoading() }
    },
  })
}

async function handleCancel() {
  if (!order.value) return
  uni.showModal({
    title: '取消订单', content: '确定要取消此订单吗？',
    success: async (res) => {
      if (!res.confirm) return
      uni.showLoading({ title: '取消中...' })
      try { await store.cancelOrder(order.value!.id, '员工主动取消'); uni.showToast({ title: '已取消', icon: 'success' }); await store.fetchOrderDetail(order.value!.id) }
      catch { uni.showToast({ title: '操作失败', icon: 'none' }) }
      finally { uni.hideLoading() }
    },
  })
}

function handleCheckout() {
  if (!order.value) return
  const p = new URLSearchParams()
  p.set('roomId', order.value.roomId || '')
  p.set('roomNumber', order.value.roomNumber || '')
  p.set('roomTypeName', order.value.roomType || '')
  p.set('roomTypeId', order.value.roomTypeId || '')
  p.set('roomPrice', String(order.value.amount || 0))
  p.set('roomFloor', '0')
  p.set('mode', 'checkout')
  if (order.value.guestName) p.set('guestName', order.value.guestName)
  if (order.value.checkIn) p.set('guestCheckIn', order.value.checkIn)
  if (order.value.checkOut) p.set('guestCheckOut', order.value.checkOut)
  uni.navigateTo({ url: `/pages/orders/create?${p.toString()}` })
}

function handleCheckin() {
  if (!order.value) return
  const p = new URLSearchParams()
  p.set('roomId', order.value.roomId || '')
  p.set('roomNumber', order.value.roomNumber || '')
  p.set('roomTypeName', order.value.roomType || '')
  p.set('roomTypeId', order.value.roomTypeId || '')
  p.set('roomPrice', String(order.value.amount || 0))
  p.set('mode', 'checkin')
  if (order.value.guestName) p.set('guestName', order.value.guestName)
  if (order.value.checkIn) p.set('guestCheckIn', order.value.checkIn)
  uni.navigateTo({ url: `/pages/orders/create?${p.toString()}` })
}

function handleCall() {
  if (!order.value?.guestPhone) return
  uni.makePhoneCall({ phoneNumber: order.value.guestPhone })
}

function handleAction(type: string) {
  if (type === 'confirm') handleConfirm()
  else if (type === 'cancel') handleCancel()
  else if (type === 'checkin') handleCheckin()
  else if (type === 'checkout') handleCheckout()
}

// ========== 格式化 ==========
function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}/${m}/${day}`
}

function formatDateTime(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}/${m}/${day} ${h}:${min}`
}
</script>

<template>
  <view class="detail-page">
    <view v-if="order" class="detail-content">
      <!-- 状态横幅 -->
      <view class="status-banner" :style="{ background: bannerConfig.bg }">
        <text class="banner-icon">{{ bannerConfig.icon }}</text>
        <text class="banner-label">{{ bannerConfig.label }}</text>
        <text class="banner-order-no">{{ order.orderNo }}</text>
      </view>

      <!-- 订单信息卡片 -->
      <view class="info-card">
        <view class="card-title">
          <text class="title-icon">📋</text>
          <text class="title-text">订单信息</text>
        </view>
        <view class="info-row">
          <text class="info-label">订单号</text>
          <text class="info-value">{{ order.orderNo }}</text>
        </view>
        <view class="info-row">
          <text class="info-label">渠道来源</text>
          <view class="channel-badge" :style="{ background: order.channelColor ? order.channelColor.replace('bg-', '#') : '#576B95' }">
            <text class="channel-badge-icon">{{ order.icon || order.channelInfo?.icon || '📋' }}</text>
            <text class="channel-badge-text">{{ order.channel }}</text>
          </view>
        </view>
        <view v-if="order.channelOrderId && order.source !== 'platform'" class="info-row">
          <text class="info-label">渠道单号</text>
          <text class="info-value">{{ order.channelOrderId }}</text>
        </view>
        <view v-if="order.platformOrderNo" class="info-row">
          <text class="info-label">平台订单号</text>
          <text class="info-value">{{ order.platformOrderNo }}</text>
        </view>
        <view v-if="order.verifyCode" class="info-row">
          <text class="info-label">核销码</text>
          <text class="info-value">{{ order.verifyCode }}</text>
        </view>
        <view class="info-row">
          <text class="info-label">创建时间</text>
          <text class="info-value">{{ formatDateTime(order.createdAt) }}</text>
        </view>
        <view v-if="order.confirmedAt" class="info-row">
          <text class="info-label">确认时间</text>
          <text class="info-value">{{ formatDateTime(order.confirmedAt) }}</text>
        </view>
      </view>

      <!-- 客人信息卡片 -->
      <view class="info-card">
        <view class="card-title">
          <text class="title-icon">👤</text>
          <text class="title-text">客人信息</text>
        </view>
        <view class="info-row">
          <text class="info-label">姓名</text>
          <text class="info-value info-value--strong">{{ order.guestName }}</text>
        </view>
        <view v-if="order.guestPhone" class="info-row">
          <text class="info-label">手机号</text>
          <text class="info-value info-value--link">{{ order.guestPhone }}</text>
        </view>
        <view class="info-row">
          <text class="info-label">入住日期</text>
          <text class="info-value">{{ formatDate(order.checkIn) }}</text>
        </view>
        <view class="info-row">
          <text class="info-label">退房日期</text>
          <text class="info-value">{{ formatDate(order.checkOut) }}</text>
        </view>
        <view class="info-row">
          <text class="info-label">共住天数</text>
          <text class="info-value info-value--strong">{{ order.nights }}晚</text>
        </view>
      </view>

      <!-- 房间信息卡片 -->
      <view class="info-card">
        <view class="card-title">
          <text class="title-icon">🛏️</text>
          <text class="title-text">房间信息</text>
        </view>
        <view class="info-row">
          <text class="info-label">房型</text>
          <text class="info-value">{{ order.roomType }}</text>
        </view>
        <view v-if="order.roomNumber" class="info-row">
          <text class="info-label">房号</text>
          <text class="info-value info-value--room">{{ order.roomNumber }}</text>
        </view>
      </view>

      <!-- 价格信息卡片 -->
      <view class="info-card">
        <view class="card-title">
          <text class="title-icon">💰</text>
          <text class="title-text">价格信息</text>
        </view>
        <view class="price-main">
          <text class="price-amount">￥{{ order.amount }}</text>
          <text
            class="payment-badge"
            :style="{
              color: order.paymentStatus === 'paid' ? '#07C160' : '#FF9500',
              background: order.paymentStatus === 'paid' ? 'rgba(7,193,96,0.1)' : 'rgba(255,149,0,0.1)'
            }"
          >
            {{ order.paymentStatusInfo?.label || order.paymentStatus }}
          </text>
        </view>
        <view class="info-row">
          <text class="info-label">原价</text>
          <text v-if="order.originalAmount !== order.amount" class="info-value info-value--strike">￥{{ order.originalAmount }}</text>
          <text v-else class="info-value">￥{{ order.originalAmount }}</text>
        </view>
        <view v-if="order.discount" class="info-row">
          <text class="info-label">优惠</text>
          <text class="info-value info-value--discount">{{ order.discount }}</text>
        </view>
        <view class="info-row">
          <text class="info-label">支付方式</text>
          <text class="info-value">{{ order.paymentMethod || '未指定' }}</text>
        </view>
      </view>

      <!-- 额外费用（如有） -->
      <view v-if="order.extras && order.extras.length > 0" class="info-card info-card--extras">
        <view class="card-title">
          <text class="title-icon">💸</text>
          <text class="title-text">额外费用</text>
        </view>
        <view v-for="(extra, idx) in order.extras" :key="idx" class="info-row">
          <text class="info-label">{{ extra.name }}</text>
          <text class="info-value info-value--warn">￥{{ extra.amount }}</text>
        </view>
      </view>

      <!-- 备注（如有） -->
      <view v-if="order.remark" class="info-card info-card--remark">
        <view class="card-title">
          <text class="title-icon">📝</text>
          <text class="title-text">备注</text>
        </view>
        <text class="remark-content">{{ order.remark }}</text>
      </view>

      <!-- 取消原因（如已取消） -->
      <view v-if="order.cancelReason && (order.status === 'cancelled')" class="info-card info-card--cancel">
        <view class="card-title">
          <text class="title-icon">⚠️</text>
          <text class="title-text">取消原因</text>
        </view>
        <text class="cancel-content">{{ order.cancelReason }}</text>
      </view>

      <!-- 操作时间线 -->
      <view v-if="order.timeline && order.timeline.length > 0" class="info-card">
        <view class="card-title">
          <text class="title-icon">🕐</text>
          <text class="title-text">操作记录</text>
        </view>
        <view class="timeline">
          <view v-for="(node, idx) in order.timeline" :key="idx" class="timeline-node">
            <view class="timeline-left">
              <view :class="['timeline-dot', { 'timeline-dot--active': idx === order.timeline.length - 1 }]" />
              <view v-if="idx < order.timeline.length - 1" class="timeline-line" />
            </view>
            <view class="timeline-right">
              <text class="timeline-label">{{ node.label }}</text>
              <text class="timeline-desc">{{ node.desc }}</text>
              <text class="timeline-time">{{ formatDateTime(node.time) }}</text>
            </view>
          </view>
        </view>
      </view>

      <!-- 底部占位（给操作栏留空间） -->
      <view class="action-placeholder" />
    </view>

    <!-- 加载中 -->
    <view v-else class="loading-state">
      <text class="loading-text">加载中...</text>
    </view>

    <!-- 底部操作栏 -->
    <view v-if="order && actions.length > 0" class="action-bar">
      <!-- 电话 / 短信 -->
      <view class="action-contact">
        <view class="contact-btn" @click="handleCall">
          <text class="contact-icon">📞</text>
          <text class="contact-label">电话</text>
        </view>
        <view class="contact-btn" @click="order?.guestPhone && uni.makePhoneCall({ phoneNumber: order.guestPhone })">
          <text class="contact-icon">💬</text>
          <text class="contact-label">短信</text>
        </view>
      </view>

      <!-- 主操作按钮 -->
      <view class="action-buttons">
        <button
          v-for="action in actions"
          :key="action.type"
          :class="['action-btn', `action-btn--${action.style}`]"
          @click="handleAction(action.type)"
        >
          {{ action.label }}
        </button>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.detail-page {
  min-height: 100vh;
  background: #F5F6FA;
}

// ========== 状态横幅 ==========
.status-banner {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48rpx 24rpx 36rpx;
  padding-top: 48rpx;
  color: #FFFFFF;
}

.banner-icon {
  font-size: 56rpx;
  margin-bottom: 12rpx;
}

.banner-label {
  font-size: 36rpx;
  font-weight: 700;
  margin-bottom: 8rpx;
}

.banner-order-no {
  font-size: 24rpx;
  opacity: 0.85;
}

// ========== 内容区域 ==========
.detail-content {
  padding: 0 24rpx;
}

// ========== 信息卡片 ==========
.info-card {
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);

  &--extras {
    background: #FFF9F0;
  }

  &--remark {
    background: #F0F5FF;
  }

  &--cancel {
    background: #FFF0F0;
  }
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-bottom: 16rpx;
  padding-bottom: 12rpx;
  border-bottom: 1rpx solid #EDEDED;
}

.title-icon {
  font-size: 24rpx;
}

.title-text {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

// ========== 信息行 ==========
.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10rpx 0;

  &:not(:last-child) {
    border-bottom: 1rpx solid rgba(0, 0, 0, 0.04);
  }
}

.info-label {
  font-size: 26rpx;
  color: #888888;
  flex-shrink: 0;
}

.info-value {
  font-size: 26rpx;
  color: #191919;
  text-align: right;

  &--strong {
    font-weight: 600;
    font-size: 28rpx;
  }

  &--link {
    color: #576B95;
  }

  &--room {
    font-size: 28rpx;
    font-weight: 600;
    color: #576B95;
    background: rgba(87, 107, 149, 0.08);
    padding: 4rpx 14rpx;
    border-radius: 8rpx;
  }

  &--strike {
    text-decoration: line-through;
    color: #888888;
  }

  &--discount {
    color: #FA5151;
    font-weight: 500;
  }

  &--warn {
    color: #FF9500;
    font-weight: 500;
  }
}

// 渠道badge
.channel-badge {
  display: inline-flex;
  align-items: center;
  gap: 4rpx;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
  color: #FFFFFF;
}

.channel-badge-icon {
  font-size: 18rpx;
}

.channel-badge-text {
  font-size: 22rpx;
  font-weight: 500;
}

// ========== 价格主显示 ==========
.price-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12rpx 0 16rpx;
  border-bottom: 1rpx solid rgba(0, 0, 0, 0.06);
  margin-bottom: 8rpx;
}

.price-amount {
  font-size: 44rpx;
  font-weight: 700;
  color: #191919;
}

.payment-badge {
  font-size: 22rpx;
  padding: 4rpx 14rpx;
  border-radius: 8rpx;
  font-weight: 500;
}

// ========== 备注/取消原因 ==========
.remark-content {
  font-size: 26rpx;
  color: #191919;
  line-height: 1.6;
}

.cancel-content {
  font-size: 26rpx;
  color: #FA5151;
  line-height: 1.6;
}

// ========== 时间线 ==========
.timeline {
  padding: 8rpx 0;
}

.timeline-node {
  display: flex;
  gap: 16rpx;
  min-height: 72rpx;
}

.timeline-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 24rpx;
  flex-shrink: 0;
}

.timeline-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 50%;
  background: #D0D0D0;
  margin-top: 8rpx;

  &--active {
    background: #07C160;
    box-shadow: 0 0 0 4rpx rgba(7, 193, 96, 0.2);
  }
}

.timeline-line {
  width: 2rpx;
  flex: 1;
  background: #EDEDED;
  margin: 4rpx 0;
}

.timeline-right {
  flex: 1;
  padding-bottom: 20rpx;
}

.timeline-label {
  display: block;
  font-size: 26rpx;
  font-weight: 500;
  color: #191919;
  margin-bottom: 4rpx;
}

.timeline-desc {
  display: block;
  font-size: 24rpx;
  color: #888888;
  margin-bottom: 4rpx;
}

.timeline-time {
  display: block;
  font-size: 22rpx;
  color: #CCCCCC;
}

// ========== 加载中 ==========
.loading-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 50vh;
}

.loading-text {
  font-size: 28rpx;
  color: #888888;
}

// ========== 底部操作栏 ==========
.action-placeholder {
  height: 140rpx;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #FFFFFF;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 24rpx;
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 16rpx rgba(0, 0, 0, 0.06);
  z-index: 100;
}

.action-contact {
  display: flex;
  gap: 16rpx;
}

.contact-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  padding: 8rpx 16rpx;
}

.contact-icon {
  font-size: 36rpx;
}

.contact-label {
  font-size: 20rpx;
  color: #888888;
}

.action-buttons {
  display: flex;
  gap: 16rpx;
}

.action-btn {
  height: 80rpx;
  padding: 0 40rpx;
  border-radius: 40rpx;
  font-size: 28rpx;
  font-weight: 500;
  border: none;
  line-height: 80rpx;

  &--primary {
    background: #07C160;
    color: #FFFFFF;
  }

  &--danger {
    background: #FFFFFF;
    color: #FA5151;
    border: 2rpx solid #FA5151;
  }

  &:active {
    opacity: 0.85;
  }
}
</style>
