<script setup lang="ts">
defineProps<{
  visible: boolean
  text: string
  cancelling?: boolean
}>()
</script>

<template>
    <view v-if="visible" class="voice-overlay" @touchmove.prevent>
      <view class="vo-bg" />

      <view class="vo-content">
        <view :class="['vo-cancel', { active: cancelling }]">
          <view class="vo-cancel-icon"><text>✕</text></view>
          <text class="vo-cancel-label">松开取消</text>
        </view>

        <view v-if="text" class="vo-text-box">
          <text class="vo-text">{{ text }}</text>
          <text class="vo-cursor">|</text>
        </view>
        <view v-else class="vo-placeholder">
          <text>正在聆听...</text>
        </view>

        <view class="vo-mic-stage">
          <view class="vo-waves">
            <view v-for="i in 12" :key="i" class="vo-bar" :style="{ animationDelay: (i * 0.08) + 's', height: (16 + Math.sin(i * 0.8) * 12) + 'rpx' }" />
          </view>
          <view class="vo-mic">
            <view class="vo-pulse" />
            <view class="vo-pulse delay" />
            <image class="vo-mic-img" src="/static/image/luyin.png" mode="aspectFit" />
          </view>
        </view>

        <text class="vo-hint">松开发送，说完稍等识别完成</text>
      </view>
    </view>
</template>

<style lang="scss" scoped>
.voice-overlay {
  position: fixed; inset: 0; z-index: 2000;
  display: flex; align-items: center; justify-content: center;
  animation: voIn 0.2s ease;
}
@keyframes voIn { from { opacity: 0; } to { opacity: 1; } }
.vo-bg {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.7);
  backdrop-filter: blur(16rpx);
}
.vo-content {
  position: relative; z-index: 1;
  display: flex; flex-direction: column; align-items: center; gap: 32rpx;
  width: 100%; padding: 0 48rpx; box-sizing: border-box;
}

/* ======== 取消区 ======== */
.vo-cancel {
  display: flex; flex-direction: column; align-items: center; gap: 12rpx;
  transition: all 0.2s;
  &.active { transform: scale(1.15); .vo-cancel-icon { border-color: #FA5151; background: rgba(250,81,81,0.2); } }
}
.vo-cancel-icon {
  width: 80rpx; height: 80rpx; border-radius: 50%;
  border: 2rpx solid rgba(255,255,255,0.35);
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s;
  text { font-size: 28rpx; color: rgba(255,255,255,0.6); }
}
.vo-cancel-label { font-size: 24rpx; color: rgba(255,255,255,0.5); }

/* ======== 实时文字 ======== */
.vo-text-box {
  max-width: 80vw; padding: 24rpx 36rpx; background: rgba(255,255,255,0.1);
  border-radius: 24rpx; display: flex; align-items: center; gap: 4rpx;
}
.vo-text { font-size: 30rpx; color: #fff; line-height: 1.5; word-break: break-all; }
.vo-cursor { font-size: 30rpx; color: #07C160; animation: blink 0.8s infinite; }
.vo-placeholder { font-size: 28rpx; color: rgba(255,255,255,0.4); }

/* ======== 麦克风动画区 ======== */
.vo-mic-stage { display: flex; flex-direction: column; align-items: center; gap: 28rpx; }

/* 波形条 */
.vo-waves { display: flex; align-items: center; gap: 5rpx; height: 56rpx; }
.vo-bar {
  width: 5rpx; border-radius: 3rpx; background: #07C160;
  animation: waveAnim 0.6s ease-in-out infinite alternate;
}
@keyframes waveAnim {
  0% { transform: scaleY(0.3); opacity: 0.3; }
  100% { transform: scaleY(1); opacity: 1; }
}

/* 脉冲麦克风 */
.vo-mic {
  position: relative; width: 140rpx; height: 140rpx;
  display: flex; align-items: center; justify-content: center;
}
.vo-mic-img { width: 64rpx; height: 64rpx; position: relative; z-index: 2; }
.vo-pulse {
  position: absolute; inset: 0; border-radius: 50%;
  background: rgba(7,193,96,0.15); animation: pulse 1.6s ease-out infinite;
  &.delay { animation-delay: 0.6s; }
}
@keyframes pulse {
  0% { transform: scale(0.7); opacity: 0.7; }
  100% { transform: scale(1.5); opacity: 0; }
}
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

/* ======== 提示 ======== */
.vo-hint { font-size: 24rpx; color: rgba(255,255,255,0.4); letter-spacing: 4rpx; }

</style>
