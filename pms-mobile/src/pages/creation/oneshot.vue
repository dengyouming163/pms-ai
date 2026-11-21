<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { get, post } from '@/api/request'

/* ===================================================================
 * 一键成片 — 从分镜方案驱动，5 步流程
 * Step 0: 选择分镜方案
 * Step 1: 分镜配置（素材分配）
 * Step 2: 声音 & 字幕配置
 * Step 3: 提交任务
 * Step 4: 查看任务列表
 * =================================================================== */

// ========== 类型 ==========

interface CreationRecord {
  id: string
  title: string
  script?: string   // JSON 字符串，包含 ShotPlan
  tags?: string[]
  createdAt?: string
}

interface ShotItem {
  index: number
  label: string
  script: string
  duration: number
  media?: string      // 分配的素材 URL
}

interface ShotPlan {
  title: string
  shots: ShotItem[]
}

interface VoiceOption {
  id: string
  name: string
  avatar?: string
}

interface AssetItem {
  id: string
  url: string
  name?: string
  type?: string
  thumbnail?: string
}

interface TaskItem {
  id: string
  title?: string
  name?: string
  status?: string
  resultUrl?: string
  videoUrl?: string
  createdAt?: string
}

// ========== 步骤状态 ==========
const step = ref(0)

// ========== Step 0: 选择分镜方案 ==========
const planList = ref<CreationRecord[]>([])
const selectedPlan = ref<CreationRecord | null>(null)
const planLoading = ref(false)

/** 加载分镜方案列表 */
async function loadPlanList() {
  planLoading.value = true
  try {
    const result: any = await get('/api/creation-records', { type: 'copy', limit: 50 })
    planList.value = result?.list || result?.data || result || []
  } catch {
    planList.value = []
  } finally {
    planLoading.value = false
  }
}

/** 解析方案 JSON → ShotPlan */
function parsePlan(record: CreationRecord): ShotPlan | null {
  if (!record.script) return null
  try {
    const parsed = JSON.parse(record.script)
    if (parsed && parsed.title && Array.isArray(parsed.shots)) {
      return parsed as ShotPlan
    }
    return null
  } catch {
    return null
  }
}

/** 选择方案，解析分镜，进入下一步 */
function handlePlanSelect(item: CreationRecord) {
  selectedPlan.value = item
  const plan = parsePlan(item)
  if (plan) {
    // 初始化分镜列表（深拷贝）
    editableShots.value = plan.shots.map((s) => ({ ...s, media: s.media || '' }))
  } else {
    // 兼容旧格式：没有 JSON 结构的纯文本脚本
    editableShots.value = [
      { index: 1, label: '全文脚本', script: item.script || '', duration: 15, media: '' },
    ]
  }
  step.value = 1
}

// ========== Step 1: 分镜配置 ==========
const editableShots = ref<ShotItem[]>([])

// ========== 素材库弹窗 ==========
const showAssetPicker = ref(false)
const assetList = ref<AssetItem[]>([])
const assetLoading = ref(false)
const currentShotIndex = ref(-1)  // 当前正在选素材的分镜 index

/** 打开素材库弹窗 */
async function openAssetPicker(shotIdx: number) {
  currentShotIndex.value = shotIdx
  showAssetPicker.value = true
  assetLoading.value = true
  try {
    const data: any = await get('/api/assets')
    assetList.value = data?.assets || data?.list || data?.data || data || []
  } catch {
    assetList.value = []
  } finally {
    assetLoading.value = false
  }
}

/** 选中素材 */
function handleAssetSelect(asset: AssetItem) {
  const url = asset.url || ''
  if (currentShotIndex.value >= 0 && currentShotIndex.value < editableShots.value.length) {
    editableShots.value[currentShotIndex.value].media = url
  }
  showAssetPicker.value = false
}

/** 关闭素材弹窗 */
function closeAssetPicker() {
  showAssetPicker.value = false
  currentShotIndex.value = -1
}

