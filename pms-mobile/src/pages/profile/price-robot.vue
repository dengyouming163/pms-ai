<!-- 已由 定价中心页 pages/profile/pricing-center 替代，待清理 -->
<!-- 收益管家 — 一键自动调价：开关 + 状态 + 最低卖价 + 熔断 -->
<template>
  <view class="page">
    <!-- 首次说明弹层 -->
    <view v-if="showIntro" class="overlay" @click="closeIntro">
      <view class="intro-sheet" @click.stop>
        <text class="intro-title">🤖 智能自动调价</text>
        <text class="intro-desc">开启后，系统每天根据「还剩多少房」自动调整价格——卖得快就涨、卖得慢就降，帮你多赚钱。你什么都不用做。</text>
        <view class="intro-points">
          <text class="point">· 每天自动定价，不用你操心</text>
          <text class="point">· 可设「最低卖价」兜底，价格不会乱</text>
          <text class="point">· 有特殊情况随时点「暂停」</text>
        </view>
        <view class="intro-btn" @click="closeIntro"><text class="intro-btn-text">知道了，去开启</text></view>
      </view>
    </view>

    <!-- 主页面 -->
    <view class="hero" :class="{ fused: fused }">
      <view class="hero-glow" />
      <view class="hero-top">
        <view class="hero-title-wrap">
          <text class="hero-title">🤖 智能自动调价</text>
        </view>
        <switch class="hero-switch" :checked="autoConfirm" color="#07C160" @change="onToggle" />
      </view>
      <view class="hero-desc">{{ autoConfirm ? '已开启 · 系统每天自动帮你调价' : '已关闭 · 手动设置价格' }}</view>
      <view class="hero-stats">
        <view class="stat">
          <text class="stat-num">{{ stats?.executedCount || 0 }}</text>
          <text class="stat-label">今天已调价</text>
        </view>
        <view class="stat-divider" />
        <view class="stat">
          <text class="stat-num">¥{{ stats?.avgPrice ?? '-' }}</text>
          <text class="stat-label">平均售价</text>
        </view>
      </view>
    </view>

    <!-- 最低卖价 -->
    <view class="card">
      <text class="card-title">最低卖价（选填）</text>
      <view class="floor-row">
        <view class="input-wrap"><text class="prefix">¥</text>
          <input class="floor-input" type="number" v-model="floorInput" @blur="saveFloor" placeholder="不填 = 不限制" />
        </view>
      </view>
      <text class="card-hint">价格永远不会低于这个数。不填 = 不限制。</text>
    </view>

    <!-- 熔断 -->
    <view v-if="autoConfirm && !fused" class="card fuse-card">
      <view class="fuse-btn" @click="handleFuse"><text class="fuse-text">🛑 暂停今天的自动调价</text></view>
      <text class="card-hint center">遇到特殊情况（要清房、有大客户），先用它把今天的自动调价停掉。</text>
    </view>
    <view v-if="fused" class="fused-tip">今天已暂停自动调价，明天 6:00 会自动恢复。</view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { getRobotSettings, updateRobotSettings } from '@/api/modules/price-robot'
import { getRobotStats, getTodayAuth, fuseRobotAuth } from '@/api/modules/price-robot'

const showIntro = ref(false)
const autoConfirm = ref(false)
const floorInput = ref('')
const floorLoaded = ref(false)
const stats = ref<any>(null)
const todayAuth = ref<any[]>([])
const saving = ref(false)

const fused = computed(() => todayAuth.value.some((a: any) => a.status === 'fused'))

async function load() {
  try {
    const [s, st, auth] = await Promise.all([
      getRobotSettings(), getRobotStats(), getTodayAuth(),
    ])
    autoConfirm.value = s?.autoConfirm === true
    floorLoaded.value = true
    floorInput.value = s?.globalFloor != null ? String(s.globalFloor) : ''
    stats.value = st || null
    todayAuth.value = Array.isArray(auth) ? auth : []
  } catch {}
}

async function onToggle(e: any) {
  const next = !!e.detail?.value
  if (next && !showIntro.value && !sessionStorage.getItem('pr-intro-shown')) {
    showIntro.value = true
    return
  }
  await persistToggle(next)
}

function closeIntro() {
  showIntro.value = false
  sessionStorage.setItem('pr-intro-shown', '1')
  persistToggle(true)
}

async function persistToggle(next: boolean) {
  if (saving.value) return
  saving.value = true
  const prev = autoConfirm.value
  try {
    await updateRobotSettings({ autoConfirm: next })
    autoConfirm.value = next
    uni.showToast({ title: next ? '已开启自动调价' : '已关闭自动调价', icon: 'success' })
  } catch { uni.showToast({ title: '操作失败', icon: 'none' }); autoConfirm.value = prev }
  finally { saving.value = false }
}

