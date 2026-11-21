<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fetchTemplates, createTask } from '@/api/modules/assets'
import { getStaffList } from '@/api/modules/staff'
import { getRoomTypes } from '@/api/modules/user'

interface Template { id: string; name: string; shotType: string; mediaType?: 'image' | 'video'; category?: string; guideText?: string; movementText?: string; avoidText?: string; durationMin?: number; durationMax?: number; exampleImageUrl?: string; exampleVideoUrl?: string }
interface StaffItem { id: string; name: string }

// 模板是否为视频（mediaType 缺失按图片处理）
function isVideoMedia(t: Template | undefined): boolean {
  return t?.mediaType === 'video'
}

// 拍摄点位 → 场景分组（发布页按场景展示）
const SCENE_GROUP: Record<string, string> = {
  entrance: '外部环境', courtyard: '外部环境', surrounding: '外部环境',
  lobby: '公共区域', garden: '公共区域', dining: '公共区域', facility: '公共区域', public: '公共区域',
  breakfast: '服务过程', housekeeping: '服务过程', transfer: '服务过程',
  full_view: '房间细节', bedding: '房间细节', bathroom: '房间细节', window: '房间细节', amenity: '房间细节',
  food: '其他', event: '其他',
}
const groupedTemplates = computed(() => {
  const groups: Record<string, Template[]> = {}
  for (const t of templates.value) {
    const g = SCENE_GROUP[t.shotType] || '其他'
    if (!groups[g]) groups[g] = []
    groups[g].push(t)
  }
  return groups
})

const templates = ref<Template[]>([])
const staffList = ref<StaffItem[]>([])
const loading = ref(true)
const form = ref({
  title: '', taskDate: '', deadline: '',
  templateRefs: [] as string[],
  roomNames: [] as string[], // 兼容旧数据，UI 已改用房型指定
  roomTypeIds: [] as string[],
  roomTypeNames: [] as string[],
  purposeTags: [] as string[],
  guideText: '',
  assigneeScope: 'all' as string,
  assigneeStaffIds: [] as string[],
})
const countMap = ref<Record<string, number>>({})
const purposeOptions = ['OTA展示', '短视频剪辑', '广告投放']
const submitting = ref(false)
// 房型列表 + 房型选择弹层
const roomTypes = ref<Array<{ id: string; name: string }>>([])
const showRoomTypePicker = ref(false)
const roomTypesLoading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    const data: any = await fetchTemplates()
    templates.value = data?.list || data?.data || data || []
    // 拉员工列表（用于"指定员工"指派），limit 200 全量拉取避免分页截断
    try {
      const staffData: any = await getStaffList({ limit: 200 })
      const list = staffData?.staff || staffData?.list || []
      staffList.value = list
    } catch { /* 拉员工失败时 request 层已统一提示，这里静默 */ }
    // 拉房型列表（用于按房型指定素材范围）
    roomTypesLoading.value = true
    try {
      const rtData: any = await getRoomTypes()
      const list = Array.isArray(rtData) ? rtData : rtData?.list || []
      roomTypes.value = list
    } catch { /* 拉房型失败时 request 层已统一提示，这里静默 */ }
    finally { roomTypesLoading.value = false }
  } finally { loading.value = false }
})

function toggleTemplate(id: string) {
  const idx = form.value.templateRefs.indexOf(id)
  if (idx >= 0) form.value.templateRefs.splice(idx, 1)
  else form.value.templateRefs.push(id)
}
function togglePurpose(tag: string) {
  const idx = form.value.purposeTags.indexOf(tag)
  if (idx >= 0) form.value.purposeTags.splice(idx, 1)
  else form.value.purposeTags.push(tag)
}
function toggleStaff(id: string) {
  const idx = form.value.assigneeStaffIds.indexOf(id)
  if (idx >= 0) form.value.assigneeStaffIds.splice(idx, 1)
  else form.value.assigneeStaffIds.push(id)
}
function toggleRoomType(rt: { id: string; name: string }) {
  const idx = form.value.roomTypeIds.indexOf(rt.id)
  if (idx >= 0) { form.value.roomTypeIds.splice(idx, 1); form.value.roomTypeNames.splice(idx, 1) }
  else { form.value.roomTypeIds.push(rt.id); form.value.roomTypeNames.push(rt.name) }
}

