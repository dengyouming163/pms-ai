<script setup lang="ts">
import { computed } from 'vue'
import { useRoomsStore } from '@/stores/rooms'
import { getOccupancyColor } from '@/constants/room'
import DateNav from './DateNav.vue'
import type { MonthlyRoomType, MonthlyDayStatus } from '@/types/room'

const store = useRoomsStore()

// 日期格式化工具函数
function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

// ===== 统计卡片数据 =====

// ===== 周日期范围 =====
// 当前周7天的日期字符串数组
const weekDateStrings = computed(() => {
  if (!store.monthlyStart) return []
  const start = new Date(store.monthlyStart)
  const dates: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    dates.push(formatDate(d))
  }
  return dates
})

// 周日期范围标签，如 "7/24 ~ 7/30"
const weekLabel = computed(() => {
  const dates = weekDateStrings.value
  if (!dates.length) return ''
  const fmt = (d: string) => { const p = d.split('-'); return `${parseInt(p[1])}/${parseInt(p[2])}` }
  return `${fmt(dates[0])} ~ ${fmt(dates[dates.length - 1])}`
})

// 当前周是否包含今天
const isCurrentWeek = computed(() => {
  const today = formatDate(new Date())
  return weekDateStrings.value.includes(today)
})

// ===== 星期表头 =====
const weekDays = ['一', '二', '三', '四', '五', '六', '日']

// ===== 辅助函数 =====
/** 判断日期字符串是否为周末 */
function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr)
  return d.getDay() === 0 || d.getDay() === 6
}

/** 判断日期字符串是否为今天 */
function isToday(dateStr: string): boolean {
  return dateStr === formatDate(new Date())
}

/** 获取房型在指定日期的状态数据 */
function getDayStatus(rt: MonthlyRoomType, dateStr: string): MonthlyDayStatus | undefined {
  return rt.dailyStatus.find(d => d.date === dateStr)
}

/** 获取房型在某天的入住率 */
function getDayOccupancyRate(rt: MonthlyRoomType, dateStr: string): number {
  const status = getDayStatus(rt, dateStr)
  if (!status || status.total === 0) return 0
  return Math.round((status.occupied + status.booked) / status.total * 100)
}

// ===== 事件 =====
const emit = defineEmits<{ dayTap: [date: string] }>()

function onDayTap(date: string, isPast: boolean) {
  if (!isPast) emit('dayTap', date)
}
</script>

<template>
  <view class="monthly-view">
    <!-- 统计栏 -->

    <!-- 周导航 -->
    <DateNav
      :label="weekLabel"
      :show-today="true"
      :is-today="isCurrentWeek"
      @prev="store.navigateMonth(-1)"
      @next="store.navigateMonth(1)"
      @today="store.goThisMonth()"
    />

    <!-- 加载中 -->
    <view v-if="store.monthlyLoading" class="state-box">
      <text class="state-icon">⏳</text>
      <text class="state-text">加载房态中...</text>
    </view>

    <!-- 错误 -->
    <view v-else-if="store.monthlyError" class="state-box" @click="store.fetchMonthlyData()">
      <text class="state-icon">⚠️</text>
      <text class="state-text">{{ store.monthlyError }}</text>
      <text class="retry-text">点击重试</text>
    </view>

    <!-- 按房型分组的周日历 -->
    <scroll-view v-else class="calendar-scroll" scroll-y>
      <view
        v-for="rt in store.monthlyData?.roomTypes"
        :key="rt.roomTypeId"
        class="room-type-card"
      >
        <!-- 房型头部：名称 + 房间数 + 基础价 -->
        <view class="rt-header">
          <view class="rt-header-left">
            <text class="rt-name">{{ rt.roomTypeName }}</text>
            <text class="rt-count">{{ rt.totalRooms }}间</text>
          </view>
          <text class="rt-price">¥{{ rt.basePrice }}/晚</text>
        </view>

        <!-- 星期表头 -->
        <view class="weekday-row">
          <view
            v-for="(wd, i) in weekDays"
            :key="i"
            class="weekday-cell"
            :class="{ weekend: i >= 5 }"
          >
            <text>{{ wd }}</text>
          </view>
        </view>

        <!-- 7天日历网格 -->
        <view class="calendar-grid">
          <view
            v-for="dateStr in weekDateStrings"
            :key="dateStr"
            class="cal-cell"
            :class="{
              past: getDayStatus(rt, dateStr)?.isPast,
              today: isToday(dateStr),
              empty: !getDayStatus(rt, dateStr),
            }"
            :style="getDayStatus(rt, dateStr) && !getDayStatus(rt, dateStr)?.isPast
              ? { background: getOccupancyColor(getDayOccupancyRate(rt, dateStr)).bg }
              : {}"
            @click="onDayTap(dateStr, getDayStatus(rt, dateStr)?.isPast ?? true)"
          >
            <!-- 日期数字 -->
            <text
              class="day-num"
              :class="{ weekend: isWeekend(dateStr) }"
            >{{ new Date(dateStr).getDate() }}</text>
            <!-- 入住率文本（非过去日期） -->
            <text
              v-if="getDayStatus(rt, dateStr) && !getDayStatus(rt, dateStr)?.isPast"
              class="day-rate"
              :style="{ color: getOccupancyColor(getDayOccupancyRate(rt, dateStr)).color }"
            >
              {{ getDayStatus(rt, dateStr)!.available === 0 ? '满' : '余' + getDayStatus(rt, dateStr)!.available }}
            </text>
          </view>
        </view>

        <!-- 图例 -->
        <view class="legend-row">
          <view class="legend-item">
            <view class="legend-dot" style="background:#D6F5E5" /><text>充裕</text>
          </view>
          <view class="legend-item">
            <view class="legend-dot" style="background:#FFF3D6" /><text>紧张</text>
          </view>
          <view class="legend-item">
            <view class="legend-dot" style="background:#FFE0E0" /><text>满房</text>
          </view>
          <view class="legend-item">
            <view class="legend-dot" style="background:#F5F5F5" /><text>过去</text>
          </view>
        </view>
      </view>

      <!-- 空数据提示 -->
      <view v-if="!store.monthlyData?.roomTypes?.length" class="state-box">
        <text class="state-icon">📅</text>
        <text class="state-text">暂无房态数据</text>
      </view>
    </scroll-view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.monthly-view {
  display: flex;
  flex-direction: column;
}

