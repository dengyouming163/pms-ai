<script setup lang="ts">
import type { AIMessage } from '@/types/ai'
import MarkdownView from './MarkdownView.vue'

interface Props { message: AIMessage }
defineProps<Props>()

const emit = defineEmits<{ playAudio: [id: string]; action: [type: string, payload: any] }>()
</script>

<template>
  <view :class="['message-row', message.role]">
    <view v-if="message.role === 'assistant'" class="avatar ai-avatar"><text>🤖</text></view>
    <view class="message-content">
      <view :class="['bubble', message.role]">
        <!-- AI 回复: 使用 Markdown 渲染 -->
        <MarkdownView v-if="message.role === 'assistant'" :content="message.content" />
        <!-- 用户消息: 纯文本显示 -->
        <text v-else class="bubble-text">{{ message.content }}</text>
      </view>
      <view v-if="message.role === 'assistant'" class="message-actions">
        <view class="action-btn" @click="emit('playAudio', message.id)">
          <text>🔊 朗读</text>
        </view>
        <view class="action-btn copy-btn" @click="uni.setClipboardData({ data: message.content })">
          <text>📋 复制</text>
        </view>
      </view>
      <view v-if="message.actions?.length" class="action-cards">
        <view v-for="(action, i) in message.actions" :key="i" class="action-card" @click="emit('action', action.type, action.payload)">
          <text>{{ action.title }}</text><text class="arrow">→</text>
        </view>
      </view>
    </view>
    <view v-if="message.role === 'user'" class="avatar user-avatar"><text>👤</text></view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.message-row { display: flex; margin-bottom: 32rpx; padding: 0 24rpx; &.user { justify-content: flex-end; } }
.avatar { width: 44rpx; height: 44rpx; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24rpx; &.ai-avatar { background: $gradient-primary; margin-right: 12rpx; } &.user-avatar { background: $gradient-gold; margin-left: 12rpx; } }
.bubble { padding: 20rpx 24rpx; border-radius: 32rpx; &.assistant { background: $bg-ai-message; border-top-left-radius: 8rpx; max-width: 620rpx; } &.user { background: $gradient-primary; border-top-right-radius: 8rpx; color: #fff; max-width: 560rpx; } }
.bubble-text { font-size: 28rpx; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: inherit; }
.message-actions { display: flex; gap: 24rpx; margin-top: 16rpx; }
.action-btn { padding: 8rpx 16rpx; border-radius: 16rpx; background: $gold-light; font-size: 22rpx; color: $gold; display: flex; align-items: center; }
.copy-btn { background: #e0f2fe; color: #0284c7; }
.action-cards { display: flex; flex-direction: column; gap: 12rpx; margin-top: 16rpx; }
.action-card { display: flex; justify-content: space-between; align-items: center; padding: 20rpx 24rpx; background: #fff; border-radius: 20rpx; box-shadow: $shadow-card; border: 2rpx solid rgba(200,169,126,0.2); }
.arrow { color: $primary-green; }
</style>