<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { fetchTasks } from '@/api/modules/assets'

interface TaskItem {
  id: string
  title: string
  taskDate?: string
  deadline?: string
  status: string
  purposeTags?: string[]
  roomNames?: string[]
  roomTypeNames?: string[]
  shotRequirements?: { shotType: string; count: number }[]
}

const tasks = ref<TaskItem[]>([])
const loading = ref(false)
const activeTab = ref<'today' | 'all'>('today')
const emptyText = computed(() => activeTab.value === 'today' ? '今日暂无打卡任务' : '暂无打卡任务')

// 今日日期：在每次请求前实时计算，避免模块顶层缓存过期值（跨天时失效）
const todayStr = ref('')
function computeTodayStr() {
  const now = new Date()
  todayStr.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// 状态筛选：全部 / 进行中 / 已结束（前端按 deadline/status 过滤）
type StatusFilter = 'all' | 'active' | 'ended'
const statusFilter = ref<StatusFilter>('all')
const statusChips: Array<{ label: string; value: StatusFilter }> = [
  { label: '全部', value: 'all' },
  { label: '进行中', value: 'active' },
  { label: '已结束', value: 'ended' },
]

// 任务是否已结束：标记 finished 或 deadline 已过（后端拒绝逾期提交，deadline 即终态）
function isEnded(t: TaskItem): boolean {
  if (t.status === 'finished') return true
  if (!t.deadline) return false
  const isPureDate = /^\d{4}-\d{2}-\d{2}$/.test(t.deadline)
  const deadlineMs = isPureDate
    ? new Date(`${t.deadline}T23:59:59`).getTime()
    : new Date(t.deadline).getTime()
  return deadlineMs < Date.now()
}
function progressText(t: TaskItem): string {
  return t.shotRequirements ? `${t.shotRequirements.length} 类拍摄` : ''
}

async function loadTasks() {
  computeTodayStr()
  loading.value = true
  try {
    const params: Record<string, any> = {}
    // 「今日」tab 直接由后端按 date 参数过滤，避免前端日期字符串匹配
    if (activeTab.value === 'today') params.date = todayStr.value
    const data = await fetchTasks(params)
    const list = data?.list || data?.data || data || []
    tasks.value = list
  } catch { /* 已在 request 层提示 */ }
  finally { loading.value = false }
}

function switchTab(t: 'today' | 'all') {
  activeTab.value = t
  loadTasks()
}

const visibleTasks = computed(() => {
  if (statusFilter.value === 'active') return tasks.value.filter(t => !isEnded(t))
  if (statusFilter.value === 'ended') return tasks.value.filter(t => isEnded(t))
  return tasks.value
})

function goDetail(id: string) {
  uni.navigateTo({ url: `/pages/assets/task-detail?id=${id}` })
}

onMounted(loadTasks)
</script>

<template>
  <view class="page">
    <view class="tabs">
      <view :class="['tab', { active: activeTab === 'today' }]" @click="switchTab('today')">今日</view>
      <view :class="['tab', { active: activeTab === 'all' }]" @click="switchTab('all')">全部</view>
    </view>

    <view class="status-chips">
      <view
        v-for="s in statusChips"
        :key="s.value"
        :class="['chip', { on: statusFilter === s.value }]"
        @click="statusFilter = s.value"
      ><text>{{ s.label }}</text></view>
    </view>

    <view v-if="loading" class="empty"><text>加载中...</text></view>
    <view v-else-if="visibleTasks.length === 0" class="empty">
      <text class="empty-emoji">📷</text>
      <text class="empty-text">{{ emptyText }}</text>
    </view>

    <view v-else class="task-list">
      <view v-for="t in visibleTasks" :key="t.id" class="task-card" @click="goDetail(t.id)">
        <view class="task-head">
          <text class="task-title">{{ t.title }}</text>
          <text v-if="isEnded(t)" class="tag-done">已结束</text>
          <text v-else class="tag-active">进行中</text>
        </view>
        <view class="task-meta">
          <text class="meta-text">{{ t.taskDate || '' }}</text>
          <text v-if="t.roomNames && t.roomNames.length" class="meta-text">房源：{{ t.roomNames.join(' / ') }}</text>
          <text v-if="t.roomTypeNames && t.roomTypeNames.length" class="meta-text">房型：{{ t.roomTypeNames.join(' / ') }}</text>
        </view>
        <view v-if="t.purposeTags && t.purposeTags.length" class="tags">
          <text v-for="tag in t.purposeTags" :key="tag" class="purpose-tag">{{ tag }}</text>
        </view>
        <view class="task-foot">
          <text class="foot-text">{{ progressText(t) }}</text>
          <text class="foot-arrow">›</text>
        </view>
      </view>
    </view>

  </view>
</template>

<style lang="scss" scoped>
.page {
  min-height: 100vh;
  background: #F5F6FA;
  /* H5 端系统原生 tabBar 为 fixed 需预留高度；App 端原生 tabBar 自动避让无需额外 padding */
  /* #ifndef APP-PLUS */
  padding-bottom: calc(112rpx + env(safe-area-inset-bottom));
  /* #endif */
}
.tabs { display: flex; background: #fff; padding: 16rpx 24rpx; gap: 16rpx; }
.tab { padding: 10rpx 32rpx; border-radius: 32rpx; font-size: 26rpx; color: #666; background: #F5F6FA; }
.tab.active { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.status-chips { display: flex; gap: 16rpx; padding: 16rpx 24rpx; background: #fff; border-top: 1rpx solid #F5F5F5; }
.chip { padding: 8rpx 28rpx; border-radius: 32rpx; font-size: 24rpx; color: #666; background: #F5F6FA; }
.chip.on { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.task-list { padding: 20rpx 24rpx; }
.task-card { background: #fff; border-radius: 20rpx; padding: 24rpx; margin-bottom: 20rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.task-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12rpx; }
.task-title { font-size: 30rpx; font-weight: 600; color: #1F1F1F; flex: 1; }
.tag-active, .tag-done, .tag-overdue { font-size: 22rpx; padding: 4rpx 16rpx; border-radius: 20rpx; }
.tag-active { color: #07C160; background: rgba(7,193,96,0.1); }
.tag-done { color: #999; background: #F0F0F0; }
.tag-overdue { color: #FA5151; background: rgba(250,81,81,0.1); }
.task-meta { display: flex; gap: 24rpx; margin-bottom: 12rpx; }
.meta-text { font-size: 24rpx; color: #888; }
.tags { display: flex; gap: 12rpx; margin-bottom: 12rpx; }
.purpose-tag { font-size: 22rpx; color: #4F6EF7; background: rgba(79,110,247,0.1); padding: 4rpx 16rpx; border-radius: 8rpx; }
.task-foot { display: flex; align-items: center; justify-content: space-between; border-top: 1rpx solid #F5F5F5; padding-top: 16rpx; }
.foot-text { font-size: 24rpx; color: #07C160; }
.foot-arrow { font-size: 28rpx; color: #ccc; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 200rpx 0; gap: 16rpx; color: #888; }
.empty-emoji { font-size: 80rpx; }
.empty-text { font-size: 28rpx; }
</style>