// ========== Step 2: 声音 & 字幕 ==========
const voiceList = ref<VoiceOption[]>([])
const selectedVoice = ref<VoiceOption | null>(null)
const showSubtitle = ref(true)
const subtitleFontSize = ref(28)
const voiceLoading = ref(false)

/** 加载声音列表 */
async function loadVoiceOptions() {
  voiceLoading.value = true
  try {
    const data: any = await get('/api/voice/list')
    voiceList.value = data || []
  } catch {
    voiceList.value = []
  } finally {
    voiceLoading.value = false
  }
}

/** 选择声音 */
function handleVoiceSelect() {
  if (voiceList.value.length === 0) {
    uni.showToast({ title: '暂无可选声音', icon: 'none' })
    return
  }
  const names = voiceList.value.map((v) => v.name)
  uni.showActionSheet({
    itemList: names,
    success: (res) => {
      selectedVoice.value = voiceList.value[res.tapIndex]
    },
  })
}

/** 进入声音 & 字幕配置步骤 */
function goToVoiceStep() {
  // 检查素材是否全部配置
  const missingMedia = editableShots.value.some((s) => !s.media)
  if (missingMedia) {
    uni.showToast({ title: '请为所有分镜配置素材', icon: 'none' })
    return
  }
  step.value = 2
}

// ========== Step 3: 提交 ==========
const oneshotSubmitting = ref(false)

/** 提交一键成片任务 */
async function submitOneShot() {
  if (!selectedVoice.value) {
    uni.showToast({ title: '请先选择配音声音', icon: 'none' })
    return
  }

  oneshotSubmitting.value = true
  try {
    const payload = {
      voiceId: selectedVoice.value.id,
      shots: editableShots.value.map((s) => ({
        index: s.index,
        media: s.media,
        script: s.script,
        duration: s.duration,
      })),
      subtitleConfig: {
        show: showSubtitle.value,
        fontSize: subtitleFontSize.value,
      },
      title: selectedPlan.value?.title || '一键成片',
    }

    await post('/api/mediakit/batch-submit', payload)
    uni.showToast({ title: '任务已提交', icon: 'success' })
    step.value = 4
    await loadTaskList()
  } catch (e: any) {
    uni.showToast({
      title: e?.msg || e?.message || '提交失败',
      icon: 'none',
    })
  } finally {
    oneshotSubmitting.value = false
  }
}

// ========== Step 4: 任务列表 ==========
const taskList = ref<TaskItem[]>([])
const taskLoading = ref(false)

/** 加载任务列表 */
async function loadTaskList() {
  taskLoading.value = true
  try {
    const result: any = await get('/api/video/tasks')
    taskList.value = result?.list || result?.data || result || []
  } catch {
    taskList.value = []
  } finally {
    taskLoading.value = false
  }
}

// ========== 导航 ==========
function handleBack() {
  if (step.value > 0) {
    step.value -= 1
  }
}

function handleBackToPlanSelect() {
  step.value = 0
  selectedPlan.value = null
  selectedVoice.value = null
  editableShots.value = []
}

// ========== 生命周期 ==========
onMounted(async () => {
  await Promise.all([loadPlanList(), loadVoiceOptions()])

  // 处理 planId 查询参数（从 studio 传入）
  const pages = getCurrentPages()
  const currentPage = pages[pages.length - 1] as any
  const planId = currentPage?.$page?.options?.planId || currentPage?.options?.planId
  if (planId && planList.value.length > 0) {
    const target = planList.value.find((p) => p.id === planId)
    if (target) {
      handlePlanSelect(target)
    }
  }
})
</script>

