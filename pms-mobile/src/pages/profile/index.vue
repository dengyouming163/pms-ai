<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { getUnreadCount } from '@/api/modules/user'
import { getRoleName } from '@/utils/role'

const authStore = useAuthStore()
const unreadCount = ref(0)

const userAvatar = computed(() => {
  const name = authStore.userInfo?.name || '用户'
  return name.substring(0, 1).toUpperCase()
})

const roleText = computed(() => {
  const map: Record<string, string> = {
    '超级管理员': '管理员', '品牌经理': '品牌经理', '酒店经理': '店长',
    '店长': '店长', '前台接待': '前台', '财务专员': '财务', '渠道运营': '渠道',
    '保洁': '保洁', '维修': '维修', '员工': '员工',
  }
  const name = getRoleName(authStore.userInfo)
  return map[name] || name || '员工'
})

const userPhone = computed(() => authStore.userInfo?.phone || '')

function handleMenuTap(path: string) { uni.navigateTo({ url: path }) }

function handleLogout() {
  uni.showModal({
    title: '确认退出', content: '确定要退出登录吗？',
    success: (res) => { if (res.confirm) authStore.logout() },
  })
}

onMounted(async () => {
  try { const r = await getUnreadCount(); unreadCount.value = r.count || 0 } catch { unreadCount.value = 0 }
})
</script>

<template>
  <view class="profile-page">
    <!-- 头部卡片 -->
    <view class="header-card">
      <view class="hc-glow" />
      <view class="hc-ring hc-ring-1" />
      <view class="hc-ring hc-ring-2" />
      <view class="hc-avatar">
        <view class="avatar-circle">
          <text class="avatar-text">{{ userAvatar }}</text>
        </view>
      </view>
      <view class="hc-info">
        <text class="user-name">{{ authStore.userInfo?.name || '用户' }}</text>
        <view class="role-badge">
          <text class="role-dot">●</text>
          <text class="role-text">{{ roleText }}</text>
        </view>
        <text v-if="userPhone" class="user-phone">{{ userPhone }}</text>
      </view>
    </view>

    <!-- 设置 -->
    <view class="setting-card">
      <view class="mi" @click="handleMenuTap('/pages/verify/index')">
        <view class="mi-left">
          <view class="mi-icon-box" style="background:#E8F9F0;">
            <image class="mi-icon" src="/static/icon/verify.png" mode="aspectFit" />
          </view>
          <text class="mi-label">到店核销</text>
        </view>
        <view class="mi-right"><text class="mi-arrow">›</text></view>
      </view>
      <view class="mi" @click="uni.showToast({ title: '功能开发中', icon: 'none' })">
        <view class="mi-left">
          <view class="mi-icon-box" style="background:#FFF1F2;">
            <image class="mi-icon" src="/static/icon/notification.png" mode="aspectFit" />
          </view>
          <text class="mi-label">消息通知</text>
        </view>
        <view class="mi-right">
          <view v-if="unreadCount > 0" class="badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</view>
          <text class="mi-arrow">›</text>
        </view>
      </view>
      <view class="mi" @click="handleMenuTap('/pages/profile/change-password')">
        <view class="mi-left">
          <view class="mi-icon-box" style="background:#EEF2FF;">
            <image class="mi-icon" src="/static/icon/change-password.png" mode="aspectFit" />
          </view>
          <text class="mi-label">修改密码</text>
        </view>
        <view class="mi-right"><text class="mi-arrow">›</text></view>
      </view>
      <view class="mi" @click="handleMenuTap('/pages/profile/help')">
        <view class="mi-left">
          <view class="mi-icon-box" style="background:#ECFDF5;">
            <image class="mi-icon" src="/static/icon/help.png" mode="aspectFit" />
          </view>
          <text class="mi-label">帮助与反馈</text>
        </view>
        <view class="mi-right"><text class="mi-arrow">›</text></view>
      </view>
      <view class="mi" @click="handleMenuTap('/pages/profile/about')">
        <view class="mi-left">
          <view class="mi-icon-box" style="background:#F0F9FF;">
            <image class="mi-icon" src="/static/icon/about.png" mode="aspectFit" />
          </view>
          <text class="mi-label">关于</text>
        </view>
        <view class="mi-right"><text class="mi-arrow">›</text></view>
      </view>
    </view>

    <!-- 退出 -->
    <view class="logout-btn" @click="handleLogout">
      <image class="logout-icon" src="/static/icon/logout.png" mode="aspectFit" />
      <text>退出登录</text>
    </view>
    <view class="version"><text>智宿管家 v1.0.0</text></view>
  </view>
</template>

