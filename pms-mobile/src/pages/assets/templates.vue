<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { fetchTemplates, createTemplate, updateTemplate, deleteTemplate, fetchSystemTemplates, importSystemTemplate } from '@/api/modules/assets'
import { uploadFile } from '@/api/request'

interface Template { id: string; name: string; shotType: string; mediaType?: string; exampleImageUrl?: string; exampleVideoUrl?: string; guideText?: string; movementText?: string; avoidText?: string; durationMin?: number; durationMax?: number; category?: string }

const templates = ref<Template[]>([])
const loading = ref(true)
const saving = ref(false)
const showForm = ref(false)
const editing = ref<Template | null>(null)
const form = ref({ name: '', shotType: '', mediaType: 'image', exampleImageUrl: '', guideText: '', movementText: '', avoidText: '', durationMin: 5, durationMax: 10, category: 'room' })

// 模板分类：房间 / 公共区域 / 美食 / 其他
const categoryOptions = [
  { label: '房间', value: 'room' },
  { label: '公共区域', value: 'view' },
  { label: '美食', value: 'food' },
  { label: '其他', value: 'other' },
]

// 页签分区：我的模板 / 系统模板库
const activeTab = ref<'mine' | 'system'>('mine')
const systemTemplates = ref<Template[]>([])
const systemLoading = ref(false)

onMounted(load)

async function load() {
  loading.value = true
  try {
    const data: any = await fetchTemplates()
    templates.value = data?.list || data?.data || data || []
  } finally { loading.value = false }
}

function openCreate() { editing.value = null; form.value = { name: '', shotType: '', mediaType: 'image', exampleImageUrl: '', guideText: '', movementText: '', avoidText: '', durationMin: 5, durationMax: 10, category: 'room' }; showForm.value = true }
function openEdit(t: Template) {
  editing.value = t
  form.value = { name: t.name, shotType: t.shotType, mediaType: t.mediaType || 'image', exampleImageUrl: t.exampleImageUrl || '', guideText: t.guideText || '', movementText: t.movementText || '', avoidText: t.avoidText || '', durationMin: t.durationMin ?? 5, durationMax: t.durationMax ?? 10, category: t.category || 'room' }
  showForm.value = true
}

function pickExample() {
  uni.chooseImage({
    count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'],
    success: async (res: any) => {
      const path = res.tempFilePaths?.[0]
      if (!path) return
      try {
        const data: any = await uploadFile('/api/upload', path, 'file')
        form.value.exampleImageUrl = data?.url || data
      } catch { /* request 层已统一提示 */ }
    },
  })
}

async function handleSave() {
  if (saving.value) return
  if (!form.value.name || !form.value.shotType) { uni.showToast({ title: '名称与拍摄类型必填', icon: 'none' }); return }
  // 提交前规范化：v-model.number 在清空输入时得到 ''（parseFloat 失败回退原始串），
  // 显式剔除避免 '' 落库污染下游（task-submit/task-detail 的 `?? 5` 对 '' 不生效）。
  // 图片模板不携带建议时长，避免冗余数据落库；仅视频模板在时长非空时提交。
  const payload: Record<string, any> = { ...form.value }
  if (payload.mediaType !== 'video' || payload.durationMin === '' || payload.durationMin == null) delete payload.durationMin
  if (payload.mediaType !== 'video' || payload.durationMax === '' || payload.durationMax == null) delete payload.durationMax
  saving.value = true
  try {
    if (editing.value) await updateTemplate(editing.value.id, payload)
    else await createTemplate(payload)
    uni.showToast({ title: '保存成功', icon: 'success' })
    showForm.value = false
    load()
  } catch { /* request 层已统一 toast 提示 */ } finally { saving.value = false }
}

function handleDelete(t: Template) {
  uni.showModal({
    title: '确认删除', content: `确定删除模板「${t.name}」吗？`,
    success: async (res) => {
      if (!res.confirm) return
      try { await deleteTemplate(t.id); uni.showToast({ title: '已删除', icon: 'success' }); load() } catch { /* request 层已统一 toast 提示 */ }
    },
  })
}

// ===== 系统模板库 =====
async function loadSystem() {
  systemLoading.value = true
  try {
    const data: any = await fetchSystemTemplates()
    systemTemplates.value = data?.list || data?.data || data || []
  } catch { /* request 层已统一提示 */ } finally { systemLoading.value = false }
}

function switchTab(t: 'mine' | 'system') {
  activeTab.value = t
  if (t === 'system' && systemTemplates.value.length === 0) loadSystem()
}

