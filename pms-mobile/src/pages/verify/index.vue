<script setup lang="ts">
import { ref, computed } from 'vue'
import { onLoad, onReachBottom } from '@dcloudio/uni-app'
import {
  getStoreProductOrderDetail,
  getStoreProductOrders,
  acceptStoreProductOrder,
  useStoreProductOrder,
  payBalanceStoreProductOrder,
  type StoreProductOrder,
} from '@/api/modules/product-orders'
import {
  getWenlvClaimByCode,
  redeemWenlvClaim,
  getWenlvTicketByCode,
  consumeWenlvTicket,
  type WenlvClaimByCode,
  type WenlvTicketByCode,
} from '@/api/modules/wenlv-verify'
import { getStayOrderByPlatformOrder } from '@/api/modules/orders'

// ========== 模式与 Tab ==========
const mode = ref<'list' | 'detail'>('list')     // list=列表 / detail=单订单操作
const activeTab = ref<'pending' | 'done'>('pending')
const pendingList = ref<StoreProductOrder[]>([])
const doneList = ref<StoreProductOrder[]>([])
const listLoading = ref(false)
const listError = ref('')
const listPage = ref(1)
const listHasMore = ref(true)
let listReqId = 0   // 列表请求序号：切换 Tab/新请求时使在途响应失效

const currentList = computed(() => (activeTab.value === 'pending' ? pendingList.value : doneList.value))

// ========== 列表加载（滚动分页） ==========
async function loadList(reset = false) {
  if (!reset && listLoading.value) return   // 非 reset 请求（触底分页）让位于在途 reset，防追加到陈旧数据
  const tab = activeTab.value
  if (!reset && !listHasMore.value) return
  const page = reset ? 1 : listPage.value
  const reqId = ++listReqId
  listLoading.value = true
  listError.value = ''
  try {
    const res = await getStoreProductOrders({ scope: tab, page, limit: 20 })
    // Tab 已切换或有更新的请求：丢弃本次响应，避免数据错位
    if (reqId !== listReqId) return
    const list = Array.isArray(res) ? res : (res?.list || res?.data || [])
    const target = tab === 'pending' ? pendingList.value : doneList.value
    if (reset) {
      target.length = 0
      target.push(...list)
    } else {
      target.push(...list)
    }
    listHasMore.value = list.length === 20
    listPage.value = page + 1
  } catch (e: any) {
    if (reqId !== listReqId) return
    listError.value = e?.message || '加载失败'
  } finally {
    if (reqId === listReqId) listLoading.value = false
  }
}

function switchTab(tab: 'pending' | 'done') {
  if (activeTab.value === tab) return
  activeTab.value = tab
  listPage.value = 1
  listHasMore.value = true
  loadList(true)
}

onLoad(() => { loadList(true) })

// 触底分页
onReachBottom(() => {
  if (mode.value === 'list') loadList(false)
})

// ========== 详情模式（复用现有单订单操作） ==========
const code = ref('')
const loading = ref(false)
const order = ref<StoreProductOrder | null>(null)
const detailKind = ref<'order' | 'claim' | 'ticket'>('order')
const claim = ref<WenlvClaimByCode | null>(null)
const ticket = ref<WenlvTicketByCode | null>(null)
const notFound = ref(false)
const errorMsg = ref('')
const verifyInput = ref('')
const busy = ref(false)   // 核销 in-flight 锁：防连点重复 POST（服务端 409 为数据安全兜底，此项仅体验防抖）

// 状态展示
const statusMap: Record<string, { label: string; color: string; icon: string }> = {
  platform_approved: { label: '待接单', color: '#FF9500', icon: '⏳' },
  store_accepted: { label: '已接单', color: '#576B95', icon: '✅' },
  used: { label: '已核销', color: '#07C160', icon: '✔️' },
  refunded: { label: '已退款', color: '#FA5151', icon: '↩️' },
  paid: { label: '待预约', color: '#888888', icon: '📋' },
  pending: { label: '待支付', color: '#888888', icon: '📋' },
  cancelled: { label: '已取消', color: '#FA5151', icon: '❌' },
}

const statusInfo = () => statusMap[order.value?.status || ''] || { label: order.value?.status || '未知', color: '#888', icon: '📋' }
const listStatusInfo = (o: StoreProductOrder) => statusMap[o.status] || { label: o.status || '未知', color: '#888', icon: '📋' }

