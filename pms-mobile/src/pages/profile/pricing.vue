<!-- 已由 定价中心页 pages/profile/pricing-center 替代，待清理 -->
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getPricingRules, updatePricingRule } from '@/api/modules/pricing'
import type { PriceRule } from '@/types/user'

const loading = ref(true)
const rules = ref<PriceRule[]>([])
const savingId = ref('')

// 每房型编辑态：日常价 + 周末/节假日加价%（从现有规则派生，尊重已有差异化定价）
interface EditState {
  base: number
  weekendPct: number
  holidayPct: number
  minPrice: number
}

const edits = ref<Record<string, EditState>>({})

function derivePct(price: number | undefined, base: number): number {
  if (!price || !base) return 0
  return Math.round((price / base - 1) * 100)
}

function initEdit(rule: PriceRule) {
  const base = rule.basePrice || 0
  edits.value[rule.id] = {
    base,
    weekendPct: derivePct(rule.weekendPrice, base) || 20,
    holidayPct: derivePct(rule.holidayPrice, base) || 50,
    minPrice: rule.minPrice || 0,
  }
}

function weekendPrice(e: EditState) { return Math.round(e.base * (1 + e.weekendPct / 100)) }
function holidayPrice(e: EditState) { return Math.round(e.base * (1 + e.holidayPct / 100)) }

async function loadData() {
  loading.value = true
  try {
    const list = await getPricingRules()
    rules.value = Array.isArray(list) ? list : []
    rules.value.forEach(initEdit)
  } catch { uni.showToast({ title: '加载失败', icon: 'none' }) }
  finally { loading.value = false }
}

async function handleSave(rule: PriceRule) {
  const e = edits.value[rule.id]
  if (!e || !(e.base > 0)) { uni.showToast({ title: '日常价需大于 0', icon: 'none' }); return }
  savingId.value = rule.id
  try {
    await updatePricingRule(rule.id, {
      basePrice: e.base,
      weekdayPrice: e.base,
      weekendPrice: weekendPrice(e),
      holidayPrice: holidayPrice(e),
      minPrice: e.minPrice,
    })
    uni.showToast({ title: '已保存', icon: 'success' })
  } catch { uni.showToast({ title: '保存失败', icon: 'none' }) }
  finally { savingId.value = '' }
}

onMounted(loadData)
</script>

<template>
  <view class="pricing-page">
    <view v-if="loading" class="empty"><text class="empty-text">加载中...</text></view>

    <view v-else-if="rules.length === 0" class="empty">
      <text class="empty-text">还没有房型价格，先去「房型管理」添加房型吧</text>
    </view>

    <view v-else class="content">
      <view class="tip">设置每个房型的日常价；周末和节假日预订多，系统会按你填的比例自动加价，改 0 表示不加。</view>

      <view v-for="rule in rules" :key="rule.id" class="price-card">
        <text class="room-name">{{ rule.roomType }}</text>

        <view class="form-item">
          <text class="f-label">日常价（每晚）</text>
          <view class="input-wrap"><text class="prefix">¥</text>
            <input class="f-input" type="number" v-model.number="edits[rule.id].base" /></view>
        </view>

        <view class="form-item">
          <text class="f-label">周末加价</text>
          <view class="input-wrap pct"><input class="f-input" type="number" v-model.number="edits[rule.id].weekendPct" /><text class="suffix">%</text></view>
          <text v-if="edits[rule.id] && edits[rule.id].base > 0" class="f-hint">周五/周六晚自动卖 ¥{{ weekendPrice(edits[rule.id]) }}</text>
        </view>

        <view class="form-item">
          <text class="f-label">节假日加价</text>
          <view class="input-wrap pct"><input class="f-input" type="number" v-model.number="edits[rule.id].holidayPct" /><text class="suffix">%</text></view>
          <text v-if="edits[rule.id] && edits[rule.id].base > 0" class="f-hint">节假日自动卖 ¥{{ holidayPrice(edits[rule.id]) }}</text>
        </view>

        <view v-if="edits[rule.id] && edits[rule.id].base > 0" class="preview">
          按当前设置：工作日 ¥{{ edits[rule.id].base }} · 周末 ¥{{ weekendPrice(edits[rule.id]) }} · 节假日 ¥{{ holidayPrice(edits[rule.id]) }}
        </view>

        <view class="save-btn" :class="{ saving: savingId === rule.id }" @click="handleSave(rule)">
          <text class="save-btn-text">{{ savingId === rule.id ? '保存中...' : '保存' }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.pricing-page { min-height: 100vh; background: #F5F6FA; }
.content { padding: 24rpx; }
.tip { font-size: 24rpx; color: #6B7C8E; background: rgba(7,193,96,0.06); border-radius: 16rpx; padding: 20rpx 24rpx; margin-bottom: 24rpx; line-height: 1.5; }
.price-card { background: #fff; border-radius: 24rpx; padding: 28rpx; margin-bottom: 20rpx; box-shadow: 0 2rpx 16rpx rgba(0,0,0,0.04); }
.room-name { font-size: 30rpx; font-weight: 600; color: #191919; display: block; margin-bottom: 24rpx; }
.form-item { margin-bottom: 20rpx; }
.f-label { font-size: 24rpx; color: #888; display: block; margin-bottom: 10rpx; }
.input-wrap { display: flex; align-items: center; background: #F5F6FA; border-radius: 16rpx; padding: 0 20rpx; height: 84rpx; }
.input-wrap.pct { width: 220rpx; }
.prefix { font-size: 28rpx; color: #888; margin-right: 8rpx; }
.suffix { font-size: 28rpx; color: #888; margin-left: 8rpx; }
.f-input { flex: 1; font-size: 30rpx; font-weight: 600; color: #191919; height: 100%; }
.f-hint { font-size: 22rpx; color: #576B95; margin-top: 8rpx; display: block; }
.preview { font-size: 24rpx; color: #191919; background: #F0F7F2; border-radius: 12rpx; padding: 16rpx 20rpx; margin-bottom: 20rpx; }
.save-btn { background: #07C160; border-radius: 40rpx; height: 80rpx; display: flex; align-items: center; justify-content: center; }
.save-btn.saving { opacity: 0.7; }
.save-btn-text { color: #fff; font-size: 28rpx; font-weight: 500; }
.empty { text-align: center; padding: 120rpx 0; font-size: 28rpx; color: #888; }
</style>
