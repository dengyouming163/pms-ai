<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import {
  getStaffList,
  getRoles,
  toggleStaff,
  createStaff,
  editStaff,
  resetStaffPassword,
} from '@/api/modules/staff'
import type { StaffInfo, StaffStats } from '@/types/user'

const authStore = useAuthStore()

// ========== 数据状态 ==========
const loading = ref(true)
const staffList = ref<StaffInfo[]>([])
const stats = ref<StaffStats | null>(null)
const roles = ref<Array<{ id: string; name: string; code: string }>>([])

// ========== 弹窗状态 ==========
const showFormModal = ref(false)         // 新增/编辑弹窗
const showLongPressMenu = ref(false)      // 长按操作菜单
const showResetConfirm = ref(false)       // 重置密码确认弹窗
const isEditing = ref(false)             // 是否编辑模式
const currentStaffId = ref('')           // 当前操作的员工 ID

// ========== 表单数据 ==========
const formData = reactive({
  name: '',
  phone: '',
  roleId: '',
  roleName: '',
  scope: 'all',
  stores: [] as Array<{ id: string; name: string }>,
})

// 表单校验错误
const formErrors = reactive({
  name: '',
  phone: '',
  roleId: '',
})

// ========== 门店选项（来自 authStore） ==========
const storeOptions = computed(() => {
  return authStore.stores.map((s) => ({ id: s.id, name: s.name, checked: false }))
})

// 可用的门店选项列表（用于勾选）
const availableStores = ref<Array<{ id: string; name: string; checked: boolean }>>([])

// ========== 长按菜单项 ==========
const menuItems = computed(() => {
  const staff = staffList.value.find((s) => s.id === currentStaffId.value)
  if (!staff) return []
  return [
    {
      label: '编辑信息',
      icon: '✏️',
      action: () => {
        showLongPressMenu.value = false
        openEditModal(staff)
      },
    },
    {
      label: staff.status === 'active' ? '禁用账号' : '启用账号',
      icon: staff.status === 'active' ? '🚫' : '✅',
      action: () => {
        showLongPressMenu.value = false
        handleToggleStatus(currentStaffId.value)
      },
    },
    {
      label: '重置密码',
      icon: '🔑',
      action: () => {
        showLongPressMenu.value = false
        currentStaffId.value = staff.id
        showResetConfirm.value = true
      },
    },
  ]
})

// ========== 工具函数 ==========

/** 状态标签样式 */
function getStatusStyle(status: string) {
  return status === 'active'
    ? { color: '#07C160', bg: 'rgba(7,193,96,0.1)' }
    : { color: '#888888', bg: 'rgba(0,0,0,0.06)' }
}

/** 状态中文名 */
function getStatusText(status: string) {
  return status === 'active' ? '在职' : '已禁用'
}

/** 角色颜色映射 */
function getRoleStyle(roleName: string) {
  const map: Record<string, string> = {
    '店长': '#576B95',
    '前台': '#07C160',
    '保洁': '#FF9500',
    '财务': '#FA5151',
    '管理员': '#576B95',
    '店员': '#888888',
    '员工': '#888888',
  }
  const color = map[roleName] || '#888888'
  return { color, bg: color + '15' }
}

// ========== 数据加载 ==========

/** 加载员工数据 */
async function loadStaff() {
  loading.value = true
  try {
    const result = await getStaffList()
    staffList.value = result.staff || []
    stats.value = result.stats || null
  } catch {
    uni.showToast({ title: '加载失败', icon: 'none' })
  } finally {
    loading.value = false
  }
}

/** 加载角色列表 */
async function loadRoles() {
  try {
    const result = await getRoles()
    roles.value = result || []
  } catch {
    // 静默失败，使用默认角色
    roles.value = []
  }
}

// ========== 门店勾选逻辑 ==========

/** 切换门店勾选 */
function toggleStoreCheck(index: number) {
  availableStores.value[index].checked = !availableStores.value[index].checked
}

/** 从勾选列表中提取已选中的门店 */
function getSelectedStores(): Array<{ id: string; name: string }> {
  return availableStores.value
    .filter((s) => s.checked)
    .map((s) => ({ id: s.id, name: s.name }))
}