<template>
  <view class="oneshot-page">
    <scroll-view class="content-scroll" scroll-y :show-scrollbar="false">
      <!-- ========== Step 0: 选择分镜方案 ========== -->
      <view v-if="step === 0" class="step-content">
        <view class="step-header">
          <text class="step-title">选择分镜方案</text>
          <text class="step-desc">从已保存的分镜方案中选择一个进行一键成片</text>
        </view>

        <!-- 空状态 -->
        <view v-if="planList.length === 0 && !planLoading" class="empty-state">
          <text class="empty-icon">📝</text>
          <text class="empty-text">暂无已保存的分镜方案</text>
          <text class="empty-hint">请先在「创作中心」中创建分镜脚本方案</text>
        </view>

        <!-- 方案卡片列表 -->
        <view
          v-for="item in planList"
          :key="item.id"
          :class="['plan-card', { selected: selectedPlan?.id === item.id }]"
          @click="handlePlanSelect(item)"
        >
          <view class="plan-card-body">
            <text class="plan-card-title">{{ item.title || '未命名方案' }}</text>
            <text class="plan-card-preview">
              {{ item.script ? item.script.slice(0, 100) : '无脚本内容' }}
            </text>
            <text class="plan-card-date">{{ item.createdAt || '' }}</text>
          </view>
          <text class="plan-card-arrow">›</text>
        </view>

        <view v-if="planLoading" class="loading-text">加载中...</view>
      </view>

      <!-- ========== Step 1: 分镜配置（素材分配） ========== -->
      <view v-if="step === 1" class="step-content">
        <view class="back-row" @click="handleBack">
          <text class="back-arrow">←</text>
          <text class="back-text">返回选择方案</text>
        </view>

        <!-- 已选方案摘要 -->
        <view class="selected-plan-card">
          <text class="selected-label">已选方案</text>
          <text class="selected-title">{{ selectedPlan?.title }}</text>
        </view>

        <!-- 分镜列表 -->
        <view class="step-header">
          <text class="step-title-sm">配置分镜素材</text>
          <text class="step-desc">为每个分镜选择对应的图片或视频素材</text>
        </view>

        <view
          v-for="(shot, idx) in editableShots"
          :key="shot.index"
          class="shot-config-card"
        >
          <view class="shot-config-header">
            <view class="shot-config-index">
              <text class="shot-config-num">{{ shot.index }}</text>
            </view>
            <text class="shot-config-label">{{ shot.label }}</text>
            <text class="shot-config-duration">{{ shot.duration }}s</text>
          </view>
          <text class="shot-config-script">{{ shot.script }}</text>

          <!-- 素材预览 / 选择按钮 -->
          <view class="shot-media-row">
            <view v-if="shot.media" class="shot-media-preview">
              <image
                v-if="isImageUrl(shot.media)"
                :src="shot.media"
                mode="aspectFill"
                class="media-thumb"
              />
              <text v-else class="media-url-text">{{ shot.media }}</text>
            </view>
            <view class="pick-media-btn" @click="openAssetPicker(idx)">
              <text>{{ shot.media ? '更换素材' : '+ 选择素材' }}</text>
            </view>
          </view>
        </view>

        <!-- 下一步按钮 -->
        <view class="submit-btn-area">
          <view class="submit-btn" @click="goToVoiceStep">
            <text>下一步：配置声音</text>
          </view>
        </view>
      </view>

      <!-- ========== Step 2: 声音 & 字幕 ========== -->
      <view v-if="step === 2" class="step-content">
        <view class="back-row" @click="handleBack">
          <text class="back-arrow">←</text>
          <text class="back-text">返回配置素材</text>
        </view>

        <view class="step-header">
          <text class="step-title">声音 & 字幕配置</text>
        </view>

        <!-- 声音选择 -->
        <view class="section-card">
          <view class="section-label">配音声音</view>
          <view class="option-row" @click="handleVoiceSelect">
            <text class="option-label">当前声音</text>
            <text class="option-value">
              {{ selectedVoice ? selectedVoice.name : '点击选择声音 →' }}
            </text>
          </view>
        </view>

        <!-- 字幕配置 -->
        <view class="section-card">
          <view class="section-label">字幕设置</view>
          <view class="option-row">
            <text class="option-label">显示字幕</text>
            <switch
              :checked="showSubtitle"
              @change="showSubtitle = !showSubtitle"
              color="#07C160"
            />
          </view>
          <view v-if="showSubtitle" class="option-row">
            <text class="option-label">字幕字号</text>
            <view class="font-size-control">
              <text
                class="font-btn"
                @click="subtitleFontSize = Math.max(20, subtitleFontSize - 2)"
              >-</text>
              <text class="font-value">{{ subtitleFontSize }}px</text>
              <text
                class="font-btn"
                @click="subtitleFontSize = Math.min(48, subtitleFontSize + 2)"
              >+</text>
            </view>
          </view>
        </view>

        <!-- 提交按钮 -->
        <view class="submit-btn-area">
          <view
            :class="['submit-btn', { disabled: oneshotSubmitting }]"
            @click="!oneshotSubmitting && submitOneShot()"
          >
            <text>{{ oneshotSubmitting ? '正在提交...' : '一键成片' }}</text>
          </view>
        </view>
      </view>

      <!-- ========== Step 4: 任务列表 ========== -->
      <view v-if="step === 4" class="step-content">
        <view class="step-header">
          <text class="step-title">任务列表</text>
          <text class="step-desc">查看视频生成任务进度</text>
        </view>

        <view
          v-for="task in taskList"
          :key="task.id"
          class="task-card"
        >
          <view class="task-info">
            <text class="task-title">{{ task.title || task.name || '视频生成任务' }}</text>
            <text class="task-id">#{{ task.id?.slice(0, 8) }}</text>
          </view>
          <view class="task-meta">
            <text :class="['task-status-tag', task.status || 'pending']">
              {{ statusLabel(task.status) }}
            </text>
            <text class="task-time">{{ task.createdAt || '' }}</text>
          </view>
          <view v-if="task.resultUrl || task.videoUrl" class="task-result">
            <text class="result-link">{{ task.resultUrl || task.videoUrl }}</text>
          </view>
        </view>

        <view v-if="taskList.length === 0 && !taskLoading" class="empty-state">
          <text class="empty-text">暂无任务记录</text>
        </view>

        <view v-if="taskLoading" class="loading-text">加载中...</view>

        <view class="submit-btn-area" style="margin-top: 32rpx;">
          <view class="outline-btn" @click="handleBackToPlanSelect">
            <text>创建新任务</text>
          </view>
        </view>
      </view>

      <!-- 底部留白 -->
      <view class="bottom-spacer" />
    </scroll-view>

    <!-- ========== 素材选择弹窗 ========== -->
    <view v-if="showAssetPicker" class="asset-picker-overlay" @click="closeAssetPicker">
      <view class="asset-picker-sheet" @click.stop>
        <view class="picker-header">
          <text class="picker-title">选择素材</text>
          <text class="picker-close" @click="closeAssetPicker">完成</text>
        </view>
        <scroll-view class="picker-scroll" scroll-y :show-scrollbar="false">
          <view v-if="assetLoading" class="loading-text">加载中...</view>
          <view v-else-if="assetList.length === 0" class="empty-state">
            <text class="empty-text">暂无素材</text>
          </view>
          <view v-else class="asset-grid">
            <view
              v-for="asset in assetList"
              :key="asset.id"
              class="asset-item"
              @click="handleAssetSelect(asset)"
            >
              <image
                v-if="isImageUrl(asset.url || '')"
                :src="asset.url"
                mode="aspectFill"
                class="asset-thumb"
              />
              <view v-else class="asset-file">
                <text class="asset-file-icon">📄</text>
              </view>
              <text class="asset-name">{{ asset.name || asset.url?.split('/').pop() || '素材' }}</text>
            </view>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<script lang="ts">
