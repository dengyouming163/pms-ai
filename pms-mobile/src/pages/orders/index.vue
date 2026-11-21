<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app'
import { useOrdersStore } from '@/stores/orders'
import PageHeader from '@/components/PageHeader.vue'
import OrderCard from '@/components/business/OrderCard.vue'
import type { Order } from '@/types/order'

const store = useOrdersStore()

// Tab 切换: 'all' | 'channel-pending'
const activeTab = ref<'all' | 'channel-pending'>('all')

// 搜索关键词（本地输入，确认后提交）
const searchKeyword = ref('')
// 筛选器展开状态
const channelPickerVisible = ref(false)
const statusPickerVisible = ref(false)

// 渠道列表（从列表数据中提取）
const channelOptions = computed(() => {
  const channels = new Set<string>()
  store.orders.forEach(o => channels.add(o.channel))
  return Array.from(channels).map(c => ({ label: c, value: c }))
})

// 状态筛选选项
const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '待确认', value: 'pending' },
  { label: '已确认', value: 'confirmed' },
  { label: '已入住', value: 'checked_in' },
  { label: '已退房', value: 'checked_out' },
  { label: '已取消', value: 'cancelled' },
]

// 当前选中的筛选名称
const selectedChannelName = computed(() => {
  if (!store.filters.channel) return '全部渠道'
  return store.filters.channel
})

const selectedStatusName = computed(() => {
  const opt = statusOptions.find(o => o.value === store.filters.status)
  return opt ? opt.label : '全部状态'
})

// 各tab下是否有数据
const hasData = computed(() => {
  if (activeTab.value === 'all') return store.filteredOrders.length > 0
  return store.channelPending.length > 0
})

// ========== 生命周期 ==========
onMounted(async () => {
  await store.fetchStats()
  await store.fetchOrders({ page: 1, limit: 20 })
})

// 下拉刷新
onPullDownRefresh(async () => {
  try {
    store.resetPagination()
    if (activeTab.value === 'all') {
      await store.fetchStats()
      await store.fetchOrders({ page: 1, limit: 20 })
    } else {
      await store.fetchChannelPending()
    }
  } finally {
    uni.stopPullDownRefresh()
  }
})

// 触底加载更多
onReachBottom(async () => {
  if (activeTab.value === 'channel-pending') return // 渠道待确认不分页
  if (store.loading) return
  if (store.pagination.page >= store.pagination.totalPages) return
  const nextPage = store.pagination.page + 1
  await store.fetchOrders({ page: nextPage })
})

// ========== Tab 切换 ==========
async function switchTab(tab: 'all' | 'channel-pending') {
  activeTab.value = tab
  if (tab === 'all') {
    store.resetPagination()
    await store.fetchOrders({ page: 1, limit: 20 })
  } else {
    store.clearSelection()
    await store.fetchChannelPending()
  }
}

// ========== 搜索 ==========
function handleSearch() {
  store.setFilter({ keyword: searchKeyword.value })
}

function handleClearSearch() {
  searchKeyword.value = ''
  store.setFilter({ keyword: '' })
}

// ========== 筛选 ==========
function handleChannelChange(index: number) {
  const channel = index === 0 ? '' : channelOptions.value[index - 1]?.value || ''
  store.setFilter({ channel })
}

function handleStatusChange(index: number) {
  const status = statusOptions[index]?.value || 'all'
  store.setFilter({ status })
}

// ========== 订单操作 ==========
function handleOrderClick(order: Order) {
  uni.navigateTo({ url: `/pages/orders/detail?id=${order.id}` })
}

function goCreate() {
  uni.navigateTo({ url: '/pages/orders/create' })
}

// ========== 渠道待确认 - 批量操作 ==========
function handleCheckOrder(orderId: string) {
  store.selectOrder(orderId)
}

function handleSelectAllChannel(name: string) {
  store.selectAllChannel(name)
}

async function handleBatchConfirm() {
  if (store.selectedIds.length === 0) return
  uni.showLoading({ title: '确认中...' })
  try {
    await store.batchConfirm(store.selectedIds)
    uni.showToast({ title: `已确认${store.selectedIds.length}个订单`, icon: 'success' })
  } catch {
    uni.showToast({ title: '操作失败', icon: 'none' })
  } finally {
    uni.hideLoading()
  }
}

function handleClearSelection() {
  store.clearSelection()
}

// ========== 渠道待确认 - 单个确认/取消 ==========
async function handleConfirmOrder(orderId: string) {
  uni.showLoading({ title: '确认中...' })
  try {
    await store.confirmOrder(orderId)
    uni.showToast({ title: '已确认', icon: 'success' })
  } catch {
    uni.showToast({ title: '操作失败', icon: 'none' })
  } finally {
    uni.hideLoading()
  }
}

