<template>
  <view class="voice-input" :class="{ recording: isRecording }" @touchstart="startRecording" @touchend="stopRecording" @touchcancel="stopRecording">
    <image v-if="!isRecording" class="voice-icon-img" src="/static/icon/voice-mic.png" mode="aspectFit" />
    <image v-else class="voice-icon-img" src="/static/icon/voice-recording.png" mode="aspectFit" />
    <view v-if="isRecording" class="recording-indicator">
      <view class="wave"></view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  result: [text: string]
  error: [error: string]
}>()

const isRecording = ref(false)
const recorderManager = uni.getRecorderManager()

recorderManager.onError((err) => {
  console.error('录音错误:', err)
  isRecording.value = false
})

recorderManager.onStop((res) => {
  console.log('录音结束:', res.tempFilePath)
})

function startRecording() {
  try {
    uni.authorize({
      scope: 'scope.record',
      success: () => {
        recorderManager.start({
          format: 'mp3',
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 48000,
          duration: 60000
        })
        isRecording.value = true
      },
      fail: () => {
        uni.showToast({ title: '无法访问麦克风', icon: 'none' })
      }
    })
  } catch (error) {
    uni.showToast({ title: '无法访问麦克风', icon: 'none' })
  }
}

function stopRecording() {
  recorderManager.stop()
  isRecording.value = false
  emit('result', '')
}
</script>

<style lang="scss" scoped>
.voice-input {
  width: 80rpx;
  height: 80rpx;
  border-radius: 50%;
  background: var(--td-bg-color-secondarycontainer);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;

  &.recording {
    background: var(--td-error-color-1);
  }
}

.voice-icon {
  font-size: 36rpx;
}

.voice-icon-img {
  width: 44rpx;
  height: 44rpx;
}

.recording-indicator {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100rpx;
  height: 100rpx;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.2);
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    transform: translate(-50%, -50%) scale(1);
    opacity: 1;
  }
  50% {
    transform: translate(-50%, -50%) scale(1.2);
    opacity: 0.5;
  }
}

.wave {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 4rpx solid var(--td-error-color);
  animation: wave 0.5s ease-out infinite;
}

@keyframes wave {
  0% {
    transform: scale(0.8);
    opacity: 1;
  }
  100% {
    transform: scale(1.2);
    opacity: 0;
  }
}
</style>