/** 判断 URL 是否为图片格式 */
function isImageUrl(url: string): boolean {
  if (!url) return false
  const ext = url.split('.').pop()?.toLowerCase() || ''
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)
}

/** 任务状态中文标签 */
function statusLabel(status?: string): string {
  switch (status) {
    case 'done': return '已完成'
    case 'processing': return '处理中'
    case 'failed': return '失败'
    default: return '等待中'
  }
}
</script>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.oneshot-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: $bg-main;
}

.content-scroll {
  flex: 1;
  height: 0;
  overflow: hidden;
}

.step-content {
  padding: 24rpx;
}

/* ========== 步骤头部 ========== */
.step-header {
  padding: 16rpx 0 24rpx;
}

.step-title {
  display: block;
  font-size: 36rpx;
  font-weight: 700;
  color: $text-primary;
}

.step-title-sm {
  display: block;
  font-size: 28rpx;
  font-weight: 700;
  color: $text-primary;
}

.step-desc {
  display: block;
  font-size: 26rpx;
  color: $text-tertiary;
  margin-top: 8rpx;
}

/* ========== 返回行 ========== */
.back-row {
  display: flex;
  align-items: center;
  gap: 8rpx;
  padding: 16rpx 0 24rpx;
}

.back-arrow {
  font-size: 28rpx;
  color: $primary-green;
}

