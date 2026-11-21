<script setup lang="ts">
import { computed } from 'vue'
import { useVideoScriptStore } from '@/stores/video-script'
import type { HistoryItem } from '@/types/video-script'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ close: []; open: [item: HistoryItem] }>()

const store = useVideoScriptStore()

/** 仅展示已完成且有成片包的记录 */
const completed = computed(() =>
  store.history.filter((h) => h.status === 'COMPLETED' && h.output?.final_package),
)

function title(h: HistoryItem): string {
  return h.output?.final_package?.approved_script?.title || '未命名脚本'
}

function version(h: HistoryItem): string {
  return h.output?.final_package?.generation_params?.version || 'all'
}

function open(item: HistoryItem) {
  emit('open', item)
}
</script>

<template>
  <view v-if="props.visible" class="hp-overlay" @click="emit('close')">
    <view class="hp-panel" @click.stop>
      <view class="hp-head">
        <text class="hp-title">历史脚本</text>
        <text class="hp-close" @click="emit('close')">✕</text>
      </view>

      <view v-if="completed.length === 0" class="hp-empty">
        <text class="hp-empty-icon">📭</text>
        <text class="hp-empty-text">还没有生成过脚本</text>
      </view>

      <scroll-view v-else class="hp-list" scroll-y>
        <view
          v-for="(h, i) in completed"
          :key="i"
          class="hp-item"
          @click="open(h)"
        >
          <view class="hp-item-body">
            <text class="hp-item-title">{{ title(h) }}</text>
            <text class="hp-item-version">{{ version(h) }}</text>
          </view>
          <text class="hp-item-arrow">›</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.hp-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.4); z-index: 1200;
  display: flex; align-items: flex-end; justify-content: center;
}
.hp-panel {
  width: 100%; max-height: 70vh;
  background: #fff; border-radius: $radius-xl $radius-xl 0 0;
  padding: 32rpx 24rpx calc(24rpx + env(safe-area-inset-bottom));
  box-sizing: border-box;
  display: flex; flex-direction: column;
}
.hp-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20rpx; }
.hp-title { font-size: 32rpx; font-weight: 700; color: $text-primary; }
.hp-close { font-size: 32rpx; color: $text-tertiary; padding: 8rpx; }

.hp-empty { display: flex; flex-direction: column; align-items: center; padding: 60rpx 0; gap: 16rpx; }
.hp-empty-icon { font-size: 72rpx; }
.hp-empty-text { font-size: 26rpx; color: $text-tertiary; }

.hp-list { max-height: 60vh; }
.hp-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24rpx 8rpx; border-bottom: 1rpx solid #f0f0f0;
}
.hp-item-body { display: flex; flex-direction: column; gap: 6rpx; flex: 1; margin-right: 16rpx; }
.hp-item-title {
  font-size: 28rpx; color: $text-primary; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hp-item-version {
  align-self: flex-start; padding: 2rpx 14rpx; border-radius: 999rpx;
  background: $bg-main; color: $text-tertiary; font-size: 20rpx;
}
.hp-item-arrow { font-size: 32rpx; color: $text-tertiary; }
</style>
