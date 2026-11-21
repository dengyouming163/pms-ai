<script setup lang="ts">
import { computed } from 'vue'
import { useVideoScriptStore } from '@/stores/video-script'

const store = useVideoScriptStore()

const node = computed(() => store.confirm)

/** 默认选项是否在列表中（用于「一键使用推荐」） */
const defaultOption = computed(() =>
  node.value?.options.find((o) => o.id === node.value.default),
)

function choose(optionId: string) {
  store.confirm(optionId)
}
</script>

<template>
  <view v-if="node" class="cp-page">
    <view class="cp-hero">
      <text class="cp-hero-emoji">👉</text>
      <text class="cp-hero-title">请选一个「{{ node.label }}」</text>
      <text class="cp-hero-sub">选一个最心动的，AI 会按这个方向继续</text>
    </view>

    <view class="cp-options">
      <view
        v-for="opt in node.options"
        :key="opt.id"
        class="cp-option"
        @click="choose(opt.id)"
      >
        <view class="cp-option-body">
          <text class="cp-option-label">{{ opt.label }}</text>
          <text v-if="opt.desc" class="cp-option-desc">{{ opt.desc }}</text>
        </view>
        <text v-if="opt.id === node.default" class="cp-recommend">推荐</text>
      </view>
    </view>

    <view v-if="defaultOption" class="cp-skip" @click="choose(defaultOption.id)">
      <text>⏭ 就用推荐（{{ defaultOption.label }}）</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.cp-page {
  min-height: 100vh;
  padding: 24rpx 24rpx 60rpx;
  box-sizing: border-box;
}

.cp-hero {
  padding: 24rpx 8rpx 28rpx;
  display: flex; flex-direction: column; gap: 8rpx;
}
.cp-hero-emoji { font-size: 56rpx; margin-bottom: 4rpx; }
.cp-hero-title { font-size: 36rpx; font-weight: 700; color: $text-primary; }
.cp-hero-sub { font-size: 26rpx; color: $text-tertiary; }

.cp-options { display: flex; flex-direction: column; gap: 20rpx; }
.cp-option {
  display: flex; align-items: center; gap: 16rpx;
  padding: 28rpx 24rpx; border-radius: $radius-lg;
  background: $bg-card; box-shadow: $shadow-card;
  transition: all 0.15s;
  &:active { transform: scale(0.98); }
}
.cp-option-body { flex: 1; display: flex; flex-direction: column; gap: 8rpx; }
.cp-option-label { font-size: 30rpx; font-weight: 600; color: $text-primary; line-height: 1.4; }
.cp-option-desc { font-size: 24rpx; color: $text-tertiary; line-height: 1.4; }
.cp-recommend {
  flex-shrink: 0; padding: 6rpx 16rpx; border-radius: 999rpx;
  background: rgba(7, 193, 96, 0.1); color: $primary-green;
  font-size: 22rpx; font-weight: 600;
}

.cp-skip {
  margin-top: 28rpx; padding: 24rpx 0; border-radius: $radius-lg;
  border: 2rpx solid $primary-green; background: #fff;
  display: flex; justify-content: center;
  &:active { background: rgba(7, 193, 96, 0.05); }
  text { font-size: 28rpx; font-weight: 600; color: $primary-green; }
}
</style>