.back-text {
  font-size: 26rpx;
  color: $primary-green;
}

/* ========== 方案选择卡片 ========== */
.plan-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 16rpx;
  display: flex;
  align-items: center;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.04);
  transition: background 0.15s;

  &.selected {
    background: rgba(7, 193, 96, 0.06);
    border: 2rpx solid $primary-green;
  }
}

.plan-card-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
  overflow: hidden;
}

.plan-card-title {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
}

.plan-card-preview {
  font-size: 24rpx;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-card-date {
  font-size: 22rpx;
  color: $text-tertiary;
}

.plan-card-arrow {
  font-size: 28rpx;
  color: #d0d0d0;
  margin-left: 12rpx;
}

/* ========== 已选方案摘要 ========== */
.selected-plan-card {
  background: rgba(7, 193, 96, 0.05);
  border: 2rpx solid rgba(7, 193, 96, 0.2);
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.selected-label {
  font-size: 22rpx;
  color: $primary-green;
  font-weight: 600;
}

.selected-title {
  display: block;
  font-size: 28rpx;
  font-weight: 700;
  color: $text-primary;
  margin-top: 8rpx;
}

/* ========== 分镜配置卡片 ========== */
.shot-config-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 20rpx 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.04);
}

.shot-config-header {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 10rpx;
}

.shot-config-index {
  width: 36rpx;
  height: 36rpx;
  border-radius: 50%;
  background: $primary-green;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.shot-config-num {
  font-size: 20rpx;
  color: #fff;
  font-weight: 700;
}

.shot-config-label {
  font-size: 24rpx;
  font-weight: 600;
  color: $text-primary;
  flex: 1;
}

.shot-config-duration {
  font-size: 20rpx;
  padding: 2rpx 12rpx;
  border-radius: 10rpx;
  background: rgba(7, 193, 96, 0.1);
  color: $primary-green;
  font-weight: 500;
}

.shot-config-script {
  display: block;
  font-size: 22rpx;
  color: $text-secondary;
  line-height: 1.5;
  margin-bottom: 12rpx;
}

.shot-media-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.shot-media-preview {
  flex: 1;
  min-width: 0;
}

.media-thumb {
  width: 100rpx;
  height: 100rpx;
  border-radius: $radius-sm;
  background: #f0f0f0;
}

.media-url-text {
  font-size: 20rpx;
  color: $info-blue;
  word-break: break-all;
}

.pick-media-btn {
  flex-shrink: 0;
  padding: 12rpx 24rpx;
  border-radius: $radius-md;
  border: 2rpx solid $primary-green;
  background: #fff;

  text {
    font-size: 22rpx;
    color: $primary-green;
    font-weight: 500;
  }

  &:active {
    background: rgba(7, 193, 96, 0.05);
  }
}

/* ========== 通用卡片 ========== */
.section-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 20rpx;
  box-shadow: $shadow-card;
}

.section-label {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 16rpx;
}

/* ========== 配置行 ========== */
.option-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12rpx 0;

  & + & {
    border-top: 2rpx solid #f5f5f5;
  }
}

.option-label {
  font-size: 26rpx;
  color: $text-secondary;
}

.option-value {
  font-size: 26rpx;
  color: $primary-green;
  font-weight: 500;
}

