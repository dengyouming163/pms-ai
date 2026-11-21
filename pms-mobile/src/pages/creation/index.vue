<script setup lang="ts">
import { onMounted, ref } from 'vue'

/** 功能卡片列表 — 创作中心入口 */
const featureCards = [
  {
    id: 'studio',
    emoji: '📝',
    title: '创作中心',
    desc: 'AI驱动，分镜脚本创作',
    url: '/pages/creation/studio',
  },
  {
    id: 'xhs',
    emoji: '📕',
    title: '小红书文案',
    desc: '智能创作小红书爆款笔记',
    url: '/pages/creation/xhs',
  },
]

/** 页面加载 */
onMounted(() => {
  // 预加载数据或埋点
})

/** 点击卡片跳转 */
function handleCardTap(url: string) {
  uni.navigateTo({ url })
}
</script>

<template>
  <view class="creation-hub-page">
    <!-- 头部区域 -->
    <view class="hub-header">
      <view class="header-title-area">
        <text class="hub-title">创作中心</text>
        <text class="hub-subtitle">一站式AI内容创作平台</text>
      </view>
      <!-- 装饰背景 -->
      <view class="header-bg-deco" />
    </view>

    <!-- 功能卡片 — 微信风格大卡片 -->
    <view class="card-grid">
      <view
        v-for="card in featureCards"
        :key="card.id"
        class="feature-card"
        @click="handleCardTap(card.url)"
      >
        <text class="card-emoji">{{ card.emoji }}</text>
        <view class="card-body">
          <text class="card-title">{{ card.title }}</text>
          <text class="card-desc">{{ card.desc }}</text>
        </view>
        <view class="card-arrow-wrap">
          <text class="card-arrow">›</text>
        </view>
      </view>
    </view>

    <!-- 底部统计提示 -->
    <view class="hub-footer">
      <text class="footer-text">智能创作，让内容更有温度</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.creation-hub-page {
  min-height: 100vh;
  background: $bg-main;
  padding: 0 24rpx 48rpx;
  box-sizing: border-box;
}

/* ========== 头部区域 ========== */
.hub-header {
  position: relative;
  padding: 40rpx 8rpx 32rpx;
  overflow: hidden;
}

.hub-title {
  font-size: 44rpx;
  font-weight: 700;
  color: $text-primary;
  letter-spacing: 2rpx;
}

.hub-subtitle {
  display: block;
  margin-top: 8rpx;
  font-size: 26rpx;
  color: $text-tertiary;
}

.header-bg-deco {
  position: absolute;
  top: -60rpx;
  right: -40rpx;
  width: 200rpx;
  height: 200rpx;
  border-radius: 50%;
  background: rgba(7, 193, 96, 0.06);
  z-index: 0;
}

/* ========== 功能卡片 — 微信风格大卡片 ========== */
.card-grid {
  display: flex;
  flex-direction: column;
  gap: 24rpx;
  position: relative;
  z-index: 1;
}

.feature-card {
  width: 100%;
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 40rpx 32rpx;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 24rpx;
  position: relative;
  box-shadow: $shadow-card;
  transition: transform 0.15s, box-shadow 0.15s;

  &:active {
    transform: scale(0.98);
    box-shadow: 0 4rpx 16rpx rgba(0, 0, 0, 0.08);
  }
}

.card-emoji {
  font-size: 64rpx;
  line-height: 1;
  flex-shrink: 0;
}

.card-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.card-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $text-primary;
  line-height: 1.3;
}

.card-desc {
  font-size: 24rpx;
  color: $text-tertiary;
  line-height: 1.4;
}

.card-arrow-wrap {
  flex-shrink: 0;
  width: 48rpx;
  height: 48rpx;
  border-radius: 50%;
  background: $bg-main;
  display: flex;
  align-items: center;
  justify-content: center;
}

.card-arrow {
  font-size: 32rpx;
  color: #b0b0b0;
}

/* ========== 底部提示 ========== */
.hub-footer {
  margin-top: 60rpx;
  padding: 24rpx 0;
  text-align: center;
}

.footer-text {
  font-size: 24rpx;
  color: #ccc;
}
</style>
