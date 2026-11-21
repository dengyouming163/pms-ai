<template>
  <view class="user-page">
    <scroll-view class="page-scroll" scroll-y>
      <!-- 用户卡片 -->
      <view class="profile-card">
        <view class="profile-main">
          <view class="avatar">{{ userAvatar }}</view>
          <view class="profile-info">
            <text class="user-name">{{ authStore.userInfo?.name || '用户' }}</text>
            <text class="user-role">{{ roleText }}</text>
          </view>
        </view>

        <!-- 当前门店 -->
        <view class="store-row" @click="handleSwitchStore">
          <image class="store-icon" src="/static/icon/store-building.png" mode="aspectFit" />
          <text class="store-name">{{ authStore.currentStore?.name || '未选择门店' }}</text>
          <image v-if="authStore.stores.length > 1" class="store-chevron" src="/static/icon/chevron-small.png" mode="aspectFit" />
        </view>
      </view>

      <!-- 门店切换弹窗 -->
      <t-popup v-model:visible="showStoreSelector" placement="bottom" :style="{ maxHeight: '60vh' }">
        <view class="selector-wrap">
          <view class="selector-header">
            <text class="selector-title">切换门店</text>
            <view class="selector-close" @click="closeStoreSelector">
              <image class="close-icon" src="/static/icon/close-x.png" mode="aspectFit" />
            </view>
          </view>
          <scroll-view class="selector-list" scroll-y>
            <view
              v-for="store in authStore.stores"
              :key="store.id"
              :class="['store-option', { active: store.id === authStore.currentStore?.id }]"
              @click="selectStore(store)"
            >
              <view class="store-opt-info">
                <text class="store-opt-name">{{ store.name }}</text>
                <text class="store-opt-addr">{{ store.address || '地址未设置' }}</text>
              </view>
              <view v-if="store.id === authStore.currentStore?.id" class="store-opt-check">
                <image class="check-icon" src="/static/icon/check-white.png" mode="aspectFit" />
              </view>
            </view>
          </scroll-view>
        </view>
      </t-popup>

      <!-- 菜单 -->
      <view class="menu-section">
        <text class="section-label">管理</text>
        <view class="menu-group">
          <view class="menu-item" @click="handleMenuClick('stores')">
            <view class="menu-left">
              <view class="menu-icon-wrap" style="background:rgba(60,80,104,.06);color:#3C5068;">
                <image class="menu-icon" src="/static/icon/menu-stores.png" mode="aspectFit" />
              </view>
              <text class="menu-text">门店管理</text>
            </view>
            <image class="menu-chevron" src="/static/icon/chevron-gray.png" mode="aspectFit" />
          </view>
          <view class="menu-item" @click="handleMenuClick('room-types')">
            <view class="menu-left">
              <view class="menu-icon-wrap" style="background:rgba(91,127,165,.08);color:#5B7FA5;">
                <image class="menu-icon" src="/static/icon/menu-room-types.png" mode="aspectFit" />
              </view>
              <text class="menu-text">房型管理</text>
            </view>
            <image class="menu-chevron" src="/static/icon/chevron-gray.png" mode="aspectFit" />
          </view>
          <view class="menu-item" @click="handleMenuClick('price-calendar')">
            <view class="menu-left">
              <view class="menu-icon-wrap" style="background:rgba(200,169,110,.1);color:#C8A96E;">
                <image class="menu-icon" src="/static/icon/menu-price-calendar.png" mode="aspectFit" />
              </view>
              <text class="menu-text">价格日历</text>
            </view>
            <image class="menu-chevron" src="/static/icon/chevron-gray.png" mode="aspectFit" />
          </view>
        </view>

        <text class="section-label">其他</text>
        <view class="menu-group">
          <view class="menu-item" @click="handleMenuClick('notifications')">
            <view class="menu-left">
              <view class="menu-icon-wrap" style="background:rgba(107,155,122,.08);color:#6B9B7A;">
                <image class="menu-icon" src="/static/icon/menu-notifications.png" mode="aspectFit" />
              </view>
              <text class="menu-text">通知设置</text>
            </view>
            <view class="menu-right">
              <view v-if="unreadCount > 0" class="badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</view>
              <image class="menu-chevron" src="/static/icon/chevron-gray.png" mode="aspectFit" />
            </view>
          </view>
          <view class="menu-item" @click="handleMenuClick('help')">
            <view class="menu-left">
              <view class="menu-icon-wrap" style="background:rgba(139,123,155,.08);color:#8B7B9B;">
                <image class="menu-icon" src="/static/icon/menu-help.png" mode="aspectFit" />
              </view>
              <text class="menu-text">帮助与反馈</text>
            </view>
            <image class="menu-chevron" src="/static/icon/chevron-gray.png" mode="aspectFit" />
          </view>
          <view class="menu-item" @click="handleMenuClick('about')">
            <view class="menu-left">
              <view class="menu-icon-wrap" style="background:rgba(60,80,104,.05);color:#3C5068;">
                <image class="menu-icon" src="/static/icon/menu-about.png" mode="aspectFit" />
              </view>
              <text class="menu-text">关于我们</text>
            </view>
            <image class="menu-chevron" src="/static/icon/chevron-gray.png" mode="aspectFit" />
          </view>
        </view>
      </view>

      <!-- 退出登录 -->
      <view class="logout-section">
        <view class="logout-btn" @click="handleLogout">
          <text>退出登录</text>
        </view>
      </view>

      <!-- 版本 -->
      <view class="version-info">
        <text>智宿管家 v1.0.0</text>
      </view>
    </scroll-view>

  </view>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

