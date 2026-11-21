<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getRoomTypes, getRooms, addRoomType, editRoomType, addRoom, editRoom, deleteRoom } from '@/api/modules/user'
import type { RoomTypeInfo, RoomInfo } from '@/types/user'

const loading = ref(true)
const roomTypes = ref<RoomTypeInfo[]>([])
const expandedId = ref('')
const rooms = ref<Record<string, RoomInfo[]>>({})
const roomsLoading = ref(false)

// 房型弹窗
const showTypeModal = ref(false)
const typeForm = ref({ id: '', storeId: '', name: '', bedType: '1.8m大床', area: 28, maxGuests: 2, basePrice: 298, roomCount: 10, facilities: [] as string[], images: [] as string[] })
const isEditType = ref(false)

// 房间弹窗
const showRoomModal = ref(false)
const roomForm = ref({ id: '', roomTypeId: '', roomTypeName: '', roomNumber: '', floor: 1, price: 298, status: 'available', attributes: [] as string[] })
const isEditRoom = ref(false)

const bedOptions = ['1.8m大床', '2.0m大床', '1.2m双床', '1.5m双床']
const facilityOptions = ['电视', '空调', '独立卫浴', '浴缸', 'WiFi', '迷你吧', '保险箱', '客厅', '阳台', '书桌', '儿童设施']
const attrOptions = ['朝南', '朝北', '靠山', '靠海', '角落', '连通', '无障碍', '高楼层']
const statusOptions = ['available', 'occupied', 'dirty', 'maintenance']

// 素材库选择
const showAssetPicker = ref(false)
const assetList = ref<Array<{ id: string; url: string; name: string }>>([])
const selectedAssets = ref<Set<string>>(new Set())

async function openAssetPicker() {
  selectedAssets.value = new Set(typeForm.value.images)
  try {
    const res: any = await uni.request({
      url: 'http://132.232.166.40:20002/api/assets',
      method: 'GET',
      header: { Authorization: `Bearer ${uni.getStorageSync('token')}` }
    })
    const d = res.data as any
    assetList.value = d?.assets || d?.list || d?.data || []
  } catch { assetList.value = [] }
  showAssetPicker.value = true
}

function toggleAssetSelect(url: string) {
  const s = new Set(selectedAssets.value)
  if (s.has(url)) s.delete(url); else s.add(url)
  selectedAssets.value = s
}

function confirmAssetSelection() {
  typeForm.value.images = Array.from(selectedAssets.value)
  showAssetPicker.value = false
}

async function loadData() {
  loading.value = true
  try {
    const types = await getRoomTypes()
    roomTypes.value = Array.isArray(types) ? types : []
  } catch { /* ignore */ }
  finally { loading.value = false }
}

async function toggleExpand(typeId: string) {
  if (expandedId.value === typeId) { expandedId.value = ''; return }
  expandedId.value = typeId
  if (!rooms.value[typeId]) await loadRooms(typeId)
}

async function loadRooms(typeId: string) {
  roomsLoading.value = true
  try {
    const r = await getRooms()
    rooms.value[typeId] = Array.isArray(r) ? r.filter((room: RoomInfo) => room.roomTypeId === typeId) : []
  } catch { rooms.value[typeId] = [] }
  finally { roomsLoading.value = false }
}

// === 房型 CRUD ===
function openAddType() {
  isEditType.value = false
  typeForm.value = { id: '', storeId: '', name: '', bedType: '1.8m大床', area: 28, maxGuests: 2, basePrice: 298, roomCount: 10, facilities: [], images: [] }
  showTypeModal.value = true
}

function openEditType(t: RoomTypeInfo) {
  isEditType.value = true
  typeForm.value = { id: t.id, storeId: t.storeId || '', name: t.name, bedType: t.bedType || '1.8m大床', area: Number(t.area) || 28, maxGuests: t.maxGuests || 2, basePrice: t.basePrice || 298, roomCount: t.roomCount || 10, facilities: t.facilities || [], images: t.images || [] }
  showTypeModal.value = true
}

function toggleFacility(f: string) {
  const idx = typeForm.value.facilities.indexOf(f)
  if (idx > -1) typeForm.value.facilities.splice(idx, 1)
  else typeForm.value.facilities.push(f)
}