async function handleCreate() {
  // 防止重复提交
  if (submitting.value) return
  if (!form.value.title) { uni.showToast({ title: '请填写任务标题', icon: 'none' }); return }
  if (form.value.templateRefs.length === 0) { uni.showToast({ title: '请选择拍摄模板', icon: 'none' }); return }
  if (form.value.assigneeScope === 'selected' && form.value.assigneeStaffIds.length === 0) {
    uni.showToast({ title: '请选择指派员工', icon: 'none' }); return
  }
  // 截止日期合法性校验：不能早于任务日期，也不能早于当前时间（否则发布即"已逾期"）
  if (form.value.deadline && form.value.taskDate &&
      new Date(form.value.deadline).getTime() < new Date(form.value.taskDate + 'T00:00:00').getTime()) {
    uni.showToast({ title: '截止日期不能早于任务日期', icon: 'none' }); return
  }
  if (form.value.deadline && new Date(form.value.deadline).getTime() < Date.now()) {
    uni.showToast({ title: '截止日期不能早于当前时间', icon: 'none' }); return
  }
  submitting.value = true
  try {
    // 依据模板 + 数量表生成 shotRequirements（countMap 按模板 id，避免同 shotType 图文串值）
    const shotRequirements = form.value.templateRefs.map(id => {
      const t = templates.value.find(x => x.id === id)
      return {
        shotType: t?.shotType || id,
        mediaType: t?.mediaType || 'image',
        count: countMap.value[id] || 1,
        name: t?.name,
        guideText: t?.guideText,
        movementText: t?.movementText,
        avoidText: t?.avoidText,
        durationMin: t?.durationMin,
        durationMax: t?.durationMax,
        exampleImageUrl: t?.exampleImageUrl,
        exampleVideoUrl: t?.exampleVideoUrl,
      }
    })
    const now = new Date()
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    await createTask({
      title: form.value.title,
      taskDate: form.value.taskDate || todayStr,
      deadline: form.value.deadline || null,
      templateRefs: form.value.templateRefs,
      roomNames: form.value.roomNames, // 兼容旧数据，UI 已改用房型指定
      roomIds: [],
      roomTypeIds: form.value.roomTypeIds,
      roomTypeNames: form.value.roomTypeNames,
      shotRequirements,
      purposeTags: form.value.purposeTags,
      guideText: form.value.guideText,
      assigneeScope: form.value.assigneeScope,
      assigneeStaffIds: form.value.assigneeStaffIds,
    })
    uni.showToast({ title: '发布成功', icon: 'success' })
    setTimeout(() => uni.navigateBack(), 800)
  } catch { /* 发布失败时 request 层已统一提示，这里静默 */ }
  finally { submitting.value = false }
}
</script>

