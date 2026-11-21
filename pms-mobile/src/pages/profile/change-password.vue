<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const phone = computed(() => authStore.userInfo?.phone || '')

const smsCode = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const sending = ref(false)
const codeCountdown = ref(0)
let timer: any = null

const passwordStrength = computed(() => {
  const pwd = newPassword.value
  if (!pwd) return { level: 0, text: '', color: '' }
  if (pwd.length < 6) return { level: 1, text: '弱', color: '#FA5151' }
  let score = 0
  if (pwd.length >= 8) score++
  if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++
  if (/\d/.test(pwd)) score++
  if (/[^a-zA-Z\d]/.test(pwd)) score++
  if (score <= 1) return { level: 1, text: '弱', color: '#FA5151' }
  if (score === 2) return { level: 2, text: '中', color: '#FF9500' }
  return { level: 3, text: '强', color: '#07C160' }
})

async function handleSendCode() {
  if (codeCountdown.value > 0) return
  sending.value = true
  try {
    const res: any = await uni.request({
      url: 'http://132.232.166.40:20002/api/auth/send-sms', method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { phone: phone.value }
    })
    const d = res.data as any
    if (d.success) {
      uni.showToast({ title: '验证码已发送', icon: 'success' })
      codeCountdown.value = 60
      timer = setInterval(() => { codeCountdown.value--; if (codeCountdown.value <= 0) { clearInterval(timer); timer = null } }, 1000)
    } else {
      uni.showToast({ title: d.error || '发送失败', icon: 'none' })
    }
  } catch { uni.showToast({ title: '发送失败', icon: 'none' }) }
  finally { sending.value = false }
}

async function handleSubmit() {
  if (!smsCode.value) { uni.showToast({ title: '请输入验证码', icon: 'none' }); return }
  if (!newPassword.value) { uni.showToast({ title: '请输入新密码', icon: 'none' }); return }
  if (newPassword.value.length < 6) { uni.showToast({ title: '新密码至少6位', icon: 'none' }); return }
  if (newPassword.value !== confirmPassword.value) { uni.showToast({ title: '两次密码输入不一致', icon: 'none' }); return }

  submitting.value = true
  try {
    const res: any = await uni.request({
      url: 'http://132.232.166.40:20002/api/auth/reset-password', method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { phone: phone.value, code: smsCode.value, newPassword: newPassword.value }
    })
    const d = res.data as any
    if (d.success) {
      uni.showToast({ title: '密码修改成功，请重新登录', icon: 'success' })
      setTimeout(() => authStore.logout(), 1000)
    } else {
      uni.showToast({ title: d.error || '修改失败', icon: 'none' })
    }
  } catch { uni.showToast({ title: '修改失败', icon: 'none' }) }
  finally { submitting.value = false }
}
</script>

<template>
  <view class="page">
    <scroll-view class="scroll" scroll-y>
      <view class="card">
        <!-- 手机号 -->
        <view class="fi"><text class="fl">手机号</text><text class="fv">{{ phone }}</text></view>
        <view class="fd" />

        <!-- 验证码 -->
        <view class="fi">
          <text class="fl">验证码</text>
          <input v-model="smsCode" class="fin" type="number" placeholder="请输入验证码" maxlength="6" />
          <text :class="['code-btn', { disabled: codeCountdown > 0 }]" @tap="handleSendCode">
            {{ codeCountdown > 0 ? `${codeCountdown}s` : sending ? '发送中' : '获取验证码' }}
          </text>
        </view>
        <view class="fd" />

        <!-- 新密码 -->
        <view class="fi">
          <text class="fl">新密码</text>
          <input v-model="newPassword" class="fin" type="password" placeholder="至少6位" maxlength="20" />
        </view>

        <!-- 密码强度 -->
        <view v-if="newPassword" class="strength">
          <view class="s-bar"><view class="s-fill" :style="{ width: (passwordStrength.level/3)*100 + '%', background: passwordStrength.color }" /></view>
          <text class="s-text" :style="{ color: passwordStrength.color }">{{ passwordStrength.text }}</text>
        </view>

        <view class="fd" />

        <!-- 确认密码 -->
        <view class="fi">
          <text class="fl">确认密码</text>
          <input v-model="confirmPassword" class="fin" type="password" placeholder="再次输入" maxlength="20" />
        </view>
        <view v-if="confirmPassword && newPassword !== confirmPassword" class="err"><text>两次密码不一致</text></view>
      </view>

      <view class="hint"><text>验证码将发送到您账号绑定的手机号</text></view>

      <view :class="['btn', { loading: submitting }]" @tap="handleSubmit">
        <text>{{ submitting ? '提交中...' : '确认修改' }}</text>
      </view>
    </scroll-view>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.scroll { padding: 24rpx; }
.card { background: #fff; border-radius: 24rpx; padding: 0 24rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.fi { display: flex; align-items: center; min-height: 96rpx; gap: 20rpx; }
.fl { font-size: 28rpx; color: #191919; width: 120rpx; flex-shrink: 0; }
.fv { font-size: 28rpx; color: #888; flex: 1; }
.fin { flex: 1; font-size: 28rpx; color: #191919; height: 96rpx; }
.fd { height: 2rpx; background: #EDEDED; }
.code-btn { font-size: 24rpx; color: #07C160; font-weight: 500; padding: 8rpx 16rpx; white-space: nowrap; }
.code-btn.disabled { color: #ccc; }
.strength { display: flex; align-items: center; gap: 16rpx; padding: 8rpx 0 16rpx 140rpx; }
.s-bar { flex: 1; height: 6rpx; background: #EDEDED; border-radius: 3rpx; overflow: hidden; }
.s-fill { height: 100%; border-radius: 3rpx; }
.s-text { font-size: 22rpx; width: 40rpx; }
.err { padding: 8rpx 0 16rpx 140rpx; }
.err text { font-size: 22rpx; color: #FA5151; }
.hint { padding: 24rpx 8rpx; }
.hint text { font-size: 24rpx; color: #888; }
.btn { width: 100%; height: 96rpx; background: #07C160; border-radius: 48rpx; display: flex; align-items: center; justify-content: center; margin-top: 8rpx; }
.btn text { font-size: 32rpx; color: #fff; font-weight: 600; }
.btn.loading { opacity: 0.7; }
</style>
