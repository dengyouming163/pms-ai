<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useRoomsStore } from '@/stores/rooms'
import { roomStatusConfig } from '@/constants/room'

const roomsStore = useRoomsStore()
const showSheet = ref(false)
const actions = [
  { label: '办理入住', action: 'checkIn', icon: '🛎️' },
  { label: '办理退房', action: 'checkOut', icon: '👋' },
  { label: '换房', action: 'changeRoom', icon: '🔄' },
  { label: '锁房', action: 'lock', icon: '🔒' },
  { label: '标记脏房', action: 'markDirty', icon: '🧹' },
  { label: '标记干净', action: 'markClean', icon: '✨' },
]

onLoad((options: { id?: string }) => {
  const id = options?.id || '0'
  roomsStore.fetchRoomDetail(id)
})

async function handleAction(index: number) {
  const act = actions[index]
  if (!act || !roomsStore.currentRoom) return
  uni.showLoading({ title: '处理中...' })
  try {
    await roomsStore.executeAction(act.action, roomsStore.currentRoom)
    uni.showToast({ title: `${act.label}成功`, icon: 'success' })
    showSheet.value = false
  } catch {
    uni.showToast({ title: '操作失败', icon: 'none' })
  } finally {
    uni.hideLoading()
  }
}
</script>

<template>
  <view class="detail-page">
    <view v-if="roomsStore.currentRoom" class="detail-content">
      <!-- 房间信息卡片 -->
      <view class="info-card">
        <view class="info-header">
          <text class="room-number">{{ roomsStore.currentRoom.roomNumber }}</text>
          <view class="status-tag" :style="{
            background: roomStatusConfig[roomsStore.currentRoom.status]?.bg,
            color: roomStatusConfig[roomsStore.currentRoom.status]?.color
          }">
            <text>{{ roomStatusConfig[roomsStore.currentRoom.status]?.label }}</text>
          </view>
        </view>
        <text class="room-type">{{ roomsStore.currentRoom.roomTypeName }}</text>
        <view class="info-row">
          <text class="info-label">楼层</text>
          <text class="info-value">{{ roomsStore.currentRoom.floor }}楼</text>
        </view>
        <view class="info-row">
          <text class="info-label">价格</text>
          <text class="info-value">¥{{ roomsStore.currentRoom.price }}/晚</text>
        </view>
        <view v-if="roomsStore.currentRoom.guest" class="guest-section">
          <view class="info-row"><text class="info-label">住客</text><text class="info-value">{{ roomsStore.currentRoom.guest }}</text></view>
          <view class="info-row" v-if="roomsStore.currentRoom.checkIn">
            <text class="info-label">日期</text>
            <text class="info-value">{{ roomsStore.currentRoom.checkIn }} ~ {{ roomsStore.currentRoom.checkOut }}</text>
          </view>
        </view>
      </view>

      <!-- 操作按钮 -->
      <view class="action-buttons">
        <view v-for="(act, i) in actions" :key="i" class="act-btn" @click="handleAction(i)">
          <text class="act-icon">{{ act.icon }}</text>
          <text class="act-label">{{ act.label }}</text>
        </view>
      </view>
    </view>

    <view v-else class="loading-state"><text>加载中...</text></view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.detail-page { min-height: 100vh; background: $bg-main; }
.info-card { background: #fff; margin: 24rpx; padding: 32rpx; border-radius: 24rpx; box-shadow: 0 2rpx 16rpx rgba(0,0,0,0.04); position: relative; overflow: hidden; }
.info-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6rpx; background: $gradient-gold; border-radius: 24rpx 24rpx 0 0; }
.info-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12rpx; }
.room-number { font-size: 40rpx; font-weight: 700; color: $text-primary; }
.status-tag { padding: 4rpx 14rpx; border-radius: 8rpx; font-size: 22rpx; font-weight: 500; }
.room-type { font-size: 28rpx; color: $text-secondary; display: block; margin-bottom: 16rpx; }
.info-row { display: flex; align-items: center; gap: 16rpx; padding: 12rpx 0; border-top: 1rpx solid rgba(0,0,0,0.04); }
.info-label { font-size: 24rpx; color: $text-tertiary; width: 80rpx; }
.info-value { font-size: 28rpx; color: $text-primary; font-weight: 500; }
.guest-section { margin-top: 8rpx; }
.action-buttons { display: flex; flex-wrap: wrap; gap: 16rpx; padding: 24rpx; }
.act-btn { flex: 0 0 calc(50% - 8rpx); background: #fff; border-radius: 20rpx; padding: 28rpx; display: flex; align-items: center; gap: 16rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.act-btn:active { background: #F5F6FA; }
.act-icon { font-size: 32rpx; }
.act-label { font-size: 26rpx; font-weight: 500; color: $text-primary; }
.loading-state { display: flex; justify-content: center; align-items: center; height: 50vh; color: $text-tertiary; }
</style>