// 判断某个渠道是否全选
function isChannelAllSelected(channelName: string): boolean {
  const group = store.channelPending.find(g => g.name === channelName)
  if (!group || group.orders.length === 0) return false
  return group.orders.every(o => store.selectedIds.includes(o.id))
}

// 渠道图标映射
const channelIcons: Record<string, string> = {
  '携程': '✈️', '美团': '🍔', '飞猪': '🐷',
  'Booking': '🌍', '到店': '🚶', 'walk-in': '🚶',
  '直营': '🏨', '抖音': '🎵', '小红书': '📕',
  '私域平台': '🎫',
}

function getChannelIcon(name: string): string {
  return channelIcons[name] || '📋'
}
</script>

<template>
  <view class="orders-page">
    <!-- 自定义头部 -->
    <PageHeader>
      
      <template #right>
        <text class="nav-create-btn" @click="goCreate">＋</text>
      </template>
      <template #tabs>
        <view class="tab-bar">
      <view
        :class="['tab-item', { 'tab-item--active': activeTab === 'all' }]"
        @click="switchTab('all')"
      >
        全部订单
      </view>
      <view
        :class="['tab-item', { 'tab-item--active': activeTab === 'channel-pending' }]"
        @click="switchTab('channel-pending')"
      >
        渠道待确认
        <view v-if="store.channelPending.length > 0" class="tab-badge">
          {{ store.channelPending.reduce((sum, g) => sum + g.count, 0) }}
        </view>
      </view>
    </view>
      </template>
    </PageHeader>

    <!-- ==================== 全部订单 Tab ==================== -->
    <!-- 用 v-show 保持 DOM，避免 scroll-view 随 v-if 销毁触发 uni-h5 scrollTop null 错误 -->
    <view v-show="activeTab === 'all'" class="tab-pane">
      <scroll-view
        class="orders-scroll"
        scroll-y
        @scrolltolower="onReachBottom"
      >
        <!-- 统计摘要行 -->
        <view class="stats-row">
          <view class="stat-item">
            <text class="stat-value">{{ store.stats?.total || 0 }}</text>
            <text class="stat-label">总订单</text>
          </view>
          <view class="stat-item">
            <text class="stat-value stat-value--warn">{{ store.stats?.pending || 0 }}</text>
            <text class="stat-label">待确认</text>
          </view>
          <view class="stat-item">
            <text class="stat-value stat-value--danger">{{ store.stats?.otaPending || 0 }}</text>
            <text class="stat-label">OTA待处理</text>
          </view>
          <view class="stat-item">
            <text class="stat-value stat-value--blue">{{ store.stats?.todayCheckin || 0 }}</text>
            <text class="stat-label">今日入住</text>
          </view>
          <view class="stat-item">
            <text class="stat-value">{{ store.stats?.todayCheckout || 0 }}</text>
            <text class="stat-label">今日退房</text>
          </view>
          <view v-if="(store.stats?.urgent || 0) > 0" class="stat-item stat-item--urgent">
            <text class="stat-value stat-value--danger">{{ store.stats?.urgent || 0 }}</text>
            <text class="stat-label">即将超时</text>
          </view>
        </view>

        <!-- 搜索栏 -->
        <view class="search-bar">
          <view class="search-input-wrap">
            <text class="search-icon">🔍</text>
            <input
              v-model="searchKeyword"
              class="search-input"
              placeholder="搜索客人姓名 / 订单号 / 手机号"
              confirm-type="search"
              @confirm="handleSearch"
            />
            <text v-if="searchKeyword" class="search-clear" @click="handleClearSearch">✕</text>
          </view>
        </view>

        <!-- 筛选栏 -->
        <view class="filter-bar">
          <picker
            :range="['全部渠道', ...channelOptions.map(c => c.label)]"
            @change="(e: any) => handleChannelChange(e.detail.value)"
          >
            <view class="picker-item">
              <text class="picker-label">{{ selectedChannelName }}</text>
              <text class="picker-arrow">▼</text>
            </view>
          </picker>
          <picker
            :range="statusOptions.map(s => s.label)"
            @change="(e: any) => handleStatusChange(e.detail.value)"
          >
            <view class="picker-item">
              <text class="picker-label">{{ selectedStatusName }}</text>
              <text class="picker-arrow">▼</text>
            </view>
          </picker>
        </view>

        <!-- 订单列表 -->
        <view class="order-list">
          <OrderCard
            v-for="order in store.filteredOrders"
            :key="order.id"
            :order="order"
            :show-channel="true"
            @click="handleOrderClick"
          />
        </view>

        <!-- 加载中 -->
        <view v-if="store.loading" class="loading-state">
          <text class="loading-text">加载中...</text>
        </view>

        <!-- 加载完毕 -->
        <view
          v-if="!store.loading && store.filteredOrders.length > 0 && store.pagination.page >= store.pagination.totalPages"
          class="no-more-state"
        >
          <text class="no-more-text">— 已加载全部订单 —</text>
        </view>

        <!-- 空状态 -->
        <view v-if="!store.loading && store.filteredOrders.length === 0" class="empty-state">
          <text class="empty-icon">📋</text>
          <text class="empty-text">暂无订单</text>
          <text class="empty-sub">点击右下角 ＋ 号新建订单</text>
        </view>

        <!-- 底部安全距离 -->
        <view class="bottom-safe" />
      </scroll-view>

      <!-- FAB 按钮 -->
      <view class="fab-button" @click="goCreate">
        <text class="fab-icon">＋</text>
      </view>
    </view>

    <!-- ==================== 渠道待确认 Tab ==================== -->
    <!-- 用 v-show 保持 DOM，避免 scroll-view 随 v-if 销毁触发 uni-h5 scrollTop null 错误 -->
    <view v-show="activeTab === 'channel-pending'" class="tab-pane">
      <scroll-view
        class="channel-scroll"
        scroll-y
        :style="{ paddingBottom: store.selectedIds.length > 0 ? '120rpx' : '0' }"
      >
        <!-- 按渠道分组 -->
        <view v-for="group in store.channelPending" :key="group.name" class="channel-group">
          <!-- 渠道组头部 -->
          <view class="channel-group-header">
            <view class="channel-group-left" @click="handleSelectAllChannel(group.name)">
              <view :class="['group-checkbox', { 'group-checkbox--all': isChannelAllSelected(group.name) }]">
                <text v-if="isChannelAllSelected(group.name)" class="group-check-icon">✓</text>
              </view>
              <text class="group-icon">{{ group.icon || getChannelIcon(group.name) }}</text>
              <text class="group-name">{{ group.name }}</text>
              <text class="group-count">{{ group.count }}笔</text>
              <text v-if="group.urgentCount > 0" class="group-urgent">⚡{{ group.urgentCount }}笔紧急</text>
            </view>
          </view>

          <!-- 该渠道下的订单 -->
          <OrderCard
            v-for="order in group.orders"
            :key="order.id"
            :order="order"
            :show-checkbox="true"
            :checked="store.selectedIds.includes(order.id)"
            @click="handleOrderClick"
            @check="handleCheckOrder"
          />
        </view>

        <!-- 空状态 -->
        <view v-if="store.channelPending.length === 0" class="empty-state">
          <text class="empty-icon">✅</text>
          <text class="empty-text">所有渠道订单已处理完毕</text>
        </view>

        <!-- 底部安全距离 -->
        <view class="bottom-safe" />
      </scroll-view>

      <!-- 底部批量操作栏 -->
      <view v-if="store.selectedIds.length > 0" class="batch-bar">
        <view class="batch-left">
          <text class="batch-count">已选 {{ store.selectedIds.length }} 项</text>
          <text class="batch-clear" @click="handleClearSelection">取消选择</text>
        </view>
        <view class="batch-right">
          <button class="batch-btn" @click="handleBatchConfirm">确认入住</button>
        </view>
      </view>
    </view>

  </view>
