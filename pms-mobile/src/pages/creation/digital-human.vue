<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { get, post } from '@/api/request'

/* ===================================================================
 * 数字人口播 — 从分镜方案驱动，6 步流程
 * Step 0: 选择分镜方案
 * Step 1: 编辑口播脚本
 * Step 2: 选择配音声音
 * Step 3: 选择视频素材（数字人背景）
 * Step 4: 提交任务
 * Step 5: 查看任务列表
 * =================================================================== */

// ========== 类型 ==========

interface CreationRecord {
  id: string
  title: string
  script?: string
  tags?: string[]
  createdAt?: string
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
  script?: string
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

/** 从方案的 script JSON 中提取完整口播文本 */
function extractFullScript(record: CreationRecord): string {
  if (!record.script) return ''
  try {
    const parsed = JSON.parse(record.script)
    if (parsed && Array.isArray(parsed.shots)) {
      // 将分镜脚本拼接为完整口播文本
      return parsed.shots
        .map((s: any) => s.script || '')
        .filter(Boolean)
        .join('\n\n')
    }
    return record.script
  } catch {
    return record.script
  }
}

/** 选择方案，提取脚本，进入下一步 */
function handlePlanSelect(item: CreationRecord) {
  selectedPlan.value = item
  scriptText.value = extractFullScript(item)
  step.value = 1
}

// ========== Step 1: 编辑口播脚本 ==========
const scriptText = ref('')

/** 进入下一步：选择声音 */
function goToVoiceStep() {
  if (!scriptText.value.trim()) {
    uni.showToast({ title: '请输入口播脚本', icon: 'none' })
    return
  }
  step.value = 2
}

// ========== Step 2: 选择声音 ==========
const voiceList = ref<VoiceOption[]>([])
const selectedVoice = ref<VoiceOption | null>(null)

/** 加载声音列表 */
async function loadVoiceOptions() {
  try {
    const data: any = await get('/api/voice/list')
    voiceList.value = data || []
  } catch {
    voiceList.value = []
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

/** 进入下一步：选择视频 */
function goToVideoStep() {
  if (!selectedVoice.value) {
    uni.showToast({ title: '请先选择配音声音', icon: 'none' })
    return
  }
  step.value = 3
}

// ========== Step 3: 选择视频素材 ==========
const selectedVideoUrl = ref('')
const selectedVideoName = ref('')

// ========== 素材库弹窗（过滤视频类型） ==========
const showAssetPicker = ref(false)
const assetList = ref<AssetItem[]>([])
const assetLoading = ref(false)

/** 打开素材库弹窗 */
async function openAssetPicker() {
  showAssetPicker.value = true
  assetLoading.value = true
  try {
    const data: any = await get('/api/assets')
    const all = data?.assets || data?.list || data?.data || data || []
    // 过滤出视频类型素材（type=video 或文件后缀为视频）
    assetList.value = all.filter((a: AssetItem) => {
      if (a.type === 'video') return true
      const url = (a.url || '').toLowerCase()
      const videoExts = ['.mp4', '.mov', '.avi', '.webm', '.mkv', '.flv']
      return videoExts.some((ext) => url.endsWith(ext))
    })
  } catch {
    assetList.value = []
  } finally {
    assetLoading.value = false
  }
}

/** 选中视频素材 */
function handleAssetSelect(asset: AssetItem) {
  selectedVideoUrl.value = asset.url || ''
  selectedVideoName.value = asset.name || asset.url?.split('/').pop() || '视频素材'
  showAssetPicker.value = false
}

/** 关闭素材弹窗 */
function closeAssetPicker() {
  showAssetPicker.value = false
}

// ========== Step 4: 提交 ==========
const submitting = ref(false)
const showSubtitle = ref(true)

/** 提交数字人口播任务 */
async function submitDigitalHuman() {
  if (!scriptText.value.trim()) {
    uni.showToast({ title: '请输入口播脚本', icon: 'none' })
    return
  }
  if (!selectedVoice.value) {
    uni.showToast({ title: '请选择配音声音', icon: 'none' })
    return
  }
  if (!selectedVideoUrl.value) {
    uni.showToast({ title: '请选择视频素材', icon: 'none' })
    return
  }

  submitting.value = true
  try {
    await post('/api/video/digital-human', {
      videoUrl: selectedVideoUrl.value,
      voiceId: selectedVoice.value.id,
      script: scriptText.value.trim(),
      showSubtitle: showSubtitle.value,
    })
    uni.showToast({ title: '任务提交成功', icon: 'success' })
    step.value = 5
    await loadTaskList()
  } catch (e: any) {
    uni.showToast({
      title: e?.msg || e?.message || '提交失败',
      icon: 'none',
    })
  } finally {
    submitting.value = false
  }
}

// ========== Step 5: 任务列表 ==========
const taskList = ref<TaskItem[]>([])
const taskLoading = ref(false)

/** 加载任务列表 */
async function loadTaskList() {
  taskLoading.value = true
  try {
    const result: any = await get('/api/video/tasks', { type: 'digital_human' })
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
  selectedVideoUrl.value = ''
  selectedVideoName.value = ''
  scriptText.value = ''
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
  <view class="digital-human-page">
    <scroll-view class="content-scroll" scroll-y :show-scrollbar="false">
      <!-- ========== Step 0: 选择分镜方案 ========== -->
      <view v-if="step === 0" class="step-content">
        <view class="step-header">
          <text class="step-title">选择分镜方案</text>
          <text class="step-desc">从已保存的分镜方案中选择一个制作数字人口播</text>
        </view>

        <view v-if="planList.length === 0 && !planLoading" class="empty-state">
          <text class="empty-icon">📝</text>
          <text class="empty-text">暂无已保存的分镜方案</text>
          <text class="empty-hint">请先在「创作中心」中创建分镜脚本方案</text>
        </view>

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

      <!-- ========== Step 1: 编辑口播脚本 ========== -->
      <view v-if="step === 1" class="step-content">
        <view class="back-row" @click="handleBack">
          <text class="back-arrow">←</text>
          <text class="back-text">返回选择方案</text>
        </view>

        <view class="selected-plan-card">
          <text class="selected-label">已选方案</text>
          <text class="selected-title">{{ selectedPlan?.title }}</text>
        </view>

        <view class="section-card">
          <view class="section-label">口播脚本</view>
          <textarea
            v-model="scriptText"
            class="script-textarea"
            placeholder="数字人口播脚本内容，可自由编辑..."
            :maxlength="3000"
            auto-height
          />
          <view class="char-count">{{ scriptText.length }}/3000</view>
        </view>

        <view class="submit-btn-area">
          <view class="submit-btn" @click="goToVoiceStep">
            <text>下一步：选择声音</text>
          </view>
        </view>
      </view>

      <!-- ========== Step 2: 选择声音 ========== -->
      <view v-if="step === 2" class="step-content">
        <view class="back-row" @click="handleBack">
          <text class="back-arrow">←</text>
          <text class="back-text">返回编辑脚本</text>
        </view>

        <view class="section-card">
          <view class="section-label">配音声音</view>
          <view class="option-row" @click="handleVoiceSelect">
            <text class="option-label">当前声音</text>
            <text class="option-value">
              {{ selectedVoice ? selectedVoice.name : '点击选择声音 →' }}
            </text>
          </view>
        </view>

        <view class="section-card">
          <view class="section-label">附加设置</view>
          <view class="option-row">
            <text class="option-label">显示字幕</text>
            <switch
              :checked="showSubtitle"
              @change="showSubtitle = !showSubtitle"
              color="#07C160"
            />
          </view>
        </view>

        <view class="submit-btn-area">
          <view class="submit-btn" @click="goToVideoStep">
            <text>下一步：选择视频</text>
          </view>
        </view>
      </view>

      <!-- ========== Step 3: 选择视频素材 ========== -->
      <view v-if="step === 3" class="step-content">
        <view class="back-row" @click="handleBack">
          <text class="back-arrow">←</text>
          <text class="back-text">返回选择声音</text>
        </view>

        <view class="step-header">
          <text class="step-title">视频来源</text>
          <text class="step-desc">选择数字人背景视频素材</text>
        </view>

        <view class="section-card">
          <view class="section-label">当前视频</view>
          <view v-if="selectedVideoUrl" class="video-preview-area">
            <view class="video-preview-placeholder">
              <text class="video-icon">🎬</text>
              <text class="video-name">{{ selectedVideoName }}</text>
            </view>
            <text class="video-url-text">{{ selectedVideoUrl }}</text>
          </view>
          <view v-else class="no-video-hint">
            <text class="no-video-text">尚未选择视频素材</text>
          </view>
          <view class="pick-video-btn" @click="openAssetPicker">
            <text>{{ selectedVideoUrl ? '更换视频素材' : '+ 从素材库选择视频' }}</text>
          </view>
        </view>

        <!-- 提交按钮 -->
        <view class="submit-btn-area">
          <view
            :class="['submit-btn', { disabled: submitting }]"
            @click="!submitting && submitDigitalHuman()"
          >
            <text>{{ submitting ? '正在提交...' : '生成数字人口播' }}</text>
          </view>
        </view>
      </view>

      <!-- ========== Step 5: 任务列表 ========== -->
      <view v-if="step === 5" class="step-content">
        <view class="step-header">
          <text class="step-title">任务列表</text>
          <text class="step-desc">查看数字人口播生成任务进度</text>
        </view>

        <view
          v-for="task in taskList"
          :key="task.id"
          class="task-card"
        >
          <view class="task-header-row">
            <text class="task-title">{{ task.title || '数字人口播任务' }}</text>
            <text :class="['task-status-tag', task.status || 'pending']">
              {{ statusLabel(task.status) }}
            </text>
          </view>
          <text v-if="task.script" class="task-script-preview">{{ task.script }}</text>
          <view v-if="task.resultUrl || task.videoUrl" class="task-result">
            <text class="result-link">{{ task.resultUrl || task.videoUrl }}</text>
            <text
              class="action-link"
              @click="uni.setClipboardData({ data: task.resultUrl || task.videoUrl })"
            >复制</text>
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
          <text class="picker-title">选择视频素材</text>
          <text class="picker-close" @click="closeAssetPicker">取消</text>
        </view>
        <scroll-view class="picker-scroll" scroll-y :show-scrollbar="false">
          <view v-if="assetLoading" class="loading-text">加载中...</view>
          <view v-else-if="assetList.length === 0" class="empty-state">
            <text class="empty-icon">🎬</text>
            <text class="empty-text">暂无视频素材</text>
            <text class="empty-hint">请先在素材库中上传视频</text>
          </view>
          <view v-else class="asset-list">
            <view
              v-for="asset in assetList"
              :key="asset.id"
              class="asset-list-item"
              @click="handleAssetSelect(asset)"
            >
              <view class="asset-list-icon">
                <text>🎬</text>
              </view>
              <view class="asset-list-info">
                <text class="asset-list-name">{{ asset.name || asset.url?.split('/').pop() || '视频素材' }}</text>
                <text class="asset-list-url">{{ asset.url }}</text>
              </view>
            </view>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<script lang="ts">
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

.digital-human-page {
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

/* ========== 卡片容器 ========== */
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

/* ========== 文本输入 ========== */
.script-textarea {
  width: 100%;
  min-height: 240rpx;
  padding: 20rpx;
  border-radius: $radius-md;
  background: $bg-main;
  font-size: 26rpx;
  color: $text-primary;
  line-height: 1.6;
  box-sizing: border-box;
}

.char-count {
  text-align: right;
  font-size: 22rpx;
  color: $text-tertiary;
  margin-top: 8rpx;
}

/* ========== 配置行 ========== */
.option-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16rpx 0;
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

/* ========== 视频预览 ========== */
.video-preview-area {
  margin-bottom: 16rpx;
}

.video-preview-placeholder {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 32rpx 24rpx;
  background: $bg-main;
  border-radius: $radius-md;
}

.video-icon {
  font-size: 40rpx;
}

.video-name {
  font-size: 26rpx;
  color: $text-primary;
  font-weight: 500;
}

.video-url-text {
  display: block;
  font-size: 22rpx;
  color: $info-blue;
  word-break: break-all;
  margin-top: 8rpx;
}

.no-video-hint {
  padding: 32rpx 0;
  text-align: center;
}

.no-video-text {
  font-size: 26rpx;
  color: $text-tertiary;
}

.pick-video-btn {
  width: 100%;
  padding: 22rpx 0;
  border: 2rpx dashed $primary-green;
  border-radius: $radius-md;
  text-align: center;
  background: rgba(7, 193, 96, 0.03);

  text {
    font-size: 26rpx;
    color: $primary-green;
    font-weight: 500;
  }

  &:active {
    background: rgba(7, 193, 96, 0.08);
  }
}

/* ========== 提交按钮 ========== */
.submit-btn-area {
  padding: 8rpx 0 16rpx;
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

/* ========== 任务历史 ========== */
.task-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.04);
}

.task-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8rpx;
}

.task-title {
  font-size: 26rpx;
  font-weight: 600;
  color: $text-primary;
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

.task-script-preview {
  display: block;
  font-size: 24rpx;
  color: $text-secondary;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.5;
}

.task-result {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-top: 12rpx;
  padding: 12rpx 16rpx;
  background: $bg-main;
  border-radius: $radius-sm;
}

.result-link {
  flex: 1;
  font-size: 24rpx;
  color: $info-blue;
  word-break: break-all;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-link {
  font-size: 24rpx;
  color: $primary-green;
  font-weight: 500;
  flex-shrink: 0;
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
  color: $text-secondary;
  font-weight: 500;
}

.picker-scroll {
  flex: 1;
  padding: 24rpx;
}

.asset-list {
  display: flex;
  flex-direction: column;
  gap: 12rpx;
}

.asset-list-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 16rpx 20rpx;
  background: $bg-main;
  border-radius: $radius-md;

  &:active {
    background: rgba(7, 193, 96, 0.06);
  }
}

.asset-list-icon {
  flex-shrink: 0;
  width: 64rpx;
  height: 64rpx;
  border-radius: $radius-sm;
  background: rgba(255, 149, 0, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.asset-list-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4rpx;
  overflow: hidden;
}

.asset-list-name {
  font-size: 26rpx;
  color: $text-primary;
  font-weight: 500;
}

.asset-list-url {
  font-size: 20rpx;
  color: $text-tertiary;
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
