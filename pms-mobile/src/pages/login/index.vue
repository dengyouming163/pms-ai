<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { getStores } from '@/api/modules/user'

const authStore = useAuthStore()

// 登录模式
const loginMode = ref<'password' | 'sms'>('password')
const phone = ref('')
const password = ref('')
const smsCode = ref('')
const showPassword = ref(false)
const loading = ref(false)

// 验证码倒计时
const codeCountdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null
const codeBtnText = computed(() => {
  if (codeCountdown.value > 0) return `${codeCountdown.value}s`
  return '获取验证码'
})

async function handleSendSms() {
  if (!/^1[3-9]\d{9}$/.test(phone.value)) {
    uni.showToast({ title: '请输入正确的手机号', icon: 'none' }); return
  }
  if (codeCountdown.value > 0) return
  try {
    const res: any = await uni.request({
      url: 'http://132.232.166.40:20002/api/auth/send-sms',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { phone: phone.value },
    })
    const d = res.data as any
    if (d.success) {
      uni.showToast({ title: '验证码已发送', icon: 'success' })
      codeCountdown.value = 60
      countdownTimer = setInterval(() => {
        codeCountdown.value--
        if (codeCountdown.value <= 0) { if (countdownTimer) clearInterval(countdownTimer); countdownTimer = null }
      }, 1000)
    } else {
      uni.showToast({ title: d.error || '发送失败', icon: 'none' })
    }
  } catch {
    uni.showToast({ title: '发送失败', icon: 'none' })
  }
}

