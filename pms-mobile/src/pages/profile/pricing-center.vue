<!-- 定价中心（移动端）— 今日推荐卡 + 采纳预览 + 手动设置弹层 + 未来 7 天价格一览 -->
<template>
  <view class="page">
    <!-- 顶部：标题 + 手动设置入口 -->
    <view class="head">
      <view class="head-left">
        <text class="head-title">今日推荐</text>
        <text class="head-sub">智能推荐 · 一键同步 OTA</text>
      </view>
      <view class="head-entry" @click="openSettings">
        <text class="head-entry-text">手动设置 ›</text>
      </view>
    </view>

    <!-- 消息条 -->
    <view v-if="toast" class="toast-bar" :class="toast.type">
      <text class="toast-text">{{ toast.text }}</text>
    </view>

    <!-- 推荐关闭提示 -->
    <view v-if="today && !today.recommendationEnabled" class="rec-off-tip">
      <text class="rec-off-text">⚠ 智能推荐已关闭，可在「手动设置」开启</text>
    </view>

    <!-- 日期 label -->
    <view v-if="today" class="date-row">
      <text class="date-label">📅 {{ today.dateLabel }}</text>
      <text v-if="soldOutCount > 0" class="soldout-label">{{ soldOutCount }} 个房型已满房</text>
    </view>

    <!-- 今日推荐列表 -->
    <view v-if="loadingToday" class="loading-card"><text class="loading-text">加载中...</text></view>
    <template v-else>
      <view v-if="visibleRooms.length === 0 && rooms.length > 0 && soldOutCount === rooms.length" class="empty-card">
        <text class="empty-text">今日所有房型均已满房</text>
      </view>
      <view v-else-if="visibleRooms.length === 0" class="empty-card">
        <text class="empty-text">今日暂无推荐，所有房型价格均已最优</text>
      </view>
      <template v-else>
        <view v-if="noChange.length > 0" class="nochange-label">{{ noChange.length }} 个房型今日无需调整</view>

        <view v-for="room in visibleRooms" :key="room.roomTypeId" class="card rec-card">
          <!-- 房型名 + 节假日标 + 已采纳标 -->
          <view class="rec-head">
            <view class="rec-name-wrap">
              <text class="rec-name">{{ room.roomTypeName }}</text>
              <text v-if="room.holiday" class="holiday-tag">{{ room.holiday }}</text>
            </view>
            <text v-if="adopted(room)" class="adopted-tag">已采纳 ¥{{ room.currentPrice }}</text>
          </view>

          <!-- 价格区 -->
          <view v-if="adopted(room)" class="price-row">
            <text class="price-main">¥{{ room.currentPrice }}</text>
            <text class="price-cross">默认 ¥{{ room.defaultPrice }}</text>
          </view>
          <view v-else class="price-row">
            <text class="price-cross">¥{{ room.currentPrice }}</text>
            <text class="price-main green">¥{{ room.suggestedPrice }}</text>
            <text v-if="room.change !== 0" class="change-tag" :class="room.change > 0 ? 'up' : 'down'">
              {{ room.change > 0 ? '▲ +' : '▼ ' }}{{ changePct(room) }}%
            </text>
          </view>

          <!-- 数据区：剩余 / 入住率 / 底价 -->
          <view class="data-row">
            <text class="data-item">剩余 <text class="strong">{{ room.remaining }}/{{ room.total }}</text> 间</text>
            <text class="data-item">入住率 <text class="strong">{{ room.occupancyPct }}%</text></text>
            <text v-if="room.minPrice != null" class="data-item">底价 <text class="strong">¥{{ room.minPrice }}</text></text>
          </view>

          <!-- 推荐理由 -->
          <view v-if="room.reasons && room.reasons.length" class="reason-list">
            <view v-for="(r, i) in room.reasons" :key="i" class="reason-item">
              <text class="reason-text">{{ r }}</text>
            </view>
          </view>

          <!-- 操作 -->
          <view class="rec-ops">
            <view v-if="adopted(room)" class="undo-btn" @click="handleUndo(room)">
              <text class="undo-btn-text">{{ undoId === room.roomTypeId ? '撤销中...' : '撤销采纳' }}</text>
            </view>
            <view v-else class="adopt-btn" @click="openAdopt(room)">
              <text class="adopt-btn-text">采纳</text>
            </view>
          </view>
        </view>
      </template>
    </template>

    <!-- 采纳预览弹层 -->
    <t-popup v-model:visible="adoptVisible" placement="center" :closeOnOverlayClick="true">
      <view v-if="adoptRoom" class="adopt-pop">
        <view class="adopt-head">
          <text class="adopt-title">采纳推荐</text>
          <text class="adopt-close" @click="adoptVisible = false">✕</text>
        </view>
        <view class="adopt-body">
          <view class="adopt-price-row">
            <text class="adopt-room-name">{{ adoptRoom.roomTypeName }}</text>
            <text class="adopt-price">¥{{ adoptRoom.suggestedPrice }}</text>
          </view>
          <view class="adopt-channels">
            <text class="adopt-ch-label">确认后将自动同步到以下渠道</text>
            <view class="adopt-ch-list">
              <text v-if="previewLoading" class="adopt-ch-empty">加载渠道中…</text>
              <template v-else>
                <text v-for="ch in previewChannels" :key="ch" class="adopt-ch-tag">{{ ch }}</text>
                <text v-if="previewChannels.length === 0" class="adopt-ch-empty">未配置渠道</text>
              </template>
            </view>
          </view>
          <view v-if="adoptRoom.reasons && adoptRoom.reasons.length" class="adopt-reasons">
            <text v-for="(r, i) in adoptRoom.reasons" :key="i" class="adopt-reason">{{ r }}</text>
          </view>
        </view>
        <view class="adopt-foot">
          <view class="pop-btn cancel" @click="adoptVisible = false"><text class="pop-btn-text gray">取消</text></view>
          <view class="pop-btn confirm" :class="{ disabled: adopting }" @click="confirmAdopt">
            <text class="pop-btn-text white">{{ adopting ? '同步中…' : '确认采纳 ¥' + adoptRoom.suggestedPrice }}</text>
          </view>
        </view>
      </view>
    </t-popup>

    <!-- 手动设置弹层（右侧抽屉） -->
    <t-popup v-model:visible="settingsVisible" placement="right" :closeOnOverlayClick="true">
      <view class="settings-sheet">
        <view class="sheet-head">
          <text class="sheet-title">手动设置</text>
          <text class="sheet-close" @click="settingsVisible = false">✕</text>
        </view>
        <scroll-view scroll-y class="sheet-scroll">
          <view v-if="settingsLoading" class="loading-tip"><text>加载中...</text></view>
          <template v-else-if="settings">
            <!-- 渠道 / 节假日加价 / 推荐开关 -->
            <view class="card s-card">
              <text class="s-label">同步渠道</text>
              <view class="chips">
                <view
                  v-for="ch in CHANNEL_OPTIONS"
                  :key="ch"
                  class="chip"
                  :class="{ on: channels.includes(ch) }"
                  @click="toggleChannel(ch)"
                >
                  <view class="chip-dot" :class="{ on: channels.includes(ch) }"></view>
                  <text class="chip-text" :class="{ on: channels.includes(ch) }">{{ ch }}</text>
                </view>
              </view>

              <text class="s-label">节假日加价</text>
              <view class="input-wrap pct">
                <input class="f-input" type="number" v-model="holidayMarkup" placeholder="0" />
                <text class="suffix">%</text>
              </view>
              <text class="s-hint">节假日价 = 平日/周末价 ×（1 + 加价%）</text>

              <view class="s-switch-row">
                <text class="s-label">智能推荐</text>
                <switch :checked="recommendationEnabled" color="#07C160" @change="onRecommendChange" />
              </view>
              <text class="s-hint">开启后每天自动生成房型推荐卡</text>
            </view>

            <!-- 每房型基础价 -->
            <view class="card s-card">
              <text class="s-label">基础价格</text>
              <text class="s-hint">留空表示不修改该项；最低价是所有促销与动态调价的保护底线。</text>
              <view v-for="b in (settings.basePrices || [])" :key="b.roomTypeId" class="room-price">
                <view class="room-price-head">
                  <text class="room-price-name">{{ b.roomTypeName }}</text>
                  <text class="room-price-cur">当前 ¥{{ b.weekdayPrice }}/{{ b.weekendPrice }}</text>
                </view>
                <view class="room-price-grid">
                  <view class="rp-item">
                    <text class="rp-label">平日价</text>
                    <view class="input-wrap sm">
                      <input class="f-input" type="number" :value="prices[b.roomTypeId] ? prices[b.roomTypeId].weekday : ''" placeholder="不修改" @input="onPriceInput(b, 'weekday', $event)" />
                    </view>
                  </view>
                  <view class="rp-item">
                    <text class="rp-label">周末价</text>
                    <view class="input-wrap sm">
                      <input class="f-input" type="number" :value="prices[b.roomTypeId] ? prices[b.roomTypeId].weekend : ''" placeholder="不修改" @input="onPriceInput(b, 'weekend', $event)" />
                    </view>
                  </view>
                  <view class="rp-item">
                    <text class="rp-label">最低价</text>
                    <view class="input-wrap sm">
                      <input class="f-input" type="number" :value="prices[b.roomTypeId] ? prices[b.roomTypeId].min : ''" placeholder="不修改" @input="onPriceInput(b, 'min', $event)" />
                    </view>
                  </view>
                </view>
              </view>
            </view>

            <view class="save-btn" :class="{ disabled: saving }" @click="saveSettings">
              <text class="save-btn-text">{{ saving ? '保存中...' : '保存设置' }}</text>
            </view>

            <!-- 未来 7 天价格一览 -->
            <view class="card s-card">
              <text class="s-label">未来 7 天价格一览</text>
              <text class="s-hint">已采纳价带标记</text>
              <view v-if="overview.length === 0" class="empty-tip"><text>暂无价格数据</text></view>
              <scroll-view v-else scroll-x class="ov-scroll">
                <view class="ov-table" :style="{ minWidth: ovMinWidth + 'px' }">
                  <view class="ov-row ov-head">
                    <view class="ov-date-col"><text class="ov-head-text">日期</text></view>
                    <view v-for="b in (settings.basePrices || [])" :key="b.roomTypeId" class="ov-price-col">
                      <text class="ov-head-text">{{ b.roomTypeName }}</text>
                    </view>
                  </view>
                  <view v-for="day in overview" :key="day.date" class="ov-row" :class="{ 'ov-holiday': isHoliday(day), 'ov-weekend': isWeekend(day) }">
                    <view class="ov-date-col">
                      <text class="ov-date">{{ day.date.slice(5) }}</text>
                      <text v-if="day.label" class="ov-tag" :class="isHoliday(day) ? 'tag-hol' : 'tag-wend'">{{ day.label }}</text>
                    </view>
                    <view v-for="b in (settings.basePrices || [])" :key="b.roomTypeId" class="ov-price-col">
                      <view v-if="getCell(day.date, b.roomTypeId)" class="ov-cell">
                        <text class="ov-price" :class="{ adopted: getCell(day.date, b.roomTypeId).adopted }">¥{{ getCell(day.date, b.roomTypeId).price }}</text>
                        <text v-if="getCell(day.date, b.roomTypeId).adopted" class="adopted-dot"></text>
                      </view>
                      <text v-else class="ov-price dash">—</text>
                    </view>
                  </view>
                </view>
              </scroll-view>
              <view class="ov-legend">
                <view class="legend-item"><view class="dot green"></view><text class="legend-text">已采纳价</text></view>
                <view class="legend-item"><view class="swatch orange"></view><text class="legend-text">节假日</text></view>
                <view class="legend-item"><view class="swatch blue"></view><text class="legend-text">周末</text></view>
              </view>
            </view>
          </template>
        </scroll-view>
      </view>
    </t-popup>
  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { pricingCenterApi } from '@/api/modules/pricing-center'
