<script setup lang="ts">
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { useAIStore } from '@/stores/ai'
import { useAppStore } from '@/stores/app'
import PageHeader from '@/components/PageHeader.vue'
import AIMessage from '@/components/ai/AIMessage.vue'
import AIInput from '@/components/ai/AIInput.vue'
import WorkbenchView from '@/components/ai/WorkbenchView.vue'
import { useVoice } from '@/composables/useVoice'
import { streamAIChat, type ChatMessage, getModelConfig, switchModel, type ModelPreset } from '@/api/modules/ai'
import type { CapabilityCard } from '@/types/ai'

// #ifdef APP-PLUS
import SseBridge from '@/components/ai/SseBridge.vue'
import { setBridgeTrigger, onAPPChunk, onAPPDone, onAPPError } from '@/api/modules/ai'
// #endif

const aiStore = useAIStore()
const appStore = useAppStore()
const { playVoice, stopVoice, isPlaying } = useVoice()
const autoRead = ref(true)
const scrollTop = ref(0)
const scrollIntoViewId = ref('')

const isWorkbench = computed(() => aiStore.viewMode === 'workbench')

/* ============ APP 端 SSE 桥接 ============ */
// #ifdef APP-PLUS
const bridgeData = ref<any>({})
onMounted(() => {
  setBridgeTrigger((data: any) => {
    bridgeData.value = { ...data }
  })
})
function handleBridgeChunk(payload: any) {
  const requestId = payload._requestId
  delete payload._requestId
  onAPPChunk(requestId, payload)
}
function handleBridgeDone(payload: any) { onAPPDone(payload.requestId, payload) }
function handleBridgeError(payload: any) { onAPPError(payload.requestId, payload) }
// #endif

/* ============ 视图切换 ============ */
function handleCardSelect(card: CapabilityCard) {
  if (card.url) {
    uni.navigateTo({ url: card.url })
    return
  }
  aiStore.clearCurrentSession()
  aiStore.setActiveCard(card)
  nextTick(() => {
    handleSend(card.prompt)
  })
}

function handleBack() { aiStore.backToWorkbench() }

function handlePlayAudio(msgId: string) {
  const msg = aiStore.currentMessages.find(m => m.id === msgId)
  if (!msg?.content) return
  stopVoice()
  playVoice(msg.content, msgId).catch(() => {})
}

function handleNewChat() {
  aiStore.clearCurrentSession()
  aiStore.setViewMode('workbench')
  aiStore.setProgressHint('')
}

/* ============ 模型切换 ============ */
const showModelPicker = ref(false)
const availablePresets = ref<ModelPreset[]>([])

async function fetchModelConfig() {
  try {
    const cfg = await getModelConfig()
    aiStore.setModel(cfg.active, cfg.config.label)
    availablePresets.value = cfg.presets
  } catch {
    // 静默失败，使用默认值
  }
}

async function handleSwitchModel(preset: ModelPreset) {
  if (aiStore.modelLoading || preset.id === aiStore.currentModel) {
    showModelPicker.value = false
    return
  }
  aiStore.setModelLoading(true)
  try {
    const result = await switchModel(preset.id)
    if (result.success) {
      aiStore.setModel(result.active, result.label)
      uni.showToast({ title: `已切换至 ${result.label}`, icon: 'success', duration: 1500 })
      // 切换模型后清空当前对话
      aiStore.clearCurrentSession()
      aiStore.backToWorkbench()
    }
  } catch {
    uni.showToast({ title: '切换失败，请重试', icon: 'none' })
  }
  aiStore.setModelLoading(false)
  showModelPicker.value = false
}

onMounted(() => {
  fetchModelConfig()
})

function handleSceneChange(scene: any) {
  aiStore.setScene(scene)
  aiStore.clearCurrentSession()
  aiStore.backToWorkbench()
}

