<template>
  <view class="home-page">
    <!-- 固定头部: PageHeader（与其他 tab 页一致：门店选择器 + 标题） -->
    <PageHeader>
      <template #title>工作台</template>
    </PageHeader>
    <scroll-view class="page-scroll" scroll-y>
      <!-- 今日素材打卡 -->
      <view class="checkin-card" @click="goToAssets">
        <view class="checkin-left">
          <text class="checkin-title">📷 今日素材打卡</text>
          <text class="checkin-sub">按拍摄模板产出素材，让门店素材持续积累</text>
        </view>
        <view class="checkin-arrow">›</view>
      </view>

      <!-- 功能菜单 -->
      <view class="section" v-for="group in menuGroups" :key="group.title">
        <text class="group-title">{{ group.title }}</text>
        <view class="grid-wrap">
          <template v-for="item in group.items" :key="item.label">
            <view
              v-if="!item.managerOnly || isManager"
              class="grid-card"
              @click="handleMenuTap(item.path)"
            >
              <view class="gc-icon-box" :style="iconBoxStyle(item)">
                <image class="gc-icon" :src="`/static/icon/${item.icon}.png`" mode="aspectFit" />
              </view>
              <text class="gc-title">{{ item.label }}</text>
            </view>
          </template>
        </view>
      </view>

      <view class="bottom-spacer" />
    </scroll-view>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import PageHeader from '@/components/PageHeader.vue'
import { useAuthStore } from '@/stores/auth'
import { isManagerRole } from '@/utils/role'

interface MenuItem {
  label: string
  path: string
  bg: string
  color: string
  // PNG 图标文件名（src/static/icon/ 下，颜色已烘焙进图片）
  icon: string
  managerOnly?: boolean
}
interface MenuGroup {
  title: string
  items: MenuItem[]
}

const authStore = useAuthStore()
// 管理端角色才显示「发打卡任务/完成率/自动化任务」等管理操作（后端 403，普通员工点了无响应）
const isManager = computed(() => isManagerRole(authStore.userInfo))

// 功能菜单配置：素材工具 / 经营管理 / 营销创作 三组
const menuGroups: MenuGroup[] = [
  {
    title: '素材工具',
    items: [
      {
        label: '素材库',
        path: '/pages/profile/assets',
        bg: '#FFF1F2',
        color: '#F43F5E',
        icon: 'material',
      },
      {
        label: '发打卡任务',
        path: '/pages/assets/task-create',
        bg: '#ECFDF5',
        color: '#10B981',
        managerOnly: true,
        icon: 'task-create',
      },
      {
        label: '完成率',
        path: '/pages/assets/task-stats',
        bg: '#FFFBEB',
        color: '#F59E0B',
        managerOnly: true,
        icon: 'completion',
      },
      {
        label: '拍摄模板',
        path: '/pages/assets/templates',
        bg: '#F5F3FF',
        color: '#8B5CF6',
        icon: 'template',
      },
      {
        label: '自动化任务',
        path: '/pages/assets/task-rules',
        bg: '#E0F2FE',
        color: '#0284C7',
        managerOnly: true,
        icon: 'auto-task',
      },
    ],
  },
  {
    title: '经营管理',
    items: [
      {
        label: '员工管理',
        path: '/pages/profile/staff',
        bg: '#EEF2FF',
        color: '#4F6EF7',
        icon: 'staff',
      },
      {
        label: '客户管理',
        path: '/pages/profile/customers',
        bg: '#FFF7ED',
        color: '#F59E0B',
        icon: 'customers',
      },
      {
        label: '定价中心',
        path: '/pages/profile/pricing-center',
        bg: '#ECFDF5',
        color: '#10B981',
        icon: 'pricing',
      },
      {
        label: '房型管理',
        path: '/pages/profile/room-types',
        bg: '#F0F9FF',
        color: '#0EA5E9',
        icon: 'room-types',
      },
      {
        label: '到店核销',
        path: '/pages/verify/index',
        bg: '#E8F9F0',
        color: '#07C160',
        icon: 'verify',
      },
    ],
  },
  {
    title: '营销创作',
    items: [
      {
        label: '短视频脚本',
        path: '/pages/video-script/index',
        bg: '#FDF2F8',
        color: '#EC4899',
        icon: 'video-script',
      },
    ],
  },
]

function handleMenuTap(path: string) {
  uni.navigateTo({ url: path })
}

// 图标盒样式：按菜单项主色派生 对角渐变 + 顶部高光 + 同色柔影（px 单位，内联 style 不转换 rpx）
function iconBoxStyle(item: MenuItem) {
  return {
    background: `linear-gradient(145deg, ${item.bg} 0%, ${item.color}2e 100%)`,
    color: item.color,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.7), 0 3px 8px ${item.color}1f`,
  }
}

function goToAssets() { uni.navigateTo({ url: '/pages/assets/task-list' }) }
</script>

<style lang="scss" scoped>
.home-page {
  min-height: 100vh;
  background: #F3F4F6;
  display: flex;
  flex-direction: column;
}

.page-scroll {
  flex: 1;
  width: 100%;
  padding: 20rpx 24rpx;
  padding-bottom: 160rpx;
  box-sizing: border-box;
}

/* === 分区通用 === */
.section {
  margin-bottom: 28rpx;
}

/* === 今日素材打卡 === */
.checkin-card {
  margin: 20rpx 0;
  background: linear-gradient(135deg, #07C160, #05A04F);
  border-radius: 20rpx;
  padding: 28rpx 32rpx;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 8rpx 24rpx rgba(7,193,96,0.25);
}

.checkin-left {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.checkin-title {
  color: #fff;
  font-size: 32rpx;
  font-weight: 700;
}

.checkin-sub {
  color: rgba(255,255,255,0.85);
  font-size: 24rpx;
}

.checkin-arrow {
  color: #fff;
  font-size: 40rpx;
}

/* === 功能菜单网格 === */
.group-title {
  font-size: 24rpx;
  font-weight: 600;
  color: #9BA8B5;
  margin-bottom: 16rpx;
  display: block;
}

.grid-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 14rpx;
  margin-bottom: 8rpx;
}

.grid-card {
  flex: 0 0 calc(25% - 11rpx);
  padding: 24rpx 6rpx 20rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  background: #FFFFFF;
  border-radius: 26rpx;
  box-shadow: 0 2rpx 12rpx rgba(29, 42, 58, 0.05);
  box-sizing: border-box;
  transition: transform 0.2s ease, box-shadow 0.2s ease;

  &:active {
    transform: scale(0.95);
    box-shadow: 0 1rpx 6rpx rgba(29, 42, 58, 0.04);
  }
}

.gc-icon-box {
  width: 64rpx;
  height: 64rpx;
  border-radius: 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14rpx;
}

.gc-icon {
  width: 48rpx;
  height: 48rpx;
}

.gc-title {
  font-size: 24rpx;
  font-weight: 500;
  color: #191919;
  letter-spacing: 1rpx;
  text-align: center;
}

.bottom-spacer {
  height: 40rpx;
}
</style>
