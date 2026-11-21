<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useVideoScriptStore } from '@/stores/video-script'

const store = useVideoScriptStore()

/** 全局去术语化步骤（与阶段顺序对应） */
const STEPS = ['了解民宿', '分析客群', '构思脚本', '写口播', '合规审核', '排分镜', '打包成片']

/** 当前阶段已覆盖到第几步（下标为「当前进行中的那一步」） */
const activeIndex = computed(() => {
  switch (store.phase) {
    case 'starting': return 1   // 了解民宿 → 分析客群
    case 'stage2': return 3     // + 构思脚本 + 写口播
    case 'stage3_4': return 5   // + 合规审核 + 排分镜
    case 'finalizing': return 6 // + 打包成片
    default: return 0
  }
})

/** 轮播提示文案（后端同步阻塞，期间用轮播安抚等待） */
const tipIndex = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    tipIndex.value = (tipIndex.value + 1) % 8
  }, 2500)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

const currentTip = computed(() => {
  const tips = store.tips
  if (!tips.length) return 'AI 正在创作中…'
  return tips[tipIndex.value % tips.length]
})
</script>

<template>
  <view class="pv-page">
    <view class="pv-robot">🤖</view>
    <text class="pv-title">AI 正在创作中</text>
    <text class="pv-text">{{ currentTip }}</text>

    <view class="pv-steps">
      <view
        v-for="(s, i) in STEPS"
        :key="s"
        :class="['pv-step', { done: i < activeIndex, active: i === activeIndex }]"
      >
        <text class="pv-step-dot">{{ i < activeIndex ? '✓' : i + 1 }}</text>
        <text class="pv-step-label">{{ s }}</text>
      </view>
    </view>

    <view class="pv-bar">
      <view class="pv-bar-inner" :style="{ width: Math.round((activeIndex / STEPS.length) * 100) + '%' }" />
    </view>

    <text class="pv-hint">每个环节都由 AI 逐个校验，稍等片刻</text>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.pv-page {
  min-height: 100vh;
  padding: 80rpx 40rpx 60rpx;
  box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center;
}

.pv-robot { font-size: 96rpx; margin-bottom: 24rpx; animation: bob 1.6s ease-in-out infinite; }
@keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-16rpx); } }

.pv-title { font-size: 36rpx; font-weight: 700; color: $text-primary; margin-bottom: 12rpx; }
.pv-text { font-size: 28rpx; color: $text-secondary; margin-bottom: 56rpx; }

.pv-steps { display: flex; flex-wrap: wrap; justify-content: center; gap: 24rpx 20rpx; margin-bottom: 40rpx; }
.pv-step { display: flex; align-items: center; gap: 8rpx; opacity: 0.35; transition: opacity 0.3s; }
.pv-step.done { opacity: 1; }
.pv-step.active { opacity: 1; }
.pv-step-dot {
  width: 36rpx; height: 36rpx; border-radius: 50%;
  background: $bg-main; border: 2rpx solid #ddd; color: $text-tertiary;
  font-size: 20rpx; display: flex; align-items: center; justify-content: center;
}
.pv-step.done .pv-step-dot { background: $primary-green; border-color: $primary-green; color: #fff; }
.pv-step.active .pv-step-dot { border-color: $primary-green; color: $primary-green; font-weight: 700; }
.pv-step-label { font-size: 24rpx; color: $text-primary; }

.pv-bar {
  width: 100%; height: 12rpx; border-radius: 999rpx;
  background: $bg-main; overflow: hidden;
}
.pv-bar-inner {
  height: 100%; border-radius: 999rpx;
  background: $gradient-primary; transition: width 0.4s ease;
}

.pv-hint { margin-top: 32rpx; font-size: 22rpx; color: $text-tertiary; }
</style>