/* ============ 发送消息 ============ */
async function handleSend(message: string) {
  const msg = message.trim()
  if (!msg || aiStore.loading) return
  // 从工作台输入时，切换到对话视图
  if (aiStore.viewMode === 'workbench') {
    aiStore.clearCurrentSession()
    aiStore.setViewMode('chat')
  }

  aiStore.addMessage({
    id: Date.now().toString(),
    role: 'user',
    content: msg,
    createdAt: new Date().toISOString(),
    scene: aiStore.currentScene,
  })
  aiStore.setLoading(true)
  aiStore.setStreaming(true)
  aiStore.setProgressHint('')

  const aiMsgId = (Date.now() + 1).toString()
  aiStore.addMessage({
    id: aiMsgId,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    scene: aiStore.currentScene,
  })

  await nextTick()
  scrollToBottom()

  const history: ChatMessage[] = aiStore.currentMessages
    .filter(m => m.id !== aiMsgId)
    .map(m => ({ role: m.role, content: m.content }))

  try {
    await streamAIChat(msg, history, {
      onAgentStart: (_agent, action) => {
        aiStore.setProgressHint(`${action}...`)
      },
      onToken: (text) => {
        aiStore.setProgressHint('')
        aiStore.appendContent(aiMsgId, text)
        scrollToBottom()
      },
      onDone: () => {
        aiStore.setProgressHint('')
        aiStore.setStreaming(false)
        aiStore.setLoading(false)
        scrollToBottom()
        // 自动朗读AI回复
        if (autoRead.value) {
          const aiMsg = aiStore.currentMessages[aiStore.currentMessages.length - 1]
          if (aiMsg?.content) playVoice(aiMsg.content, aiMsg.id).catch(() => {})
        }
      },
      onError: (error) => {
        aiStore.setProgressHint('')
        aiStore.appendContent(aiMsgId, '❌ ' + error)
        aiStore.setStreaming(false)
        aiStore.setLoading(false)
      },
    })
  } catch (e: any) {
    aiStore.setProgressHint('')
    aiStore.appendContent(aiMsgId, '❌ ' + (e?.message || '请求失败'))
    aiStore.setStreaming(false)
    aiStore.setLoading(false)
  }
}

function scrollToBottom() {
  nextTick(() => { scrollTop.value = 999999 })
}

watch(() => aiStore.currentMessages.length, () => { scrollToBottom() })
watch(() => appStore.currentStore?.id, (newId, oldId) => {
  if (newId && newId !== oldId) {
    aiStore.clearCurrentSession()
    aiStore.backToWorkbench()
  }
})
</script>

<template>
  <view class="ai-page">
    <!-- APP 端 SSE 桥接组件 -->
    <!-- #ifdef APP-PLUS -->
    <SseBridge
      :bridge-data="bridgeData"
      @chunk="handleBridgeChunk"
      @done="handleBridgeDone"
      @error="handleBridgeError"
    />
    <!-- #endif -->

    <!-- 固定头部: PageHeader + 场景Tab -->
    <PageHeader>
      <template #right>
        <view class="model-switch" @click="showModelPicker = !showModelPicker">
          <text class="model-label">{{ aiStore.currentModelLabel }}</text>
          <text class="model-arrow">▼</text>
        </view>
        <text v-if="isPlaying" class="nav-action stop-audio" @click="stopVoice">⏹</text>
        <text class="nav-action tts-toggle" @click="autoRead = !autoRead">
          {{ autoRead ? '🔊' : '🔇' }}
        </text>
        <text class="nav-action gold" @click="handleNewChat">✨</text>
      </template>
      <template #tabs>
        <view class="scene-tabs">
          <view
            v-for="scene in aiStore.availableScenes"
            :key="scene.key"
            :class="['scene-tab', { active: scene.key === aiStore.currentScene }]"
            @click="handleSceneChange(scene.key)">
            <text class="scene-label">{{ scene.label }}</text>
          </view>
        </view>
      </template>
    </PageHeader>

    <!-- 模型选择器下拉 -->
    <view v-if="showModelPicker" class="model-picker-overlay" @click="showModelPicker = false">
      <view class="model-picker-panel" @click.stop>
        <view class="picker-title">选择 AI 模型</view>
        <view
          v-for="preset in availablePresets"
          :key="preset.id"
          :class="['picker-item', { active: preset.id === aiStore.currentModel }]"
          @click="handleSwitchModel(preset)"
        >
          <view class="picker-item-left">
            <text class="picker-item-name">{{ preset.label }}</text>
            <text class="picker-item-model">{{ preset.model }}</text>
          </view>
          <text v-if="preset.id === aiStore.currentModel" class="picker-check">✅</text>
        </view>
      </view>
    </view>

    <!-- 中间唯一滚动区域 -->
    <scroll-view
      class="content-scroll"
      scroll-y
      :scroll-top="scrollTop"
      :scroll-with-animation="true"
      :scroll-into-view="scrollIntoViewId"
    >
      <!-- 工作台视图 -->
      <view v-if="isWorkbench" class="workbench-area">
        <WorkbenchView @select-card="handleCardSelect" />
      </view>

      <!-- 对话视图 -->
      <view v-else class="chat-area">
        <view
          v-for="msg in aiStore.currentMessages"
          :key="msg.id"
          :id="'msg-' + msg.id"
          class="msg-wrapper"
        >
          <AIMessage :message="msg" @play-audio="handlePlayAudio" />
        </view>
        <view v-if="aiStore.streaming && aiStore.progressHint" class="streaming-hint">
          <text class="hint-icon">🤖</text>
          <text class="hint-text">{{ aiStore.progressHint }}</text>
          <text class="hint-dot">▌</text>
        </view>
        <view id="chat-bottom" class="chat-bottom-anchor" />
      </view>
    </scroll-view>

    <!-- 固定底部输入区（始终显示，留出底部导航高度） -->
    <view class="fixed-bottom">
      <AIInput
        :loading="aiStore.loading"
        :streaming="aiStore.streaming"
        @send="handleSend"
      />
    </view>

  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.ai-page {
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  background: $bg-main;
  overflow: hidden;
}