</template>

<style lang="scss" scoped>
.orders-page {
  height: 100vh;
  box-sizing: border-box;
  /* H5 端系统原生 tabBar 为 fixed 需预留高度；App 端原生 tabBar 自动避让无需额外 padding */
  /* #ifndef APP-PLUS */
  padding-bottom: calc(112rpx + env(safe-area-inset-bottom));
  /* #endif */
  background: #F5F6FA;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.page-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #191919;
}

.nav-create-btn {
  font-size: 40rpx;
  color: #07C160;
  font-weight: 300;
  width: 64rpx;
  height: 64rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

// ========== Tab 切换（固定浮动） ==========
.tab-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 20rpx 24rpx 16rpx;
  background: #F5F6FA;
  z-index: 10;
}

.tab-item {
  flex: 1;
  height: 68rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  border-radius: 34rpx;
  font-size: 26rpx;
  font-weight: 500;
  color: #666666;
  background: #F5F6FA;
  transition: all 0.3s;

  &--active {
    background: #07C160;
    color: #FFFFFF;
  }
}

.tab-badge {
  min-width: 32rpx;
  height: 32rpx;
  border-radius: 16rpx;
  background: #FA5151;
  color: #fff;
  font-size: 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8rpx;
}

// ========== 统计摘要 ==========
.stats-row {
  display: flex;
  padding: 16rpx 24rpx;
  gap: 12rpx;
}

.stat-item {
  flex: 1;
  background: #FFFFFF;
  border-radius: 16rpx;
  padding: 16rpx 12rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}

