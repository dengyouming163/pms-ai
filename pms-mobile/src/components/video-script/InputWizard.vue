<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAppStore } from '@/stores/app'
import { useVideoScriptStore } from '@/stores/video-script'
import type { VideoScriptInput } from '@/types/video-script'

const emit = defineEmits<{ start: [input: VideoScriptInput] }>()

const appStore = useAppStore()
const store = useVideoScriptStore()

/** 亮点标签（民宿/旅游住宿常用） */
const HIGHLIGHT_TAGS = [
  '海景', '山景', '温泉', '亲子', '情侣', '近海滩', '民宿房券',
  '性价比', '管家服务', '独栋别墅', '星空夜景', '网红打卡',
  '宠物友好', '接送服务', '本地美食',
]

/** 目标 */
const GOALS = [
  { id: '引流订房', label: '引流订房', desc: '吸引新客下单' },
  { id: '涨粉种草', label: '涨粉种草', desc: '积累粉丝关注' },
  { id: '卖套餐', label: '卖套餐', desc: '推动套餐成交' },
]

const storeName = ref('')
const highlights = ref<string[]>([])
const goal = ref('引流订房')
const note = ref('')

onMounted(() => {
  // 预填：优先上次输入，其次当前门店名（零填表）
  storeName.value = store.input.storeName || appStore.storeName || ''
  if (store.input.highlights.length) highlights.value = [...store.input.highlights]
  if (store.input.goal) goal.value = store.input.goal
  if (store.input.note) note.value = store.input.note
})

function toggleTag(tag: string) {
  const i = highlights.value.indexOf(tag)
  if (i >= 0) highlights.value.splice(i, 1)
  else highlights.value.push(tag)
}

function handleStart() {
  const name = storeName.value.trim()
  if (!name) {
    uni.showToast({ title: '请填写民宿名称', icon: 'none' })
    return
  }
  if (highlights.value.length === 0) {
    uni.showToast({ title: '请至少选择一个亮点', icon: 'none' })
    return
  }
  emit('start', {
    storeName: name,
    highlights: [...highlights.value],
    goal: goal.value,
    note: note.value.trim(),
  })
}
</script>

<template>
  <view class="iw-page">
    <view class="iw-hero">
      <text class="iw-hero-title">🎬 生成短视频脚本</text>
      <text class="iw-hero-sub">三步填完，AI 帮你产出可直接拍摄的高转化脚本</text>
    </view>

    <!-- 第 1 步：民宿名称 -->
    <view class="iw-card">
      <view class="iw-card-title-row">
        <text class="iw-step-badge">1</text>
        <text class="iw-card-title">你的民宿叫什么</text>
      </view>
      <input
        v-model="storeName"
        class="iw-input"
        placeholder="如：述椿云宿·海景店"
        :maxlength="40"
      />
    </view>

    <!-- 第 2 步：亮点标签 -->
    <view class="iw-card">
      <view class="iw-card-title-row">
        <text class="iw-step-badge">2</text>
        <text class="iw-card-title">民宿亮点（多选）</text>
      </view>
      <view class="iw-tags">
        <view
          v-for="tag in HIGHLIGHT_TAGS"
          :key="tag"
          :class="['iw-tag', { active: highlights.includes(tag) }]"
          @click="toggleTag(tag)"
        >
          <text>{{ tag }}</text>
        </view>
      </view>
    </view>

    <!-- 第 3 步：目标 -->
    <view class="iw-card">
      <view class="iw-card-title-row">
        <text class="iw-step-badge">3</text>
        <text class="iw-card-title">这次想达成什么</text>
      </view>
      <view class="iw-goals">
        <view
          v-for="g in GOALS"
          :key="g.id"
          :class="['iw-goal', { active: goal === g.id }]"
          @click="goal = g.id"
        >
          <text class="iw-goal-label">{{ g.label }}</text>
          <text class="iw-goal-desc">{{ g.desc }}</text>
        </view>
      </view>
    </view>

    <!-- 选填：一句卖点 -->
    <view class="iw-card">
      <view class="iw-card-title-row">
        <text class="iw-step-badge">✨</text>
        <text class="iw-card-title">一句话卖点（选填）</text>
      </view>
      <input
        v-model="note"
        class="iw-input"
        placeholder="如：步行 3 分钟到沙滩，含双早"
        :maxlength="60"
      />
    </view>

    <view class="iw-start-btn" @click="handleStart">
      <text>🚀 开始生成脚本</text>
    </view>
    <text class="iw-hint">预计 1-2 分钟，过程中会请你做 3 次小选择</text>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.iw-page {
  min-height: 100vh;
  padding: 24rpx 24rpx 60rpx;
  box-sizing: border-box;
}

.iw-hero {
  padding: 24rpx 8rpx 28rpx;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}
.iw-hero-title { font-size: 40rpx; font-weight: 700; color: $text-primary; }
.iw-hero-sub { font-size: 26rpx; color: $text-tertiary; }

.iw-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 28rpx 24rpx;
  margin-bottom: 20rpx;
  box-shadow: $shadow-card;
}
.iw-card-title-row { display: flex; align-items: center; gap: 12rpx; margin-bottom: 20rpx; }
.iw-step-badge {
  width: 40rpx; height: 40rpx; border-radius: 50%;
  background: $gradient-primary; color: #fff; font-size: 22rpx; font-weight: 700;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.iw-card-title { font-size: 30rpx; font-weight: 600; color: $text-primary; }

.iw-input {
  height: 80rpx; padding: 0 24rpx;
  background: $bg-main; border-radius: $radius-md;
  font-size: 28rpx; color: $text-primary; box-sizing: border-box;
}

.iw-tags { display: flex; flex-wrap: wrap; gap: 16rpx; }
.iw-tag {
  padding: 14rpx 28rpx; border-radius: 999rpx;
  background: $bg-main; border: 2rpx solid transparent;
  font-size: 26rpx; color: $text-secondary;
  transition: all 0.15s;
  &.active {
    background: rgba(7, 193, 96, 0.08);
    border-color: $primary-green;
    color: $primary-green; font-weight: 600;
  }
}

.iw-goals { display: flex; gap: 16rpx; }
.iw-goal {
  flex: 1; padding: 20rpx 12rpx; border-radius: $radius-md;
  background: $bg-main; border: 2rpx solid transparent;
  display: flex; flex-direction: column; align-items: center; gap: 4rpx;
  transition: all 0.15s;
  &.active {
    background: rgba(7, 193, 96, 0.08);
    border-color: $primary-green;
    .iw-goal-label { color: $primary-green; }
  }
}
.iw-goal-label { font-size: 26rpx; font-weight: 600; color: $text-primary; }
.iw-goal-desc { font-size: 20rpx; color: $text-tertiary; }

.iw-start-btn {
  margin-top: 16rpx;
  padding: 26rpx 0; border-radius: $radius-xl;
  background: $gradient-primary;
  display: flex; justify-content: center;
  box-shadow: 0 8rpx 24rpx rgba(7, 193, 96, 0.3);
  &:active { opacity: 0.9; }
  text { font-size: 32rpx; font-weight: 700; color: #fff; }
}
.iw-hint { display: block; margin-top: 20rpx; text-align: center; font-size: 22rpx; color: $text-tertiary; }
</style>