/* ============ 导航右侧操作 ============ */
.nav-action { font-size: 26rpx; color: $primary-green; font-weight: 500; }
.nav-action.gold { color: $gold; }

/* ============ 模型切换按钮 ============ */
.model-switch {
  display: flex; align-items: center; gap: 4rpx;
  padding: 8rpx 16rpx; border-radius: 24rpx;
  background: rgba(200,169,110,0.12); margin-right: 12rpx;
}
.model-label { font-size: 22rpx; color: $gold; font-weight: 500; max-width: 140rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-arrow { font-size: 16rpx; color: $gold; }

/* ============ 模型选择下拉面板 ============ */
.model-picker-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.3); z-index: 1100; /* 高于底部导航，遮住 TabBar */
  display: flex; justify-content: center; align-items: flex-start;
  padding-top: 160rpx;
}
.model-picker-panel {
  width: 600rpx; background: #fff; border-radius: 24rpx;
  padding: 32rpx 0; box-shadow: 0 12rpx 48rpx rgba(0,0,0,0.15);
}
.picker-title {
  font-size: 30rpx; font-weight: 600; color: #191919;
  text-align: center; padding-bottom: 24rpx; border-bottom: 1rpx solid #f0f0f0;
  margin-bottom: 8rpx;
}
.picker-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24rpx 32rpx; margin: 4rpx 12rpx; border-radius: 16rpx;
  &.active { background: rgba(7,193,96,0.08); }
}
.picker-item-left { display: flex; flex-direction: column; gap: 6rpx; }
.picker-item-name { font-size: 30rpx; color: #191919; font-weight: 500; }
.picker-item-model { font-size: 24rpx; color: #999; }
.picker-check { font-size: 32rpx; }
.nav-action.tts-toggle { font-size: 30rpx; margin: 0 6rpx; padding: 4rpx; }
.nav-action.stop-audio { font-size: 30rpx; color: #FA5151; padding: 4rpx; animation: blink 0.8s infinite; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.5} }

/* ============ 场景 TabBar ============ */
.scene-tabs {
  display: flex;
  padding: 32rpx 20rpx 12rpx;
  gap: 12rpx;
  background: $bg-main;
}
.scene-tab {
  flex: 1;
  padding: 18rpx 12rpx;
  border-radius: $radius-lg;
  text-align: center;
  background: #fff;
  transition: all 0.2s;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04);
  &.active {
    background: $gradient-primary;
    color: #fff;
    box-shadow: 0 6rpx 24rpx rgba(7,193,96,0.35);
    transform: translateY(-2rpx);
  }
}
.scene-label { font-size: 26rpx; font-weight: 500; }

/* ============ 中间滚动区域 ============ */
.content-scroll {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.workbench-area {
  padding: 20rpx 24rpx 120rpx;
}

.chat-area {
  padding: 12rpx 0 120rpx;
}

/* ============ 流式提示 ============ */
.streaming-hint {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin: 16rpx 32rpx;
  padding: 24rpx 32rpx;
  background: #fff;
  border-radius: $radius-xl;
  border-top-left-radius: $radius-sm;
  max-width: 85%;
  box-shadow: $shadow-card;
}
.hint-icon { font-size: 32rpx; }
.hint-text { font-size: 28rpx; color: $text-secondary; font-style: italic; }
.hint-dot { color: $primary-green; font-size: 28rpx; animation: blink 0.8s infinite; }

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.chat-bottom-anchor { height: 2rpx; }

/* ============ 底部输入区（紧跟滚动区，让出底部导航空间） ============ */
.fixed-bottom {
  flex-shrink: 0;
  background: #fff;
  border-top: 1rpx solid rgba(0,0,0,0.06);
  box-shadow: 0 -4rpx 24rpx rgba(0,0,0,0.04);
  /* H5 端系统原生 tabBar 为 fixed 需预留高度；App 端原生 tabBar 自动避让，无需额外 padding */
  /* #ifndef APP-PLUS */
  padding-bottom: calc(112rpx + env(safe-area-inset-bottom));
  /* #endif */
}
</style>