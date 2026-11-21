<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { get, post } from '@/api/request'

/** 预定义的6个场景 */
const sceneOptions = [
  { key: 'new_house', label: '新房上线', icon: '🏠' },
  { key: 'seasonal', label: '季节推广', icon: '🌸' },
  { key: 'promo', label: '特价促销', icon: '💰' },
  { key: 'review', label: '客户好评', icon: '⭐' },
  { key: 'travel', label: '周边游攻略', icon: '🗺️' },
  { key: 'free', label: '自由发挥', icon: '✍️' },
]

/** 预定义的5个风格 */
const styleOptions = [
  { key: 'warm', label: '温馨治愈', icon: '🧸' },
  { key: 'cool', label: '高级冷淡', icon: '🖤' },
  { key: 'cute', label: '活泼可爱', icon: '🐣' },
  { key: 'literary', label: '文艺诗意', icon: '📖' },
  { key: 'real', label: '真实接地气', icon: '🌿' },
]

/* ========== 表单数据 ========== */
/** 选中的场景 */
const selectedScene = ref('')
/** 选中的风格 */
const selectedStyle = ref('')
/** 关键词 */
const keywords = ref('')
/** AI生成的内容 */
const generatedTitle = ref('')
const generatedContent = ref('')
const generatedTags = ref<string[]>([])
/** 生成中 */
const generating = ref(false)
/** 保存中 */
const saving = ref(false)
/** 从素材库选中的图片列表 */
const selectedAssetImages = ref<Array<{ id: string; url: string; name?: string }>>([])
/** 素材库弹窗 */
const showAssetPicker = ref(false)
/** 素材列表 */
const assetList = ref<Array<{ id: string; url: string; name?: string; type?: string }>>([])
/** 素材加载中 */
const assetLoading = ref(false)
/** 草稿列表 */
const draftList = ref<any[]>([])
/** 草稿加载中 */
const draftLoading = ref(false)

/* ========== 方法 ========== */

/** AI 生成小红书文案 (SSE 流式) */
async function handleGenerate() {
  if (!selectedScene.value) {
    uni.showToast({ title: '请选择场景', icon: 'none' })
    return
  }

  generating.value = true
  generatedTitle.value = ''
  generatedContent.value = ''
  generatedTags.value = []

  try {
    // 使用 fetch 进行 SSE 流式请求
    const token = uni.getStorageSync('token') || ''
    const storeId = uni.getStorageSync('currentStore')?.id || uni.getStorageSync('storeId') || ''

    const body: any = {
      scene: selectedScene.value,
      style: selectedStyle.value || 'warm',
      keywords: keywords.value || '',
    }

    // fetch API with ReadableStream for SSE
    const response = await fetch('/api/xhs/drafts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
        'X-Store-Id': String(storeId),
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('不支持流式读取')
    }

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const json = JSON.parse(line.slice(6))
            if (json.title) generatedTitle.value += json.title
            if (json.content) generatedContent.value += json.content
            if (json.tags) generatedTags.value = json.tags
          } catch {
            // 跳过解析失败的行
          }
        }
      }
    }

    uni.showToast({ title: '文案生成完成', icon: 'success' })
  } catch (e: any) {
    uni.showToast({
      title: e?.msg || e?.message || 'AI生成失败，请重试',
      icon: 'none',
    })
  } finally {
    generating.value = false
  }
}

/** 保存到草稿 */
async function handleSaveDraft() {
  if (!generatedTitle.value || !generatedContent.value) {
    uni.showToast({ title: '请先生成文案内容', icon: 'none' })
    return
  }

  saving.value = true
  try {
    await post('/api/xhs/drafts', {
      title: generatedTitle.value,
      content: generatedContent.value,
      tags: generatedTags.value,
      scene: selectedScene.value,
      style: selectedStyle.value,
      action: 'save',
      images: selectedAssetImages.value.map((img) => ({ id: img.id, url: img.url })),
    })

    uni.showToast({ title: '已保存为草稿', icon: 'success' })
    await loadDrafts()
    // 清空已选图片
    selectedAssetImages.value = []
  } catch (e: any) {
    uni.showToast({ title: e?.msg || e?.message || '保存失败', icon: 'none' })
  } finally {
    saving.value = false
  }
}