import type {
  PricingTodayRoom,
  PricingTodayData,
  PricingSettings,
  PricingOverviewDay,
} from '@/api/modules/pricing-center'

// ===== 消息条（采纳/撤销/保存成功或失败提示，2.5s 自动消失）=====
const toast = ref<{ type: 'success' | 'error'; text: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
function showToast(text: string, type: 'success' | 'error' = 'success') {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { type, text }
  toastTimer = setTimeout(() => { toast.value = null }, 2500)
}
/** 统一取后端错误提示（request 层 { success:false } 会 reject 原始响应，err.error 即后端提示语） */
function errText(err: any, fallback: string): string {
  return (err && err.error) || (err && err.message) || fallback
}

// ===== 今日推荐 =====
const today = ref<PricingTodayData | null>(null)
const loadingToday = ref(true)
const undoId = ref('')

const rooms = computed(() => today.value?.rooms || [])
// 出卡房型：有建议（suggestedPrice 非空）且未满房；已采纳的也展示（可撤销）
const visibleRooms = computed(() =>
  rooms.value.filter((r) => (!r.soldOut && r.suggestedPrice !== null) || !!r.dailySource))
const noChange = computed(() => rooms.value.filter((r) => !r.soldOut && r.suggestedPrice === null && !r.dailySource))
const soldOutCount = computed(() => rooms.value.filter((r) => r.soldOut).length)

function adopted(room: PricingTodayRoom): boolean {
  return !!room.dailySource
}
function changePct(room: PricingTodayRoom): number {
  return room.currentPrice > 0 ? Math.round((room.change / room.currentPrice) * 100) : 0
}

async function loadToday() {
  loadingToday.value = true
  try {
    today.value = await pricingCenterApi.getToday()
  } catch (err: any) {
    today.value = null
    showToast(errText(err, '加载今日推荐失败'), 'error')
  } finally {
    loadingToday.value = false
  }
}

// ===== 采纳 =====
const adoptVisible = ref(false)
const adoptRoom = ref<PricingTodayRoom | null>(null)
const previewChannels = ref<string[]>([])
const previewLoading = ref(false)
const adopting = ref(false)

async function openAdopt(room: PricingTodayRoom) {
  const roomId = room.roomTypeId
  adoptRoom.value = room
  adoptVisible.value = true
  previewChannels.value = []
  previewLoading.value = true
  try {
    const s = await pricingCenterApi.getSettings()
    if (adoptRoom.value?.roomTypeId !== roomId) return // 弹层已切换，丢弃过时响应
    previewChannels.value = (s && s.channels) || []
  } catch {
    if (adoptRoom.value?.roomTypeId !== roomId) return
    previewChannels.value = []
  } finally {
    if (adoptRoom.value?.roomTypeId === roomId) previewLoading.value = false
  }
}

async function confirmAdopt() {
  const room = adoptRoom.value
  if (!room || room.suggestedPrice == null || adopting.value) return
  adopting.value = true
  try {
    const d = await pricingCenterApi.adopt({ roomTypeId: room.roomTypeId, price: room.suggestedPrice })
    showToast(`已采纳 ¥${d.price}，正在同步 OTA…`)
    adoptVisible.value = false
    adoptRoom.value = null
    await loadToday()
  } catch (err: any) {
    showToast(errText(err, '采纳失败'), 'error')
  } finally {
    adopting.value = false
  }
}

// ===== 撤销采纳 =====
async function handleUndo(room: PricingTodayRoom) {
  if (undoId.value) return
  undoId.value = room.roomTypeId
  try {
    const d = await pricingCenterApi.undo({ roomTypeId: room.roomTypeId })
    showToast(`已撤销，回落到 ¥${d.fallbackPrice}`)
    await loadToday()
  } catch (err: any) {
    showToast(errText(err, '撤销失败'), 'error')
  } finally {
    undoId.value = ''
  }
}

// ===== 手动设置 =====
const settingsVisible = ref(false)
const settings = ref<PricingSettings | null>(null)
const overview = ref<PricingOverviewDay[]>([])
const settingsLoading = ref(false)
const saving = ref(false)
const holidayMarkup = ref('')
const recommendationEnabled = ref(true)
const channels = ref<string[]>([])
const prices = ref<Record<string, { weekday: string; weekend: string; min: string }>>({})

// 手动设置里的可选同步渠道（与后端配置对齐）
const CHANNEL_OPTIONS = ['携程', '美团', '直营']

function toggleChannel(ch: string) {
  channels.value = channels.value.includes(ch)
    ? channels.value.filter((c) => c !== ch)
    : [...channels.value, ch]
}

function updatePrice(roomTypeId: string, field: 'weekday' | 'weekend' | 'min', value: string) {
  const cur = prices.value[roomTypeId] || { weekday: '', weekend: '', min: '' }
  cur[field] = value
  prices.value = { ...prices.value, [roomTypeId]: cur }
}

function onPriceInput(b: { roomTypeId: string }, field: 'weekday' | 'weekend' | 'min', e: any) {
  updatePrice(b.roomTypeId, field, (e && e.detail && e.detail.value) || '')
}

function onRecommendChange(e: any) {
  recommendationEnabled.value = !!(e && e.detail && e.detail.value)
}

async function openSettings() {
  settingsVisible.value = true
  settingsLoading.value = true
  try {
    const [s, o] = await Promise.all([
      pricingCenterApi.getSettings(),
      pricingCenterApi.getOverview(7),
    ])
    if (s) {
      settings.value = s
      holidayMarkup.value = String(s.holidayMarkupPct ?? 0)
      recommendationEnabled.value = !!s.recommendationEnabled
      channels.value = s.channels || []
      const map: Record<string, { weekday: string; weekend: string; min: string }> = {}
      ;(s.basePrices || []).forEach((b) => {
        map[b.roomTypeId] = {
          weekday: b.weekdayPrice != null ? String(b.weekdayPrice) : '',
          weekend: b.weekendPrice != null ? String(b.weekendPrice) : '',
          min: b.minPrice != null ? String(b.minPrice) : '',
        }
      })
      prices.value = map
    }
    if (o && o.days) overview.value = o.days
  } catch (err: any) {
    showToast(errText(err, '加载设置失败'), 'error')
  } finally {
    settingsLoading.value = false
  }
}

async function saveSettings() {
  if (!settings.value || saving.value) return

  // 前端基本校验（与后端一致，避免无意义请求）
  if (channels.value.length === 0) { showToast('请至少选择一个同步渠道', 'error'); return }
  const basePrices = (settings.value.basePrices || []).map((b) => {
    const p = prices.value[b.roomTypeId]
    const item: { roomTypeId: string; weekdayPrice?: number; weekendPrice?: number; minPrice?: number } = { roomTypeId: b.roomTypeId }
    if (p) {
      if (p.weekday !== '') item.weekdayPrice = Number(p.weekday)
      if (p.weekend !== '') item.weekendPrice = Number(p.weekend)
      if (p.min !== '') item.minPrice = Number(p.min)
    }
    return item
  })
  const invalid = basePrices.some((b) =>
    (b.weekdayPrice != null && (!Number.isFinite(b.weekdayPrice) || b.weekdayPrice < 0)) ||
    (b.weekendPrice != null && (!Number.isFinite(b.weekendPrice) || b.weekendPrice < 0)) ||
    (b.minPrice != null && (!Number.isFinite(b.minPrice) || b.minPrice < 0)))
  if (invalid) { showToast('价格需为≥0的数字', 'error'); return }
  const hm = Number(holidayMarkup.value)
  if (holidayMarkup.value !== '' && (Number.isNaN(hm) || hm < 0 || hm > 100)) {
    showToast('节假日加价%需在 0-100 之间', 'error'); return
  }

  const body: Record<string, unknown> = { basePrices }
  if (holidayMarkup.value !== '' && !Number.isNaN(hm)) body.holidayMarkupPct = hm
  body.recommendationEnabled = recommendationEnabled.value
  body.channels = channels.value

  saving.value = true
  try {
    await pricingCenterApi.saveSettings(body)
    showToast('设置已保存')
    await openSettings()
  } catch (err: any) {
    showToast(errText(err, '保存失败'), 'error')
  } finally {
    saving.value = false
  }
}

// ===== 未来 7 天价格一览 =====
const ovDateCol = 110
const ovPriceCol = 130
const ovMinWidth = computed(() => ovDateCol + (settings.value?.basePrices.length || 0) * ovPriceCol)

function isHoliday(day: PricingOverviewDay): boolean {
  return day.label !== '' && day.label !== '周末'
}
function isWeekend(day: PricingOverviewDay): boolean {
  return day.label === '周末'
}
// 预计算 date → roomTypeId → cell 的 Map，避免模板每单元格多次 Array.find()
const overviewMap = computed(() => {
  const map = new Map<string, Map<string, PricingOverviewDay['roomTypes'][0]>>()
  overview.value.forEach((day) => {
    const inner = new Map<string, PricingOverviewDay['roomTypes'][0]>()
    day.roomTypes.forEach((rt) => inner.set(rt.roomTypeId, rt))
    map.set(day.date, inner)
  })
  return map
})
function getCell(date: string, roomTypeId: string) {
  return overviewMap.value.get(date)?.get(roomTypeId)
}

onMounted(loadToday)
</script>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F4F6F8; padding: 24rpx; padding-bottom: calc(48rpx + env(safe-area-inset-bottom)); }

