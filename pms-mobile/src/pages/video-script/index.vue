<script setup lang="ts">
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { useVideoScriptStore } from '@/stores/video-script'
import type { VideoScriptInput, HistoryItem } from '@/types/video-script'
import InputWizard from '@/components/video-script/InputWizard.vue'
import ProgressView from '@/components/video-script/ProgressView.vue'
import ConfirmPanel from '@/components/video-script/ConfirmPanel.vue'
import ScriptCard from '@/components/video-script/ScriptCard.vue'
import HistoryPanel from '@/components/video-script/HistoryPanel.vue'

const store = useVideoScriptStore()
const showHistory = ref(false)

// 每次进入页面重置到输入向导（reset 保留 input 与偏好，不会清空预填），
// 避免二次进入时残留上一次的 done/confirm 态
onLoad(() => {
  store.reset()
})

const isProgress = computed(() =>
  ['starting', 'stage2', 'stage3_4', 'finalizing'].includes(store.phase),
)
const isConfirm = computed(() =>
  ['confirm1', 'confirm2', 'confirm3'].includes(store.phase),
)

function handleStart(input: VideoScriptInput) {
  store.start(input)
}

function handleRetry() {
  store.reset()
}

async function openHistory() {
  showHistory.value = true
  await store.loadHistory()
}

function handleOpenHistoryItem(item: HistoryItem) {
  store.projectId = item.output?.final_package?.project_info?.project_id || ''
  store.output = item.output || {}
  store.finalPackage = item.output?.final_package || null
  store.phase = 'done'
  showHistory.value = false
}
</script>

<template>
  <view class="vs-page">
    <!-- 输入向导 -->
    <InputWizard v-if="store.phase === 'idle'" @start="handleStart" />

    <!-- 生成进度 -->
    <ProgressView v-else-if="isProgress" />

    <!-- 确认节点 -->
    <ConfirmPanel v-else-if="isConfirm" />

    <!-- 脚本卡输出 -->
    <ScriptCard v-else-if="store.phase === 'done'" />

    <!-- 错误 -->
    <view v-else-if="store.phase === 'error'" class="vs-error">
      <text class="vs-error-icon">😵</text>
      <text class="vs-error-title">生成遇到点问题</text>
      <text class="vs-error-text">{{ store.error || '请稍后重试' }}</text>
      <view class="vs-error-btn" @click="handleRetry">
        <text>重新开始</text>
      </view>
    </view>

    <!-- 历史入口（仅输入态显示） -->
    <view v-if="store.phase === 'idle'" class="vs-history-entry" @click="openHistory">
      <text>📜 历史脚本</text>
    </view>

    <!-- 历史面板 -->
    <HistoryPanel
      :visible="showHistory"
      @close="showHistory = false"
      @open="handleOpenHistoryItem"
    />
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.vs-page { min-height: 100vh; background: $bg-main; }

.vs-error {
  min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 16rpx; padding: 0 60rpx;
}
.vs-error-icon { font-size: 96rpx; }
.vs-error-title { font-size: 34rpx; font-weight: 700; color: $text-primary; }
.vs-error-text { font-size: 26rpx; color: $text-tertiary; text-align: center; line-height: 1.6; }
.vs-error-btn {
  margin-top: 24rpx; padding: 22rpx 80rpx; border-radius: $radius-lg;
  background: $gradient-primary;
  text { font-size: 28rpx; font-weight: 600; color: #fff; }
}

.vs-history-entry {
  position: fixed; right: 24rpx; bottom: 60rpx; z-index: 10;
  padding: 16rpx 28rpx; border-radius: 999rpx;
  background: #fff; box-shadow: $shadow-card;
  text { font-size: 24rpx; color: $text-secondary; font-weight: 500; }
}
</style>