/** 加载草稿列表 */
async function loadDrafts() {
  draftLoading.value = true
  try {
    const result: any = await get('/api/xhs/drafts')
    draftList.value = result?.list || result?.data || result || []
  } catch {
    draftList.value = []
  } finally {
    draftLoading.value = false
  }
}

/** 删除草稿 */
async function handleDeleteDraft(id: string) {
  uni.showModal({
    title: '确认删除',
    content: '确定要删除这条草稿吗？',
    success: async (res) => {
      if (res.confirm) {
        try {
          await (await import('@/api/request')).del(`/api/xhs/drafts/${id}`)
          uni.showToast({ title: '已删除', icon: 'success' })
          await loadDrafts()
        } catch {
          uni.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    },
  })
}

/** 打开素材库弹窗 */
async function openAssetPicker() {
  showAssetPicker.value = true
  assetLoading.value = true
  try {
    const data: any = await get('/api/assets')
    const all = data?.assets || data?.list || data?.data || data || []
    // 过滤出图片类型素材
    assetList.value = all.filter((a: any) => {
      if (a.type === 'image') return true
      const url = (a.url || '').toLowerCase()
      const imgExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']
      return imgExts.some((ext) => url.endsWith(ext))
    })
  } catch {
    assetList.value = []
  } finally {
    assetLoading.value = false
  }
}

/** 选中素材图片 */
function handleAssetSelect(asset: { id: string; url: string; name?: string }) {
  // 避免重复添加
  if (!selectedAssetImages.value.find((img) => img.id === asset.id)) {
    selectedAssetImages.value.push(asset)
  }
  showAssetPicker.value = false
}

/** 移除已选图片 */
function removeAssetImage(id: string) {
  selectedAssetImages.value = selectedAssetImages.value.filter((img) => img.id !== id)
}

/** 关闭素材弹窗 */
function closeAssetPicker() {
  showAssetPicker.value = false
}

/** 页面初始化 */
onMounted(async () => {
  await loadDrafts()
})
</script>

<template>
  <view class="xhs-page">
    <scroll-view class="content-scroll" scroll-y :show-scrollbar="false">
      <!-- ========== 场景选择 ========== -->
      <view class="section-card">
        <view class="section-label">选择场景</view>
        <view class="chip-grid">
          <view
            v-for="scene in sceneOptions"
            :key="scene.key"
            :class="['chip-item', { active: selectedScene === scene.key }]"
            @click="selectedScene = scene.key"
          >
            <text class="chip-icon">{{ scene.icon }}</text>
            <text class="chip-label">{{ scene.label }}</text>
          </view>
        </view>
      </view>

      <!-- ========== 风格选择 ========== -->
      <view class="section-card">
        <view class="section-label">文案风格</view>
        <view class="chip-grid">
          <view
            v-for="style in styleOptions"
            :key="style.key"
            :class="['chip-item', { active: selectedStyle === style.key }]"
            @click="selectedStyle = style.key"
          >
            <text class="chip-icon">{{ style.icon }}</text>
            <text class="chip-label">{{ style.label }}</text>
          </view>
        </view>
      </view>

      <!-- ========== 关键词输入 ========== -->
      <view class="section-card">
        <view class="section-label">关键词（可选）</view>
        <input
          v-model="keywords"
          class="form-input"
          placeholder="例如：海景民宿、亲子出游、拍照打卡..."
          :maxlength="100"
        />
      </view>

      <!-- ========== AI生成按钮 ========== -->
      <view class="submit-btn-area">
        <view
          :class="['submit-btn', { disabled: generating }]"
          @click="!generating && handleGenerate()"
        >
          <text>{{ generating ? '✨ AI正在创作中...' : '✨ AI 生成文案' }}</text>
        </view>
      </view>

      <!-- ========== 生成结果展示 ========== -->
      <view v-if="generatedTitle || generatedContent" class="result-area">
        <!-- 标题 -->
        <view class="section-card result-card">
          <view class="result-header">
            <text class="result-label">标题</text>
            <text class="edit-hint" @click="uni.setClipboardData({ data: generatedTitle })">复制</text>
          </view>
          <text class="result-title-text">{{ generatedTitle }}</text>
        </view>

        <!-- 正文 -->
        <view class="section-card result-card">
          <view class="result-header">
            <text class="result-label">正文内容</text>
            <text class="edit-hint" @click="uni.setClipboardData({ data: generatedContent })">复制</text>
          </view>
          <view class="result-content-text">{{ generatedContent }}</view>
        </view>

        <!-- 标签 -->
        <view v-if="generatedTags.length > 0" class="section-card result-card">
          <text class="result-label">推荐标签</text>
          <view class="tag-row">
            <text
              v-for="(tag, idx) in generatedTags"
              :key="idx"
              class="tag-badge"
            >#{{ tag }}</text>
          </view>
        </view>

        <!-- 编辑&保存 -->
        <view class="action-row">
          <view
            :class="['save-btn', { disabled: saving }]"
            @click="!saving && handleSaveDraft()"
          >
            <text>{{ saving ? '保存中...' : '💾 保存为草稿' }}</text>
          </view>
        </view>

        <!-- 素材图片选择 -->
        <view class="section-card asset-section">
          <view class="result-header">
            <text class="result-label">配图选择（从素材库）</text>
          </view>
          <!-- 已选图片预览 -->
          <view v-if="selectedAssetImages.length > 0" class="selected-images-row">
            <view
              v-for="img in selectedAssetImages"
              :key="img.id"
              class="selected-image-item"
            >
              <image :src="img.url" mode="aspectFill" class="selected-thumb" />
              <view class="remove-img-btn" @click="removeAssetImage(img.id)">
                <text class="remove-img-icon">x</text>
              </view>
            </view>
          </view>
          <!-- 添加图片按钮 -->
          <view class="add-image-btn" @click="openAssetPicker">
            <text>+ 从素材库选择图片</text>
          </view>
        </view>
      </view>

      <!-- 生成中的加载动画 -->
      <view v-if="generating" class="generating-hint">
        <text class="gen-icon">🤖</text>
        <text class="gen-text">AI 正在为你创作精彩文案...</text>
        <view class="gen-dots">
          <view class="dot" />
          <view class="dot" />
          <view class="dot" />
        </view>
      </view>

      <!-- ========== 草稿列表 ========== -->
      <view class="drafts-section">
        <view class="drafts-header">
          <text class="drafts-title">草稿列表</text>
          <text class="drafts-count">共{{ draftList.length }}条</text>
        </view>

        <view
          v-for="draft in draftList"
          :key="draft.id"
          class="draft-card"
        >
          <view class="draft-body">
            <text class="draft-title">{{ draft.title || '未命名草稿' }}</text>
            <text class="draft-content">{{ draft.content || '' }}</text>
            <view v-if="draft.tags && draft.tags.length" class="draft-tags">
              <text
                v-for="(tag, idx) in draft.tags"
                :key="idx"
                class="draft-tag"
              >#{{ tag }}</text>
            </view>
            <text class="draft-date">{{ draft.createdAt || '' }}</text>
          </view>
          <text class="draft-delete" @click="handleDeleteDraft(draft.id)">删除</text>
        </view>

        <view v-if="draftList.length === 0 && !draftLoading" class="empty-state">
          <text class="empty-icon">📝</text>
          <text class="empty-text">暂无草稿记录</text>
        </view>

        <view v-if="draftLoading" class="loading-text">加载中...</view>
      </view>

      <view class="bottom-spacer" />
    </scroll-view>

    <!-- ========== 素材选择弹窗 ========== -->
    <view v-if="showAssetPicker" class="asset-picker-overlay" @click="closeAssetPicker">
      <view class="asset-picker-sheet" @click.stop>
        <view class="picker-header">
          <text class="picker-title">选择素材图片</text>
          <text class="picker-close" @click="closeAssetPicker">取消</text>
        </view>
        <scroll-view class="picker-scroll" scroll-y :show-scrollbar="false">
          <view v-if="assetLoading" class="loading-text">加载中...</view>
          <view v-else-if="assetList.length === 0" class="empty-state">
            <text class="empty-icon">🖼️</text>
            <text class="empty-text">暂无图片素材</text>
            <text class="empty-hint">请先在素材库中上传图片</text>
          </view>
          <view v-else class="asset-grid">
            <view
              v-for="asset in assetList"
              :key="asset.id"
              class="asset-grid-item"
              @click="handleAssetSelect(asset)"
            >
              <image
                :src="asset.url"
                mode="aspectFill"
                class="asset-grid-thumb"
              />
              <text class="asset-grid-name">{{ asset.name || asset.url?.split('/').pop() || '图片' }}</text>
            </view>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.xhs-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: $bg-main;
}

.content-scroll {
  flex: 1;
  height: 0;
  overflow: hidden;
  padding: 24rpx;
}

/* ========== 卡片容器 ========== */
.section-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 20rpx;
  box-shadow: $shadow-card;
}