/* ========== 字号控制器 ========== */
.font-size-control {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.font-btn {
  width: 48rpx;
  height: 48rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-main;
  border-radius: $radius-sm;
  font-size: 32rpx;
  color: $text-primary;
  font-weight: 600;
}

.font-value {
  font-size: 26rpx;
  color: $text-primary;
  font-weight: 500;
  min-width: 60rpx;
  text-align: center;
}

/* ========== 提交按钮 ========== */
.submit-btn-area {
  padding: 8rpx 0;
}

.submit-btn {
  width: 100%;
  padding: 28rpx 0;
  background: $gradient-primary;
  border-radius: $radius-md;
  text-align: center;
  box-shadow: 0 6rpx 24rpx rgba(7, 193, 96, 0.3);

  text {
    font-size: 32rpx;
    font-weight: 600;
    color: #fff;
  }

  &.disabled {
    opacity: 0.6;
  }

  &:active {
    opacity: 0.85;
  }
}

.outline-btn {
  width: 100%;
  padding: 28rpx 0;
  border: 2rpx solid $primary-green;
  border-radius: $radius-md;
  text-align: center;
  background: #fff;

  text {
    font-size: 32rpx;
    font-weight: 600;
    color: $primary-green;
  }

  &:active {
    background: rgba(7, 193, 96, 0.05);
  }
}

/* ========== 任务卡片 ========== */
.task-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.04);
}

.task-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.task-title {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
  flex: 1;
}

.task-id {
  font-size: 22rpx;
  color: $text-tertiary;
}

.task-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12rpx;
}

.task-status-tag {
  font-size: 22rpx;
  padding: 6rpx 16rpx;
  border-radius: 12rpx;

  &.done {
    color: $primary-green;
    background: rgba(7, 193, 96, 0.1);
  }

  &.processing {
    color: $warning-orange;
    background: rgba(255, 149, 0, 0.1);
  }

  &.failed {
    color: $price-red;
    background: rgba(250, 81, 81, 0.1);
  }

  &.pending {
    color: $text-tertiary;
    background: #f5f5f5;
  }
}

.task-time {
  font-size: 22rpx;
  color: $text-tertiary;
}

.task-result {
  margin-top: 12rpx;
  padding: 12rpx 16rpx;
  background: $bg-main;
  border-radius: $radius-sm;
}

.result-link {
  font-size: 24rpx;
  color: $info-blue;
  word-break: break-all;
}

/* ========== 素材选择弹窗 ========== */
.asset-picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.asset-picker-sheet {
  background: #fff;
  border-radius: $radius-lg $radius-lg 0 0;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  padding-bottom: constant(safe-area-inset-bottom);
  padding-bottom: env(safe-area-inset-bottom);
}

.picker-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24rpx;
  border-bottom: 2rpx solid #f0f0f0;
}

.picker-title {
  font-size: 30rpx;
  font-weight: 700;
  color: $text-primary;
}

.picker-close {
  font-size: 26rpx;
  color: $primary-green;
  font-weight: 500;
}

.picker-scroll {
  flex: 1;
  padding: 24rpx;
}

.asset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.asset-item {
  width: calc(33.33% - 12rpx);
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  cursor: pointer;
}

.asset-thumb {
  width: 100%;
  aspect-ratio: 1;
  border-radius: $radius-md;
  background: #f0f0f0;
}

.asset-file {
  width: 100%;
  aspect-ratio: 1;
  border-radius: $radius-md;
  background: $bg-main;
  display: flex;
  align-items: center;
  justify-content: center;
}

.asset-file-icon {
  font-size: 40rpx;
}

.asset-name {
  font-size: 20rpx;
  color: $text-secondary;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ========== 空状态 / 加载 ========== */
.empty-state {
  text-align: center;
  padding: 80rpx 0;
}

.empty-icon {
  font-size: 64rpx;
}

.empty-text {
  display: block;
  font-size: 28rpx;
  color: $text-secondary;
  margin-top: 16rpx;
}

.empty-hint {
  display: block;
  font-size: 24rpx;
  color: $text-tertiary;
  margin-top: 8rpx;
}

.loading-text {
  text-align: center;
  font-size: 26rpx;
  color: $text-tertiary;
  padding: 32rpx 0;
}

.bottom-spacer {
  height: 48rpx;
}
</style>