async function handleImport(t: Template) {
  uni.showModal({
    title: '导入模板',
    content: `将「${t.name}」导入到本店模板？导入后可编辑`,
    success: async (res) => {
      if (!res.confirm) return
      try {
        const r: any = await importSystemTemplate(t.id)
        uni.showToast({ title: r?.duplicated ? '已导入过' : '已导入', icon: 'success' })
        activeTab.value = 'mine'
        load()
      } catch { /* request 层已统一提示 */ }
    },
  })
}
</script>

<template>
  <view class="page">
    <view class="head">
      <text class="head-title">拍摄模板库</text>
      <view class="add-btn" @click="openCreate"><text class="add-btn-text">+ 新建</text></view>
    </view>

    <view class="tabs">
      <view :class="['tab', { active: activeTab === 'mine' }]" @click="switchTab('mine')">我的模板</view>
      <view :class="['tab', { active: activeTab === 'system' }]" @click="switchTab('system')">系统模板库</view>
    </view>

    <!-- 我的模板 -->
    <template v-if="activeTab === 'mine'">
      <view v-if="loading" class="empty"><text>加载中...</text></view>
      <view v-else-if="templates.length === 0" class="empty"><text>暂无模板</text></view>

      <view v-else class="tmpl-list">
        <view v-for="t in templates" :key="t.id" class="tmpl-card" @click="openEdit(t)" @longpress="handleDelete(t)">
          <image v-if="t.exampleImageUrl" :src="t.exampleImageUrl" mode="aspectFill" class="tmpl-img" />
          <view class="tmpl-info">
            <view class="tmpl-name-row">
              <text class="tmpl-name">{{ t.name }}</text>
              <text :class="['media-badge', t.mediaType === 'video' ? 'video' : 'image']">{{ t.mediaType === 'video' ? '视频' : '图片' }}</text>
            </view>
            <text class="tmpl-guide">{{ t.guideText || '无要点说明' }}</text>
          </view>
        </view>
      </view>
    </template>

    <!-- 系统模板库 -->
    <template v-else>
      <view v-if="systemLoading" class="empty"><text>加载中...</text></view>
      <view v-else-if="systemTemplates.length === 0" class="empty"><text>暂无系统模板</text></view>

      <view v-else class="tmpl-list">
        <view v-for="t in systemTemplates" :key="t.id" class="tmpl-card">
          <image v-if="t.exampleImageUrl" :src="t.exampleImageUrl" mode="aspectFill" class="tmpl-img" />
          <view class="tmpl-info">
            <view class="tmpl-name-row">
              <text class="tmpl-name">{{ t.name }}</text>
              <text :class="['media-badge', t.mediaType === 'video' ? 'video' : 'image']">{{ t.mediaType === 'video' ? '视频' : '图片' }}</text>
            </view>
            <text class="tmpl-guide">{{ t.guideText || '无要点说明' }}</text>
          </view>
          <view class="import-btn" @click="handleImport(t)"><text class="import-btn-text">导入</text></view>
        </view>
      </view>
    </template>

    <!-- 新建/编辑弹层：改用 t-popup 底部弹层，遮罩由组件内部管理，
         点击遮罩关闭不再挂在输入框的祖先元素上，避免聚焦时误触关闭导致输入框失焦无法输入 -->
    <t-popup v-model:visible="showForm" placement="bottom">
      <view class="form-wrap">
        <view class="sheet-head">
          <text class="sheet-title">{{ editing ? '编辑模板' : '新建模板' }}</text>
          <text class="sheet-close" @click="showForm = false">✕</text>
        </view>
        <scroll-view scroll-y class="form-scroll">
          <view class="field">
            <text class="label">模板名称 *</text>
            <input v-model="form.name" class="input" placeholder="如：房间全景拍摄" />
          </view>
          <view class="field">
            <text class="label">拍摄类型 *</text>
            <input v-model="form.shotType" class="input" placeholder="如：full_view / 卫浴特写" />
          </view>
          <view class="field">
            <text class="label">分类</text>
            <view class="chip-row">
              <view
                v-for="c in categoryOptions"
                :key="c.value"
                :class="['chip', { on: form.category === c.value }]"
                @click="form.category = c.value"
              ><text>{{ c.label }}</text></view>
            </view>
          </view>
          <view class="field">
            <text class="label">素材类型</text>
            <view class="chip-row">
              <view :class="['chip', { on: form.mediaType === 'image' }]" @click="form.mediaType = 'image'"><text>图片</text></view>
              <view :class="['chip', { on: form.mediaType === 'video' }]" @click="form.mediaType = 'video'"><text>视频</text></view>
            </view>
          </view>
          <view class="field">
            <text class="label">运镜建议（视频）</text>
            <input v-model="form.movementText" class="input" placeholder="如：「推」门口→床；「摇」环视" />
          </view>
          <view class="field">
            <text class="label">禁拍项</text>
            <textarea v-model="form.avoidText" class="textarea" placeholder="如：杂物入镜、倾斜超45°" />
          </view>
          <view v-if="form.mediaType === 'video'" class="field">
            <text class="label">建议时长（秒）</text>
            <view class="duration-row">
              <input v-model.number="form.durationMin" class="input duration-input" type="number" placeholder="5" />
              <text class="duration-sep">~</text>
              <input v-model.number="form.durationMax" class="input duration-input" type="number" placeholder="10" />
            </view>
          </view>
          <view class="field">
            <text class="label">拍摄要点</text>
            <textarea v-model="form.guideText" class="textarea" placeholder="如：站门口中间横拍、开灯、角度略仰" />
          </view>
          <view class="field">
            <text class="label">示例图</text>
            <view class="example-row">
              <image v-if="form.exampleImageUrl" :src="form.exampleImageUrl" mode="aspectFill" class="example-img" />
              <view class="example-btn" @click="pickExample"><text>{{ form.exampleImageUrl ? '更换' : '上传示例图' }}</text></view>
            </view>
          </view>
          <view class="save-btn" :class="{ disabled: saving }" @click="handleSave"><text class="save-btn-text">{{ saving ? '保存中...' : '保存' }}</text></view>
        </scroll-view>
      </view>
    </t-popup>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; }