async function handleSaveType() {
  if (!typeForm.value.name) { uni.showToast({ title: '请输入房型名称', icon: 'none' }); return }
  try {
    const data = { ...typeForm.value, images: typeForm.value.images || [] }
    if (isEditType.value) {
      await editRoomType(typeForm.value.id, data)
    } else {
      await addRoomType(data)
    }
    uni.showToast({ title: isEditType.value ? '修改成功' : '创建成功', icon: 'success' })
    showTypeModal.value = false
    await loadData()
  } catch { uni.showToast({ title: '操作失败', icon: 'none' }) }
}

// === 房间 CRUD ===
function openAddRoom(typeId: string, typeName: string) {
  isEditRoom.value = false
  roomForm.value = { id: '', roomTypeId: typeId, roomTypeName: typeName, roomNumber: '', floor: 1, price: 298, status: 'available', attributes: [] }
  showRoomModal.value = true
}

function openEditRoom(r: RoomInfo) {
  isEditRoom.value = true
  roomForm.value = { id: r.id, roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName || '', roomNumber: r.roomNumber, floor: r.floor || 1, price: r.price || 298, status: r.status, attributes: r.attributes || [] }
  showRoomModal.value = true
}

function toggleAttr(a: string) {
  const idx = roomForm.value.attributes.indexOf(a)
  if (idx > -1) roomForm.value.attributes.splice(idx, 1)
  else roomForm.value.attributes.push(a)
}

async function handleSaveRoom() {
  if (!roomForm.value.roomNumber) { uni.showToast({ title: '请输入房间号', icon: 'none' }); return }
  try {
    if (isEditRoom.value) {
      await editRoom(roomForm.value.id, { roomNumber: roomForm.value.roomNumber, floor: roomForm.value.floor, status: roomForm.value.status, price: roomForm.value.price, attributes: roomForm.value.attributes })
    } else {
      await addRoom({ storeId: '', roomTypeId: roomForm.value.roomTypeId, roomTypeName: roomForm.value.roomTypeName, roomNumber: roomForm.value.roomNumber, floor: roomForm.value.floor, price: roomForm.value.price, attributes: roomForm.value.attributes })
    }
    uni.showToast({ title: isEditRoom.value ? '修改成功' : '创建成功', icon: 'success' })
    showRoomModal.value = false; loadRooms(roomForm.value.roomTypeId)
  } catch { uni.showToast({ title: '操作失败', icon: 'none' }) }
}

async function handleDeleteRoom(r: RoomInfo) {
  uni.showModal({
    title: '确认删除', content: `确定要删除房间 ${r.roomNumber} 吗？`,
    success: async (res) => {
      if (!res.confirm) return
      try { await deleteRoom(r.id); uni.showToast({ title: '已删除', icon: 'success' }); loadRooms(r.roomTypeId) }
      catch { uni.showToast({ title: '删除失败', icon: 'none' }) }
    },
  })
}

function getStatusLabel(s: string) {
  const m: Record<string, string> = { available: '空闲', occupied: '在住', booked: '预订', dirty: '脏房', maintenance: '维修', locked: '锁房' }
  return m[s] || s
}

function getStatusColor(s: string) {
  const m: Record<string, string> = { available: '#07C160', occupied: '#FF9500', booked: '#576B95', dirty: '#888', maintenance: '#FA5151', locked: '#ccc' }
  return m[s] || '#888'
}

function roomCounts(rooms: RoomInfo[]) {
  const available = rooms.filter(r => r.status === 'available').length
  const occupied = rooms.filter(r => r.status === 'occupied').length
  return { available, occupied }
}

onMounted(() => loadData())
</script>

