<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { VoiceTask } from '@/types/ai'

interface VoiceRecord {
  id: string
  voiceId: string
  voiceName: string
  gender: string
  scenario: string
  status: string
  createdAt: string
}

const loading = ref(true)
const list = ref<VoiceRecord[]>([])
const showCreate = ref(false)
const createForm = ref({ voiceName: '', gender: '男', scenario: 'story' })

const genderOptions = ['男', '女']
const scenarioOptions = [
  { value: 'story', label: '有声书' },
  { value: 'customer_service', label: '客服' },
  { value: 'narration', label: '旁白' },
]

const statusMap: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: '处理中', color: '#FF9500', bg: 'rgba(255,149,0,0.1)' },
  training: { label: '训练中', color: '#576B95', bg: 'rgba(87,107,149,0.1)' },
  ready: { label: '就绪', color: '#07C160', bg: 'rgba(7,193,96,0.1)' },
  failed: { label: '失败', color: '#FA5151', bg: 'rgba(250,81,81,0.1)' },
}

async function fetchList() {
  loading.value = true
  try {
    const res = await uni.request({
      url: 'http://132.232.166.40:20002/api/voice/ims/list',
      method: 'GET',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${uni.getStorageSync('token')}`,
      },
    })
    const data = res.data as any
    list.value = data?.data || data || []
  } catch {
    // 静默
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (!createForm.value.voiceName) {
    uni.showToast({ title: '请输入音色名称', icon: 'none' })
    return
  }
  const voiceId = 'voice_' + Date.now()
  try {
    await uni.request({
      url: 'http://132.232.166.40:20002/api/voice/ims/create',
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${uni.getStorageSync('token')}`,
      },
      data: { voiceId, voiceName: createForm.value.voiceName, gender: createForm.value.gender, scenario: createForm.value.scenario },
    })
    uni.showToast({ title: '创建成功', icon: 'success' })
    showCreate.value = false
    createForm.value = { voiceName: '', gender: '男', scenario: 'story' }
    fetchList()
  } catch {
    uni.showToast({ title: '创建失败', icon: 'none' })
  }
}