<template>
  <view class="page">
    <view class="form-card">
      <view class="field">
        <text class="label">任务标题 *</text>
        <input v-model="form.title" class="input" placeholder="如：8月5日 房间素材拍摄" />
      </view>
      <view class="field">
        <text class="label">任务日期</text>
        <picker mode="date" :value="form.taskDate" @change="(e:any) => form.taskDate = e.detail.value">
          <view class="picker-value">{{ form.taskDate || '选择日期' }}</view>
        </picker>
      </view>
      <view class="field">
        <text class="label">截止日期</text>
        <picker mode="date" :value="form.deadline ? form.deadline.slice(0, 10) : ''" @change="(e:any) => { const d = e.detail.value; form.deadline = d ? new Date(d + 'T23:59:59').toISOString() : '' }">
          <view class="picker-value">{{ form.deadline ? form.deadline.slice(0, 10) : '选择截止日期（可选）' }}</view>
        </picker>
      </view>
      <view class="field">
        <text class="label">指派范围</text>
        <view class="seg">
          <view :class="['seg-item', { active: form.assigneeScope === 'all' }]" @click="form.assigneeScope = 'all'">全员</view>
          <view :class="['seg-item', { active: form.assigneeScope === 'selected' }]" @click="form.assigneeScope = 'selected'">指定员工</view>
        </view>
        <view v-if="form.assigneeScope === 'selected'" class="staff-row">
          <view v-for="s in staffList" :key="s.id"
            :class="['staff-chip', { on: form.assigneeStaffIds.includes(s.id) }]"
            @click="toggleStaff(s.id)">
            <text>{{ s.name }}</text>
          </view>
        </view>
      </view>
    </view>

    <view class="section-title">选择拍摄模板 *</view>
    <view v-if="loading" class="empty"><text>加载中...</text></view>
    <view v-else class="tmpl-list">
      <template v-for="(tpls, scene) in groupedTemplates" :key="scene">
        <view class="scene-label"><text>{{ scene }}</text></view>
        <view v-for="t in tpls" :key="t.id"
          :class="['tmpl-card', { selected: form.templateRefs.includes(t.id) }]"
          @click="toggleTemplate(t.id)">
          <image v-if="t.exampleImageUrl" :src="t.exampleImageUrl" mode="aspectFill" class="tmpl-img" />
          <view class="tmpl-info">
            <view class="tmpl-name-row">
              <text class="tmpl-name">{{ t.name }}</text>
              <text :class="['media-badge', isVideoMedia(t) ? 'video' : 'image']">{{ isVideoMedia(t) ? '视频' : '图片' }}</text>
            </view>
            <text class="tmpl-guide">{{ t.guideText || '无要点说明' }}</text>
            <view class="count-row">
              <text class="count-label">{{ isVideoMedia(t) ? '条数' : '张数' }}</text>
              <view class="stepper">
                <text class="step-btn" @click.stop="countMap[t.id] = Math.max(1, (countMap[t.id] || 1) - 1)">−</text>
                <text class="step-val">{{ countMap[t.id] || 1 }}</text>
                <text class="step-btn" @click.stop="countMap[t.id] = (countMap[t.id] || 1) + 1">+</text>
              </view>
            </view>
          </view>
          <view :class="['check', { on: form.templateRefs.includes(t.id) }]">
            <text class="check-text">{{ form.templateRefs.includes(t.id) ? '✓' : '' }}</text>
          </view>
        </view>
      </template>
    </view>

    <view class="section-title">指定房型</view>
    <view class="rooms-row">
      <view v-for="(r, i) in form.roomTypeNames" :key="i" class="room-chip" @click="toggleRoomType({ id: form.roomTypeIds[i], name: r })">
        <text>{{ r }} ✕</text>
      </view>
      <view class="room-add" @click="showRoomTypePicker = true"><text>+ 房型</text></view>
    </view>

    <view class="section-title">用途标签</view>
    <view class="tag-row">
      <view v-for="tag in purposeOptions" :key="tag"
        :class="['tag-chip', { on: form.purposeTags.includes(tag) }]" @click="togglePurpose(tag)">
        <text>{{ tag }}</text>
      </view>
    </view>

    <view class="form-card">
      <view class="field">
        <text class="label">补充要求</text>
        <textarea v-model="form.guideText" class="textarea" placeholder="给员工的补充说明（选填）" />
      </view>
    </view>

    <view class="bottom-bar">
      <view class="submit-btn" :class="{ disabled: submitting }" @click="handleCreate">
        <text class="submit-btn-text">{{ submitting ? '发布中...' : '发布任务' }}</text>
      </view>
    </view>

    <!-- 房型选择弹层（底部，chips 多选，无 input 焦点问题） -->
    <t-popup v-model:visible="showRoomTypePicker" placement="bottom">
      <view class="picker-wrap">
        <view class="picker-head"><text class="picker-title">选择房型</text><text class="picker-close" @click="showRoomTypePicker = false">✕</text></view>
        <view v-if="roomTypesLoading" class="picker-hint">加载中...</view>
        <view v-else-if="roomTypes.length === 0" class="picker-hint">暂无房型，请先在后台添加</view>
        <scroll-view v-else scroll-y class="chip-scroll">
          <view class="chip-row">
            <view v-for="rt in roomTypes" :key="rt.id"
              :class="['chip', { on: form.roomTypeIds.includes(rt.id) }]" @click="toggleRoomType(rt)">
              <text>{{ rt.name }}</text>
            </view>
          </view>
        </scroll-view>
      </view>
    </t-popup>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; padding-bottom: 140rpx; }
