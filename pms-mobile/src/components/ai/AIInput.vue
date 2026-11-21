<script setup lang="ts">
import { ref } from 'vue'
import { useVoice } from '@/composables/useVoice'
import VoiceOverlay from './VoiceOverlay.vue'

interface Props { loading?: boolean; streaming?: boolean }
withDefaults(defineProps<Props>(), { loading: false, streaming: false })

const emit = defineEmits<{ send: [message: string]; stop: [] }>()
const { isRecording, audioText, startRecording, stopRecording, cancelRecording } = useVoice()

const isApp = typeof plus !== 'undefined'
const hasWebSpeech = typeof window !== 'undefined' && (!!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition)
const inputMode = ref<'voice' | 'text'>((hasWebSpeech || isApp) ? 'voice' : 'text')
const inputText = ref('')

const showOverlay = ref(false)
const overlayText = ref('')
const isCancelling = ref(false)

function toggleMode() { inputMode.value = inputMode.value === 'voice' ? 'text' : 'voice' }
function handleSend() { const t = inputText.value.trim(); if (t) { emit('send', t); inputText.value = '' } }
function handleStop() { emit('stop') }

let _active = false, _startY = 0, _cancelled = false

async function onPressStart(e: any) {
  if (_active) return
  _active = true; _cancelled = false
  _startY = e.touches?.[0]?.clientY || e.clientY || 0
  overlayText.value = ''; isCancelling.value = false
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()) }
    catch { _active = false; uni.showToast({ title: '请允许麦克风权限后重试', icon: 'none' }); return }
  }
  showOverlay.value = true
  try {
    const text = await startRecording((interim) => { overlayText.value = interim; isCancelling.value = false })
    if (!_cancelled && text?.trim()) { emit('send', text.trim()); audioText.value = '' }
  } catch (e: any) {
    if (!_cancelled && e?.message !== '用户取消') {
      uni.showToast({ title: e?.message || '识别失败', icon: 'none' })
      if (e?.message?.includes('不支持')) inputMode.value = 'text'
    }
  }
  resetVoice()
}
function onPressMove(e: any) {
  if (!_active) return
  isCancelling.value = ((e.touches?.[0]?.clientY || 0) - _startY) < -70
}
function onPressEnd() {
  if (isCancelling.value) { _cancelled = true; cancelRecording(); resetVoice(); return }
  // 延迟 1.5 秒停止，确保用户说完最后几个字被识别到
  setTimeout(() => stopRecording(), 1500)
}
function resetVoice() { showOverlay.value = false; overlayText.value = ''; isCancelling.value = false; _active = false }
</script>

<template>
  <view class="ai-input">
    <view v-if="inputMode === 'voice'" class="voice-mode">
      <view class="mode-switch" @click="toggleMode">
        <image class="mode-icon" src="/static/image/yysr.png" mode="aspectFit" />
      </view>
      <view class="voice-btn" :class="{ active: isRecording }"
        @touchstart.prevent="onPressStart" @touchmove.prevent="onPressMove" @touchend.prevent="onPressEnd"
        @mousedown.prevent="onPressStart" @mouseup.prevent="onPressEnd">
        <image class="voice-mic" src="/static/image/luyin.png" mode="aspectFit" />
        <text class="voice-text">{{ isRecording ? '松开发送' : '按住说话' }}</text>
      </view>
    </view>
    <view v-else class="text-mode">
      <view class="mode-switch" @click="toggleMode">
        <image class="mode-icon" src="/static/image/luyin.png" mode="aspectFit" />
      </view>
      <input v-model="inputText" class="text-input" placeholder="输入消息..." :disabled="loading" confirm-type="send" @confirm="handleSend" />
      <view v-if="streaming" class="stop-btn" @click="handleStop"><image class="btn-icon" src="/static/image/stop.png" mode="aspectFit" /></view>
      <view v-else class="send-btn" :class="{ disabled: !inputText.trim() }" @click="handleSend"><image class="btn-icon" src="/static/image/send.png" mode="aspectFit" /></view>
    </view>
    <VoiceOverlay :visible="showOverlay" :text="overlayText" :cancelling="isCancelling" />
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.ai-input { background: #fff; padding: 20rpx 28rpx; }
.voice-mode { display: flex; align-items: center; gap: 16rpx; }
.mode-switch { width: 80rpx; height: 80rpx; border-radius: 50%; background: #C8A96E; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.mode-icon { width: 40rpx; height: 40rpx; }
.voice-btn { flex: 1; height: 96rpx; border-radius: 48rpx; background: $gradient-primary; display: flex; align-items: center; justify-content: center; gap: 14rpx; box-shadow: 0 4rpx 20rpx rgba(7,193,96,0.3); }
.voice-btn.active { background: #FA5151; box-shadow: 0 4rpx 20rpx rgba(250,81,81,0.3); }
.voice-mic { width: 44rpx; height: 44rpx; }
.voice-text { font-size: 32rpx; color: #fff; font-weight: 500; }
.text-mode { display: flex; align-items: center; gap: 14rpx; }
.text-input { flex: 1; height: 88rpx; padding: 0 32rpx; background: #F5F6FA; border-radius: 44rpx; font-size: 30rpx; color: #191919; }
.send-btn, .stop-btn { width: 88rpx; height: 88rpx; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.send-btn { background: $gradient-primary; }
.send-btn.disabled { opacity: 0.4; }
.stop-btn { background: #FF9500; }
.btn-icon { width: 40rpx; height: 40rpx; }
</style>