/* ===== 顶部 ===== */
.head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20rpx; }
.head-left { display: flex; flex-direction: column; gap: 6rpx; }
.head-title { font-size: 38rpx; font-weight: 700; color: #1F2937; }
.head-sub { font-size: 22rpx; color: #94A3B8; }
.head-entry { background: #fff; border-radius: 40rpx; padding: 16rpx 28rpx; box-shadow: 0 4rpx 16rpx rgba(15,23,42,0.06); }
.head-entry-text { font-size: 26rpx; color: #07C160; font-weight: 600; }

/* ===== 消息条（z-index 高于 t-popup 11500）===== */
.toast-bar { position: fixed; top: 88rpx; left: 50%; transform: translateX(-50%); z-index: 12000; max-width: 84%; padding: 18rpx 36rpx; border-radius: 999rpx; color: #fff; box-shadow: 0 8rpx 28rpx rgba(0,0,0,0.16); }
.toast-bar.success { background: #07C160; }
.toast-bar.error { background: #EF4444; }
.toast-text { font-size: 26rpx; }

/* ===== 推荐关闭 / 日期 ===== */
.rec-off-tip { background: #FFFBEB; border: 1rpx solid #FDE68A; border-radius: 16rpx; padding: 18rpx 24rpx; margin-bottom: 20rpx; }
.rec-off-text { font-size: 24rpx; color: #B45309; }
.date-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20rpx; }
.date-label { font-size: 26rpx; color: #4B5563; font-weight: 500; }
.soldout-label { font-size: 22rpx; color: #9CA3AF; }

/* ===== 推荐卡 ===== */
.card { background: #fff; border-radius: 24rpx; padding: 28rpx; margin-bottom: 20rpx; box-shadow: 0 6rpx 24rpx rgba(15,23,42,0.05); }
.rec-card { display: flex; flex-direction: column; gap: 16rpx; }
.rec-head { display: flex; align-items: center; justify-content: space-between; }
.rec-name-wrap { display: flex; align-items: center; gap: 12rpx; flex: 1; min-width: 0; }
.rec-name { font-size: 30rpx; font-weight: 600; color: #1F2937; }
.holiday-tag { font-size: 20rpx; color: #C2410C; background: #FFF3E0; border: 1rpx solid #FFD8A8; border-radius: 8rpx; padding: 4rpx 12rpx; }
.adopted-tag { font-size: 20rpx; color: #047857; background: #ECFDF5; border-radius: 999rpx; padding: 6rpx 16rpx; }
.price-row { display: flex; align-items: baseline; gap: 16rpx; }
.price-main { font-size: 44rpx; font-weight: 700; color: #1F2937; }
.price-main.green { color: #07C160; }
.price-cross { font-size: 24rpx; color: #9CA3AF; text-decoration: line-through; }
.change-tag { font-size: 22rpx; font-weight: 600; padding: 4rpx 14rpx; border-radius: 999rpx; }
.change-tag.up { color: #DC2626; background: #FEF2F2; }
.change-tag.down { color: #059669; background: #ECFDF5; }
.data-row { display: flex; align-items: center; gap: 28rpx; }
.data-item { font-size: 22rpx; color: #6B7280; }
.data-item .strong { color: #1F2937; font-weight: 600; }
.reason-list { display: flex; flex-direction: column; gap: 8rpx; }
.reason-item { background: #F8FAFC; border-radius: 12rpx; padding: 12rpx 18rpx; }
.reason-text { font-size: 22rpx; color: #475569; line-height: 1.5; }
.rec-ops { display: flex; justify-content: flex-end; }
.adopt-btn { background: #07C160; border-radius: 40rpx; padding: 16rpx 56rpx; box-shadow: 0 8rpx 20rpx rgba(7,193,96,0.22); }
.adopt-btn-text { color: #fff; font-size: 28rpx; font-weight: 600; }
.undo-btn { border: 1rpx solid #E2E8F0; border-radius: 40rpx; padding: 14rpx 40rpx; }
.undo-btn-text { font-size: 24rpx; color: #64748B; }
.loading-card, .empty-card { background: #fff; border-radius: 24rpx; padding: 80rpx 32rpx; text-align: center; }
.loading-text, .empty-text { font-size: 26rpx; color: #94A3B8; }
.nochange-label { font-size: 22rpx; color: #94A3B8; margin-bottom: 16rpx; }

/* ===== 采纳预览弹层 ===== */
.adopt-pop { width: 600rpx; background: #fff; border-radius: 28rpx; overflow: hidden; }
.adopt-head { display: flex; align-items: center; justify-content: space-between; padding: 32rpx; border-bottom: 1rpx solid #F1F5F9; }
.adopt-title { font-size: 32rpx; font-weight: 600; color: #1F2937; }
.adopt-close { font-size: 32rpx; color: #94A3B8; padding: 4rpx; }
.adopt-body { padding: 32rpx; display: flex; flex-direction: column; gap: 24rpx; }
.adopt-price-row { display: flex; align-items: center; justify-content: space-between; }
.adopt-room-name { font-size: 28rpx; font-weight: 500; color: #1F2937; }
.adopt-price { font-size: 44rpx; font-weight: 700; color: #07C160; }
.adopt-channels { display: flex; flex-direction: column; gap: 12rpx; }
.adopt-ch-label { font-size: 22rpx; color: #94A3B8; }
.adopt-ch-list { display: flex; flex-wrap: wrap; gap: 12rpx; }
.adopt-ch-tag { font-size: 22rpx; color: #475569; background: #F8FAFC; border: 1rpx solid #E2E8F0; border-radius: 12rpx; padding: 8rpx 20rpx; }
.adopt-ch-empty { font-size: 22rpx; color: #94A3B8; }
.adopt-reasons { display: flex; flex-direction: column; gap: 8rpx; background: #F8FAFC; border-radius: 16rpx; padding: 16rpx 20rpx; }
.adopt-reason { font-size: 22rpx; color: #64748B; line-height: 1.5; }
.adopt-foot { display: flex; gap: 20rpx; justify-content: flex-end; padding: 24rpx 32rpx; border-top: 1rpx solid #F1F5F9; }
.pop-btn { border-radius: 40rpx; padding: 18rpx 40rpx; }
.pop-btn.cancel { border: 1rpx solid #E2E8F0; }
.pop-btn.confirm { background: #07C160; }
.pop-btn.confirm.disabled { opacity: 0.6; }
.pop-btn-text { font-size: 26rpx; font-weight: 500; }
.pop-btn-text.gray { color: #64748B; }
.pop-btn-text.white { color: #fff; }

/* ===== 手动设置抽屉 ===== */
.settings-sheet { width: 88vw; height: 100vh; background: #F4F6F8; display: flex; flex-direction: column; }
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 28rpx 32rpx; background: #fff; border-bottom: 1rpx solid #F1F5F9; }
.sheet-title { font-size: 32rpx; font-weight: 600; color: #1F2937; }
.sheet-close { font-size: 32rpx; color: #94A3B8; padding: 4rpx; }
.sheet-scroll { flex: 1; height: 0; padding: 24rpx; box-sizing: border-box; }
.loading-tip { text-align: center; padding: 80rpx 0; color: #94A3B8; font-size: 26rpx; }

.s-card { display: flex; flex-direction: column; gap: 14rpx; }
.s-label { font-size: 26rpx; font-weight: 600; color: #1F2937; }
.s-hint { font-size: 22rpx; color: #94A3B8; line-height: 1.5; }
.chips { display: flex; flex-wrap: wrap; gap: 16rpx; }
.chip { display: flex; align-items: center; gap: 10rpx; border: 1rpx solid #E2E8F0; border-radius: 999rpx; padding: 12rpx 24rpx; background: #F8FAFC; }
.chip.on { border-color: #07C160; background: #ECFDF5; }
.chip-dot { width: 20rpx; height: 20rpx; border-radius: 50%; border: 1rpx solid #CBD5E1; }
.chip-dot.on { background: #07C160; border-color: #07C160; }
.chip-text { font-size: 24rpx; color: #64748B; }
.chip-text.on { color: #07C160; font-weight: 600; }
.input-wrap { display: flex; align-items: center; background: #F4F7F6; border-radius: 16rpx; padding: 0 20rpx; height: 80rpx; }
.input-wrap.pct { width: 200rpx; }
.input-wrap.sm { height: 72rpx; }
.f-input { flex: 1; font-size: 28rpx; font-weight: 500; color: #1F2937; height: 100%; }
.suffix { font-size: 26rpx; color: #94A3B8; margin-left: 8rpx; }
.s-switch-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8rpx; }

.room-price { border-top: 1rpx dashed #E2E8F0; padding-top: 20rpx; margin-top: 20rpx; }
.room-price:first-of-type { border-top: none; padding-top: 0; margin-top: 8rpx; }
.room-price-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14rpx; }
.room-price-name { font-size: 26rpx; font-weight: 600; color: #1F2937; }
.room-price-cur { font-size: 22rpx; color: #94A3B8; }
.room-price-grid { display: flex; gap: 16rpx; }
.rp-item { flex: 1; display: flex; flex-direction: column; gap: 8rpx; }
.rp-label { font-size: 20rpx; color: #94A3B8; }

.save-btn { background: #07C160; border-radius: 40rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; margin-bottom: 20rpx; box-shadow: 0 8rpx 20rpx rgba(7,193,96,0.22); }
.save-btn.disabled { opacity: 0.6; }
.save-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }

/* ===== 未来 7 天价格一览 ===== */
.empty-tip { text-align: center; padding: 48rpx 0; font-size: 24rpx; color: #94A3B8; }
.ov-scroll { width: 100%; }
.ov-table { border: 1rpx solid #E2E8F0; border-radius: 12rpx; overflow: hidden; }
.ov-row { display: flex; align-items: stretch; border-bottom: 1rpx solid #F1F5F9; }
.ov-row:last-child { border-bottom: none; }
.ov-head { background: #F8FAFC; }
.ov-holiday { background: #FFF8E1; }
.ov-weekend { background: #EFF6FF; }
.ov-date-col { width: 110px; flex-shrink: 0; padding: 14rpx 12rpx; display: flex; align-items: center; flex-direction: column; justify-content: center; gap: 4rpx; }
.ov-price-col { width: 130px; flex-shrink: 0; padding: 14rpx 8rpx; display: flex; align-items: center; justify-content: center; }
.ov-head-text { font-size: 22rpx; font-weight: 600; color: #64748B; text-align: center; }
.ov-date { font-size: 24rpx; font-weight: 500; color: #1F2937; }
.ov-tag { font-size: 18rpx; border-radius: 6rpx; padding: 2rpx 10rpx; }
.ov-tag.tag-hol { color: #C2410C; background: #FFE3C2; }
.ov-tag.tag-wend { color: #2563EB; background: #DBEAFE; }
.ov-cell { display: flex; align-items: center; gap: 6rpx; }
.ov-price { font-size: 24rpx; color: #475569; }
.ov-price.adopted { color: #07C160; font-weight: 700; }
.ov-price.dash { color: #CBD5E1; }
.adopted-dot { width: 12rpx; height: 12rpx; border-radius: 50%; background: #07C160; }
.ov-legend { display: flex; align-items: center; gap: 24rpx; margin-top: 16rpx; flex-wrap: wrap; }
.legend-item { display: flex; align-items: center; gap: 8rpx; }
.dot { width: 12rpx; height: 12rpx; border-radius: 50%; }
.dot.green { background: #07C160; }
.swatch { width: 24rpx; height: 18rpx; border-radius: 4rpx; }
.swatch.orange { background: #FFE3C2; border: 1rpx solid #FFC98A; }
.swatch.blue { background: #DBEAFE; border: 1rpx solid #BFD9FE; }
.legend-text { font-size: 20rpx; color: #94A3B8; }
</style>
