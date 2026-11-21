<script setup lang="ts">
import { ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { fetchTaskDetail } from '@/api/modules/assets'
import { shotTypeLabel } from '@/constants/shotType'
import { SHOOT_GUIDE_SECTIONS } from '@/constants/shootGuide'

interface ShotReq {
  shotType: string
  mediaType?: 'image' | 'video'
  count: number
  guideText?: string
  movementText?: string
  avoidText?: string
  durationMin?: number | null
  durationMax?: number | null
  exampleImageUrl?: string
  exampleVideoUrl?: string
}

const taskId = ref('')
const task = ref<any>(null)
const shotRequirements = ref<ShotReq[]>([])
const mySubmission = ref<any>(null)
const loading = ref(true)
// 任务是否已截止（过 deadline 即锁定提交入口，后端拒绝逾期提交）
const overdue = ref(false)
// 拍摄规范教学卡折叠开关
const showGuide = ref(false)

// onLoad 先设 taskId → onShow 触发首次加载（仅 1 次请求）；从提交页返回时 onShow 再刷新
onLoad((options: any) => { taskId.value = options?.id || '' })
onShow(() => { if (taskId.value) load() })

async function load() {
  loading.value = true
  try {
    const data = await fetchTaskDetail(taskId.value)
    const t = data?.task || data || {}
    task.value = t
    shotRequirements.value = t.shotRequirements || []
    mySubmission.value = t.mySubmission || null
    // 截止校验：过 deadline 即锁定提交入口（后端拒绝逾期提交，完成态亦不可继续补充）
    const dl = t.deadline ? new Date(t.deadline).getTime() : 0
    overdue.value = dl > 0 && dl < Date.now()
  } catch {}
  finally { loading.value = false }
}

function goSubmit() {
  uni.navigateTo({ url: `/pages/assets/task-submit?id=${taskId.value}` })
}
</script>

<template>
  <view class="page">
    <view v-if="loading" class="empty"><text>加载中...</text></view>
    <view v-else-if="task">
      <view class="head">
        <text class="head-title">{{ task.title }}</text>
        <text class="head-date">{{ task.taskDate || '' }}</text>
        <text v-if="task.roomNames && task.roomNames.length" class="head-rooms">房源：{{ task.roomNames.join(' / ') }}</text>
        <text v-if="task.roomTypeNames && task.roomTypeNames.length" class="head-rooms">房型：{{ task.roomTypeNames.join(' / ') }}</text>
        <view v-if="task.purposeTags && task.purposeTags.length" class="tags">
          <text v-for="tag in task.purposeTags" :key="tag" class="purpose-tag">{{ tag }}</text>
        </view>
        <text v-if="task.guideText" class="head-guide">{{ task.guideText }}</text>
      </view>

      <view class="guide-card">
        <view class="guide-head" @click="showGuide = !showGuide">
          <text class="guide-title">📖 拍摄规范（新手先看）</text>
          <text class="guide-arrow">{{ showGuide ? '▾' : '▸' }}</text>
        </view>
        <view v-if="showGuide" class="guide-body">
          <view v-for="sec in SHOOT_GUIDE_SECTIONS" :key="sec.title" class="guide-sec">
            <text class="guide-sec-title">{{ sec.title }}</text>
            <text v-for="it in sec.items" :key="it" class="guide-item">· {{ it }}</text>
          </view>
        </view>
      </view>

      <view class="section-title">拍摄清单</view>
      <view class="shot-list">
        <view v-for="(req, i) in shotRequirements" :key="i" class="shot-card">
          <view class="shot-top">
            <text class="shot-index">{{ i + 1 }}</text>
            <text class="shot-type">{{ shotTypeLabel(req.shotType) }}</text>
            <text :class="['media-badge', (req.mediaType || 'image') === 'video' ? 'video' : 'image']">{{ (req.mediaType || 'image') === 'video' ? '视频' : '图片' }}</text>
            <text class="shot-count">需 {{ req.count }} {{ (req.mediaType || 'image') === 'video' ? '条' : '张' }}</text>
          </view>
          <view v-if="req.movementText" class="sop-line">运镜：{{ req.movementText }}</view>
          <view v-if="req.avoidText" class="sop-line sop-avoid">禁拍：{{ req.avoidText }}</view>
          <view v-if="(req.mediaType || 'image') === 'video' && req.durationMin != null && req.durationMax != null" class="sop-line">
            建议时长：{{ req.durationMin }}~{{ req.durationMax }} 秒
          </view>
          <view v-if="req.exampleVideoUrl" class="shot-example">
            <video :src="req.exampleVideoUrl" class="shot-video" controls />
            <text v-if="req.guideText" class="shot-guide">{{ req.guideText }}</text>
          </view>
          <view v-else-if="req.exampleImageUrl" class="shot-example">
            <image :src="req.exampleImageUrl" mode="aspectFill" class="shot-img" />
            <text class="shot-guide">{{ req.guideText || '参考示例' }}</text>
          </view>
          <text v-else-if="req.guideText" class="shot-guide-only">{{ req.guideText }}</text>
        </view>
      </view>

      <view v-if="mySubmission" class="submit-state">
        <text>{{ mySubmission.status === 'completed' ? '✅ 已完成打卡' : '⏳ 已提交，待补足' }}（{{ mySubmission.assetCount }} 张）</text>
      </view>

      <view class="bottom-bar">
        <view class="submit-btn" :class="{ disabled: overdue }" @click="!overdue && goSubmit()">
          <text class="submit-btn-text">{{ overdue ? '任务已截止' : (mySubmission?.status === 'completed' ? '继续补充素材' : '去打卡') }}</text>
        </view>
      </view>
    </view>
    <view v-else class="empty"><text>任务不存在或已删除</text></view>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; padding-bottom: 140rpx; }