<template>
  <view class="rt-page">
    <!-- 顶部按钮 -->
    <view class="header-bar">
      <text class="header-title">房型管理</text>
      <text class="add-btn" @click="openAddType">+ 添加房型</text>
    </view>

    <scroll-view class="content" scroll-y v-if="!loading">
      <view v-if="roomTypes.length === 0" class="empty-state">
        <text class="empty-icon">🛏️</text>
        <text class="empty-text">暂无房型数据</text>
      </view>

      <view v-for="rt in roomTypes" :key="rt.id" class="type-card">
        <!-- 房型头部 -->
        <view class="type-header" @click="toggleExpand(rt.id)">
          <view class="type-left">
            <text class="type-name">{{ rt.name }}</text>
            <view class="type-meta">
              <text class="meta-item">{{ rt.bedType }}</text>
              <text class="meta-div">|</text>
              <text class="meta-item">{{ rt.area || '-' }}m²</text>
              <text class="meta-div">|</text>
              <text class="meta-item">最多{{ rt.maxGuests || 2 }}人</text>
            </view>
            <text class="type-price">¥{{ rt.basePrice || 0 }}/晚</text>
          </view>
          <view class="type-right">
            <text class="expand-icon">{{ expandedId === rt.id ? '▲' : '▼' }}</text>
          </view>
        </view>

        <!-- 房型操作 -->
        <view class="type-actions">
          <text class="type-stat">共{{ rt.roomCount || 0 }}间</text>
          <view class="type-btns">
            <text class="action-link" @click="openEditType(rt)">编辑</text>
          </view>
        </view>

        <!-- 展开房间列表 -->
        <view v-if="expandedId === rt.id" class="room-section">
          <view v-if="roomsLoading" class="room-loading">加载中...</view>
          <view v-else>
            <view v-if="rooms[rt.id]?.length" class="room-stats">
              <text class="room-stat green">空闲 {{ roomCounts(rooms[rt.id]).available }}</text>
              <text class="room-stat orange">在住 {{ roomCounts(rooms[rt.id]).occupied }}</text>
            </view>
            <view v-for="r in (rooms[rt.id] || [])" :key="r.id" class="room-item">
              <view class="room-info">
                <text class="room-no">{{ r.roomNumber }}</text>
                <text class="room-floor">{{ r.floor || '-' }}楼</text>
                <view class="room-status" :style="{ color: getStatusColor(r.status), background: getStatusColor(r.status) + '15' }">
                  <text class="status-text">{{ getStatusLabel(r.status) }}</text>
                </view>
                <text class="room-price">¥{{ r.price || '-' }}</text>
              </view>
              <view class="room-actions">
                <text class="room-edit" @click="openEditRoom(r)">✏️</text>
                <text class="room-del" @click="handleDeleteRoom(r)">🗑️</text>
              </view>
            </view>
            <view class="add-room-btn" @click="openAddRoom(rt.id, rt.name)">+ 添加房间</view>
          </view>
        </view>
      </view>
    </scroll-view>

    <!-- 房型弹窗 -->
    <view v-if="showTypeModal" class="overlay" @click="showTypeModal = false">
      <view class="sheet" @click.stop>
        <text class="sheet-title">{{ isEditType ? '编辑房型' : '添加房型' }}</text>
        <view class="fi"><text class="fl">房型名称 *</text><input v-model="typeForm.name" class="fin" placeholder="如：豪华大床房" /></view>
        <view class="fi"><text class="fl">床型</text>
          <view class="tag-group">
            <view v-for="b in bedOptions" :key="b" :class="['tag', { sel: typeForm.bedType === b }]" @click="typeForm.bedType = b"><text class="tag-text">{{ b }}</text></view>
          </view>
        </view>
        <view class="fi"><text class="fl">面积(m²)</text><input v-model.number="typeForm.area" class="fin" type="number" /></view>
        <view class="fi"><text class="fl">最多入住</text><input v-model.number="typeForm.maxGuests" class="fin" type="number" /></view>
        <view class="fi"><text class="fl">基准价格(元/晚)</text><input v-model.number="typeForm.basePrice" class="fin" type="number" /></view>
        <view class="fi"><text class="fl">房间数量</text><input v-model.number="typeForm.roomCount" class="fin" type="number" /></view>
        <view class="fi"><text class="fl">设施</text>
          <view class="tag-group">
            <view v-for="f in facilityOptions" :key="f" :class="['tag', { sel: typeForm.facilities.includes(f) }]" @click="toggleFacility(f)"><text class="tag-text">{{ f }}</text></view>
          </view>
        </view>
        <!-- 房型图片 -->
        <view class="fi"><text class="fl">房型图片</text></view>
        <view class="img-grid">
          <image v-for="(img, i) in typeForm.images" :key="i" :src="img" class="img-thumb" mode="aspectFill" />
          <view class="img-add" @tap="openAssetPicker"><text class="img-add-text">+</text></view>
        </view>
        <view v-if="typeForm.images.length > 0" class="img-hint"><text>已选 {{ typeForm.images.length }} 张，点击可删除</text></view>
        <view class="btns"><view class="bc" @click="showTypeModal = false"><text>取消</text></view><view class="bf" @click="handleSaveType"><text>保存</text></view></view>
      </view>
    </view>

    <!-- 素材库选择弹窗 -->
    <view v-if="showAssetPicker" class="overlay" @click="showAssetPicker = false">
      <view class="sheet" @click.stop>
        <text class="sheet-title">从素材库选择</text>
        <view v-if="assetList.length === 0" class="empty-hint">暂无素材</view>
        <view v-else class="asset-grid-4">
          <view v-for="a in assetList" :key="a.id"
            :class="['asset-cell', { sel: selectedAssets.has(a.url) }]"
            @tap="toggleAssetSelect(a.url)">
            <image :src="a.url" class="ac-thumb" mode="aspectFill" />
            <view v-if="selectedAssets.has(a.url)" class="ac-check">✓</view>
          </view>
        </view>
        <view class="btns">
          <view class="bc" @click="showAssetPicker = false"><text>取消</text></view>
          <view class="bf" @click="confirmAssetSelection"><text>确认选择 ({{ selectedAssets.size }})</text></view>
        </view>
      </view>
    </view>

    <!-- 房间弹窗 -->
    <view v-if="showRoomModal" class="overlay" @click="showRoomModal = false">
      <view class="sheet" @click.stop>
        <text class="sheet-title">{{ isEditRoom ? '编辑房间' : '添加房间' }}</text>
        <view class="fi"><text class="fl">房间号 *</text><input v-model="roomForm.roomNumber" class="fin" placeholder="如：301" /></view>
        <view class="fi"><text class="fl">楼层</text><input v-model.number="roomForm.floor" class="fin" type="number" /></view>
        <view class="fi"><text class="fl">价格(元/晚)</text><input v-model.number="roomForm.price" class="fin" type="number" /></view>
        <view v-if="isEditRoom" class="fi"><text class="fl">状态</text>
          <view class="tag-group">
            <view v-for="s in statusOptions" :key="s" :class="['tag', { sel: roomForm.status === s }]" @click="roomForm.status = s"><text class="tag-text">{{ getStatusLabel(s) }}</text></view>
          </view>
        </view>
        <view class="fi"><text class="fl">房间属性</text>
          <view class="tag-group">
            <view v-for="a in attrOptions" :key="a" :class="['tag', { sel: roomForm.attributes.includes(a) }]" @click="toggleAttr(a)"><text class="tag-text">{{ a }}</text></view>
          </view>
        </view>
        <view class="btns"><view class="bc" @click="showRoomModal = false"><text>取消</text></view><view class="bf" @click="handleSaveRoom"><text>保存</text></view></view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.rt-page { min-height: 100vh; background: #F5F6FA; }
.header-bar { display: flex; align-items: center; justify-content: space-between; padding: 24rpx; background: #fff; }
.header-title { font-size: 32rpx; font-weight: 600; color: #191919; }
.add-btn { font-size: 26rpx; color: #07C160; font-weight: 500; }
.content { padding: 24rpx; }
.empty-state { display: flex; flex-direction: column; align-items: center; padding: 120rpx 0; }
.empty-icon { font-size: 80rpx; margin-bottom: 24rpx; }
.empty-text { font-size: 28rpx; color: #888; }

.type-card { background: #fff; border-radius: 24rpx; padding: 24rpx; margin-bottom: 16rpx; box-shadow: 0 2rpx 16rpx rgba(0,0,0,0.04); }
.type-header { display: flex; align-items: flex-start; justify-content: space-between; cursor: pointer; }
.type-left { flex: 1; min-width: 0; }
.type-name { font-size: 30rpx; font-weight: 600; color: #191919; display: block; margin-bottom: 8rpx; }
.type-meta { display: flex; align-items: center; gap: 8rpx; margin-bottom: 6rpx; }
.meta-item { font-size: 24rpx; color: #888; }
.meta-div { color: #EDEDED; font-size: 20rpx; }
.type-price { font-size: 26rpx; font-weight: 600; color: #07C160; }
.type-actions { display: flex; justify-content: space-between; align-items: center; padding-top: 16rpx; border-top: 1rpx solid #EDEDED; margin-top: 16rpx; }
.type-stat { font-size: 24rpx; color: #888; }
.action-link { font-size: 24rpx; color: #07C160; font-weight: 500; padding: 4rpx 12rpx; }

.room-section { margin-top: 16rpx; border-top: 1rpx dashed #EDEDED; padding-top: 16rpx; }
.room-loading { text-align: center; padding: 24rpx; font-size: 24rpx; color: #888; }
.room-stats { display: flex; gap: 16rpx; margin-bottom: 12rpx; }
.room-stat { font-size: 22rpx; padding: 4rpx 12rpx; border-radius: 8rpx; }
.room-stat.green { color: #07C160; background: rgba(7,193,96,0.1); }
.room-stat.orange { color: #FF9500; background: rgba(255,149,0,0.1); }
.room-item { display: flex; align-items: center; justify-content: space-between; padding: 16rpx 0; border-bottom: 1rpx solid #F5F6FA; }
.room-info { display: flex; align-items: center; gap: 12rpx; flex-wrap: wrap; }
.room-no { font-size: 26rpx; font-weight: 600; color: #191919; }
.room-floor { font-size: 22rpx; color: #888; }
.room-status { padding: 2rpx 10rpx; border-radius: 6rpx; }
.status-text { font-size: 20rpx; font-weight: 500; }
.room-price { font-size: 24rpx; color: #191919; font-weight: 500; }
.room-actions { display: flex; gap: 16rpx; }
.room-edit, .room-del { font-size: 28rpx; padding: 4rpx; }
.add-room-btn { text-align: center; padding: 20rpx; font-size: 26rpx; color: #07C160; font-weight: 500; border: 2rpx dashed rgba(7,193,96,0.3); border-radius: 16rpx; margin-top: 12rpx; }

/* modal shared */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 999; display: flex; align-items: flex-end; }
.sheet { background: #fff; width: 100%; border-radius: 32rpx 32rpx 0 0; padding: 32rpx 24rpx 48rpx; max-height: 80vh; overflow-y: auto; }
.sheet-title { font-size: 32rpx; font-weight: 600; color: #191919; text-align: center; display: block; margin-bottom: 32rpx; }
.fi { margin-bottom: 24rpx; }
.fl { font-size: 26rpx; color: #888; display: block; margin-bottom: 10rpx; }
.fin { height: 80rpx; background: #F5F6FA; border-radius: 16rpx; padding: 0 24rpx; font-size: 28rpx; color: #191919; }
.tag-group { display: flex; flex-wrap: wrap; gap: 12rpx; }
.tag { padding: 12rpx 20rpx; border-radius: 20rpx; background: #F5F6FA; }
.tag.sel { background: rgba(7,193,96,0.1); }
.tag-text { font-size: 24rpx; color: #666; }
.tag.sel .tag-text { color: #07C160; font-weight: 500; }
.btns { display: flex; gap: 24rpx; margin-top: 32rpx; }
.bc { flex: 1; height: 80rpx; background: #F5F6FA; border-radius: 40rpx; display: flex; align-items: center; justify-content: center; font-size: 28rpx; color: #666; }
.bf { flex: 1; height: 80rpx; background: #07C160; border-radius: 40rpx; display: flex; align-items: center; justify-content: center; font-size: 28rpx; color: #fff; font-weight: 500; }

/* 图片网格 & 素材选择器 */
.img-grid { display: flex; flex-wrap: wrap; gap: 12rpx; margin-bottom: 12rpx; }
.img-thumb { width: 140rpx; height: 140rpx; border-radius: 12rpx; }
.img-add { width: 140rpx; height: 140rpx; border-radius: 12rpx; border: 2rpx dashed #ddd; display: flex; align-items: center; justify-content: center; }
.img-add-text { font-size: 48rpx; color: #ccc; }
.img-hint { font-size: 22rpx; color: #999; margin-bottom: 8rpx; }
.asset-grid-4 { display: flex; flex-wrap: wrap; gap: 10rpx; max-height: 450rpx; overflow-y: auto; }
.asset-cell { width: calc(25% - 8rpx); position: relative; padding-bottom: calc(25% - 8rpx); border-radius: 10rpx; overflow: hidden; border: 3rpx solid transparent; }
.asset-cell.sel { border-color: #07C160; }
.ac-thumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.ac-check { position: absolute; top: 4rpx; right: 4rpx; width: 32rpx; height: 32rpx; background: #07C160; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 20rpx; }
.empty-hint { text-align: center; padding: 60rpx; color: #999; font-size: 26rpx; }
</style>