.head { display: flex; justify-content: space-between; align-items: center; background: #fff; padding: 24rpx; }
.head-title { font-size: 32rpx; font-weight: 700; }
.add-btn { background: #07C160; border-radius: 32rpx; padding: 10rpx 28rpx; }
.add-btn-text { color: #fff; font-size: 26rpx; }
.tabs { display: flex; background: #fff; padding: 16rpx 24rpx; gap: 16rpx; }
.tab { padding: 10rpx 32rpx; border-radius: 32rpx; font-size: 26rpx; color: #666; background: #F5F6FA; }
.tab.active { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.tmpl-list { padding: 20rpx 24rpx; }
.tmpl-card { display: flex; gap: 20rpx; align-items: center; background: #fff; border-radius: 20rpx; padding: 20rpx; margin-bottom: 16rpx; }
.tmpl-img { width: 160rpx; height: 120rpx; border-radius: 12rpx; background: #F0F0F0; flex-shrink: 0; }
.tmpl-info { flex: 1; display: flex; flex-direction: column; gap: 8rpx; }
.tmpl-name { font-size: 28rpx; font-weight: 600; }
.tmpl-guide { font-size: 22rpx; color: #888; }
.tmpl-name-row { display: flex; align-items: center; gap: 12rpx; }
.media-badge { font-size: 20rpx; padding: 2rpx 12rpx; border-radius: 8rpx; }
.media-badge.image { color: #4F6EF7; background: rgba(79,110,247,0.1); }
.media-badge.video { color: #07C160; background: rgba(7,193,96,0.1); }
.import-btn { background: #07C160; border-radius: 32rpx; padding: 12rpx 32rpx; flex-shrink: 0; }
.import-btn-text { color: #fff; font-size: 26rpx; }
.form-wrap { background: #fff; border-radius: 24rpx 24rpx 0 0; padding: 32rpx 24rpx 32rpx; }
.form-scroll { max-height: 60vh; }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24rpx; }
.sheet-title { font-size: 32rpx; font-weight: 700; }
.sheet-close { font-size: 32rpx; color: #999; }
.field { margin-bottom: 24rpx; }
.label { font-size: 26rpx; color: #333; font-weight: 600; display: block; margin-bottom: 12rpx; }
.input { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; height: 88rpx; line-height: 48rpx; }
.textarea { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; width: 100%; box-sizing: border-box; min-height: 120rpx; height: 160rpx; }
.chip-row { display: flex; flex-wrap: wrap; gap: 16rpx; }
.chip { padding: 12rpx 24rpx; border-radius: 32rpx; background: #F5F6FA; font-size: 24rpx; color: #666; }
.chip.on { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.duration-row { display: flex; align-items: center; gap: 16rpx; }
.duration-input { flex: 1; }
.duration-sep { font-size: 28rpx; color: #999; }
.example-row { display: flex; gap: 16rpx; align-items: center; }
.example-img { width: 120rpx; height: 90rpx; border-radius: 12rpx; background: #F0F0F0; }
.example-btn { padding: 14rpx 24rpx; border-radius: 12rpx; border: 2rpx dashed #ccc; font-size: 24rpx; color: #07C160; }
.save-btn { background: #07C160; border-radius: 44rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.save-btn.disabled { opacity: 0.5; }
.save-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }
.empty { display: flex; justify-content: center; padding: 120rpx 0; color: #888; }
</style>