<style lang="scss" scoped>
.profile-page {
  min-height: 100vh;
  background: #F3F4F6;
  /* H5 端系统原生 tabBar 为 fixed 需预留高度；App 端原生 tabBar 自动避让无需额外 padding */
  /* #ifndef APP-PLUS */
  padding-bottom: calc(112rpx + env(safe-area-inset-bottom));
  /* #endif */
}

/* ======== 头部 — 大尺寸 ======== */
.header-card {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, #10C968 0%, #07C160 45%, #05A04A 100%);
  padding: calc(90rpx + env(safe-area-inset-top)) 40rpx 60rpx;
  display: flex; align-items: center; gap: 32rpx;
  border-radius: 0 0 48rpx 48rpx;
}
/* 右上角柔光斑 + 左下装饰圆环，增加层次 */
.hc-glow {
  position: absolute; top: -120rpx; right: -80rpx;
  width: 360rpx; height: 360rpx; border-radius: 50%;
  background: radial-gradient(circle, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 70%);
  pointer-events: none;
}
.hc-ring {
  position: absolute; border-radius: 50%;
  border: 2rpx solid rgba(255,255,255,0.14);
  pointer-events: none;
}
.hc-ring-1 { width: 200rpx; height: 200rpx; bottom: -60rpx; left: -40rpx; }
.hc-ring-2 { width: 300rpx; height: 300rpx; bottom: -110rpx; left: -90rpx; border-color: rgba(255,255,255,0.10); }

.avatar-circle {
  width: 128rpx; height: 128rpx; border-radius: 64rpx;
  background: linear-gradient(145deg, rgba(255,255,255,0.34), rgba(255,255,255,0.16));
  border: 4rpx solid rgba(255,255,255,0.45);
  box-shadow: 0 8rpx 24rpx rgba(3, 94, 47, 0.28);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.avatar-text { font-size: 56rpx; font-weight: 700; color: #fff; }
.hc-info { flex: 1; display: flex; flex-direction: column; gap: 12rpx; min-width: 0; }
.user-name { font-size: 40rpx; font-weight: 700; color: #fff; letter-spacing: 1rpx; }
.role-badge {
  align-self: flex-start; display: flex; align-items: center; gap: 8rpx;
  padding: 6rpx 20rpx; background: rgba(255,255,255,0.18);
  border-radius: 24rpx; border: 1rpx solid rgba(255,255,255,0.22);
}
.role-dot { font-size: 14rpx; color: #DFF9EC; line-height: 1; }
.role-text { font-size: 22rpx; color: #fff; font-weight: 500; }
.user-phone { font-size: 26rpx; color: rgba(255,255,255,0.85); letter-spacing: 1rpx; }

/* ======== 设置 ======== */
.setting-card {
  background: #fff; border-radius: 28rpx; margin: 24rpx 24rpx 0;
  overflow: hidden; box-shadow: 0 6rpx 24rpx rgba(29,42,58,0.06);
}
.mi {
  display: flex; align-items: center; justify-content: space-between;
  padding: 26rpx 28rpx;
  border-bottom: 1rpx solid #F5F6FA;
  &:last-child { border-bottom: none; }
  &:active { background: #FAFBFC; }
}
.mi-left { display: flex; align-items: center; gap: 22rpx; min-width: 0; }
.mi-icon-box {
  width: 64rpx; height: 64rpx; border-radius: 18rpx;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

.mi-icon {
  width: 48rpx; height: 48rpx;
}
.mi-label { font-size: 28rpx; color: #191919; font-weight: 500; }
.mi-right { display: flex; align-items: center; gap: 10rpx; }
.mi-arrow { font-size: 32rpx; color: #C8CFD6; line-height: 1; }
.badge {
  min-width: 34rpx; height: 34rpx; padding: 0 10rpx; background: #FA5151; color: #fff;
  font-size: 20rpx; border-radius: 17rpx; display: flex; align-items: center; justify-content: center; font-weight: 500;
}

/* ======== 退出 ======== */
.logout-btn {
  display: flex; align-items: center; justify-content: center; gap: 12rpx;
  background: #fff; border-radius: 28rpx; margin: 24rpx 24rpx 0; padding: 30rpx;
  box-shadow: 0 6rpx 24rpx rgba(29,42,58,0.06);
  color: #FA5151;
  text { color: #FA5151; font-size: 30rpx; font-weight: 500; }
  &:active { background: #FFF4F4; transform: scale(0.99); }
}

.logout-icon {
  width: 64rpx; height: 64rpx;
}
.version { text-align: center; padding: 36rpx 0 48rpx; text { font-size: 24rpx; color: #B0B0B0; } }
</style>