.form-card { background: #fff; margin: 20rpx 24rpx; border-radius: 20rpx; padding: 24rpx; }
.field { margin-bottom: 24rpx; }
.label { font-size: 26rpx; color: #333; font-weight: 600; display: block; margin-bottom: 12rpx; }
.input { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; height: 88rpx; line-height: 48rpx; }
.picker-value { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; color: #333; }
.seg { display: flex; background: #F5F6FA; border-radius: 12rpx; overflow: hidden; }
.seg-item { flex: 1; text-align: center; padding: 20rpx; font-size: 26rpx; color: #666; }
.seg-item.active { background: #07C160; color: #fff; }
.staff-row { display: flex; flex-wrap: wrap; gap: 16rpx; margin-top: 16rpx; }
.staff-chip { padding: 12rpx 24rpx; border-radius: 32rpx; background: #F5F6FA; font-size: 24rpx; color: #666; }
.staff-chip.on { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.section-title { padding: 24rpx 24rpx 8rpx; font-size: 28rpx; font-weight: 600; color: #333; }
.tmpl-list { padding: 0 24rpx; }
.tmpl-card { display: flex; gap: 20rpx; background: #fff; border-radius: 20rpx; padding: 20rpx; margin-bottom: 16rpx; border: 2rpx solid transparent; position: relative; }
.tmpl-card.selected { border-color: #07C160; }
.tmpl-img { width: 160rpx; height: 120rpx; border-radius: 12rpx; background: #F0F0F0; flex-shrink: 0; }
.tmpl-info { flex: 1; display: flex; flex-direction: column; gap: 8rpx; padding-right: 56rpx; }
.tmpl-name { font-size: 28rpx; font-weight: 600; }
.tmpl-guide { font-size: 22rpx; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count-row { display: flex; align-items: center; justify-content: space-between; }
.count-label { font-size: 24rpx; color: #666; }
.stepper { display: flex; align-items: center; gap: 16rpx; }
.step-btn { width: 48rpx; height: 48rpx; border-radius: 24rpx; background: #F0F0F0; text-align: center; line-height: 48rpx; font-size: 28rpx; color: #666; }
.step-val { font-size: 28rpx; font-weight: 600; min-width: 40rpx; text-align: center; }
.check { position: absolute; top: 16rpx; right: 16rpx; width: 40rpx; height: 40rpx; border-radius: 20rpx; border: 2rpx solid #ddd; display: flex; align-items: center; justify-content: center; }
.check.on { background: #07C160; border-color: #07C160; }
.check-text { color: #fff; font-size: 24rpx; }
.rooms-row, .tag-row { display: flex; flex-wrap: wrap; gap: 16rpx; padding: 8rpx 24rpx; }
.room-chip, .tag-chip { padding: 12rpx 24rpx; border-radius: 32rpx; background: #fff; font-size: 24rpx; color: #333; }
.tag-chip.on { background: rgba(79,110,247,0.1); color: #4F6EF7; }
.room-add { padding: 12rpx 24rpx; border-radius: 32rpx; border: 2rpx dashed #ccc; font-size: 24rpx; color: #07C160; }
.textarea { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; width: 100%; box-sizing: border-box; min-height: 120rpx; height: 160rpx; }
.bottom-bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 20rpx 24rpx calc(20rpx + env(safe-area-inset-bottom)); background: #fff; }
.submit-btn { background: #07C160; border-radius: 44rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.submit-btn.disabled { opacity: 0.5; }
.submit-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }
.empty { display: flex; justify-content: center; padding: 120rpx 0; color: #888; }
.picker-wrap { background: #fff; border-radius: 24rpx 24rpx 0 0; padding: 32rpx 24rpx 48rpx; }
.picker-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24rpx; }
.picker-title { font-size: 32rpx; font-weight: 700; }
.picker-close { font-size: 32rpx; color: #999; }
.chip-row { display: flex; flex-wrap: wrap; gap: 16rpx; padding-bottom: 8rpx; }
.chip-scroll { max-height: 50vh; }
.picker-hint { padding: 40rpx 0; text-align: center; color: #888; font-size: 26rpx; }
.chip { padding: 14rpx 28rpx; border-radius: 32rpx; background: #F5F6FA; font-size: 26rpx; color: #666; }
.chip.on { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.scene-label { padding: 20rpx 8rpx 8rpx; font-size: 24rpx; font-weight: 600; color: #999; }
.tmpl-name-row { display: flex; align-items: center; gap: 12rpx; }
.media-badge { font-size: 20rpx; padding: 2rpx 12rpx; border-radius: 8rpx; }
.media-badge.image { color: #4F6EF7; background: rgba(79,110,247,0.1); }
.media-badge.video { color: #07C160; background: rgba(7,193,96,0.1); }
</style>