async function saveFloor() {
  if (!floorLoaded.value) return
  const v = floorInput.value
  const floor = v === '' ? null : Number(v)
  if (floor != null && !(floor >= 0)) { uni.showToast({ title: '最低卖价需 ≥ 0', icon: 'none' }); return }
  try {
    await updateRobotSettings({ globalFloor: floor })
    uni.showToast({ title: floor == null ? '已清除最低卖价' : '已保存最低卖价', icon: 'success' })
  } catch { uni.showToast({ title: '保存失败', icon: 'none' }) }
}

async function handleFuse() {
  const auth = todayAuth.value.find((a: any) => a.status === 'confirmed')
  if (!auth) { uni.showToast({ title: '今日暂无执行中的计划', icon: 'none' }); return }
  uni.showModal({
    title: '暂停确认',
    content: '将停掉今天所有的自动调价（明天 6:00 自动恢复），确定吗？',
    success: async (r) => {
      if (!r.confirm) return
      try { await fuseRobotAuth(auth.id); uni.showToast({ title: '已暂停', icon: 'success' }); await load() }
      catch { uni.showToast({ title: '暂停失败', icon: 'none' }) }
    },
  })
}

onMounted(load)
</script>

<style scoped lang="scss">
.page { min-height: 100vh; background: #F4F6F8; padding: 24rpx; padding-bottom: calc(48rpx + env(safe-area-inset-bottom)); }
.hero { position: relative; background: linear-gradient(135deg, #07C160 0%, #0EA5A5 100%); border-radius: 28rpx; padding: 36rpx 32rpx; color: #fff; margin-bottom: 24rpx; overflow: hidden; box-shadow: 0 12rpx 32rpx rgba(7,193,96,0.22); }
.hero.fused { background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); }
.hero-glow { position: absolute; right: -60rpx; top: -80rpx; width: 280rpx; height: 280rpx; border-radius: 50%; background: rgba(255,255,255,0.10); }
.hero-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12rpx; position: relative; z-index: 1; }
.hero-title-wrap { display: flex; align-items: center; gap: 12rpx; flex: 1; }
.hero-title { font-size: 38rpx; font-weight: 700; }
.hero-switch { transform: scale(0.9); }
.hero-desc { font-size: 24rpx; opacity: 0.9; margin-bottom: 20rpx; position: relative; z-index: 1; }
.hero-stats { display: flex; align-items: center; background: rgba(255,255,255,0.14); border-radius: 20rpx; padding: 20rpx 0; position: relative; z-index: 1; }
.stat { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4rpx; }
.stat-num { font-size: 32rpx; font-weight: 700; }
.stat-label { font-size: 20rpx; opacity: 0.85; }
.stat-divider { width: 1rpx; height: 40rpx; background: rgba(255,255,255,0.25); }
.card { background: #fff; border-radius: 24rpx; padding: 28rpx; margin-bottom: 24rpx; box-shadow: 0 6rpx 24rpx rgba(15,23,42,0.05); }
.card-title { font-size: 28rpx; font-weight: 600; color: #1F2937; display: block; margin-bottom: 16rpx; }
.card-hint { font-size: 22rpx; color: #94A3B8; display: block; margin-top: 12rpx; line-height: 1.5; }
.card-hint.center { text-align: center; }
.floor-row { display: flex; align-items: center; }
.input-wrap { display: flex; align-items: center; background: #F4F7F6; border-radius: 16rpx; padding: 0 20rpx; height: 88rpx; width: 260rpx; }
.prefix { font-size: 28rpx; color: #94A3B8; margin-right: 8rpx; }
.floor-input { flex: 1; font-size: 30rpx; font-weight: 600; color: #1F2937; height: 100%; }
.fuse-card { border: 1rpx solid rgba(239,68,68,0.15); }
.fuse-btn { background: rgba(239,68,68,0.08); border-radius: 16rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.fuse-text { color: #EF4444; font-size: 28rpx; font-weight: 600; }
.fused-tip { text-align: center; color: #EF4444; font-size: 24rpx; padding: 8rpx 0 24rpx; }
/* 首次引导 */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1200; display: flex; align-items: center; justify-content: center; }
.intro-sheet { width: 86%; background: #fff; border-radius: 28rpx; padding: 48rpx 36rpx; display: flex; flex-direction: column; gap: 20rpx; }
.intro-title { font-size: 36rpx; font-weight: 700; color: #1F2937; text-align: center; }
.intro-desc { font-size: 28rpx; color: #4B5563; line-height: 1.6; text-align: center; }
.intro-points { display: flex; flex-direction: column; gap: 12rpx; }
.point { font-size: 26rpx; color: #6B7280; }
.intro-btn { background: #07C160; border-radius: 40rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.intro-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }
</style>