.calendar-scroll {
  flex: 1;
  height: calc(100vh - 560rpx);
  padding: 0 24rpx 24rpx;
}

// ===== 房型卡片 =====
.room-type-card {
  background: #fff;
  border-radius: 24rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
  box-shadow: $shadow-card;
}

// 房型头部
.rt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16rpx;
  padding-bottom: 12rpx;
  border-bottom: 1rpx solid #f0f0f0;
}

.rt-header-left {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.rt-name {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
}

.rt-count {
  font-size: 22rpx;
  color: $text-tertiary;
  background: $bg-main;
  padding: 2rpx 12rpx;
  border-radius: 10rpx;
}

.rt-price {
  font-size: 24rpx;
  color: $primary-green;
  font-weight: 500;
}

// 星期表头
.weekday-row {
  display: flex;
  margin-bottom: 8rpx;
}

.weekday-cell {
  flex: 1;
  text-align: center;
  padding: 8rpx 0;
}

.weekday-cell text {
  font-size: 22rpx;
  color: $text-tertiary;
}

.weekday-cell.weekend text {
  color: #FA5151;
}

// 日历网格
.calendar-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6rpx;
}

.cal-cell {
  flex: 0 0 calc((100% - 36rpx) / 7);
  aspect-ratio: 1;
  border-radius: 10rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2rpx;
  border: 1rpx solid #f0f0f0;
  background: #fff;
}

.cal-cell.empty {
  border: 1rpx dashed #e0e0e0;
  background: transparent;
}

.cal-cell.past {
  background: #f5f5f5;
  opacity: 0.6;
}

.cal-cell.today {
  box-shadow: 0 0 0 3rpx $primary-green;
}

.day-num {
  font-size: 24rpx;
  font-weight: 600;
  color: $text-primary;
}

.day-num.weekend {
  color: #FA5151;
}

.day-rate {
  font-size: 18rpx;
}

// 图例
.legend-row {
  display: flex;
  justify-content: center;
  gap: 24rpx;
  padding: 20rpx 0 8rpx;
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6rpx;
}

.legend-item text {
  font-size: 20rpx;
  color: $text-tertiary;
}

.legend-dot {
  width: 16rpx;
  height: 16rpx;
  border-radius: 4rpx;
}

// ===== 加载/错误/空状态 =====
.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 0;
}

.state-icon {
  font-size: 64rpx;
  margin-bottom: 16rpx;
}

.state-text {
  font-size: 28rpx;
  color: $text-tertiary;
}

.retry-text {
  font-size: 26rpx;
  color: $primary-green;
  text-decoration: underline;
  margin-top: 16rpx;
}
</style>