.section-label {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
  margin-bottom: 16rpx;
}

/* ========== 场景/风格 芯片网格 ========== */
.chip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}

.chip-item {
  display: flex;
  align-items: center;
  gap: 8rpx;
  padding: 12rpx 20rpx;
  border-radius: 24rpx;
  background: #f5f5f5;
  transition: all 0.2s;

  &.active {
    background: $primary-green;
  }
}

.chip-icon {
  font-size: 26rpx;
}

.chip-label {
  font-size: 24rpx;
  color: $text-secondary;
  font-weight: 500;
}

.chip-item.active .chip-label {
  color: #fff;
  font-weight: 600;
}

/* ========== 输入框 ========== */
.form-input {
  width: 100%;
  padding: 20rpx;
  border-radius: $radius-md;
  background: $bg-main;
  font-size: 26rpx;
  color: $text-primary;
  box-sizing: border-box;
}

/* ========== 提交按钮 ========== */
.submit-btn-area {
  padding: 8rpx 0 16rpx;
}

.submit-btn {
  width: 100%;
  padding: 28rpx 0;
  background: $gradient-primary;
  border-radius: $radius-md;
  text-align: center;
  box-shadow: 0 6rpx 24rpx rgba(7, 193, 96, 0.3);

  text {
    font-size: 32rpx;
    font-weight: 600;
    color: #fff;
  }

  &.disabled {
    opacity: 0.6;
  }

  &:active {
    opacity: 0.85;
  }
}