import { getUnreadCount } from '@/api/modules/user'
import type { Store } from '@/types/user'
import { getRoleName } from '@/utils/role'

const authStore = useAuthStore()

const showStoreSelector = ref(false)
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

function handleSwitchStore() {
  if (authStore.stores.length <= 1) {
    uni.showToast({ title: '暂无其他门店', icon: 'none' })
    return
  }
  showStoreSelector.value = true
}

function closeStoreSelector() { showStoreSelector.value = false }

function selectStore(store: Store) {
  authStore.switchStore(store)
  closeStoreSelector()
  uni.showToast({ title: '已切换门店', icon: 'success' })
}

function handleMenuClick(menu: string) {
  const messages: Record<string, { title: string; content: string }> = {
    stores: { title: '门店管理', content: '请在Web管理后台操作门店管理功能' },
    'room-types': { title: '房型管理', content: '请在Web管理后台操作房型管理功能' },
    'price-calendar': { title: '价格日历', content: '请在Web管理后台操作价格日历功能' },
    notifications: { title: '通知设置', content: '请在Web管理后台操作通知设置功能' },
    help: { title: '帮助与反馈', content: '如遇问题请联系管理员或发送邮件至support@zhisu.com' },
    about: { title: '关于智宿管家', content: '智宿管家 v1.0.0\n\n专业的酒店管理系统\n帮助您高效管理酒店运营\n\n© 2024 智宿管家' }
  }
  const msg = messages[menu]
  if (msg) {
    uni.showModal({ title: msg.title, content: msg.content, showCancel: false })
  }
}

function handleLogout() {
  uni.showModal({
    title: '退出登录',
    content: '确定要退出登录吗？',
    success: (res) => { if (res.confirm) authStore.logout() }
  })
}

onMounted(async () => {
  try {
    const result = await getUnreadCount()
    unreadCount.value = result.count || 0
  } catch { unreadCount.value = 0 }
})
</script>

<style lang="scss" scoped>
.user-page {
  min-height: 100vh;
  background: #F3F4F6;
  display: flex;
  flex-direction: column;
}

.page-scroll {
  flex: 1;
  width: 100%;
  padding: 24rpx;
  padding-bottom: 160rpx;
  box-sizing: border-box;
}

/* === 个人信息卡片 === */
.profile-card {
  background: #FFFFFF;
  border-radius: 28rpx;
  padding: 32rpx 28rpx;
  margin-bottom: 24rpx;
  border: 1rpx solid #F0F1F4;
  box-shadow: 0 1rpx 4rpx rgba(29, 42, 58, 0.03);
}

.profile-main {
  display: flex;
  align-items: center;
  gap: 20rpx;
  margin-bottom: 24rpx;
}

