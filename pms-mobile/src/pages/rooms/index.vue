<script setup lang="ts">
import { onMounted } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useRoomsStore } from '@/stores/rooms'
import PageHeader from '@/components/PageHeader.vue'
import DailyView from '@/components/rooms/DailyView.vue'
import MonthlyView from '@/components/rooms/MonthlyView.vue'
import RoomActionSheet from '@/components/rooms/RoomActionSheet.vue'
import type { DailyRoom } from '@/types/room'

const store = useRoomsStore()

function refreshData() {
  store.fetchDailyData()
  store.fetchMonthlyData()
}

onMounted(refreshData)
// APP 切回标签页时自动刷新
onShow(refreshData)

function handleRoomTap(room: DailyRoom) {
  store.showActionSheet(room)
}

function handleAction(action: string, room: DailyRoom) {
  let mode = action
  if (action === 'checkIn') mode = 'checkin'
  else if (action === 'book') mode = 'book'
  else if (action === 'checkOut') mode = 'checkout'
  else if (action === 'extendStay') mode = 'extend'
  else if (action === 'changeRoom') mode = 'change'
  // 中文参数用 encodeURIComponent + 接收端 decodeURIComponent
  const params = `roomId=${room.id}&roomNumber=${room.roomNumber}&roomTypeId=${room.roomTypeId}&roomPrice=${room.price || 0}&roomFloor=${room.floor || 0}&mode=${mode}&roomTypeName=${encodeURIComponent(room.roomTypeName || '')}`
  // 住客信息（退房/续住用）
  let extra = room.checkOut ? `&currentCheckOut=${room.checkOut}` : ''
  if (room.guest) extra += `&guestName=${encodeURIComponent(room.guest)}`
  if (room.checkIn) extra += `&guestCheckIn=${room.checkIn}`
  if (room.checkOut) extra += `&guestCheckOut=${room.checkOut}`
  uni.navigateTo({ url: `/pages/orders/create?${params}${extra}` })
}

function onDayTap(date: string) {
  store.setDate(date)
  store.setViewMode('daily')
}
</script>

<template>
  <view class="rooms-page">
    <!-- 固定头部: PageHeader + 视图Tab -->
    <PageHeader>
      <template #tabs>
        <view class="view-tabs">
          <view
            v-for="tab in ['daily', 'monthly']"
            :key="tab"
            :class="['view-tab', { active: store.viewMode === tab }]"
            @click="store.setViewMode(tab)">
            <text class="tab-label">{{ tab === 'daily' ? '日房态' : '月房态' }}</text>
          </view>
        </view>
      </template>
    </PageHeader>

    <!-- 滚动内容区 -->
    <scroll-view class="content-scroll" scroll-y>
      <!-- 日房态（用 v-show 保持 DOM，避免 scroll-view 随 v-if 销毁触发 uni-h5 scrollTop null 错误） -->
      <DailyView v-show="store.viewMode === 'daily'" @room-tap="handleRoomTap" />

      <!-- 月房态 -->
      <MonthlyView v-show="store.viewMode === 'monthly'" @day-tap="onDayTap" />
    </scroll-view>

    <!-- 快捷操作面板 -->
    <RoomActionSheet @action="handleAction" />

  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.rooms-page {
  height: 100vh;
  box-sizing: border-box;
  /* H5 端系统原生 tabBar 为 fixed 需预留高度；App 端原生 tabBar 自动避让无需额外 padding */
  /* #ifndef APP-PLUS */
  padding-bottom: calc(112rpx + env(safe-area-inset-bottom));
  /* #endif */
  display: flex;
  flex-direction: column;
  background: $bg-main;
  overflow: hidden;
}

.view-tabs {
  display: flex;
  gap: 12rpx;
  padding: 20rpx 24rpx 16rpx;
}
.view-tab {
  padding: 10rpx 28rpx;
  border-radius: 24rpx;
  background: #f0f0f0;
  transition: all 0.2s;
}
.view-tab text { font-size: 26rpx; color: $text-tertiary; }
.view-tab.active { background: $primary-green; }
.view-tab.active text { color: #fff; font-weight: 600; }

.content-scroll {
  flex: 1;
  height: 0;
  overflow: hidden;
}
</style>