/** 是否可以提交 */
const canSubmit = computed(() => {
  return formData.name.trim() && formData.phone.trim() && formData.roleId
})

// ========== 表单弹窗 ==========

/** 打开新增弹窗 */
function openAddModal() {
  isEditing.value = false
  currentStaffId.value = ''
  formData.name = ''
  formData.phone = ''
  formData.roleId = ''
  formData.roleName = ''
  formData.scope = 'all'
  formData.stores = []
  formErrors.name = ''
  formErrors.phone = ''
  formErrors.roleId = ''

  // 初始化门店勾选列表
  availableStores.value = authStore.stores.map((s) => ({
    id: s.id,
    name: s.name,
    checked: false,
  }))

  showFormModal.value = true
}

/** 打开编辑弹窗 */
function openEditModal(staff: StaffInfo) {
  isEditing.value = true
  currentStaffId.value = staff.id
  formData.name = staff.name || ''
  formData.phone = staff.phone || ''
  formData.roleId = staff.roleId || ''
  formData.roleName = staff.roleName || ''
  formData.scope = staff.scope || 'all'
  formErrorClear()

  // 初始化门店勾选列表，标记已选中的门店
  const staffStoreIds = new Set((staff.stores || []).map((s) => s.id))
  availableStores.value = authStore.stores.map((s) => ({
    id: s.id,
    name: s.name,
    checked: staffStoreIds.has(s.id),
  }))

  // 设置角色 picker 索引

  showFormModal.value = true
}

/** 关闭表单弹窗 */
function closeFormModal() {
  showFormModal.value = false
}

/** 表单校验 */
function validateForm(): boolean {
  let valid = true
  formErrors.name = ''
  formErrors.phone = ''
  formErrors.roleId = ''

  if (!formData.name.trim()) {
    formErrors.name = '请输入员工姓名'
    valid = false
  }
  if (!formData.phone.trim()) {
    formErrors.phone = '请输入手机号'
    valid = false
  } else if (!/^1[3-9]\d{9}$/.test(formData.phone.trim())) {
    formErrors.phone = '手机号格式不正确'
    valid = false
  }
  if (!formData.roleId) {
    formErrors.roleId = '请选择角色'
    valid = false
  }
  return valid
}

/** 清空表单错误 */
function formErrorClear() {
  formErrors.name = ''
  formErrors.phone = ''
  formErrors.roleId = ''
}

/** 选择角色 */
function selectRole(role: { id: string; name: string }) {
  formData.roleId = role.id
  formData.roleName = role.name
  formErrors.roleId = ''
}

/** 提交表单 */
async function handleFormSubmit() {
  if (!validateForm()) return

  // 构建门店列表
  const selectedStores = getSelectedStores()

  const payload = {
    name: formData.name.trim(),
    phone: formData.phone.trim(),
    roleId: formData.roleId,
    roleName: formData.roleName,
    scope: formData.scope,
    stores: selectedStores,
  }

  uni.showLoading({ title: isEditing.value ? '保存中...' : '添加中...', mask: true })

  try {
    if (isEditing.value) {
      await editStaff(currentStaffId.value, payload)
      uni.showToast({ title: '修改成功', icon: 'success' })
    } else {
      await createStaff(payload)
      uni.showToast({ title: '添加成功', icon: 'success' })
    }
    closeFormModal()
    await loadStaff()
  } catch (err: any) {
    const msg = err?.msg || err?.error || (isEditing.value ? '修改失败' : '添加失败')
    uni.showToast({ title: msg, icon: 'none' })
  } finally {
    uni.hideLoading()
  }
}

// ========== 长按菜单 ==========

/** 长按员工卡片 */
function onStaffLongPress(staffId: string) {
  currentStaffId.value = staffId
  showLongPressMenu.value = true
}

/** 关闭长按菜单 */
function closeLongPressMenu() {
  showLongPressMenu.value = false
}

// ========== 员工操作 ==========

/** 切换员工状态 */
async function handleToggleStatus(staffId: string) {
  try {
    const result = await toggleStaff(staffId)
    const label = result.status === 'active' ? '已启用' : '已禁用'
    uni.showToast({ title: label, icon: 'success' })
    await loadStaff()
  } catch (err: any) {
    uni.showToast({ title: err?.msg || '操作失败', icon: 'none' })
  }
}