/* ========== 生成结果区 ========== */
.result-area {
  margin-top: 8rpx;
}

.result-card {
  background: #fafffe;
  border: 2rpx solid rgba(7, 193, 96, 0.12);
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12rpx;
}

.result-label {
  font-size: 26rpx;
  font-weight: 600;
  color: $primary-green;
}

.edit-hint {
  font-size: 24rpx;
  color: $primary-green;
  padding: 4rpx 12rpx;
}

.result-title-text {
  font-size: 32rpx;
  font-weight: 700;
  color: $text-primary;
  line-height: 1.5;
}

.result-content-text {
  font-size: 26rpx;
  color: $text-primary;
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-all;
}

/* ========== 标签 ========== */
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}

.tag-badge {
  padding: 6rpx 16rpx;
  background: rgba(7, 193, 96, 0.08);
  color: $primary-green;
  font-size: 22rpx;
  border-radius: 16rpx;
  font-weight: 500;
}

/* ========== 操作行 ========== */
.action-row {
  padding: 8rpx 0;
}

.save-btn {
  width: 100%;
  padding: 24rpx 0;
  border: 2rpx solid $primary-green;
  border-radius: $radius-md;
  text-align: center;
  background: #fff;

  text {
    font-size: 28rpx;
    font-weight: 600;
    color: $primary-green;
  }

  &.disabled {
    opacity: 0.6;
  }

  &:active {
    background: rgba(7, 193, 96, 0.05);
  }
}

/* ========== 生成中动画 ========== */
.generating-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12rpx;
  padding: 32rpx;
  margin-bottom: 20rpx;
  background: #fff;
  border-radius: $radius-lg;
  box-shadow: $shadow-card;
}

.gen-icon {
  font-size: 36rpx;
  animation: bounce 1s infinite;
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8rpx); }
}

.gen-text {
  font-size: 26rpx;
  color: $text-secondary;
}

.gen-dots {
  display: flex;
  gap: 6rpx;
}

