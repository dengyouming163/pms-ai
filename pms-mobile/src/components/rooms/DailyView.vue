<script setup lang="ts">
import { computed } from 'vue'
import { useRoomsStore } from '@/stores/rooms'
import { roomStatusConfig } from '@/constants/room'
import DateNav from './DateNav.vue'
import RoomCell from './RoomCell.vue'
import type { DailyRoom } from '@/types/room'

const store = useRoomsStore()


// 日期标签 + 是否今天
const dateLabel = computed(() => {
  if (!store.dailyData?.date) return ''
  const d = new Date(store.dailyData.date)
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 周${wd}`
})

const isToday = computed(() => {
  const today = new Date().toISOString().split('T')[0]
  return store.selectedDate === today
})

const groupedRooms = computed(() => {
  return store.groupBy === 'floor' ? store.roomsByFloor : store.roomsByType
})

function getGroupRate(rooms: DailyRoom[]): number {
  if (!rooms.length) return 0
  const occ = rooms.filter(r => r.status === 'occupied' || r.status === 'booked').length
  return Math.round(occ / rooms.length * 100)
}

const statusKeys = Object.keys(roomStatusConfig)

// 图例项（含各状态数量）
const legendItems = computed(() => {
  const s = store.dailySummary
  return statusKeys.map(key => ({
    key,
    label: roomStatusConfig[key].label,
    color: roomStatusConfig[key].color,
    count: s ? ((s as any)[key] || 0) : 0,
  }))
})

// 状态分布条数据
const distSegments = computed(() => {
  const s = store.dailySummary
  if (!s || !s.total) return []
  return statusKeys.map(key => ({
    key,
    count: (s as any)[key] || 0,
    width: ((s as any)[key] || 0) / s.total * 100,
    color: roomStatusConfig[key].color,
  })).filter(seg => seg.count > 0)
})

const emit = defineEmits<{ roomTap: [room: DailyRoom] }>()
</script>

<template>
  <view class="daily-view">
    <!-- 统计栏 -->

    <!-- 日期导航 -->
    <DateNav
      :label="dateLabel"
      :is-today="isToday"
      @prev="store.navigateDate(-1)"
      @next="store.navigateDate(1)"
      @today="store.goToday()"
    />

    <!-- 状态图例（含数量）+ 分组切换 -->
    <view class="toolbar">
      <view class="legend">
        <view v-for="item in legendItems" :key="item.key" class="legend-item">
          <view class="legend-dot" :style="{ background: item.color }" />
          <text class="legend-text">{{ item.label }}({{ item.count }})</text>
        </view>
      </view>
      <view class="group-switch">
        <text class="switch-btn" :class="{ active: store.groupBy === 'floor' }" @click="store.setGroupBy('floor')">按楼层</text>
        <text class="switch-btn" :class="{ active: store.groupBy === 'roomType' }" @click="store.setGroupBy('roomType')">按房型</text>
      </view>
    </view>

    <!-- 加载中 -->
    <view v-if="store.dailyLoading" class="state-box">
      <text class="state-icon">⏳</text>
      <text class="state-text">加载房态中...</text>
    </view>

    <!-- 错误 -->
    <view v-else-if="store.dailyError" class="state-box" @click="store.fetchDailyData()">
      <text class="state-icon">⚠️</text>
      <text class="state-text">{{ store.dailyError }}</text>
      <text class="retry-text">点击重试</text>
    </view>

    <!-- 房间网格 -->
    <scroll-view v-else class="rooms-scroll" scroll-y>
      <view v-for="(rooms, groupName) in groupedRooms" :key="groupName" class="group-section">
        <view class="group-header">
          <text class="group-name">{{ store.groupBy === 'floor' ? groupName + '楼' : groupName }}</text>
          <view class="group-meta">
            <text class="meta-count">{{ (rooms || []).length }}间</text>
          </view>
        </view>
        <!-- 出租率进度条 -->
        <view class="progress-bar-wrap">
          <view class="progress-bar">
            <view
              class="progress-fill"
              :style="{ width: getGroupRate(rooms || []) + '%', background: '#07C160' }"
            />
          </view>
          <text class="progress-text">出租率{{ getGroupRate(rooms || []) }}%</text>
        </view>
        <view class="room-grid">
          <RoomCell v-for="room in (rooms || []).filter(Boolean)" :key="room.id" :room="room" @tap="emit('roomTap', room)" />
        </view>
      </view>

      <!-- 状态分布条 -->
      <view v-if="distSegments.length" class="dist-bar-section">
        <text class="dist-title">状态分布</text>
        <view class="dist-bar">
          <view
            v-for="seg in distSegments"
            :key="seg.key"
            class="dist-segment"
            :style="{ width: seg.width + '%', background: seg.color }"
          />
        </view>
        <view class="dist-legend">
          <view v-for="seg in distSegments" :key="seg.key" class="dist-legend-item">
            <view class="dist-legend-dot" :style="{ background: seg.color }" />
            <text class="dist-legend-text">{{ roomStatusConfig[seg.key].label }} {{ seg.count }}</text>
          </view>
        </view>
      </view>

      <view v-if="!store.dailyData?.rooms?.length" class="state-box">
        <text class="state-icon">🏨</text>
        <text class="state-text">暂无房间数据</text>
      </view>
    </scroll-view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.daily-view { display: flex; flex-direction: column; }
.toolbar { display: flex; align-items: center; justify-content: space-between; padding: 0 24rpx 16rpx; flex-wrap: wrap; gap: 12rpx; }
.legend { display: flex; flex-wrap: wrap; gap: 16rpx; }
.legend-item { display: flex; align-items: center; gap: 6rpx; }
.legend-dot { width: 14rpx; height: 14rpx; border-radius: 4rpx; }
.legend-text { font-size: 20rpx; color: $text-tertiary; }
.group-switch { display: flex; gap: 8rpx; }
.switch-btn { padding: 6rpx 16rpx; font-size: 22rpx; border-radius: 16rpx; background: #f0f0f0; color: $text-tertiary; }
.switch-btn.active { background: rgba(7, 193, 96, 0.1); color: $primary-green; font-weight: 500; }
.rooms-scroll { flex: 1; height: calc(100vh - 560rpx); padding: 0 24rpx 24rpx; }
.group-section { margin-bottom: 24rpx; }
.group-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8rpx; padding: 0 4rpx; }
.group-name { font-size: 26rpx; font-weight: 600; color: $text-primary; }
.group-meta { display: flex; gap: 12rpx; }
.meta-count { font-size: 22rpx; color: $text-tertiary; }

// 出租率进度条
.progress-bar-wrap {
  display: flex; align-items: center; gap: 12rpx;
  margin-bottom: 12rpx; padding: 0 4rpx;
}
.progress-bar {
  flex: 1; height: 10rpx;
  background: #f0f0f0; border-radius: 5rpx; overflow: hidden;
}
.progress-fill { height: 100%; border-radius: 5rpx; background: $primary-green; transition: width 0.3s; }
.progress-text { font-size: 20rpx; color: $primary-green; white-space: nowrap; }

.room-grid { display: flex; flex-wrap: wrap; gap: 12rpx; }
.room-grid > view { flex: 0 0 calc(33.333% - 8rpx); min-width: 0; }

// 状态分布条
.dist-bar-section {
  background: #fff; border-radius: 24rpx; padding: 20rpx;
  margin-top: 8rpx; box-shadow: $shadow-card;
}
.dist-title { font-size: 24rpx; font-weight: 600; color: $text-primary; display: block; margin-bottom: 16rpx; }
.dist-bar { display: flex; height: 20rpx; border-radius: 10rpx; overflow: hidden; }
.dist-segment { height: 100%; min-width: 4rpx; transition: width 0.3s; }
.dist-legend { display: flex; flex-wrap: wrap; gap: 16rpx; margin-top: 14rpx; }
.dist-legend-item { display: flex; align-items: center; gap: 6rpx; }
.dist-legend-dot { width: 12rpx; height: 12rpx; border-radius: 3rpx; }
.dist-legend-text { font-size: 20rpx; color: $text-tertiary; }

.state-box { display: flex; flex-direction: column; align-items: center; padding: 120rpx 0; }
.state-icon { font-size: 64rpx; margin-bottom: 16rpx; }
.state-text { font-size: 28rpx; color: $text-tertiary; }
.retry-text { font-size: 26rpx; color: $primary-green; text-decoration: underline; margin-top: 16rpx; }
</style>