/** 重置密码确认 */
function confirmResetPassword() {
  showResetConfirm.value = false
  handleResetPassword()
}

/** 执行重置密码 */
async function handleResetPassword() {
  uni.showLoading({ title: '重置中...', mask: true })
  try {
    await resetStaffPassword(currentStaffId.value)
    uni.showToast({ title: '密码已重置为 888888', icon: 'success' })
  } catch (err: any) {
    uni.showToast({ title: err?.msg || '重置失败', icon: 'none' })
  } finally {
    uni.hideLoading()
  }
}

/** 关闭重置确认弹窗 */
function closeResetConfirm() {
  showResetConfirm.value = false
}

// ========== 初始化 ==========
onMounted(async () => {
  await Promise.all([loadStaff(), loadRoles()])
})
</script>

<template>
  <view class="staff-page">


    <scroll-view class="page-scroll" scroll-y :show-scrollbar="false">
      <!-- 统计卡片 -->
      <view v-if="stats" class="stats-row">
        <view class="stat-item">
          <text class="stat-value">{{ stats.total }}</text>
          <text class="stat-label">员工总数</text>
        </view>
        <view class="stat-item">
          <text class="stat-value green">{{ stats.active }}</text>
          <text class="stat-label">在职</text>
        </view>
        <view class="stat-item">
          <text class="stat-value gray">{{ stats.disabled }}</text>
          <text class="stat-label">已禁用</text>
        </view>
      </view>

      <!-- 加载状态 -->
      <view v-if="loading" class="empty-state">
        <text class="empty-text">加载中...</text>
      </view>

      <!-- 空状态 -->
      <view v-else-if="staffList.length === 0" class="empty-state">
        <text class="empty-icon">👥</text>
        <text class="empty-text">暂无员工数据</text>
        <view class="empty-action" @click="openAddModal">
          <text class="empty-action-text">添加员工</text>
        </view>
      </view>

      <!-- 员工列表 -->
      <view v-else class="staff-list">
        <view
          v-for="staff in staffList"
          :key="staff.id"
          class="staff-card"
          @tap="openEditModal(staff)"
          @longpress="onStaffLongPress(staff.id)"
        >
          <view
            class="staff-avatar"
            :style="{ backgroundColor: getRoleStyle(staff.roleName || '').bg }"
          >
            <text
              class="staff-avatar-text"
              :style="{ color: getRoleStyle(staff.roleName || '').color }"
            >
              {{ (staff.name || '?').substring(0, 1) }}
            </text>
          </view>
          <view class="staff-info">
            <view class="staff-name-row">
              <text class="staff-name">{{ staff.name }}</text>
              <view
                class="staff-status-badge"
                :style="{
                  color: getStatusStyle(staff.status).color,
                  backgroundColor: getStatusStyle(staff.status).bg,
                }"
              >
                <text class="badge-text">{{ getStatusText(staff.status) }}</text>
              </view>
            </view>
            <text class="staff-phone">{{ staff.phone }}</text>
            <view class="staff-tags">
              <view
                v-if="staff.roleName"
                class="staff-role-badge"
                :style="{
                  color: getRoleStyle(staff.roleName).color,
                  backgroundColor: getRoleStyle(staff.roleName).bg,
                }"
              >
                <text class="role-badge-text">{{ staff.roleName }}</text>
              </view>
              <view v-if="staff.scope && staff.scope !== 'all'" class="staff-scope-badge">
                <text class="scope-badge-text">{{ staff.scope === 'store' ? '单门店' : '跨门店' }}</text>
              </view>
            </view>
          </view>
          <view class="staff-arrow">
            <text class="staff-arrow-icon">›</text>
          </view>
        </view>
      </view>

      <!-- 底部安全距离 -->
      <view class="bottom-safe" />
    </scroll-view>

    <!-- 底部添加按钮 -->
    <view class="add-btn-wrap">
      <view class="add-btn" @click="openAddModal">
        <text class="add-btn-text">+ 添加员工</text>
      </view>
    </view>

    <!-- 长按操作菜单 -->
    <view v-if="showLongPressMenu" class="overlay" @click="closeLongPressMenu">
      <view class="action-sheet" @click.stop>
        <view class="action-sheet-title">操作</view>
        <view
          v-for="item in menuItems"
          :key="item.label"
          class="action-sheet-item"
          @click="item.action"
        >
          <text class="action-icon">{{ item.icon }}</text>
          <text class="action-label">{{ item.label }}</text>
        </view>
        <view class="action-sheet-divider" />
        <view class="action-sheet-item cancel" @click="closeLongPressMenu">
          <text class="action-label">取消</text>
        </view>
      </view>
    </view>

    <!-- 新增/编辑员工弹窗（底部弹出） -->
    <view v-if="showFormModal" class="overlay" @click="closeFormModal">
      <view class="form-popup" @click.stop>
        <scroll-view class="form-scroll" scroll-y :show-scrollbar="false">
          <!-- 弹窗标题 -->
          <view class="popup-header">
            <text class="popup-title">{{ isEditing ? '编辑员工' : '添加员工' }}</text>
            <view class="popup-close" @click="closeFormModal">
              <text>✕</text>
            </view>
          </view>

          <!-- 姓名 -->
          <view class="form-group">
            <view class="form-label">
              <text class="form-label-text">姓名</text>
              <text class="form-required">*</text>
            </view>
            <input
              v-model="formData.name"
              class="form-input"
              :class="{ error: formErrors.name }"
              placeholder="请输入员工姓名"
              maxlength="20"
            />
            <text v-if="formErrors.name" class="form-error-text">{{ formErrors.name }}</text>
          </view>

          <!-- 手机号 -->
          <view class="form-group">
            <view class="form-label">
              <text class="form-label-text">手机号</text>
              <text class="form-required">*</text>
            </view>
            <input
              v-model="formData.phone"
              class="form-input"
              :class="{ error: formErrors.phone }"
              type="number"
              placeholder="请输入手机号"
              maxlength="11"
            />
            <text v-if="formErrors.phone" class="form-error-text">{{ formErrors.phone }}</text>
          </view>

          <!-- 角色选择（内联列表） -->
          <view class="form-group">
            <view class="form-label">
              <text class="form-label-text">角色</text>
              <text class="form-required">*</text>
            </view>
            <view class="role-inline">
              <view v-if="roles.length === 0" class="role-loading"><text>加载中...</text></view>
              <view v-for="r in roles" :key="r.id" :class="['role-chip', { on: r.id === formData.roleId }]" @tap="selectRole(r)">
                <text class="rc-text">{{ r.name }}</text>
              </view>
            </view>
            <text v-if="formErrors.roleId" class="form-error-text">{{ formErrors.roleId }}</text>
          </view>

          <!-- 门店选择（多选） -->
          <view class="form-group">
            <view class="form-label">
              <text class="form-label-text">门店选择</text>
              <text class="form-label-hint">（可多选）</text>
            </view>
            <view v-if="availableStores.length === 0" class="no-store-tip">
              <text>暂无可用门店</text>
            </view>
            <view v-else class="store-check-list">
              <view
                v-for="(store, index) in availableStores"
                :key="store.id"
                class="store-check-item"
                @click="toggleStoreCheck(index)"
              >
                <view class="check-box" :class="{ checked: store.checked }">
                  <text v-if="store.checked" class="check-mark">✓</text>
                </view>
                <text class="check-label">{{ store.name }}</text>
              </view>
            </view>
          </view>
        </scroll-view>

        <!-- 提交按钮 -->
        <view class="form-footer">
          <view class="form-submit-btn" :class="{ disabled: !canSubmit }" @click="handleFormSubmit">
            <text class="form-submit-text">{{ isEditing ? '保存修改' : '确认添加' }}</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 重置密码确认弹窗 -->
    <view v-if="showResetConfirm" class="overlay" @click="closeResetConfirm">
      <view class="confirm-dialog" @click.stop>
        <view class="confirm-title">
          <text>重置密码</text>
        </view>
        <view class="confirm-body">
          <text>确定要重置该员工的密码吗？密码将被重置为 888888。</text>
        </view>
        <view class="confirm-footer">
          <view class="confirm-btn cancel" @click="closeResetConfirm">
            <text>取消</text>
          </view>
          <view class="confirm-btn primary" @click="confirmResetPassword">
            <text>确定</text>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.staff-page {
  min-height: 100vh;
  background: #F5F6FA;
  display: flex;
  flex-direction: column;
}