async function handleLogin() {
  if (!phone.value) { uni.showToast({ title: '请输入手机号', icon: 'none' }); return }

  if (loginMode.value === 'password' && !password.value) {
    uni.showToast({ title: '请输入密码', icon: 'none' }); return
  }
  if (loginMode.value === 'sms' && !smsCode.value) {
    uni.showToast({ title: '请输入验证码', icon: 'none' }); return
  }

  loading.value = true
  try {
    const body: any = { phone: phone.value }
    if (loginMode.value === 'password') {
      body.password = password.value
    } else {
      body.code = smsCode.value
    }
    const res: any = await uni.request({
      url: 'http://132.232.166.40:20002/api/auth/login',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: body,
    })
    const d = res.data as any
    if (d.success) {
      const { token, userInfo, stores } = d.data
      let userStores = stores || []
      if (userStores.length === 0) {
        try { userStores = await getStores() } catch {}
      }
      authStore.token = token
      authStore.userInfo = userInfo
      authStore.stores = userStores
      authStore.currentStore = userStores[0] || null
      authStore.isLoggedIn = true
      const { useAppStore } = await import('@/stores/app')
      const appStore = useAppStore()
      if (authStore.currentStore) appStore.setCurrentStore(authStore.currentStore)
      // 持久化存储
      uni.setStorageSync('token', token)
      uni.setStorageSync('userInfo', userInfo)
      uni.setStorageSync('stores', userStores)
      if (authStore.currentStore) uni.setStorageSync('currentStore', authStore.currentStore)
      uni.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => { uni.reLaunch({ url: '/pages/ai/index' }) }, 500)
    } else {
      uni.showToast({ title: d.error || '登录失败', icon: 'none' })
    }
  } catch (e: any) {
    uni.showToast({ title: e?.message || '登录失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <view class="login-page">
    <!-- Logo -->
    <view class="logo-section">
      <image class="logo-img" src="/static/image/logo.png" mode="aspectFit" />
      <text class="logo-title">述椿云宿</text>
      <text class="logo-sub">AI 智能酒店管理</text>
    </view>

    <!-- 表单卡片 -->
    <view class="form-card">
      <!-- Tab 切换 -->
      <view class="login-tabs">
        <view :class="['tab', { active: loginMode === 'password' }]" @click="loginMode = 'password'">
          <text>密码登录</text>
        </view>
        <view :class="['tab', { active: loginMode === 'sms' }]" @click="loginMode = 'sms'">
          <text>验证码登录</text>
        </view>
      </view>

      <!-- 手机号 -->
      <view class="input-wrap">
        <text class="input-prefix">+86</text>
        <input v-model="phone" class="input-field" type="number" placeholder="请输入手机号" maxlength="11" />
      </view>

      <!-- 密码模式 -->
      <view v-if="loginMode === 'password'" class="input-wrap">
        <text class="input-prefix">🔒</text>
        <input v-model="password" class="input-field" :password="!showPassword" placeholder="请输入密码" />
        <text class="toggle-pwd" @click="showPassword = !showPassword">{{ showPassword ? '🙈' : '👁️' }}</text>
      </view>

      <!-- 验证码模式 -->
      <view v-if="loginMode === 'sms'" class="input-wrap">
        <text class="input-prefix">✉️</text>
        <input v-model="smsCode" class="input-field" type="number" placeholder="请输入验证码" maxlength="6" />
        <text :class="['code-btn', { disabled: codeCountdown > 0 }]" @click="handleSendSms">{{ codeBtnText }}</text>
      </view>

      <!-- 登录按钮 -->
      <view class="login-btn" :class="{ loading }" @click="handleLogin">
        <text class="btn-text">{{ loading ? '登录中...' : '登 录' }}</text>
      </view>

      <!-- 底部链接 -->
      <view class="footer-links">
        <text class="link">忘记密码？</text>
        <text class="divider">|</text>
        <text class="link">联系客服</text>
      </view>
    </view>

    <!-- 版权 -->
    <view class="bottom">
      <text>© 2026 述椿云宿 · v1.0.0</text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.login-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #07C160 0%, #05A04A 40%, #F5F6FA 40%);
  display: flex; flex-direction: column;
}

/* Logo */
.logo-section {
  display: flex; flex-direction: column; align-items: center;
  padding-top: calc(120rpx + env(safe-area-inset-top));
  padding-bottom: 60rpx;
}
.logo-img { width: 160rpx; height: 160rpx; border-radius: 36rpx; margin-bottom: 24rpx; box-shadow: 0 8rpx 40rpx rgba(0,0,0,0.2); }
.logo-title { font-size: 44rpx; font-weight: 700; color: #fff; margin-bottom: 8rpx; }
.logo-sub { font-size: 26rpx; color: rgba(255,255,255,0.85); }

/* 表单卡片 */
.form-card {
  background: #fff; margin: 0 40rpx; border-radius: 32rpx;
  padding: 40rpx 36rpx; box-shadow: 0 8rpx 48rpx rgba(0,0,0,0.1);
}

/* Tab */
.login-tabs { display: flex; gap: 0; margin-bottom: 40rpx; }
.tab {
  flex: 1; text-align: center; padding: 16rpx 0; font-size: 30rpx; color: #999;
  border-bottom: 4rpx solid transparent; transition: all 0.3s;
}
.tab.active { color: #07C160; font-weight: 600; border-bottom-color: #07C160; }

/* 输入框 */
.input-wrap {
  display: flex; align-items: center; height: 96rpx;
  background: #F5F6FA; border-radius: 24rpx; padding: 0 24rpx; margin-bottom: 24rpx;
}
.input-prefix { font-size: 24rpx; color: #999; margin-right: 16rpx; flex-shrink: 0; font-weight: 500; }
.input-field { flex: 1; font-size: 28rpx; color: #191919; height: 100%; }
.toggle-pwd { font-size: 28rpx; padding: 8rpx; flex-shrink: 0; }
.code-btn {
  font-size: 24rpx; color: #07C160; font-weight: 500; flex-shrink: 0; padding: 8rpx 16rpx;
  white-space: nowrap;
  &.disabled { color: #ccc; }
}

/* 登录按钮 */
.login-btn {
  margin-top: 40rpx; height: 96rpx; background: #07C160; border-radius: 48rpx;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8rpx 28rpx rgba(7,193,96,0.35);
  &.loading { opacity: 0.7; }
}
.btn-text { font-size: 32rpx; font-weight: 600; color: #fff; letter-spacing: 8rpx; }

/* 底部链接 */
.footer-links { display: flex; justify-content: center; margin-top: 32rpx; gap: 24rpx; }
.link { font-size: 26rpx; color: #888; }
.divider { color: #ddd; }

/* 版权 */
.bottom { text-align: center; padding: 48rpx; margin-top: auto;
  text { font-size: 22rpx; color: #B0B0B0; }
}
</style>
