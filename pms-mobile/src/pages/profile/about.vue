<script setup lang="ts">
</script>

<template>
  <view class="page">
    <view class="logo-wrap"><image class="logo" src="/static/image/logo.png" mode="aspectFit" /></view>
    <text class="name">述椿云宿</text>
    <text class="ver">v1.0.0</text>
    <text class="desc">智慧酒店管理系统</text>

    <view class="card">
      <view class="row"><text class="rl">官方网站</text><text class="rv">www.shuchunyunshu.com</text></view>
      <view class="row"><text class="rl">联系邮箱</text><text class="rv">714284292@qq.com</text></view>
      <view class="row"><text class="rl">服务时间</text><text class="rv">7×24小时</text></view>
    </view>

    <view class="copy"><text>© 2026 述椿云宿 All Rights Reserved</text></view>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; display: flex; flex-direction: column; align-items: center; padding: 80rpx 48rpx 48rpx; }
.logo-wrap { margin-bottom: 28rpx; }
.logo { width: 160rpx; height: 160rpx; border-radius: 36rpx; }
.name { font-size: 40rpx; font-weight: 700; color: #191919; margin-bottom: 10rpx; }
.ver { font-size: 24rpx; color: #07C160; background: rgba(7,193,96,0.1); padding: 4rpx 16rpx; border-radius: 12rpx; margin-bottom: 10rpx; }
.desc { font-size: 26rpx; color: #888; margin-bottom: 48rpx; }
.card { width: 100%; background: #fff; border-radius: 24rpx; padding: 8rpx 24rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.row { display: flex; justify-content: space-between; align-items: center; padding: 24rpx 0; border-bottom: 1rpx solid #F5F6FA; }
.row:last-child { border-bottom: none; }
.rl { font-size: 28rpx; color: #888; }
.rv { font-size: 28rpx; color: #191919; }
.rv.link { color: #576B95; }
.copy { margin-top: auto; padding-top: 48rpx; }
.copy text { font-size: 24rpx; color: #ccc; }
</style>