async function handleDelete(item: VoiceRecord) {
  uni.showModal({
    title: '确认删除',
    content: `确定要删除"${item.voiceName}"吗？`,
    success: async (res) => {
      if (!res.confirm) return
      try {
        await uni.request({
          url: 'http://132.232.166.40:20002/api/voice/ims/delete',
          method: 'POST',
          header: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${uni.getStorageSync('token')}`,
          },
          data: { id: item.id },
        })
        uni.showToast({ title: '已删除', icon: 'success' })
        fetchList()
      } catch {
        uni.showToast({ title: '删除失败', icon: 'none' })
      }
    },
  })
}

function getGenderColor(gender: string) {
  return gender === '男' ? '#576B95' : '#FA5151'
}

onMounted(() => fetchList())
</script>

<template>
  <view class="voice-page">
    <!-- 头部操作栏 -->
    <view class="header-bar">
      <text class="header-title">我的声音</text>
      <text class="header-btn" @click="showCreate = true">+ 创建音色</text>
    </view>

    <!-- 加载中 -->
    <view v-if="loading" class="state-box">
      <text class="state-text">加载中...</text>
    </view>

    <!-- 空状态 -->
    <view v-else-if="list.length === 0" class="state-box">
      <text class="state-icon">🎤</text>
      <text class="state-text">还没有声音克隆任务</text>
      <text class="state-sub">点击右上角创建音色</text>
    </view>

    <!-- 声音列表 -->
    <scroll-view v-else class="voice-scroll" scroll-y>
      <view v-for="item in list" :key="item.id" class="voice-card">
        <view class="card-left">
          <view class="card-avatar" :style="{ backgroundColor: getGenderColor(item.gender) + '15' }">
            <text class="card-avatar-text" :style="{ color: getGenderColor(item.gender) }">🎙️</text>
          </view>
        </view>
        <view class="card-body">
          <view class="card-header">
            <text class="card-name">{{ item.voiceName || item.voiceId }}</text>
            <view class="card-status" :style="{ color: (statusMap[item.status] || statusMap.pending).color, backgroundColor: (statusMap[item.status] || statusMap.pending).bg }">
              <text class="status-text">{{ (statusMap[item.status] || statusMap.pending).label }}</text>
            </view>
          </view>
          <view class="card-meta">
            <text class="meta-item">{{ item.gender || '-' }}</text>
            <text class="meta-divider">|</text>
            <text class="meta-item">{{ scenarioOptions.find(s => s.value === item.scenario)?.label || item.scenario || '-' }}</text>
          </view>
          <text class="card-id">{{ item.voiceId }}</text>
        </view>
        <view class="card-right">
          <text class="delete-btn" @click="handleDelete(item)">🗑️</text>
        </view>
      </view>
    </scroll-view>

    <!-- 创建弹窗 -->
    <view v-if="showCreate" class="modal-overlay" @click="showCreate = false">
      <view class="modal-sheet" @click.stop>
        <text class="modal-title">创建声音克隆任务</text>

        <view class="form-group">
          <text class="form-label">音色名称</text>
          <input v-model="createForm.voiceName" class="form-input" placeholder="请输入音色名称" />
        </view>

        <view class="form-group">
          <text class="form-label">性别</text>
          <view class="radio-group">
            <view
              v-for="g in genderOptions" :key="g"
              :class="['radio-item', { active: createForm.gender === g }]"
              @click="createForm.gender = g"
            >
              <text class="radio-text">{{ g }}</text>
            </view>
          </view>
        </view>

        <view class="form-group">
          <text class="form-label">场景</text>
          <view class="radio-group">
            <view
              v-for="s in scenarioOptions" :key="s.value"
              :class="['radio-item', { active: createForm.scenario === s.value }]"
              @click="createForm.scenario = s.value"
            >
              <text class="radio-text">{{ s.label }}</text>
            </view>
          </view>
        </view>

        <view class="modal-btns">
          <view class="btn-cancel" @click="showCreate = false"><text>取消</text></view>
          <view class="btn-confirm" @click="handleCreate"><text>确认创建</text></view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.voice-page { min-height: 100vh; background: #F5F6FA; }
.header-bar { display: flex; align-items: center; justify-content: space-between; padding: 24rpx; background: #fff; }
.header-title { font-size: 32rpx; font-weight: 600; color: #191919; }
.header-btn { font-size: 26rpx; color: #07C160; font-weight: 500; }
.voice-card { display: flex; align-items: center; gap: 20rpx; background: #fff; border-radius: 24rpx; padding: 24rpx; margin: 24rpx; box-shadow: 0 2rpx 16rpx rgba(0,0,0,0.04); }
.card-avatar { width: 80rpx; height: 80rpx; border-radius: 40rpx; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.card-avatar-text { font-size: 36rpx; }
.card-body { flex: 1; min-width: 0; }
.card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6rpx; }
.card-name { font-size: 28rpx; font-weight: 600; color: #191919; }
.card-status { padding: 4rpx 12rpx; border-radius: 8rpx; }
.status-text { font-size: 20rpx; font-weight: 500; }
.card-meta { display: flex; align-items: center; gap: 8rpx; margin-bottom: 4rpx; }
.meta-item { font-size: 24rpx; color: #888; }
.meta-divider { color: #EDEDED; }
.card-id { font-size: 22rpx; color: #ccc; }
.card-right { flex-shrink: 0; }
.delete-btn { font-size: 32rpx; padding: 8rpx; }
.state-box { display: flex; flex-direction: column; align-items: center; padding: 120rpx 0; }
.state-icon { font-size: 80rpx; margin-bottom: 24rpx; }
.state-text { font-size: 28rpx; color: #888; margin-bottom: 8rpx; }
.state-sub { font-size: 24rpx; color: #ccc; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; display: flex; align-items: flex-end; }
.modal-sheet { background: #fff; width: 100%; border-radius: 32rpx 32rpx 0 0; padding: 32rpx 24rpx 48rpx; max-height: 70vh; }
.modal-title { font-size: 32rpx; font-weight: 600; color: #191919; text-align: center; margin-bottom: 32rpx; }
.form-group { margin-bottom: 24rpx; }
.form-label { font-size: 26rpx; color: #888; margin-bottom: 12rpx; display: block; }
.form-input { height: 80rpx; background: #F5F6FA; border-radius: 16rpx; padding: 0 24rpx; font-size: 28rpx; color: #191919; }
.radio-group { display: flex; gap: 16rpx; flex-wrap: wrap; }
.radio-item { padding: 16rpx 32rpx; border-radius: 24rpx; background: #F5F6FA; font-size: 26rpx; color: #666; }
.radio-item.active { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 500; }
.modal-btns { display: flex; gap: 24rpx; margin-top: 32rpx; }
.btn-cancel { flex: 1; height: 80rpx; background: #F5F6FA; border-radius: 40rpx; display: flex; align-items: center; justify-content: center; font-size: 28rpx; color: #666; }
.btn-confirm { flex: 1; height: 80rpx; background: #07C160; border-radius: 40rpx; display: flex; align-items: center; justify-content: center; font-size: 28rpx; color: #fff; font-weight: 500; }
</style>