.page-scroll {
  flex: 1;
  width: 100%;
  padding: 24rpx;
  box-sizing: border-box;
}

/* ========== 统计卡片行 ========== */
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
  &.gray { color: #888888; }
}

.stat-label {
  font-size: 24rpx;
  color: #888888;
}

/* ========== 空状态 ========== */
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

.empty-action {
  margin-top: 16rpx;
  padding: 16rpx 40rpx;
  background: #07C160;
  border-radius: 40rpx;
}

.empty-action-text {
  color: #FFFFFF;
  font-size: 28rpx;
  font-weight: 500;
}

/* ========== 员工卡片列表 ========== */
.staff-list {
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.staff-card {
  display: flex;
  align-items: center;
  gap: 20rpx;
  background: #FFFFFF;
  border-radius: 24rpx;
  padding: 24rpx;
  box-shadow: 0 2rpx 16rpx rgba(0, 0, 0, 0.04);

  &:active {
    background: rgba(0, 0, 0, 0.02);
  }
}

.staff-avatar {
  width: 80rpx;
  height: 80rpx;
  border-radius: 40rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.staff-avatar-text {
  font-size: 32rpx;
  font-weight: 700;
}

.staff-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.staff-name-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.staff-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

.staff-status-badge {
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
}

.badge-text {
  font-size: 20rpx;
  font-weight: 500;
}

.staff-phone {
  font-size: 24rpx;
  color: #888888;
}

.staff-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8rpx;
}

.staff-role-badge {
  align-self: flex-start;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
}

.role-badge-text {
  font-size: 20rpx;
  font-weight: 500;
}

.staff-scope-badge {
  align-self: flex-start;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  background: rgba(87, 107, 149, 0.1);
}

.scope-badge-text {
  font-size: 20rpx;
  color: #576B95;
  font-weight: 500;
}

.staff-arrow {
  flex-shrink: 0;
}

.staff-arrow-icon {
  font-size: 32rpx;
  color: #C8CFD6;
}

/* ========== 底部浮动按钮 ========== */
.add-btn-wrap {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
  padding: 16rpx 24rpx;
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  background: linear-gradient(180deg, rgba(245,246,250,0) 0%, rgba(245,246,250,1) 30%, #fff 100%);
}

.add-btn {
  background: #07C160;
  border-radius: 44rpx;
  padding: 24rpx;
  text-align: center;
  box-shadow: 0 4rpx 20rpx rgba(7,193,96,0.35);

  &:active { background: #06AD56; }
}

.add-btn-text { color: #fff; font-size: 32rpx; font-weight: 600; }

.bottom-safe { height: 140rpx; }

/* ========== 角色内联芯片 ========== */
.role-inline { display: flex; flex-wrap: wrap; gap: 12rpx; padding: 8rpx 0; }
.role-loading { font-size: 24rpx; color: #ccc; padding: 8rpx 0; }
.role-chip { padding: 14rpx 24rpx; border-radius: 20rpx; border: 2rpx solid #EDEDED; font-size: 26rpx; color: #666; }
.role-chip:active { background: #F5F6FA; }
.role-chip.on { border-color: #07C160; background: rgba(7,193,96,0.06); color: #07C160; font-weight: 500; }

/* ========== 遮罩层 ========== */
.overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2000;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

/* ========== 长按操作菜单 ========== */
.action-sheet {
  width: 100%;
  background: #FFFFFF;
  border-radius: 24rpx 24rpx 0 0;
  padding-bottom: env(safe-area-inset-bottom);
}

.action-sheet-title {
  text-align: center;
  padding: 24rpx;
  font-size: 24rpx;
  color: #888888;
}

.action-sheet-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12rpx;
  padding: 32rpx;
  font-size: 32rpx;
  color: #191919;

  &:active {
    background: rgba(0, 0, 0, 0.04);
  }

  &.cancel {
    color: #888888;
  }
}

.action-icon {
  font-size: 32rpx;
}

.action-label {
  font-size: 30rpx;
}

.action-sheet-divider {
  height: 12rpx;
  background: #F5F6FA;
}

/* ========== 表单弹窗 ========== */
.form-popup {
  width: 100%;
  max-height: 80vh;
  background: #FFFFFF;
  border-radius: 24rpx 24rpx 0 0;
  display: flex;
  flex-direction: column;
}

.form-scroll {
  flex: 1;
  padding: 0 32rpx;
  max-height: 60vh;
}

.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 28rpx 0 20rpx;
  border-bottom: 1rpx solid #EDEDED;
  margin-bottom: 20rpx;
}

.popup-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #191919;
}

.popup-close {
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

/* 表单字段 */
.form-group {
  margin-bottom: 28rpx;
}

.form-label {
  display: flex;
  align-items: center;
  gap: 4rpx;
  margin-bottom: 12rpx;
}

.form-label-text {
  font-size: 28rpx;
  font-weight: 600;
  color: #191919;
}

.form-required {
  color: #FA5151;
  font-size: 24rpx;
}

.form-label-hint {
  font-size: 22rpx;
  color: #888888;
}

.form-input {
  height: 88rpx;
  background: #F5F6FA;
  border-radius: 16rpx;
  padding: 0 24rpx;
  font-size: 28rpx;
  color: #191919;

  &.error {
    border: 2rpx solid #FA5151;
    background: #FFF5F5;
  }
}

.form-error-text {
  font-size: 22rpx;
  color: #FA5151;
  margin-top: 8rpx;
  display: block;
}

/* picker 模拟 */
.picker-display {
  height: 88rpx;
  background: #F5F6FA;
  border-radius: 16rpx;
  padding: 0 24rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 28rpx;
  color: #191919;

  &.error {
    border: 2rpx solid #FA5151;
    background: #FFF5F5;
  }

  &.placeholder {
    color: #C8CFD6;
  }
}

.picker-arrow {
  font-size: 20rpx;
  color: #888888;
}

/* 门店多选 */
.no-store-tip {
  padding: 24rpx;
  text-align: center;
  color: #888888;
  font-size: 24rpx;
  background: #F5F6FA;
  border-radius: 16rpx;
}

.store-check-list {
  display: flex;
  flex-direction: column;
  gap: 2rpx;
  background: #F5F6FA;
  border-radius: 16rpx;
  overflow: hidden;
}

.store-check-item {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 24rpx;
  background: #FFFFFF;

  &:active {
    background: rgba(0, 0, 0, 0.02);
  }
}

.check-box {
  width: 40rpx;
  height: 40rpx;
  border-radius: 8rpx;
  border: 3rpx solid #C8CFD6;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s;

  &.checked {
    background: #07C160;
    border-color: #07C160;
  }
}

.check-mark {
  font-size: 24rpx;
  color: #FFFFFF;
  font-weight: 700;
}

.check-label {
  font-size: 28rpx;
  color: #191919;
}

/* 提交按钮 */
.form-footer {
  padding: 20rpx 32rpx;
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
  border-top: 1rpx solid #EDEDED;
}

.form-submit-btn {
  background: #07C160;
  border-radius: 44rpx;
  padding: 26rpx;
  text-align: center;

  &:active {
    background: #06AD56;
  }

  &.disabled {
    background: #C8CFD6;
  }
}

.form-submit-text {
  color: #FFFFFF;
  font-size: 32rpx;
  font-weight: 600;
}

/* ========== 确认弹窗（居中） ========== */
.confirm-dialog {
  width: 600rpx;
  background: #FFFFFF;
  border-radius: 24rpx;
  margin-bottom: 200rpx;
  overflow: hidden;
}

.confirm-title {
  padding: 40rpx 32rpx 16rpx;
  text-align: center;
  font-size: 32rpx;
  font-weight: 700;
  color: #191919;
}

.confirm-body {
  padding: 16rpx 32rpx 32rpx;
  text-align: center;
  font-size: 28rpx;
  color: #666666;
  line-height: 1.6;
}

.confirm-footer {
  display: flex;
  border-top: 1rpx solid #EDEDED;
}

.confirm-btn {
  flex: 1;
  padding: 28rpx;
  text-align: center;
  font-size: 30rpx;

  &:active {
    background: rgba(0, 0, 0, 0.04);
  }

  &.cancel {
    color: #888888;
    border-right: 1rpx solid #EDEDED;
  }

  &.primary {
    color: #07C160;
    font-weight: 600;
  }
}
</style>