// —— LY 领奖码 / W 门票券 状态与展示 ——
const claimStatusMap: Record<string, { label: string; color: string; icon: string; ok: boolean }> = {
  claimed: { label: '待核销', color: '#07C160', icon: '🎁', ok: true },
  redeemed: { label: '已核销', color: '#888888', icon: '✔️', ok: false },
  cancelled: { label: '已取消', color: '#FA5151', icon: '❌', ok: false },
}
function claimStatus() {
  return claimStatusMap[claim.value?.status || ''] || { label: claim.value?.status || '未知', color: '#888', icon: '📋', ok: false }
}
function ticketView(t: WenlvTicketByCode | null) {
  if (!t) return { label: '未知', color: '#888', icon: '🎫', ok: false }
  if (t.status === 'used') return { label: '已使用', color: '#888888', icon: '✔️', ok: false }
  if (t.status === 'refunded') return { label: '已退款', color: '#FA5151', icon: '↩️', ok: false }
  if (t.status === 'expired') return { label: '已过期', color: '#AAAAAA', icon: '⏳', ok: false }
  if (!t.expiresAt) return { label: '待生效', color: '#AAAAAA', icon: '📋', ok: false }
  // 唯一放行态 = DB 'unused'（平台枚举 unused/used/expired/refunded）；未知 status 一律不放行
  return t.status === 'unused'
    ? (new Date(t.expiresAt).getTime() < Date.now()
      ? { label: '已过期', color: '#AAAAAA', icon: '⏳', ok: false }
      : { label: '待使用', color: '#07C160', icon: '🎫', ok: true })
    : { label: t.status || '未知', color: '#888', icon: '🎫', ok: false }
}
function fmtDT(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const notFoundText = computed(() => (detailKind.value === 'claim' ? '未找到该集章领奖码' : detailKind.value === 'ticket' ? '未找到该门票券码' : '未找到该订单'))
const notFoundSub = computed(() => (detailKind.value === 'claim' ? '请核对游客出示的 LY 领奖码' : detailKind.value === 'ticket' ? '请核对游客出示的 W 门票券码' : '仅已预约或已接单的套餐订单可查询核销'))
const hintTitle = computed(() => (detailKind.value === 'claim' ? '扫描或输入集章领奖码' : detailKind.value === 'ticket' ? '扫描或输入文旅门票券码' : '扫描或输入套餐订单号'))
const hintSub = '核销已预约/已接单的私域套餐订单、文旅门票或集章领奖码'

const modeLabel = () => (order.value?.mode === 'A' ? '订金' : order.value?.mode === 'B' ? '全款' : order.value?.mode || '-')
const isModeAUnpaid = (o: StoreProductOrder | null) => o?.mode === 'A' && !o?.balancePaidAt

function money(v: string | null | undefined): string {
  const n = Number(v)
  return Number.isFinite(n) ? String(n) : '0'
}

function normalizeResult(res: any): StoreProductOrder | null {
  if (!res) return null
  if (res.id) return res as StoreProductOrder
  return null
}

// ========== 列表 → 详情 ==========
function goDetail(o: StoreProductOrder) {
  order.value = o
  claim.value = null
  ticket.value = null
  detailKind.value = 'order'
  mode.value = 'detail'
  notFound.value = false
  errorMsg.value = ''
}

function backToList() {
  mode.value = 'list'
  order.value = null
  claim.value = null
  ticket.value = null
  detailKind.value = 'order'
  code.value = ''
  verifyInput.value = ''
  loadList(true)
}

function onRowClick(o: StoreProductOrder) {
  // 已处理非 used（退款/取消）仅列表展示，不进入详情（员工端详情按预约可见性过滤，非 confirmed 会 404）
  if (activeTab.value === 'done' && o.status !== 'used') return
  goDetail(o)
}

// ========== 列表行内操作（确认后执行，成功返回列表刷新） ==========
function confirmThenRun(fn: () => Promise<void>, title: string, content: string) {
  uni.showModal({
    title,
    content,
    success: async (res) => {
      if (!res.confirm) return
      uni.showLoading({ title: '处理中...' })
      try {
        await fn()
        uni.showToast({ title: '操作成功', icon: 'success' })
        backToList()
      } catch (e: any) {
        uni.showToast({ title: e?.error || e?.message || '操作失败', icon: 'none' })
      } finally {
        uni.hideLoading()
      }
    },
  })
}

function handleListAccept(o: StoreProductOrder) {
  confirmThenRun(() => acceptStoreProductOrder(o.id), '确认接单', `确认接单客人${o.guestName}的套餐订单？`)
}

function handleListPayBalance(o: StoreProductOrder) {
  confirmThenRun(() => payBalanceStoreProductOrder(o.id), '登记尾款', `确认已收取尾款 ¥${Number(o.balanceAmount) || 0}？`)
}

function handleListUse(o: StoreProductOrder) {
  if (isModeAUnpaid(o)) {
    uni.showToast({ title: '订金模式订单需先补尾款', icon: 'none' })
    return
  }
  confirmThenRun(() => useStoreProductOrder(o.id), '确认核销', `确认核销套餐「${o.productName || ''}」？核销后不可撤销。`)
}

// ========== 查看住宿订单（闭环最后一公里） ==========
async function viewStayOrder(o: StoreProductOrder) {
  try {
    const stay = await getStayOrderByPlatformOrder(o.id)
    if (stay?.id) {
      uni.navigateTo({ url: `/pages/orders/detail?id=${stay.id}` })
    } else {
      uni.showToast({ title: '未找到对应住宿订单', icon: 'none' })
    }
  } catch (e: any) {
    if (e?.code === 404) {
      // 该单确无住宿订单（正常 used 单核销即转化，此分支极少）
      uni.showToast({ title: '未找到对应住宿订单', icon: 'none' })
    } else {
      // 回调未达/转化未生成：补偿调度器 60s 自动补
      uni.showToast({ title: '住宿订单生成中，稍后查看', icon: 'none' })
    }
  }
}

// ========== 扫码/输入单查 ==========
async function lookup(raw: string) {
  const input = (raw || '').trim()
  if (!input) {
    uni.showToast({ title: '请输入订单号/领奖码/券码', icon: 'none' })
    return
  }
  loading.value = true
  notFound.value = false
  errorMsg.value = ''
  order.value = null
  claim.value = null
  ticket.value = null
  detailKind.value = 'order'
  try {
    const up = input.toUpperCase()
    // LY → 集章领奖码预览
    if (up.startsWith('LY')) {
      claim.value = await getWenlvClaimByCode(up)
      detailKind.value = 'claim'
      mode.value = 'detail'
      return
    }
    // W+12位大写十六进制 → 门票券码预览（QR 为 W + 12 hex）
    if (/^W[0-9A-F]{12}$/.test(up)) {
      ticket.value = await getWenlvTicketByCode(up)
      detailKind.value = 'ticket'
      mode.value = 'detail'
      return
    }
    // —— 既有套餐订单流（po_ 直查 / 订单号模糊匹配，零回归）——
    let found: StoreProductOrder | null = null
    // 订单ID直查
    if (input.startsWith('po_')) {
      const res = await getStoreProductOrderDetail(input)
      found = normalizeResult(res)
    }
    // 订单号模糊匹配（预约可见性：仅已预约/已接单订单可查）
    if (!found) {
      const res = await getStoreProductOrders({ keyword: input, page: 1, limit: 20 })
      const list = Array.isArray(res) ? res : (res?.list || res?.data || [])
      found = list.find((o: StoreProductOrder) => o.orderNo === input) || null
    }
    if (found) {
      goDetail(found)
    } else {
      order.value = null
      notFound.value = true
      mode.value = 'detail'
    }
  } catch (e: any) {
    order.value = null
    claim.value = null
    ticket.value = null
    const upInput = input.toUpperCase()
    const isLy = upInput.startsWith('LY')
    const isW = /^W[0-9A-F]{12}$/.test(upInput)
    // 按输入前缀把 detailKind 置回 claim/ticket：无效 LY/W 码的 404 落到对应未找到文案（非 LY/W 仍为 order，errorMsg 语义不变）
    detailKind.value = isLy ? 'claim' : isW ? 'ticket' : 'order'
    if ((e as any)?.code === 404 && (isLy || isW)) {
      // LY/W 券码查无 → 未找到态（接口已 showError:false，不再额外 toast）
      notFound.value = true
    } else {
      errorMsg.value = (e as any)?.error || (e as any)?.message || '查询失败'
    }
    mode.value = 'detail'
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  lookup(code.value)
}

function handleScan() {
  // H5 环境不支持 uni.scanCode，失败时提示手动输入
  // #ifdef H5
  uni.showToast({ title: '当前环境不支持扫码，请手动输入', icon: 'none' })
  // #endif
  // #ifndef H5
  uni.scanCode({
    scanType: ['qrCode', 'barCode'],
    success: (res) => {
      code.value = res.result || ''
      lookup(res.result)
    },
    fail: () => {
      uni.showToast({ title: '扫码失败，请手动输入', icon: 'none' })
    },
  })
  // #endif
}

// ========== 详情操作 ==========
async function runAction(fn: () => Promise<any>, successMsg: string) {
  if (!order.value) return
  uni.showLoading({ title: '处理中...' })
  try {
    await fn()
    uni.showToast({ title: successMsg, icon: 'success' })
    await refreshDetail()
  } catch (e: any) {
    // 业务错误优先展示后端 message（如「核销码不正确」），否则兜底通用提示
    uni.showToast({ title: e?.error || e?.message || '操作失败', icon: 'none' })
  } finally {
    uni.hideLoading()
  }
}

// ========== LY / W 到店核销 ==========
async function refreshClaim() {
  if (!claim.value) return
  const d = await getWenlvClaimByCode(claim.value.code)
  if (d) claim.value = d
}
async function refreshTicket() {
  if (!ticket.value) return
  const d = await getWenlvTicketByCode(ticket.value.code)
  if (d) ticket.value = d
}
function confirmRedeem(fn: () => Promise<any>, refreshFn: () => Promise<void>, successMsg: string, content: string) {
  uni.showModal({
    title: '确认核销',
    content,
    success: (res) => {
      if (!res.confirm) return
      if (busy.value) return   // 防连点：上一次核销 in-flight 中忽略重复确认
      busy.value = true
      uni.showLoading({ title: '处理中...', mask: true })
      fn()
        .then(() => {
          // 成功提示先于刷新：POST 已成功即 toast，不被随后的 best-effort 刷新失败覆盖
          uni.hideLoading()
          uni.showToast({ title: successMsg, icon: 'success' })
        })
        .catch((e: any) => {
          uni.hideLoading()
          uni.showToast({ title: (e as any)?.error || (e as any)?.message || '核销失败', icon: 'none' })
        })
        .finally(async () => {
          try {
            await refreshFn()   // best-effort：刷新失败静默，卡片短暂停留旧态，下次进入/重扫自然收敛真值
          } catch { /* 静默 */ }
          busy.value = false
        })
    },
  })
}
function handleRedeemClaim() {
  const c = claim.value
  if (!c) return
  confirmRedeem(() => redeemWenlvClaim(c.id), refreshClaim, '核销成功', `确认核销集章领奖码「${c.code}」？核销后不可撤销。`)
}
function handleConsumeTicket() {
  const t = ticket.value
  if (!t) return
  confirmRedeem(() => consumeWenlvTicket(t.code), refreshTicket, '验票成功', `确认核销门票「${t.productName || ''}」？核销后不可撤销。`)
}

async function refreshDetail() {
  if (!order.value) return
  try {
    const res = await getStoreProductOrderDetail(order.value.id)
    const fresh = normalizeResult(res)
    if (fresh) order.value = fresh
  } catch { /* 忽略刷新失败 */ }
}

function handleAccept() {
  if (!order.value) return
  uni.showModal({
    title: '确认接单',
    content: `确认接单客人${order.value.guestName}的套餐订单？`,
    success: (res) => {
      if (res.confirm) runAction(() => acceptStoreProductOrder(order.value!.id), '已接单')
    },
  })
}

function handlePayBalance() {
  if (!order.value) return
  uni.showModal({
    title: '登记尾款',
    content: `确认已收取尾款 ¥${Number(order.value.balanceAmount) || 0}？`,
    success: (res) => {
      if (res.confirm) runAction(() => payBalanceStoreProductOrder(order.value!.id), '尾款已登记')
    },
  })
}

function handleUse() {
  if (!order.value) return
  const o = order.value
  if (o.mode === 'A' && !o.balancePaidAt) {
    uni.showToast({ title: '订金模式订单需先补尾款', icon: 'none' })
    return
  }
  uni.showModal({
    title: '确认核销',
    content: `确认核销套餐「${o.productName || ''}」？核销后不可撤销。`,
    success: (res) => {
      if (res.confirm) {
        const vc = verifyInput.value.trim()
        runAction(() => useStoreProductOrder(o.id, vc || undefined), '核销成功')
      }
    },
  })
}
</script>

<template>
  <view class="verify-page">
    <!-- 搜索卡（两种模式均显示） -->
    <view class="search-card">
      <view class="scan-badge">
        <text class="scan-icon">📷</text>
        <text class="scan-text">到店核销</text>
      </view>
      <view class="search-row">
        <view class="search-input-wrap">
          <text class="search-icon">🔍</text>
          <input
            v-model="code"
            class="search-input"
            placeholder="输入订单号/领奖码/券码"
            confirm-type="search"
            @confirm="handleSearch"
          />
          <text v-if="code" class="search-clear" @click="code = ''">✕</text>
        </view>
        <view class="scan-btn" @click="handleScan">
          <text class="scan-btn-icon">⤢</text>
          <text class="scan-btn-text">扫码</text>
        </view>
      </view>
      <view class="search-btn" @click="handleSearch">
        <text class="search-btn-text">查询核销</text>
      </view>
    </view>

    <!-- ========== 列表模式 ========== -->
    <template v-if="mode === 'list'">
      <!-- Tab 切换 -->
      <view class="tab-bar">
        <view class="tab-item" :class="{ active: activeTab === 'pending' }" @click="switchTab('pending')">
          待处理
        </view>
        <view class="tab-item" :class="{ active: activeTab === 'done' }" @click="switchTab('done')">
          已处理
        </view>
      </view>

      <!-- 加载/错误/空态 -->
      <view v-if="listLoading && currentList.length === 0" class="state-box">
        <text class="state-text">加载中...</text>
      </view>
      <view v-else-if="listError && currentList.length === 0" class="state-box">
        <text class="state-icon">⚠️</text>
        <text class="state-text">{{ listError }}</text>
      </view>
      <view v-else-if="currentList.length === 0" class="state-box">
        <text class="state-icon">📋</text>
        <text class="state-text">{{ activeTab === 'pending' ? '暂无可处理的套餐订单' : '暂无已处理订单' }}</text>
      </view>

      <!-- 订单列表 -->
      <view v-else class="list-wrap">
        <view
          v-for="o in currentList"
          :key="o.id"
          class="order-card"
          :class="{ 'is-disabled': activeTab === 'done' && o.status !== 'used' }"
          @click="onRowClick(o)"
        >
          <view class="list-row-top">
            <text class="list-status-badge" :style="{ background: listStatusInfo(o).color }">{{ listStatusInfo(o).label }}</text>
            <text class="list-order-no">{{ o.orderNo }}</text>
          </view>
          <view class="list-info">
            <text class="list-product">{{ o.productName || '套餐' }}</text>
            <text class="list-guest">{{ o.guestName }}<text v-if="o.guestPhone"> · {{ o.guestPhone }}</text></text>
          </view>
          <view class="list-meta">
            <text class="list-date">预约 {{ o.reservationDate || '-' }}</text>
            <text class="list-amount">¥{{ money(o.totalAmount) }}</text>
          </view>

          <!-- 待处理行操作（点击不冒泡进详情） -->
          <view v-if="activeTab === 'pending'" class="list-actions" @click.stop>
            <template v-if="o.status === 'platform_approved'">
              <button class="mini-btn mini-btn--primary" @click="handleListAccept(o)">接单</button>
            </template>
            <template v-else-if="o.status === 'store_accepted'">
              <button v-if="isModeAUnpaid(o)" class="mini-btn mini-btn--warning" @click="handleListPayBalance(o)">补尾款</button>
              <button class="mini-btn mini-btn--primary" @click="handleListUse(o)">核销</button>
            </template>
          </view>

          <!-- 已核销行：查看住宿订单 -->
          <view v-else-if="o.status === 'used'" class="list-actions" @click.stop>
            <button class="mini-btn mini-btn--link" @click="viewStayOrder(o)">查看住宿订单 ›</button>
          </view>
        </view>

        <!-- 分页状态 -->
        <view v-if="listLoading" class="load-more">加载中...</view>
        <view v-else-if="!listHasMore && currentList.length > 0" class="load-more">已加载全部</view>
      </view>
    </template>

    <!-- ========== 详情模式（复用现有单订单操作视图） ========== -->
    <template v-else>
      <view class="detail-back" @click="backToList">‹ 返回列表</view>

      <view v-if="loading" class="state-box">
        <text class="state-text">查询中...</text>
      </view>

      <view v-else-if="notFound" class="state-box">
        <text class="state-icon">❓</text>
        <text class="state-text">{{ notFoundText }}</text>
        <text class="state-sub">{{ notFoundSub }}</text>
      </view>

      <view v-else-if="errorMsg" class="state-box">
        <text class="state-icon">⚠️</text>
        <text class="state-text">{{ errorMsg }}</text>
      </view>

      <!-- LY 集章领奖码结果卡 -->
      <view v-else-if="detailKind === 'claim' && claim" class="order-content">
        <view class="status-banner" :style="{ background: claimStatus().color }">
          <text class="banner-icon">{{ claimStatus().icon }}</text>
          <text class="banner-label">{{ claimStatus().label }}</text>
          <text class="banner-order-no">领奖码 {{ claim.code }}</text>
        </view>
        <view class="info-card">
          <view class="card-title"><text class="title-icon">🎁</text><text class="title-text">集章领奖信息</text></view>
          <view class="info-row">
            <text class="info-label">集章产品</text>
            <text class="info-value info-value--strong">{{ claim.productTitle || '-' }}<text v-if="claim.productMode === 'rally'" class="mode-tag">集章</text></text>
          </view>
          <view class="info-row"><text class="info-label">档位</text><text class="info-value">{{ claim.tierName || '-' }}</text></view>
          <view class="info-row"><text class="info-label">奖励</text><text class="info-value">{{ claim.rewardName || '-' }}{{ claim.rewardType ? '（' + claim.rewardType + '）' : '' }}</text></view>
          <view class="info-row"><text class="info-label">领取时间</text><text class="info-value">{{ fmtDT(claim.claimedAt) }}</text></view>
        </view>
        <view v-if="claim.status === 'redeemed'" class="info-card">
          <view class="card-title"><text class="title-icon">🧾</text><text class="title-text">核销信息</text></view>
          <view class="info-row"><text class="info-label">经办员工</text><text class="info-value">{{ claim.redeemedBy || '-' }}</text></view>
          <view class="info-row"><text class="info-label">核销门店</text><text class="info-value">{{ claim.redeemedStoreId || '-' }}</text></view>
          <view class="info-row"><text class="info-label">核销时间</text><text class="info-value">{{ fmtDT(claim.redeemedAt) }}</text></view>
        </view>
        <view class="action-placeholder" />
        <view v-if="claimStatus().ok" class="action-bar">
          <button class="action-btn action-btn--primary" @click="handleRedeemClaim">核销领奖</button>
        </view>
      </view>

      <!-- W 文旅门票结果卡 -->
      <view v-else-if="detailKind === 'ticket' && ticket" class="order-content">
        <view class="status-banner" :style="{ background: ticketView(ticket).color }">
          <text class="banner-icon">{{ ticketView(ticket).icon }}</text>
          <text class="banner-label">{{ ticketView(ticket).label }}</text>
          <text class="banner-order-no">券码 {{ ticket.code }}</text>
        </view>
        <view class="info-card">
          <view class="card-title"><text class="title-icon">🎫</text><text class="title-text">门票信息</text></view>
          <view class="info-row"><text class="info-label">门票名称</text><text class="info-value info-value--strong">{{ ticket.productName || '-' }}</text></view>
          <view class="info-row"><text class="info-label">订单号</text><text class="info-value">{{ ticket.orderNo || '-' }}</text></view>
          <view class="info-row"><text class="info-label">有效期至</text><text class="info-value">{{ fmtDT(ticket.expiresAt) }}</text></view>
        </view>
        <view v-if="ticket.status === 'used'" class="info-card">
          <view class="card-title"><text class="title-icon">🧾</text><text class="title-text">核销信息</text></view>
          <view class="info-row"><text class="info-label">核销门店</text><text class="info-value">{{ ticket.verifyStoreId || '-' }}</text></view>
          <view class="info-row"><text class="info-label">核销时间</text><text class="info-value">{{ fmtDT(ticket.usedAt) }}</text></view>
        </view>
        <view class="action-placeholder" />
        <view v-if="ticketView(ticket).ok" class="action-bar">
          <button class="action-btn action-btn--primary" @click="handleConsumeTicket">核销验票</button>
        </view>
      </view>

      <view v-else-if="order" class="order-content">
        <!-- 状态横幅 -->
        <view class="status-banner" :style="{ background: statusInfo().color }">
          <text class="banner-icon">{{ statusInfo().icon }}</text>
          <text class="banner-label">{{ statusInfo().label }}</text>
          <text class="banner-order-no">{{ order.orderNo }}</text>
        </view>

        <!-- 套餐信息 -->
        <view class="info-card">
          <view class="card-title">
            <text class="title-icon">🎁</text>
            <text class="title-text">套餐信息</text>
          </view>
          <view class="info-row">
            <text class="info-label">套餐名称</text>
            <text class="info-value info-value--strong">{{ order.productName || '-' }}</text>
          </view>
          <view class="info-row">
            <text class="info-label">数量/间夜</text>
            <text class="info-value">x{{ order.quantity || 1 }} 份 · {{ order.roomNights || 1 }}晚</text>
          </view>
          <view class="info-row">
            <text class="info-label">预约入住</text>
            <text class="info-value">{{ order.reservationDate || '-' }}</text>
          </view>
        </view>

        <!-- 客人信息 -->
        <view class="info-card">
          <view class="card-title">
            <text class="title-icon">👤</text>
            <text class="title-text">客人信息</text>
          </view>
          <view class="info-row">
            <text class="info-label">姓名</text>
            <text class="info-value info-value--strong">{{ order.guestName }}</text>
          </view>
          <view v-if="order.guestPhone" class="info-row">
            <text class="info-label">手机号</text>
            <text class="info-value info-value--link">{{ order.guestPhone }}</text>
          </view>
        </view>

        <!-- 费用信息 -->
        <view class="info-card">
          <view class="card-title">
            <text class="title-icon">💰</text>
            <text class="title-text">费用信息</text>
          </view>
          <view class="info-row">
            <text class="info-label">订单金额</text>
            <text class="info-value info-value--price">¥{{ money(order.totalAmount) }}</text>
          </view>
          <view class="info-row">
            <text class="info-label">预订模式</text>
            <text class="info-value">{{ modeLabel() }}（{{ order.mode || 'B' }}）</text>
          </view>
          <template v-if="order.mode === 'A'">
            <view class="info-row">
              <text class="info-label">已付订金</text>
              <text class="info-value">¥{{ money(order.depositAmount) }}</text>
            </view>
            <view class="info-row">
              <text class="info-label">尾款</text>
              <text :class="['info-value', order.balancePaidAt ? 'info-value--paid' : 'info-value--warn']">
                ¥{{ money(order.balanceAmount) }}{{ order.balancePaidAt ? '（已补）' : '（未补）' }}
              </text>
            </view>
          </template>
        </view>

        <!-- 核销码输入（客人出示，可选填） -->
        <view v-if="order.status === 'store_accepted'" class="info-card">
          <view class="card-title">
            <text class="title-icon">🎫</text>
            <text class="title-text">核销码</text>
          </view>
          <view class="verify-row">
            <text class="info-label">客人核销码</text>
            <input
              v-model="verifyInput"
              class="verify-input"
              type="number"
              maxlength="6"
              placeholder="客人出示的6位核销码（可选）"
              :disabled="loading"
            />
          </view>
          <view class="verify-hint">核销时将校验核销码，不正确将无法核销</view>
        </view>

        <!-- 底部占位 -->
        <view class="action-placeholder" />
      </view>

      <view v-else class="state-box">
        <text class="state-icon">🎫</text>
        <text class="state-text">{{ hintTitle }}</text>
        <text class="state-sub">{{ hintSub }}</text>
      </view>

      <!-- 底部操作栏 -->
      <view v-if="order && (order.status === 'store_accepted' || order.status === 'platform_approved')" class="action-bar">
        <template v-if="order.status === 'store_accepted'">
          <button
            v-if="isModeAUnpaid(order)"
            class="action-btn action-btn--warning"
            @click="handlePayBalance"
          >
            补尾款
          </button>
          <button class="action-btn action-btn--primary" @click="handleUse">
            核销
          </button>
        </template>
        <template v-else-if="order.status === 'platform_approved'">
          <button class="action-btn action-btn--primary" @click="handleAccept">
            接单
          </button>
        </template>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.verify-page {
  min-height: 100vh;
  background: #F5F6FA;
  padding: 24rpx;
}

// ========== 搜索卡片 ==========
.search-card {
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 28rpx 24rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}

.scan-badge {
  display: flex;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 20rpx;
}

.scan-icon {
  width: 56rpx;
  height: 56rpx;
  border-radius: 16rpx;
  background: linear-gradient(135deg, #07C160, #05A04A);
  color: #fff;
  font-size: 28rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scan-text {
  font-size: 32rpx;
  font-weight: 700;
  color: #191919;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.search-input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  background: #F5F6FA;
  border-radius: 20rpx;
  padding: 16rpx 20rpx;
  gap: 12rpx;
}

.search-icon {
  font-size: 28rpx;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  font-size: 28rpx;
  color: #191919;
  height: 44rpx;
}

.search-clear {
  font-size: 28rpx;
  color: #999;
  width: 40rpx;
  height: 40rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.scan-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 96rpx;
  height: 76rpx;
  border-radius: 20rpx;
  background: linear-gradient(135deg, #07C160, #05A04A);
  color: #fff;

  &:active {
    opacity: 0.85;
  }
}

.scan-btn-icon {
  font-size: 30rpx;
  line-height: 1;
}

.scan-btn-text {
  font-size: 20rpx;
  margin-top: 2rpx;
}

.search-btn {
  margin-top: 20rpx;
  height: 80rpx;
  border-radius: 20rpx;
  background: linear-gradient(135deg, #07C160, #05A04A);
  display: flex;
  align-items: center;
  justify-content: center;

  &:active {
    opacity: 0.85;
  }
}

.search-btn-text {
  font-size: 30rpx;
  font-weight: 600;
  color: #fff;
}

// ========== 状态/空状态 ==========
.state-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 0;
}

.state-icon {
  font-size: 88rpx;
  margin-bottom: 24rpx;
}

.state-text {
  font-size: 30rpx;
  color: #191919;
  font-weight: 500;
}

.state-sub {
  font-size: 24rpx;
  color: #AAAAAA;
  margin-top: 12rpx;
  text-align: center;
}

// ========== 订单内容 ==========
.order-content {
  margin-top: 24rpx;
}

.status-banner {
  border-radius: 24rpx;
  padding: 36rpx 24rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  color: #fff;
  margin-bottom: 16rpx;
}

.banner-icon {
  font-size: 52rpx;
  margin-bottom: 10rpx;
}

.banner-label {
  font-size: 36rpx;
  font-weight: 700;
  margin-bottom: 8rpx;
}

.banner-order-no {
  font-size: 24rpx;
  opacity: 0.9;
}

.info-card {
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8rpx;
  margin-bottom: 14rpx;
  padding-bottom: 12rpx;
  border-bottom: 1rpx solid #EDEDED;
}

.title-icon {
  font-size: 24rpx;
}

.title-text {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10rpx 0;

  &:not(:last-child) {
    border-bottom: 1rpx solid rgba(0, 0, 0, 0.04);
  }
}

.info-label {
  font-size: 26rpx;
  color: #888888;
  flex-shrink: 0;
}

.info-value {
  font-size: 26rpx;
  color: #191919;
  text-align: right;

  &--strong {
    font-weight: 600;
  }

  &--link {
    color: #576B95;
  }

  &--price {
    font-size: 32rpx;
    font-weight: 700;
  }

  &--paid {
    color: #07C160;
    font-weight: 500;
  }

  &--warn {
    color: #FF9500;
    font-weight: 500;
  }
}

.verify-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10rpx 0;
  gap: 16rpx;
}

.verify-input {
  flex: 1;
  text-align: right;
  font-size: 28rpx;
  color: #191919;
  letter-spacing: 2rpx;
  background: #F5F6FA;
  border-radius: 12rpx;
  padding: 10rpx 20rpx;
}

.verify-hint {
  font-size: 22rpx;
  color: #AAAAAA;
  padding-top: 6rpx;
}

.action-placeholder {
  height: 140rpx;
}

// ========== 底部操作栏 ==========
.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #FFFFFF;
  display: flex;
  gap: 16rpx;
  padding: 16rpx 24rpx;
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 16rpx rgba(0, 0, 0, 0.06);
  z-index: 100;
}

.action-btn {
  flex: 1;
  height: 84rpx;
  border-radius: 42rpx;
  font-size: 30rpx;
  font-weight: 600;
  border: none;
  line-height: 84rpx;
  color: #fff;

  &--primary {
    background: linear-gradient(135deg, #07C160, #05A04A);
  }

  &--warning {
    background: linear-gradient(135deg, #FF9500, #F08200);
  }

  &:active {
    opacity: 0.85;
  }
}

// ========== 列表模式（新增） ==========
.tab-bar {
  display: flex;
  background: #FFFFFF;
  border-radius: 20rpx;
  padding: 8rpx;
  margin-top: 20rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}
.tab-item {
  flex: 1;
  text-align: center;
  font-size: 28rpx;
  color: #888;
  padding: 16rpx 0;
  border-radius: 16rpx;
  transition: all .2s;
  &.active {
    background: linear-gradient(135deg, #07C160, #05A04A);
    color: #fff;
    font-weight: 600;
  }
}
.list-wrap {
  margin-top: 20rpx;
}
.order-card {
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  margin-bottom: 16rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
  &.is-disabled {
    opacity: .6;
  }
}
.list-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}
.list-status-badge {
  font-size: 22rpx;
  color: #fff;
  padding: 6rpx 16rpx;
  border-radius: 20rpx;
}
.list-order-no {
  font-size: 24rpx;
  color: #999;
}
.list-info {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
  margin-bottom: 10rpx;
}
.list-product {
  font-size: 30rpx;
  font-weight: 600;
  color: #191919;
}
.list-guest {
  font-size: 24rpx;
  color: #666;
}
.list-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 14rpx;
  border-bottom: 1rpx solid rgba(0, 0, 0, 0.04);
}
.list-date {
  font-size: 24rpx;
  color: #888;
}
.list-amount {
  font-size: 30rpx;
  font-weight: 700;
  color: #191919;
}
.list-actions {
  display: flex;
  justify-content: flex-end;
  gap: 16rpx;
  padding-top: 16rpx;
}
.mini-btn {
  height: 60rpx;
  line-height: 60rpx;
  padding: 0 28rpx;
  border-radius: 30rpx;
  font-size: 26rpx;
  font-weight: 600;
  border: none;
  color: #fff;
  &--primary {
    background: linear-gradient(135deg, #07C160, #05A04A);
  }
  &--warning {
    background: linear-gradient(135deg, #FF9500, #F08200);
  }
  &--link {
    background: #FFFFFF;
    color: #07C160;
    border: 1rpx solid #07C160;
  }
  &:active {
    opacity: .85;
  }
}
.load-more {
  text-align: center;
  font-size: 24rpx;
  color: #AAA;
  padding: 20rpx 0 40rpx;
}
.detail-back {
  padding: 20rpx 8rpx 0;
  font-size: 28rpx;
  color: #576B95;
}
.mode-tag {
  display: inline-block;
  font-size: 20rpx;
  color: #07C160;
  border: 1rpx solid #07C160;
  border-radius: 8rpx;
  padding: 0 8rpx;
  margin-left: 8rpx;
  vertical-align: middle;
}
</style>
