<script setup lang="ts">
import { computed } from 'vue'
import { useRoomsStore } from '@/stores/rooms'
import { roomStatusConfig, getActionsByStatus, type ActionButton } from '@/constants/room'
import type { DailyRoom } from '@/types/room'

const store = useRoomsStore()

const room = computed(() => store.actionSheetRoom)
const show = computed(() => store.actionSheetShow)

const config = computed(() => {
  if (!room.value) return null
  return roomStatusConfig[room.value.status] || roomStatusConfig.available
})

const actions = computed<ActionButton[]>(() => {
  if (!room.value) return []
  return getActionsByStatus(room.value.status)
})

const emit = defineEmits<{ action: [action: string, room: DailyRoom] }>()

async function onAction(action: string) {
  if (!room.value) return
  const instantActions = ['markDirty', 'markClean', 'lock', 'unlock', 'setMaintenance', 'restoreAvailable']
  if (instantActions.includes(action)) {
    uni.showLoading({ title: '处理中...' })
    const ok = await store.executeAction(action, room.value)
    uni.hideLoading()
    uni.showToast({ title: ok ? '操作成功' : '操作失败', icon: ok ? 'success' : 'none' })
    close()
  } else {
    close()
    emit('action', action, room.value)
  }
}

function close() {
  store.hideActionSheet()
}

const btnTypeClass: Record<string, string> = {
  primary: 'btn-primary',
  danger: 'btn-danger',
  warning: 'btn-warning',
  info: 'btn-info',
  neutral: 'btn-neutral',
}
</script>

<template>
  <view v-if="show && room && config" class="action-sheet-mask" @click="close">
    <view class="action-sheet" @click.stop>
      <!-- 拖拽指示器 -->
      <view class="sheet-handle" />

      <!-- 房间信息头 -->
      <view class="sheet-header">
        <view class="header-left">
          <text class="room-number">{{ room.roomNumber }}</text>
          <text class="room-sub">{{ room.roomTypeName }} · ¥{{ room.price }}/晚 · {{ room.floor }}楼</text>
        </view>
        <view class="status-tag" :style="{ background: config.bg, color: config.color }">
          <text>{{ config.label }}</text>
        </view>
      </view>

      <!-- 住客信息 -->
      <view v-if="room.guest" class="guest-info">
        <view class="info-item">
          <text class="info-label">住客</text>
          <text class="info-value">{{ room.guest }}</text>
        </view>
        <view v-if="room.checkIn" class="info-item">
          <text class="info-label">入住</text>
          <text class="info-value">{{ room.checkIn }} ~ {{ room.checkOut }}</text>
        </view>
      </view>

      <!-- 操作按钮网格 -->
      <view class="action-grid">
        <view
          v-for="btn in actions"
          :key="btn.action"
          class="action-btn"
          :class="btnTypeClass[btn.type]"
          @tap="onAction(btn.action)"
        >
          <text class="btn-icon">{{ btn.icon }}</text>
          <text class="btn-text">{{ btn.label }}</text>
        </view>
      </view>

      <!-- 取消按钮 -->
      <view class="cancel-btn" @tap="close">
        <text>取消</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.action-sheet-mask {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.4); z-index: 1100; /* 高于底部导航，遮住 TabBar */
  display: flex; flex-direction: column; justify-content: flex-end;
}
.action-sheet {
  background: #fff; border-radius: 32rpx 32rpx 0 0; padding: 0 0 16rpx;
  animation: slideUp 0.3s ease;
}
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
.sheet-handle { width: 64rpx; height: 8rpx; background: #ddd; border-radius: 4rpx; margin: 16rpx auto; }
.sheet-header {
  padding: 16rpx 32rpx 20rpx; border-bottom: 1rpx solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center;
}
.header-left { display: flex; flex-direction: column; gap: 6rpx; }
.room-number { font-size: 36rpx; font-weight: 700; color: $text-primary; }
.room-sub { font-size: 22rpx; color: $text-tertiary; }
.status-tag { padding: 6rpx 20rpx; border-radius: 20rpx; }
.status-tag text { font-size: 22rpx; }
.guest-info {
  margin: 16rpx 32rpx; padding: 16rpx 20rpx; background: #f7f7f7; border-radius: 16rpx;
  display: flex; gap: 40rpx;
}
.info-item { display: flex; flex-direction: column; gap: 4rpx; }
.info-label { font-size: 20rpx; color: $text-tertiary; }
.info-value { font-size: 24rpx; color: $text-primary; font-weight: 500; }
.action-grid {
  display: flex; flex-wrap: wrap; gap: 16rpx; padding: 24rpx 32rpx;
}
.action-btn {
  flex: 0 0 calc(50% - 8rpx); padding: 24rpx 16rpx; border-radius: 16rpx;
  display: flex; align-items: center; justify-content: center; gap: 12rpx;
}
.btn-icon { font-size: 36rpx; }
.btn-text { font-size: 28rpx; font-weight: 500; }
.btn-primary { background: $primary-green; }
.btn-primary text { color: #fff; }
.btn-danger { background: #FFE8E8; }
.btn-danger text { color: $price-red; }
.btn-warning { background: #FFF3E0; }
.btn-warning text { color: $warning-orange; }
.btn-info { background: #EBF0F7; }
.btn-info text { color: $info-blue; }
.btn-neutral { background: #f5f5f5; }
.btn-neutral text { color: $text-secondary; }
.cancel-btn {
  margin: 8rpx 32rpx 0; padding: 24rpx; text-align: center;
  background: #f5f5f5; border-radius: 16rpx;
}
.cancel-btn text { font-size: 28rpx; color: $text-secondary; }
</style>
