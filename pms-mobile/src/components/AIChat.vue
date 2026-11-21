<script setup lang="ts">
import { ref, nextTick, watch } from 'vue'
import type { AIMessage } from '@/api/modules/ai'

interface Props {
  messages: AIMessage[]
  loading?: boolean
  placeholder?: string
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  placeholder: '输入消息，例如：帮我分析本周入住率...'
})

const emit = defineEmits<{
  send: [message: string]
  clear: []
}>()

const inputText = ref('')
const scrollTop = ref(0)
const messagesRef = ref<any>(null)

function handleSend() {
  const text = inputText.value.trim()
  if (!text || props.loading) return
  emit('send', text)
  inputText.value = ''
}

// 发送按钮图标：禁用态换灰（颜色烘焙进 PNG）
const sendIconSrc = computed(() =>
  !inputText.value.trim() || props.loading
    ? '/static/icon/chat-send-disabled.png'
    : '/static/icon/chat-send.png'
)

function scrollToBottom() {
  nextTick(() => {
    scrollTop.value = 999999
  })
}

// 新消息到达时自动滚动
watch(() => props.messages.length, () => {
  scrollToBottom()
})

watch(() => props.loading, (val) => {
  if (val) scrollToBottom()
})

defineExpose({ scrollToBottom })
</script>

<template>
  <view class="ai-chat">
    <!-- 消息列表 -->
    <scroll-view
      class="message-list"
      scroll-y
      :scroll-top="scrollTop"
      scroll-with-animation
    >
      <!-- 顶部插槽：横向滑动卡片等 -->
      <slot name="header" />

      <!-- 空状态引导 -->
      <view v-if="messages.length === 0 && !loading" class="empty-state">
        <view class="empty-icon">
          <image class="ai-empty-icon" src="/static/icon/ai-bolt.png" mode="aspectFit" />
        </view>
        <text class="empty-title">有什么可以帮您？</text>
        <text class="empty-desc">我是您的酒店运营助手，可以帮您分析数据、调整价格、查询报表、回复点评等。</text>
        <slot name="empty" />
      </view>

      <!-- 消息气泡 -->
      <view v-for="msg in messages" :key="msg.id" :class="['message-row', msg.role]">
        <!-- AI 头像 -->
        <view v-if="msg.role === 'assistant'" class="msg-avatar assistant-avatar">
          <image class="ai-avatar-icon" src="/static/icon/ai-bolt.png" mode="aspectFit" />
        </view>

        <!-- 消息内容 -->
        <view :class="['msg-bubble', msg.role]">
          <text class="msg-text">{{ msg.content }}</text>
        </view>

        <!-- 用户头像 -->
        <view v-if="msg.role === 'user'" class="msg-avatar user-avatar">
          <image class="ai-avatar-icon" src="/static/icon/chat-user.png" mode="aspectFit" />
        </view>
      </view>

      <!-- 加载动画 -->
      <view v-if="loading" class="message-row assistant">
        <view class="msg-avatar assistant-avatar">
          <image class="ai-avatar-icon" src="/static/icon/ai-bolt.png" mode="aspectFit" />
        </view>
        <view class="msg-bubble assistant typing">
          <view class="typing-dots">
            <view class="dot" />
            <view class="dot" />
            <view class="dot" />
          </view>
        </view>
      </view>

      <view class="list-spacer" />
    </scroll-view>

    <!-- 输入区域 -->
    <view class="input-area">
      <view class="input-row">
        <input
          class="chat-input"
          v-model="inputText"
          :placeholder="placeholder"
          confirm-type="send"
          :disabled="loading"
          @confirm="handleSend"
        />
        <view
          :class="['send-btn', { disabled: !inputText.trim() || loading }]"
          @click="handleSend"
        >
          <image class="send-icon" :src="sendIconSrc" mode="aspectFit" />
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.ai-chat {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #F3F4F6;
}

/* === 消息列表 === */
.message-list {
  flex: 1;
  padding: 24rpx;
}

.list-spacer {
  height: 16rpx;
}

/* === 空状态 === */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 80rpx 48rpx 0;
}

.empty-icon {
  width: 104rpx;
  height: 104rpx;
  border-radius: 52rpx;
  background: rgba(200, 169, 110, 0.1);
  color: #C8A96E;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24rpx;
}

.ai-empty-icon {
  width: 96rpx;
  height: 96rpx;
}

.empty-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1D2A3A;
  margin-bottom: 12rpx;
}

.empty-desc {
  font-size: 26rpx;
  color: #9BA8B5;
  text-align: center;
  line-height: 1.5;
}

/* === 消息行 === */
.message-row {
  display: flex;
  margin-bottom: 24rpx;

  &.assistant {
    justify-content: flex-start;
  }

  &.user {
    justify-content: flex-end;
  }
}

.msg-avatar {
  width: 64rpx;
  height: 64rpx;
  border-radius: 32rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  &.assistant-avatar {
    background: rgba(200, 169, 110, 0.12);
    color: #C8A96E;
    margin-right: 16rpx;
  }

  &.user-avatar {
    background: rgba(60, 80, 104, 0.08);
    color: #3C5068;
    margin-left: 16rpx;
  }
}

.ai-avatar-icon {
  width: 40rpx;
  height: 40rpx;
}

/* === 消息气泡 === */
.msg-bubble {
  max-width: 72%;
  padding: 20rpx 24rpx;
  border-radius: 20rpx;
  font-size: 28rpx;
  line-height: 1.55;

  &.assistant {
    background: #FFFFFF;
    color: #1D2A3A;
    border: 1rpx solid #F0F1F4;
    border-top-left-radius: 6rpx;
    box-shadow: 0 1rpx 3rpx rgba(29, 42, 58, 0.03);
  }

  &.user {
    background: linear-gradient(135deg, #3C5068, #4E6580);
    color: #FFFFFF;
    border-top-right-radius: 6rpx;
  }

  &.typing {
    padding: 28rpx 32rpx;
  }
}

.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* === 打字动画 === */
.typing-dots {
  display: flex;
  gap: 8rpx;
  align-items: center;
}

.dot {
  width: 12rpx;
  height: 12rpx;
  border-radius: 50%;
  background: #C8CFD6;
  animation: typingBounce 1.4s ease-in-out infinite;

  &:nth-child(2) { animation-delay: 0.2s; }
  &:nth-child(3) { animation-delay: 0.4s; }
}

@keyframes typingBounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-8rpx); opacity: 1; }
}

/* === 输入区域 === */
.input-area {
  padding: 20rpx 24rpx;
  background: #FFFFFF;
  border-top: 1rpx solid #F0F1F4;
  padding-bottom: 20rpx;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.chat-input {
  flex: 1;
  height: 76rpx;
  padding: 0 24rpx;
  background: #F6F7F9;
  border-radius: 38rpx;
  font-size: 28rpx;
  color: #1D2A3A;
  border: none;

  &::placeholder {
    color: #9BA8B5;
  }

  &:focus {
    background: #FFFFFF;
    box-shadow: 0 0 0 2rpx rgba(60, 80, 104, 0.1);
  }
}

.send-btn {
  width: 76rpx;
  height: 76rpx;
  border-radius: 38rpx;
  background: #3C5068;
  color: #FFFFFF;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s;

  &.disabled {
    background: #E5E7EB;
    color: #C8CFD6;
  }

  &:not(.disabled):active {
    opacity: 0.85;
  }
}

.send-icon {
  width: 40rpx;
  height: 40rpx;
}
</style>