.avatar {
  width: 96rpx;
  height: 96rpx;
  border-radius: 48rpx;
  background: linear-gradient(135deg, #3C5068, #5B7490);
  color: #FFFFFF;
  font-size: 40rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.profile-info {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.user-name {
  font-size: 34rpx;
  font-weight: 600;
  color: #1D2A3A;
}

.user-role {
  font-size: 24rpx;
  color: #6B7C8E;
  padding: 4rpx 14rpx;
  background: rgba(60, 80, 104, 0.06);
  border-radius: 8rpx;
  align-self: flex-start;
}

.store-row {
  display: flex;
  align-items: center;
  gap: 8rpx;
  padding: 16rpx 20rpx;
  background: #F8F9FB;
  border-radius: 16rpx;

  &:active { background: #F0F1F4; }
}

.store-name {
  flex: 1;
  font-size: 26rpx;
  color: #1D2A3A;
  font-weight: 500;
}

.store-icon {
  width: 36rpx;
  height: 36rpx;
}

.store-chevron {
  width: 28rpx;
  height: 28rpx;
}

/* === 门店选择弹窗 === */
.selector-wrap {
  background: #FFFFFF;
  border-radius: 20rpx 20rpx 0 0;
}

.selector-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 28rpx 28rpx 16rpx;
  border-bottom: 1rpx solid #F0F1F4;
}

.selector-title {
  font-size: 30rpx;
  font-weight: 600;
  color: #1D2A3A;
}

.selector-close {
  color: #9BA8B5;
  padding: 4rpx;
}

.close-icon {
  width: 40rpx;
  height: 40rpx;
}

.selector-list {
  max-height: 60vh;
  padding: 16rpx 28rpx 28rpx;
}

.store-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24rpx 20rpx;
  border-radius: 16rpx;
  margin-bottom: 12rpx;
  background: #F8F9FB;

  &.active {
    background: rgba(60, 80, 104, 0.04);
    border: 1rpx solid rgba(60, 80, 104, 0.12);
  }

  &:active { background: rgba(60, 80, 104, 0.06); }
}

.store-opt-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #1D2A3A;
}

.store-opt-addr {
  font-size: 22rpx;
  color: #9BA8B5;
  margin-top: 4rpx;
}

.store-opt-check {
  width: 40rpx;
  height: 40rpx;
  background: #3C5068;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #FFFFFF;
}

.check-icon {
  width: 32rpx;
  height: 32rpx;
}

/* === 菜单 === */
.section-label {
  font-size: 22rpx;
  color: #9BA8B5;
  text-transform: uppercase;
  padding: 0 8rpx;
  margin-bottom: 12rpx;
  display: block;
}

.menu-group {
  background: #FFFFFF;
  border-radius: 20rpx;
  overflow: hidden;
  margin-bottom: 24rpx;
  border: 1rpx solid #F0F1F4;
}

.menu-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 28rpx 24rpx;
  border-bottom: 1rpx solid #F8F9FB;

  &:last-child { border-bottom: none; }

  &:active { background: #F8F9FB; }
}

.menu-left {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.menu-icon-wrap {
  width: 64rpx;
  height: 64rpx;
  border-radius: 16rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.menu-icon {
  width: 40rpx;
  height: 40rpx;
}

.menu-chevron {
  width: 32rpx;
  height: 32rpx;
}

.menu-text {
  font-size: 28rpx;
  color: #1D2A3A;
}

.menu-right {
  display: flex;
  align-items: center;
  gap: 8rpx;
}

.badge {
  min-width: 36rpx;
  height: 36rpx;
  padding: 0 10rpx;
  background: #D35A5A;
  color: #FFFFFF;
  font-size: 20rpx;
  border-radius: 18rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 500;
}

/* === 退出登录 === */
.logout-section {
  padding: 8rpx 0;
  margin-bottom: 32rpx;
}

.logout-btn {
  background: #FFFFFF;
  border-radius: 20rpx;
  padding: 28rpx;
  text-align: center;
  border: 1rpx solid #F0F1F4;
  color: #D35A5A;
  font-size: 28rpx;
  font-weight: 500;

  &:active { background: #FDF4F4; }
}

/* === 版本 === */
.version-info {
  text-align: center;
  padding: 32rpx 0;

  text {
    font-size: 24rpx;
    color: #C8CFD6;
  }
}
</style>
