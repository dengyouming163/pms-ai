<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchTasks, fetchTaskStats } from '@/api/modules/assets'

interface TaskItem { id: string; title: string; status: string; deadline?: string }
interface StatsRow { staffId: string; staffName: string; status: string; assetCount: number }

const tasks = ref<TaskItem[]>([])
const loading = ref(true)
const current = ref<TaskItem | null>(null)
const stats = ref<{ total: number; submitted: number; completed: number; overdue: number; rows: StatsRow[] } | null>(null)

const statusLabel: Record<string, string> = { pending: '未完成', submitted: '已提交', completed: '已完成' }

onMounted(async () => {
  loading.value = true
  try {
    const data: any = await fetchTasks()
    tasks.value = data?.list || data?.data || data || []
  } finally { loading.value = false }
})

async function openTask(t: TaskItem) {
  current.value = t
  stats.value = null
  try {
    const res: any = await fetchTaskStats(t.id)
    if (current.value?.id === t.id) {
      stats.value = res?.statistics || null
    }
  } catch {
    if (current.value?.id === t.id) {
      uni.showToast({ title: '统计加载失败', icon: 'none' })
      closeStats()
    }
  }
}
function closeStats() { current.value = null; stats.value = null }
const rate = computed(() => {
  if (!stats.value?.total) return 0
  return Math.min(100, Math.round(stats.value.completed / stats.value.total * 100))
})
</script>

<template>
  <view class="page">
    <view v-if="loading" class="empty"><text>加载中...</text></view>
    <view v-else-if="tasks.length === 0" class="empty"><text>暂无任务</text></view>
    <view v-else class="task-list">
      <view v-for="t in tasks" :key="t.id" class="task-card" @click="openTask(t)">
        <view class="task-head">
          <text class="task-title">{{ t.title }}</text>
          <text class="task-status">{{ (t.status === 'finished' || (t.deadline && new Date(t.deadline).getTime() < Date.now())) ? '已结束' : '进行中' }}</text>
        </view>
        <text class="task-hint">点击查看完成率</text>
      </view>
    </view>

    <!-- 统计弹层 -->
    <view v-if="current" class="overlay" @click="closeStats">
      <view class="sheet" @click.stop>
        <view class="sheet-head">
          <text class="sheet-title">{{ current.title }}</text>
          <text class="sheet-close" @click="closeStats">✕</text>
        </view>
        <view v-if="stats">
          <view class="rate-bar">
            <text class="rate-num">{{ rate }}%</text>
            <view class="bar"><view class="bar-inner" :style="{ width: rate + '%' }" /></view>
            <view class="rate-meta">
              <text>应执行 {{ stats.total }} · 已完成 {{ stats.completed }} · 已提交 {{ stats.submitted }} · 逾期 {{ stats.overdue }}</text>
            </view>
          </view>
          <view class="rows">
            <view v-for="r in stats.rows" :key="r.staffId" class="row">
              <text class="row-name">{{ r.staffName }}</text>
              <text :class="['row-status', r.status]">{{ statusLabel[r.status] || r.status }}（{{ r.assetCount }}张）</text>
            </view>
          </view>
        </view>
        <view v-else class="empty"><text>加载中...</text></view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.task-list { padding: 20rpx 24rpx; }
.task-card { background: #fff; border-radius: 20rpx; padding: 24rpx; margin-bottom: 20rpx; }
.task-head { display: flex; justify-content: space-between; align-items: center; }
.task-title { font-size: 30rpx; font-weight: 600; }
.task-status { font-size: 22rpx; color: #07C160; }
.task-hint { font-size: 24rpx; color: #999; margin-top: 8rpx; display: block; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: flex-end; }
.sheet { background: #fff; width: 100%; border-radius: 24rpx 24rpx 0 0; padding: 32rpx 24rpx calc(32rpx + env(safe-area-inset-bottom)); max-height: 70vh; overflow-y: auto; }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24rpx; }
.sheet-title { font-size: 32rpx; font-weight: 700; }
.sheet-close { font-size: 32rpx; color: #999; }
.rate-bar { margin-bottom: 24rpx; }
.rate-num { font-size: 48rpx; font-weight: 700; color: #07C160; }
.bar { height: 16rpx; background: #F0F0F0; border-radius: 8rpx; margin: 12rpx 0; overflow: hidden; }
.bar-inner { height: 100%; background: #07C160; border-radius: 8rpx; transition: width 0.3s; }
.rate-meta { font-size: 24rpx; color: #888; }
.rows { border-top: 1rpx solid #F5F5F5; }
.row { display: flex; justify-content: space-between; padding: 20rpx 0; border-bottom: 1rpx solid #F5F5F5; }
.row-name { font-size: 28rpx; }
.row-status.completed { color: #07C160; }
.row-status.submitted { color: #FF9500; }
.row-status.pending { color: #999; }
.empty { display: flex; justify-content: center; padding: 120rpx 0; color: #888; }
</style>
