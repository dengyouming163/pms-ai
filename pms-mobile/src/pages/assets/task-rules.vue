<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { fetchTaskRules, createTaskRule, updateTaskRule, setTaskRuleStatus, deleteTaskRule, fetchTemplates } from '@/api/modules/assets'
import { getRoomTypes } from '@/api/modules/user'
import { getStaffList } from '@/api/modules/staff'

interface Rule { id: string; name: string; publishTime: string; status: string; nextRunAt?: string; roomTypeNames?: string[] }
interface Template { id: string; name: string; shotType: string }
interface RoomType { id: string; name: string }
interface StaffItem { id: string; name: string }

const rules = ref<Rule[]>([])
const templates = ref<Template[]>([])
const roomTypes = ref<RoomType[]>([])
const staffList = ref<StaffItem[]>([])
const loading = ref(true)
const showForm = ref(false)
const editing = ref<Rule | null>(null)

// 分配范围：全员 / 指定员工
const assigneeOptions = [
  { label: '全员', value: 'all' },
  { label: '指定员工', value: 'selected' },
]
const form = ref({
  name: '', templateRefs: [] as string[], roomTypeIds: [] as string[], roomTypeNames: [] as string[],
  purposeTags: [] as string[], guideText: '', assigneeScope: 'all' as string, assigneeStaffIds: [] as string[],
  publishTime: '09:00',
  // status 走 /status 专用接口，编辑表单不控制
  status: 'enabled' as string,
})
const saving = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    const [d, t, r] = await Promise.all([fetchTaskRules(), fetchTemplates(), getRoomTypes()])
    rules.value = d?.list || d?.data || d || []
    templates.value = t?.list || t?.data || t || []
    const rt = Array.isArray(r) ? r : r?.list || []
    roomTypes.value = rt
  } finally { loading.value = false }
  // 拉员工列表（用于「指定员工」分配范围），limit 200 全量拉取避免分页截断
  try {
    const staffData: any = await getStaffList({ limit: 200 })
    const list = staffData?.staff || staffData?.list || []
    staffList.value = list
  } catch { /* 拉员工失败时 request 层已统一提示 */ }
})