.stat-value {
  font-size: 36rpx;
  font-weight: 700;
  color: #191919;

  &--warn {
    color: #FF9500;
  }

  &--blue {
    color: #576B95;
  }
  &--danger {
    color: #FA5151;
  }
}
.stat-item--urgent {
  background: rgba(250,81,81,0.06);
}

.stat-label {
  font-size: 20rpx;
  color: #888888;
}

// ========== 搜索栏 ==========
.search-bar {
  padding: 0 24rpx 12rpx;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  background: #F5F6FA;
  border-radius: 24rpx;
  padding: 12rpx 20rpx;
  gap: 12rpx;
}

.search-icon {
  font-size: 28rpx;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  font-size: 26rpx;
  color: #191919;
  height: 40rpx;
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

// ========== 筛选栏 ==========
.filter-bar {
  display: flex;
  padding: 0 24rpx 12rpx;
  gap: 12rpx;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 8rpx;
  background: #FFFFFF;
  border-radius: 16rpx;
  padding: 12rpx 20rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}

.picker-label {
  font-size: 24rpx;
  color: #191919;
}

.picker-arrow {
  font-size: 18rpx;
  color: #888888;
}

// ========== 滚动区域 ==========
// v-show 包裹层：占满剩余高度并作为 flex column 容器，使内部 scroll-view 的 flex:1/height:0 生效
.tab-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.orders-scroll {
  flex: 1;
  height: 0;
}

.channel-scroll {
  flex: 1;
  height: 0;
  padding: 16rpx 24rpx;
}

.order-list {
  padding: 0 24rpx;
}

// ========== 加载/空状态 ==========
.loading-state {
  display: flex;
  justify-content: center;
  padding: 32rpx;
}

.loading-text {
  font-size: 24rpx;
  color: #888888;
}

.no-more-state {
  display: flex;
  justify-content: center;
  padding: 32rpx;
}

.no-more-text {
  font-size: 22rpx;
  color: #CCCCCC;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 0;
}

.empty-icon {
  font-size: 80rpx;
  margin-bottom: 24rpx;
}

.empty-text {
  font-size: 28rpx;
  color: #888888;
  margin-bottom: 8rpx;
}

.empty-sub {
  font-size: 24rpx;
  color: #CCCCCC;
}

// ========== FAB 按钮 ==========
.fab-button {
  position: fixed;
  right: 32rpx;
  bottom: calc(120rpx + env(safe-area-inset-bottom)); /* 悬浮于底部导航上方 */
  width: 96rpx;
  height: 96rpx;
  border-radius: 48rpx;
  background: #07C160;
  box-shadow: 0 8rpx 24rpx rgba(7, 193, 96, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  transition: all 0.2s;

  &:active {
    transform: scale(0.92);
    opacity: 0.9;
  }
}

.fab-icon {
  font-size: 48rpx;
  color: #FFFFFF;
  font-weight: 300;
  line-height: 1;
}

// ========== 渠道待确认分组 ==========
.channel-group {
  margin-bottom: 24rpx;
}

.channel-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 0;
}

.channel-group-left {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.group-checkbox {
  width: 36rpx;
  height: 36rpx;
  border-radius: 6rpx;
  border: 2rpx solid #D0D0D0;
  display: flex;
  align-items: center;
  justify-content: center;

  &--all {
    background: #07C160;
    border-color: #07C160;
  }
}

.group-check-icon {
  color: #fff;
  font-size: 22rpx;
  font-weight: 700;
}

.group-icon {
  font-size: 32rpx;
}

.group-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

.group-count {
  font-size: 24rpx;
  color: #888888;
  background: #F5F6FA;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

.group-urgent {
  font-size: 22rpx;
  color: #FA5151;
  background: rgba(250, 81, 81, 0.08);
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

// ========== 底部批量操作栏 ==========
.batch-bar {
  position: fixed;
  bottom: calc(112rpx + env(safe-area-inset-bottom)); /* 位于底部导航上方 */
  left: 0;
  right: 0;
  background: #FFFFFF;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16rpx 24rpx;
  box-shadow: 0 -4rpx 16rpx rgba(0, 0, 0, 0.06);
  z-index: 100;
}

.batch-left {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.batch-count {
  font-size: 26rpx;
  color: #191919;
  font-weight: 500;
}

.batch-clear {
  font-size: 24rpx;
  color: #888888;
}

.batch-right {
  display: flex;
  gap: 12rpx;
}

.batch-btn {
  height: 72rpx;
  padding: 0 36rpx;
  background: #07C160;
  color: #FFFFFF;
  border-radius: 36rpx;
  font-size: 26rpx;
  font-weight: 500;
  border: none;
  line-height: 72rpx;

  &:active {
    opacity: 0.85;
  }
}

// ========== 底部安全距离 ==========
.bottom-safe {
  height: calc(48rpx + env(safe-area-inset-bottom));
}
</style>
