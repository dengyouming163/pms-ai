<script setup lang="ts">
import { ref, onMounted } from 'vue'

import { getCustomerList, getCustomerDetail } from '@/api/modules/customers'
import type { CustomerInfo, CustomerStats, MemberLevel } from '@/types/customer'

const loading = ref(true)
const customerList = ref<CustomerInfo[]>([])
const stats = ref<CustomerStats | null>(null)
const keyword = ref('')
const selectedLevel = ref('')
const showDetail = ref(false)
const detailCustomer = ref<CustomerInfo | null>(null)

/** 会员等级配置 */
const levelOptions = [
  { label: '全部', value: '' },
  { label: '钻石会员', value: 'diamond' },
  { label: '金卡会员', value: 'gold' },
  { label: '银卡会员', value: 'silver' },
  { label: '普通会员', value: 'regular' },
]

/** 会员等级颜色 */
function getLevelStyle(level: string | MemberLevel | undefined) {
  const key = typeof level === 'object' ? (level as MemberLevel).key : level
  const map: Record<string, { color: string; bg: string; name: string; icon: string }> = {
    diamond: { color: '#576B95', bg: 'rgba(87,107,149,0.1)', name: '钻石会员', icon: '💎' },
    gold: { color: '#FF9500', bg: 'rgba(255,149,0,0.1)', name: '金卡会员', icon: '🥇' },
    silver: { color: '#888888', bg: 'rgba(136,136,136,0.1)', name: '银卡会员', icon: '🥈' },
    regular: { color: '#07C160', bg: 'rgba(7,193,96,0.1)', name: '普通会员', icon: '🎫' },
  }
  return map[key as string] || map.regular
}

/** 来源中文映射 */
const sourceMap: Record<string,string> = { walk_in:'到店',walkin:'到店',direct:'直营',ota:'OTA',phone:'电话预订',group:'团队',corporate:'企业协议',manual:'手动录入',携程:'携程',美团:'美团',飞猪:'飞猪',抖音:'抖音',直营:'直营',到店:'到店',散客:'到店',到店散客:'到店',walk:'到店','自来客':'到店','walk-in':'到店' }
function getSourceLabel(s?: string) {
  if (!s) return '到店'
  const k = s.toLowerCase().replace(/[-_\s]/g,'')
  for (const [key,val] of Object.entries(sourceMap)) { if (key.toLowerCase().replace(/[-_\s]/g,'') === k) return val }
  return s
}

/** 过滤掉来源类标签 */
const sourceKeys = ['walk_in','walk-in','walkin','walk','direct','ota','phone','group','corporate','manual','到店散客','自来客','散客']
function isSourceTag(t: string) { return sourceKeys.includes(t.toLowerCase().replace(/[-_\s]/g,'')) }
function getDisplayTags(tags?: string[]) { return (tags||[]).filter(t => !isSourceTag(t)) }

/** 标签颜色 */
function getTagStyle(index: number) {
  const colors = ['rgba(7,193,96,0.1)', 'rgba(87,107,149,0.1)', 'rgba(255,149,0,0.1)', 'rgba(250,81,81,0.1)']
  const textColors = ['#07C160', '#576B95', '#FF9500', '#FA5151']
  return { bg: colors[index % colors.length], color: textColors[index % textColors.length] }
}