function openCreate() {
  editing.value = null
  // 新建默认停用：避免当日即生效超出用户预期，手动开启走 setTaskRuleStatus 会重算 nextRunAt
  form.value = { name: '', templateRefs: [], roomTypeIds: [], roomTypeNames: [], purposeTags: [], guideText: '', assigneeScope: 'all', assigneeStaffIds: [], publishTime: '09:00', status: 'disabled' }
  showForm.value = true
}
function openEdit(rule: Rule) {
  editing.value = rule
  const body: any = rule
  form.value = {
    name: body.name || '', templateRefs: body.templateRefs || [], roomTypeIds: body.roomTypeIds || [],
    roomTypeNames: body.roomTypeNames || [], purposeTags: body.purposeTags || [], guideText: body.guideText || '',
    assigneeScope: body.assigneeScope || 'all', assigneeStaffIds: body.assigneeStaffIds || [],
    publishTime: body.publishTime || '09:00',
    // status 走 /status 专用接口，编辑表单不控制
    status: body.status || 'enabled',
  }
  showForm.value = true
}
function toggleTemplate(id: string) {
  const i = form.value.templateRefs.indexOf(id)
  if (i >= 0) form.value.templateRefs.splice(i, 1); else form.value.templateRefs.push(id)
}
function toggleRoomType(rt: RoomType) {
  const i = form.value.roomTypeIds.indexOf(rt.id)
  if (i >= 0) { form.value.roomTypeIds.splice(i, 1); form.value.roomTypeNames.splice(i, 1) }
  else { form.value.roomTypeIds.push(rt.id); form.value.roomTypeNames.push(rt.name) }
}
function togglePurpose(tag: string) {
  const i = form.value.purposeTags.indexOf(tag)
  if (i >= 0) form.value.purposeTags.splice(i, 1); else form.value.purposeTags.push(tag)
}
function toggleStaff(id: string) {
  const i = form.value.assigneeStaffIds.indexOf(id)
  if (i >= 0) form.value.assigneeStaffIds.splice(i, 1); else form.value.assigneeStaffIds.push(id)
}
async function toggleStatus(rule: Rule) {
  const next = rule.status === 'enabled' ? 'disabled' : 'enabled'
  try {
    await setTaskRuleStatus(rule.id, next)
    rule.status = next
    // 刷新下次执行时间（后端 enable 时重算 nextRunAt）
    const d: any = await fetchTaskRules()
    rules.value = d?.list || d?.data || d || []
  } catch (e) {
    console.error('切换规则状态失败', e)
    uni.showToast({ title: '操作失败', icon: 'none' })
  }
}
async function handleSave() {
  if (saving.value) return
  if (!form.value.name) { uni.showToast({ title: '请填写规则名称', icon: 'none' }); return }
  if (form.value.templateRefs.length === 0) { uni.showToast({ title: '请选择拍摄模板', icon: 'none' }); return }
  if (form.value.assigneeScope === 'selected' && form.value.assigneeStaffIds.length === 0) { uni.showToast({ title: '请选择指定员工', icon: 'none' }); return }
  saving.value = true
  try {
    const payload = { ...form.value }
    if (editing.value) await updateTaskRule(editing.value.id, payload)
    else await createTaskRule(payload)
    uni.showToast({ title: '保存成功', icon: 'success' })
    showForm.value = false
    const d: any = await fetchTaskRules()
    rules.value = d?.list || d?.data || d || []
  } catch (e) {
    console.error('保存规则失败', e)
    uni.showToast({ title: '操作失败', icon: 'none' })
  } finally { saving.value = false }
}
function handleDelete(rule: Rule) {
  uni.showModal({
    title: '确认删除', content: `删除规则「${rule.name}」？`,
    success: async (res) => {
      if (!res.confirm) return
      try {
        await deleteTaskRule(rule.id)
        rules.value = rules.value.filter(x => x.id !== rule.id)
      } catch (e) {
        console.error('删除规则失败', e)
        uni.showToast({ title: '操作失败', icon: 'none' })
      }
    },
  })
}
function nextTimeText(rule: Rule): string {
  return rule.nextRunAt
    ? new Date(rule.nextRunAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
    : '—'
}
</script>

<template>
  <view class="page">
    <view class="head">
      <text class="head-title">自动化任务</text>
      <view class="add-btn" @click="openCreate"><text class="add-btn-text">+ 新建规则</text></view>
    </view>

    <view v-if="loading" class="empty"><text>加载中...</text></view>
    <view v-else-if="rules.length === 0" class="empty">
      <text class="empty-emoji">🤖</text>
      <text class="empty-text">暂无自动化规则，点击右上角创建</text>
    </view>

    <view v-else class="rule-list">
      <view v-for="rule in rules" :key="rule.id" class="rule-card" @click="openEdit(rule)">
        <view class="rule-head">
          <text class="rule-name">{{ rule.name }}</text>
          <switch :checked="rule.status === 'enabled'" @click.stop @change="toggleStatus(rule)" />
        </view>
        <view class="rule-meta">
          <text v-if="rule.roomTypeNames && rule.roomTypeNames.length" class="meta-text">房型：{{ rule.roomTypeNames.join(' / ') }}</text>
          <text class="meta-text">每日 {{ rule.publishTime }} 发布</text>
        </view>
        <view class="rule-foot">
          <text :class="['rule-status', rule.status]">{{ rule.status === 'enabled' ? '已开启' : '已停用' }}</text>
          <text class="rule-next">下次：{{ nextTimeText(rule) }}</text>
        </view>
        <!-- 可见删除入口：@click.stop 避免触发卡片点击进入编辑 -->
        <view class="rule-del" @click.stop="handleDelete(rule)"><text class="rule-del-text">删除</text></view>
      </view>
    </view>

    <!-- 新建/编辑规则弹层 -->
    <t-popup v-model:visible="showForm" placement="bottom">
      <view class="form-wrap">
        <view class="sheet-head">
          <text class="sheet-title">{{ editing ? '编辑规则' : '新建规则' }}</text>
          <text class="sheet-close" @click="showForm = false">✕</text>
        </view>
        <scroll-view scroll-y class="form-scroll">
          <view class="field"><text class="label">规则名称 *</text>
            <input v-model="form.name" class="input" placeholder="如：每日房态拍摄" /></view>

          <view class="field">
            <text class="label">选择拍摄模板 *</text>
            <view class="chip-row">
              <view v-for="t in templates" :key="t.id" :class="['chip', { on: form.templateRefs.includes(t.id) }]" @click="toggleTemplate(t.id)"><text>{{ t.name }}</text></view>
            </view>
          </view>

          <view class="field">
            <text class="label">指定房型</text>
            <view class="chip-row">
              <view v-for="rt in roomTypes" :key="rt.id" :class="['chip', { on: form.roomTypeIds.includes(rt.id) }]" @click="toggleRoomType(rt)"><text>{{ rt.name }}</text></view>
            </view>
          </view>

          <view class="field">
            <text class="label">用途标签</text>
            <view class="chip-row">
              <view v-for="p in ['OTA展示','短视频剪辑','广告投放']" :key="p" :class="['chip', { on: form.purposeTags.includes(p) }]" @click="togglePurpose(p)"><text>{{ p }}</text></view>
            </view>
          </view>

          <view class="field">
            <text class="label">拍摄指引</text>
            <textarea v-model="form.guideText" class="textarea" placeholder="如：站门口中间横拍、开灯、角度略仰（可空）" />
          </view>

          <view class="field">
            <text class="label">分配范围</text>
            <view class="chip-row">
              <view
                v-for="s in assigneeOptions"
                :key="s.value"
                :class="['chip', { on: form.assigneeScope === s.value }]"
                @click="form.assigneeScope = s.value"
              ><text>{{ s.label }}</text></view>
            </view>
          </view>

          <view v-if="form.assigneeScope === 'selected'" class="field">
            <text class="label">指定员工</text>
            <view class="chip-row">
              <view
                v-for="s in staffList"
                :key="s.id"
                :class="['chip', { on: form.assigneeStaffIds.includes(s.id) }]"
                @click="toggleStaff(s.id)"
              ><text>{{ s.name }}</text></view>
            </view>
            <text v-if="staffList.length === 0" class="tip">暂无可选员工</text>
          </view>

          <view class="field">
            <text class="label">每日发布时间</text>
            <picker mode="time" :value="form.publishTime" @change="(e:any) => form.publishTime = e.detail.value">
              <view class="picker-value">{{ form.publishTime }}</view>
            </picker>
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
.rule-list { padding: 20rpx 24rpx; }
.rule-card { background: #fff; border-radius: 20rpx; padding: 24rpx; margin-bottom: 20rpx; }
.rule-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12rpx; }
.rule-name { font-size: 30rpx; font-weight: 600; }
.rule-meta { display: flex; flex-direction: column; gap: 8rpx; margin-bottom: 12rpx; }
.meta-text { font-size: 24rpx; color: #888; }
.rule-foot { display: flex; justify-content: space-between; border-top: 1rpx solid #F5F5F5; padding-top: 16rpx; }
.rule-status { font-size: 24rpx; font-weight: 600; }
.rule-status.enabled { color: #07C160; }
.rule-status.disabled { color: #999; }
.rule-next { font-size: 22rpx; color: #999; }
.rule-del { border-top: 1rpx solid #F5F5F5; margin-top: 16rpx; padding-top: 16rpx; }
.rule-del-text { display: block; text-align: center; color: #FF4D4F; font-size: 26rpx; background: rgba(255,77,79,0.06); border-radius: 28rpx; padding: 12rpx 0; }
.form-wrap { background: #fff; padding: 32rpx 24rpx 32rpx; }
.form-scroll { max-height: 70vh; }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24rpx; }
.sheet-title { font-size: 32rpx; font-weight: 700; }
.sheet-close { font-size: 32rpx; color: #999; }
.field { margin-bottom: 24rpx; }
.label { font-size: 26rpx; color: #333; font-weight: 600; display: block; margin-bottom: 12rpx; }
.input { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; height: 88rpx; line-height: 48rpx; }
.textarea { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; width: 100%; box-sizing: border-box; min-height: 120rpx; height: 160rpx; }
.picker-value { background: #F5F6FA; border-radius: 12rpx; padding: 20rpx; font-size: 28rpx; color: #333; }
.tip { font-size: 22rpx; color: #999; margin-top: 12rpx; display: block; }
.chip-row { display: flex; flex-wrap: wrap; gap: 16rpx; }
.chip { padding: 12rpx 24rpx; border-radius: 32rpx; background: #F5F6FA; font-size: 24rpx; color: #666; }
.chip.on { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 600; }
.save-btn { background: #07C160; border-radius: 44rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.save-btn.disabled { opacity: 0.5; }
.save-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 120rpx 0; color: #888; gap: 12rpx; }
.empty-emoji { font-size: 72rpx; }
</style>