.dot {
  width: 10rpx;
  height: 10rpx;
  border-radius: 50%;
  background: $primary-green;
  animation: blink 1.2s infinite;

  &:nth-child(2) { animation-delay: 0.2s; }
  &:nth-child(3) { animation-delay: 0.4s; }
}

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

/* ========== 草稿列表 ========== */
.drafts-section {
  margin-top: 32rpx;
}

.drafts-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16rpx;
}

.drafts-title {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
}

.drafts-count {
  font-size: 24rpx;
  color: $text-tertiary;
}

.draft-card {
  background: $bg-card;
  border-radius: $radius-lg;
  padding: 24rpx;
  margin-bottom: 16rpx;
  display: flex;
  align-items: flex-start;
  box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04);
}

.draft-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  overflow: hidden;
}

.draft-title {
  font-size: 28rpx;
  font-weight: 600;
  color: $text-primary;
}

.draft-content {
  font-size: 24rpx;
  color: $text-secondary;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.5;
}

.draft-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8rpx;
}

.draft-tag {
  font-size: 20rpx;
  color: $primary-green;
  background: rgba(7, 193, 96, 0.06);
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

.draft-date {
  font-size: 22rpx;
  color: $text-tertiary;
}

.draft-delete {
  font-size: 24rpx;
  color: $price-red;
  padding: 8rpx 0 8rpx 16rpx;
  flex-shrink: 0;
}

/* ========== 空状态 ========== */
.empty-state {
  text-align: center;
  padding: 64rpx 0;
}

.empty-icon {
  font-size: 56rpx;
}

.empty-text {
  display: block;
  font-size: 26rpx;
  color: $text-tertiary;
  margin-top: 12rpx;
}

.loading-text {
  text-align: center;
  font-size: 26rpx;
  color: $text-tertiary;
  padding: 32rpx 0;
}

.bottom-spacer {
  height: 48rpx;
}

/* ========== 素材图片选择 ========== */
.asset-section {
  margin-top: 0;
}

.selected-images-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  margin-bottom: 16rpx;
}

.selected-image-item {
  position: relative;
  width: 140rpx;
  height: 140rpx;
}

.selected-thumb {
  width: 100%;
  height: 100%;
  border-radius: $radius-md;
  background: #f0f0f0;
}

.remove-img-btn {
  position: absolute;
  top: -8rpx;
  right: -8rpx;
  width: 36rpx;
  height: 36rpx;
  border-radius: 50%;
  background: $price-red;
  display: flex;
  align-items: center;
  justify-content: center;
}

.remove-img-icon {
  font-size: 20rpx;
  color: #fff;
  font-weight: 700;
}

.add-image-btn {
  width: 100%;
  padding: 22rpx 0;
  border: 2rpx dashed $primary-green;
  border-radius: $radius-md;
  text-align: center;
  background: rgba(7, 193, 96, 0.03);

  text {
    font-size: 26rpx;
    color: $primary-green;
    font-weight: 500;
  }

  &:active {
    background: rgba(7, 193, 96, 0.08);
  }
}

/* ========== 素材选择弹窗 ========== */
.asset-picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.asset-picker-sheet {
  background: #fff;
  border-radius: $radius-lg $radius-lg 0 0;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  padding-bottom: constant(safe-area-inset-bottom);
  padding-bottom: env(safe-area-inset-bottom);
}

.picker-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24rpx;
  border-bottom: 2rpx solid #f0f0f0;
}

.picker-title {
  font-size: 30rpx;
  font-weight: 700;
  color: $text-primary;
}

.picker-close {
  font-size: 26rpx;
  color: $text-secondary;
  font-weight: 500;
}

.picker-scroll {
  flex: 1;
  padding: 24rpx;
}

.asset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}

.asset-grid-item {
  width: calc(33.33% - 12rpx);
  display: flex;
  flex-direction: column;
  gap: 8rpx;
  cursor: pointer;
}

.asset-grid-thumb {
  width: 100%;
  aspect-ratio: 1;
  border-radius: $radius-md;
  background: #f0f0f0;
}

.asset-grid-name {
  font-size: 20rpx;
  color: $text-secondary;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