.head { background: #fff; padding: 28rpx 24rpx; display: flex; flex-direction: column; gap: 12rpx; }
.head-title { font-size: 34rpx; font-weight: 700; color: #1F1F1F; }
.head-date, .head-rooms { font-size: 26rpx; color: #888; }
.tags { display: flex; gap: 12rpx; }
.purpose-tag { font-size: 22rpx; color: #4F6EF7; background: rgba(79,110,247,0.1); padding: 4rpx 16rpx; border-radius: 8rpx; }
.head-guide { font-size: 26rpx; color: #666; background: #F9FAFB; border-radius: 12rpx; padding: 16rpx; }
.section-title { padding: 24rpx 24rpx 8rpx; font-size: 28rpx; font-weight: 600; color: #333; }
.shot-list { padding: 0 24rpx; }
.shot-card { background: #fff; border-radius: 20rpx; padding: 20rpx; margin-bottom: 16rpx; }
.shot-top { display: flex; align-items: center; gap: 16rpx; margin-bottom: 12rpx; }
.shot-index { width: 40rpx; height: 40rpx; border-radius: 20rpx; background: #07C160; color: #fff; font-size: 22rpx; display: flex; align-items: center; justify-content: center; }
.shot-type { font-size: 28rpx; font-weight: 600; flex: 1; }
.shot-count { font-size: 24rpx; color: #FA5151; }
.shot-example { display: flex; gap: 16rpx; align-items: center; }
.shot-img { width: 160rpx; height: 120rpx; border-radius: 12rpx; background: #F0F0F0; flex-shrink: 0; }
.shot-guide { font-size: 24rpx; color: #666; flex: 1; }
.shot-guide-only { font-size: 24rpx; color: #666; }
.submit-state { margin: 24rpx; padding: 20rpx; background: rgba(7,193,96,0.08); border-radius: 16rpx; text-align: center; color: #07C160; font-size: 26rpx; }
.bottom-bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 20rpx 24rpx calc(20rpx + env(safe-area-inset-bottom)); background: #fff; box-shadow: 0 -4rpx 20rpx rgba(0,0,0,0.05); }
.submit-btn { background: #07C160; border-radius: 44rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.submit-btn:active { background: #06AD56; }
.submit-btn.disabled { opacity: 0.5; }
.submit-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }
.empty { display: flex; justify-content: center; padding: 200rpx 0; color: #888; }
.guide-card { margin: 20rpx 24rpx 4rpx; background: #fff; border-radius: 16rpx; padding: 20rpx 24rpx; }
.guide-head { display: flex; justify-content: space-between; align-items: center; }
.guide-title { font-size: 28rpx; font-weight: 600; }
.guide-arrow { color: #999; font-size: 24rpx; }
.guide-body { margin-top: 12rpx; }
.guide-sec { margin-bottom: 12rpx; }
.guide-sec-title { font-size: 24rpx; font-weight: 600; color: #4F6EF7; display: block; margin-bottom: 4rpx; }
.guide-item { display: block; font-size: 24rpx; color: #666; line-height: 1.7; }
.media-badge { font-size: 20rpx; padding: 2rpx 12rpx; border-radius: 8rpx; }
.media-badge.image { color: #4F6EF7; background: rgba(79,110,247,0.1); }
.media-badge.video { color: #07C160; background: rgba(7,193,96,0.1); }
.sop-line { font-size: 24rpx; color: #666; margin: 8rpx 0 0 56rpx; }
.sop-avoid { color: #D35A5A; }
.shot-video { width: 100%; height: 320rpx; border-radius: 12rpx; margin-top: 12rpx; }
</style>