/** 加载客户列表 */
async function loadCustomers() {
  loading.value = true
  try {
    const result = await getCustomerList({
      keyword: keyword.value || undefined,
      level: selectedLevel.value || undefined,
    })
    customerList.value = result.customers || []
    stats.value = result.stats || null
  } catch {
    uni.showToast({ title: '加载失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

/** 搜索 */
function handleSearch() {
  loadCustomers()
}

/** 筛选等级 */
function handleLevelChange(level: string) {
  selectedLevel.value = level
  loadCustomers()
}

/** 点击查看客户详情 */
async function handleViewDetail(customer: CustomerInfo) {
  try {
    const detail = await getCustomerDetail(customer.id)
    detailCustomer.value = detail
    showDetail.value = true
  } catch {
    uni.showToast({ title: '获取详情失败', icon: 'none' })
  }
}

onMounted(() => {
  loadCustomers()
})
</script>

<template>
  <view class="customers-page">
    <scroll-view class="page-scroll" scroll-y :show-scrollbar="false">
      <!-- 统计卡片 -->
      <view v-if="stats" class="stats-row">
        <view class="stat-item"><text class="stat-value">{{ stats.total }}</text><text class="stat-label">客户总数</text></view>
        <view class="stat-item"><text class="stat-value green">{{ stats.vipCount }}</text><text class="stat-label">VIP</text></view>
        <view class="stat-item"><text class="stat-value orange">{{ stats.newThisMonth }}</text><text class="stat-label">本月新增</text></view>
        <view class="stat-item"><text class="stat-value accent">{{ stats.carePending || 0 }}</text><text class="stat-label">待关怀</text></view>
      </view>

      <!-- 搜索栏 -->
      <view class="search-bar">
        <view class="search-input-wrap">
          <text class="search-icon">🔍</text>
          <input
            v-model="keyword"
            class="search-input"
            placeholder="搜索姓名/手机号"
            confirm-type="search"
            @confirm="handleSearch"
          />
        </view>
      </view>

      <!-- 等级筛选 -->
      <scroll-view class="level-filter" scroll-x :show-scrollbar="false">
        <view
          v-for="opt in levelOptions"
          :key="opt.value"
          :class="['filter-tag', { active: selectedLevel === opt.value }]"
          @click="handleLevelChange(opt.value)"
        >
          <text class="filter-text">{{ opt.label }}</text>
        </view>
      </scroll-view>

      <!-- 加载状态 -->
      <view v-if="loading" class="empty-state">
        <text class="empty-text">加载中...</text>
      </view>

      <!-- 空状态 -->
      <view v-else-if="customerList.length === 0" class="empty-state">
        <text class="empty-icon">👥</text>
        <text class="empty-text">暂无客户数据</text>
      </view>

      <!-- 客户列表 -->
      <view v-else class="customer-list">
        <view v-for="(customer, idx) in customerList" :key="customer.id" class="customer-card" @click="handleViewDetail(customer)">
          <view class="customer-main">
            <view class="customer-avatar" :style="{ backgroundColor: getLevelStyle(customer.memberLevel).bg }">
              <text class="customer-avatar-text">{{ customer.name.substring(0, 1) }}</text>
            </view>
            <view class="customer-info">
              <view class="customer-name-row">
                <text class="customer-name">{{ customer.name }}</text>
                <view
                  class="level-badge"
                  :style="{ color: getLevelStyle(customer.memberLevel).color, backgroundColor: getLevelStyle(customer.memberLevel).bg }"
                >
                  <text class="level-text">{{ getLevelStyle(customer.memberLevel).name }}</text>
                </view>
              </view>
              <text v-if="customer.phone" class="customer-phone">{{ customer.phone }}</text>
              <!-- 标签 -->
              <view v-if="getDisplayTags(customer.tags).length > 0" class="tag-row">
                <view
                  v-for="(tag, tagIdx) in getDisplayTags(customer.tags).slice(0, 3)"
                  :key="tag"
                  class="tag-item"
                  :style="{ backgroundColor: getTagStyle(tagIdx).bg, color: getTagStyle(tagIdx).color }"
                >
                  <text class="tag-text">{{ tag }}</text>
                </view>
              </view>
            </view>
          </view>
          <!-- 消费数据 -->
          <view class="customer-stats">
            <view class="customer-stat-item">
              <text class="cs-label">入住次数</text>
              <text class="cs-value">{{ customer.stayCount || 0 }}</text>
            </view>
            <view class="customer-stat-item">
              <text class="cs-label">累计消费</text>
              <text class="cs-value price">¥{{ customer.totalSpent || 0 }}</text>
            </view>
            <view class="customer-stat-item">
              <text class="cs-label">来源</text>
              <text class="cs-value">{{ getSourceLabel(customer.source) }}</text>
            </view>
          </view>
        </view>
      </view>
    </scroll-view>

    <!-- 客户详情弹窗 -->
    <view v-if="showDetail && detailCustomer" class="detail-overlay" @click="showDetail = false">
      <view class="detail-popup" @click.stop>
        <view class="detail-header">
          <text class="detail-title">客户详情</text>
          <view class="detail-close" @click="showDetail = false">
            <text>✕</text>
          </view>
        </view>
        <view class="detail-body">
          <view class="detail-row">
            <text class="detail-label">姓名</text>
            <text class="detail-value">{{ detailCustomer.name }}</text>
          </view>
          <view class="detail-row">
            <text class="detail-label">手机号</text>
            <text class="detail-value">{{ detailCustomer.phone || '-' }}</text>
          </view>
          <view class="detail-row">
            <text class="detail-label">来源</text>
            <text class="detail-value">{{ getSourceLabel(detailCustomer.source) }}</text>
          </view>
          <view class="detail-row">
            <text class="detail-label">会员等级</text>
            <text class="detail-value">{{ getLevelStyle(detailCustomer.memberLevel).icon }} {{ getLevelStyle(detailCustomer.memberLevel).name }}</text>
          </view>
          <view class="detail-row">
            <text class="detail-label">入住次数</text>
            <text class="detail-value">{{ detailCustomer.stayCount || 0 }} 次</text>
          </view>
          <view class="detail-row">
            <text class="detail-label">累计消费</text>
            <text class="detail-value price">¥{{ detailCustomer.totalSpent || 0 }}</text>
          </view>
          <view class="detail-row">
            <text class="detail-label">价值评分</text>
            <text class="detail-value">{{ detailCustomer.valueScore || 0 }} 分</text>
          </view>
          <view v-if="detailCustomer.remark" class="detail-row">
            <text class="detail-label">备注</text>
            <text class="detail-value">{{ detailCustomer.remark }}</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.customers-page {
  min-height: 100vh;
  background: #F5F6FA;
}

.page-scroll {
  padding: 24rpx;
  box-sizing: border-box;
}

/* 统计卡片行 */
.stats-row {
  display: flex;
  gap: 16rpx;
  margin-bottom: 24rpx;
}

.stat-item {
  flex: 1;
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 28rpx 20rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}

.stat-value {
  font-size: 36rpx;
  font-weight: 700;
  color: #191919;

  &.green { color: #07C160; }
  &.orange { color: #FF9500; }
}

.stat-label {
  font-size: 24rpx;
  color: #888888;
}

/* 搜索栏 */
.search-bar {
  margin-bottom: 16rpx;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  gap: 12rpx;
  background: #FFFFFF;
  border-radius: 16rpx;
  padding: 0 24rpx;
  height: 80rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);
}

.search-icon {
  font-size: 28rpx;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  font-size: 28rpx;
  color: #191919;
  height: 80rpx;
}

/* 等级筛选 */
.level-filter {
  white-space: nowrap;
  margin-bottom: 16rpx;
  padding: 4rpx 0;
}

.filter-tag {
  display: inline-flex;
  align-items: center;
  padding: 12rpx 24rpx;
  background: #FFFFFF;
  border-radius: 16rpx;
  margin-right: 16rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);

  &.active {
    background: rgba(7, 193, 96, 0.1);
    border: 2rpx solid #07C160;
  }

  &:active {
    opacity: 0.7;
  }
}

.filter-text {
  font-size: 24rpx;
  color: #191919;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 120rpx 0;
  gap: 16rpx;
}

.empty-icon {
  font-size: 72rpx;
}

.empty-text {
  font-size: 28rpx;
  color: #888888;
}

/* 客户列表 */
.customer-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.customer-card {
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);

  &:active {
    background: rgba(0, 0, 0, 0.02);
  }
}

.customer-main {
  display: flex;
  gap: 20rpx;
}

.customer-avatar {
  width: 80rpx;
  height: 80rpx;
  border-radius: 40rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.customer-avatar-text {
  font-size: 32rpx;
  font-weight: 700;
}

.customer-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.customer-name-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.customer-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

.level-badge {
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
}

.level-text {
  font-size: 20rpx;
  font-weight: 500;
}

.customer-phone {
  font-size: 24rpx;
  color: #888888;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8rpx;
  margin-top: 4rpx;
}

.tag-item {
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

.tag-text {
  font-size: 20rpx;
  font-weight: 500;
}

/* 客户消费数据 */
.customer-stats {
  display: flex;
  gap: 24rpx;
  margin-top: 16rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #EDEDED;
}

.customer-stat-item {
  display: flex;
  flex-direction: column;
  gap: 4rpx;
}

.cs-label {
  font-size: 20rpx;
  color: #888888;
}

.cs-value {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;

  &.price {
    color: #FA5151;
  }
}

/* ========== 详情弹窗 ========== */
.detail-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2000;
  display: flex;
  align-items: flex-end;
}

.detail-popup {
  width: 100%;
  max-height: 70vh;
  background: #FFFFFF;
  border-radius: 24rpx 24rpx 0 0;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 28rpx 24rpx 16rpx;
  border-bottom: 1rpx solid #EDEDED;
}

.detail-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #191919;
}

.detail-close {
  width: 48rpx;
  height: 48rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 24rpx;
  background: #F5F6FA;
  font-size: 24rpx;
  color: #888888;
}

.detail-body {
  padding: 16rpx 24rpx 48rpx;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20rpx 0;
  border-bottom: 1rpx solid #EDEDED;

  &:last-child {
    border-bottom: none;
  }
}

.detail-label {
  font-size: 28rpx;
  color: #888888;
}

.detail-value {
  font-size: 28rpx;
  color: #191919;
  font-weight: 500;

  &.price {
    color: #FA5151;
  }
}
  .stat-value.blue { color: #576B95; }
  .stat-value.accent { color: #8B5CF6; }
</style>
