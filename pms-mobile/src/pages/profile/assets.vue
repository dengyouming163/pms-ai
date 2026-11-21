<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { onReachBottom } from '@dcloudio/uni-app'
import { post, uploadFile } from '@/api/request'
import { fetchAssets, patchAsset, deleteAsset } from '@/api/modules/assets'
import { getRoomTypes } from '@/api/modules/user'

interface AssetItem {
  id: string | number
  url: string
  name: string
  assetCategory: string
  tags: string[]
  createdAt: string
  quality?: string
  mediaType?: string
  roomTypeIds?: string[]
  roomTypeNames?: string[]
}

interface RoomType { id: string; name: string }

const categories = [
  { label: '全部', value: '' }, { label: '房间照片', value: 'room' },
  { label: '周边风景', value: 'view' }, { label: '品牌素材', value: 'brand' },
  { label: '餐饮美食', value: 'food' }, { label: '实景路线', value: 'route' },
  { label: '老板娘语音', value: 'voice' }, { label: '模板素材', value: 'template' },
  { label: '其他', value: 'other' },
]

const activeCategory = ref('')
const purposeOptions = ['OTA展示', '短视频剪辑', '广告投放']
const activePurpose = ref('')
const assets = ref<AssetItem[]>([])
const loading = ref(false)
// 分页状态：limit 默认 50，与后端一致；hasMore 由已加载数 < total 判断
const pageSize = 50
const page = ref(1)
const total = ref(0)
const hasMore = ref(true)

// 房型筛选（'' 全部 | 'unbound' 未绑定 | 房型 id）
const roomTypes = ref<RoomType[]>([])
const activeRoomType = ref('')

// 素材操作弹层
const sheetItem = ref<AssetItem | null>(null)
const selRoomTypeIds = ref<string[]>([])
const selRoomTypeNames = ref<string[]>([])
const selPurposeTags = ref<string[]>([])

// ========== 房型 ==========
async function loadRoomTypes() {
  try { roomTypes.value = await getRoomTypes() } catch { roomTypes.value = [] }
}

function switchRoomType(value: string) {
  activeRoomType.value = activeRoomType.value === value ? '' : value
  loadAssets()
}

// ========== CRUD ==========
async function loadAssets(append = false) {
  if (loading.value) return
  if (!append) { page.value = 1; hasMore.value = true }
  loading.value = true
  try {
    const params: Record<string, any> = { limit: pageSize, offset: (page.value - 1) * pageSize }
    if (activeCategory.value) params.category = activeCategory.value
    if (activePurpose.value) params.purpose = activePurpose.value
    if (activeRoomType.value === 'unbound') params.unbound = 'true'
    else if (activeRoomType.value) params.room_type_ids = activeRoomType.value
    const data = await fetchAssets(params)
    // 兼容旧返回（数组）与新返回（{ assets, total }）
    const list = Array.isArray(data) ? data : (data?.assets || [])
    const count = Array.isArray(data) ? list.length : (data?.total ?? list.length)
    if (append) assets.value = [...assets.value, ...list]
    else assets.value = list
    total.value = count
    hasMore.value = assets.value.length < total.value
    page.value += 1
  } catch { uni.showToast({ title: '加载失败', icon: 'none' }) }
  finally { loading.value = false }
}

// 触底加载下一页（追加）
onReachBottom(async () => {
  if (!hasMore.value || loading.value) return
  await loadAssets(true)
})

function switchCategory(value: string) { activeCategory.value = value; loadAssets() }
function switchPurpose(value: string) { activePurpose.value = activePurpose.value === value ? '' : value; loadAssets() }

// ========== 素材操作弹层 ==========
function openSheet(item: AssetItem) {
  sheetItem.value = item
  selRoomTypeIds.value = item.roomTypeIds ? [...item.roomTypeIds] : []
  selRoomTypeNames.value = item.roomTypeNames ? [...item.roomTypeNames] : []
  selPurposeTags.value = item.tags ? [...item.tags] : []
}

function closeSheet() { sheetItem.value = null }

// 用途标签点选/取消
function togglePurpose(p: string) {
  const idx = selPurposeTags.value.indexOf(p)
  if (idx >= 0) selPurposeTags.value.splice(idx, 1)
  else selPurposeTags.value.push(p)
}

function toggleRoomType(rt: RoomType) {
  const idx = selRoomTypeIds.value.indexOf(rt.id)
  if (idx >= 0) {
    selRoomTypeIds.value.splice(idx, 1)
    selRoomTypeNames.value.splice(idx, 1)
  } else {
    selRoomTypeIds.value.push(rt.id)
    selRoomTypeNames.value.push(rt.name)
  }
}

function clearRoomType() {
  selRoomTypeIds.value = []
  selRoomTypeNames.value = []
}

async function saveBinding() {
  if (!sheetItem.value) return
  try {
    await patchAsset(sheetItem.value.id, {
      roomTypeIds: selRoomTypeIds.value,
      roomTypeNames: selRoomTypeNames.value,
      purposeTags: selPurposeTags.value,
    })
    uni.showToast({ title: '已保存', icon: 'success' })
    closeSheet()
    loadAssets()
  } catch { /* request 层已统一 toast 提示 */ }
}

async function handleDelete(item: AssetItem) {
  uni.showModal({
    title: '确认删除', content: `确定删除「${item.name || '该素材'}」吗？`,
    success: async (res) => {
      if (!res.confirm) return
      try { await deleteAsset(item.id); uni.showToast({ title: '已删除', icon: 'success' }); closeSheet(); loadAssets() } catch { /* request 层已统一 toast 提示 */ }
    },
  })
}

async function toggleFeatured(item: AssetItem) {
  const next = item.quality === 'featured' ? 'normal' : 'featured'
  try { await patchAsset(item.id, { quality: next }); item.quality = next } catch { /* request 层已统一 toast 提示 */ }
}

function previewImage(currentUrl: string) {
  // uni.previewImage 不支持视频，过滤掉视频素材
  const urls = assets.value.filter(a => a.url && a.mediaType !== 'video').map(a => a.url)
  if (urls.length > 0) uni.previewImage({ current: currentUrl, urls })
}

// 弹层预览：视频用 <video> 播放，图片走 previewImage
function previewSheet(item: AssetItem) {
  if (item.mediaType === 'video') return
  previewImage(item.url)
}

// ========== 图片压缩 (<500KB) ==========
function compressImage(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    uni.getImageInfo({
      src: filePath,
      success: (info) => {
        const w = info.width; const h = info.height
        // 计算压缩比例，目标 <500KB
        let quality = 80
        let maxSide = Math.max(w, h)
        if (maxSide > 2048) maxSide = 2048
        const ratio = maxSide / Math.max(w, h)
        const dw = Math.round(w * ratio); const dh = Math.round(h * ratio)

        // 用 offscreen canvas 压缩（H5）
        // #ifdef H5
        const img = new Image(); img.crossOrigin = 'anonymous'
        img.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = dw; canvas.height = dh
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(img, 0, 0, dw, dh)
          // PNG 保留透明通道（输出 image/png），其余格式走 image/jpeg
          const format = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
          // 二分查找最佳 quality
          let lo = 30, hi = 92, best = ''
          const tryCompress = (q: number) => canvas.toDataURL(format, q / 100)
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2)
            const dataUrl = tryCompress(mid)
            const size = dataUrl.length * 0.75 / 1024 // 估算KB
            if (size <= 500) { best = dataUrl; lo = mid + 1 }
            else { hi = mid - 1 }
          }
          resolve(best || tryCompress(40))
        }
        img.onerror = () => resolve(filePath)
        img.src = filePath
        // #endif
        // #ifndef H5
        // APP/小程序：用 uni.compressImage 压缩后返回临时文件，避免原图直传超 5MB 导致上传失败
        uni.compressImage({
          src: filePath,
          quality: 80,
          success: (r: any) => resolve(r.tempFilePath || filePath),
          fail: () => resolve(filePath),
        })
        // #endif
      },
      fail: () => resolve(filePath)
    })
  })
}

// ========== 上传 ==========
async function uploadSingleFile(filePath: string, index: number, total: number) {
  const fileName = filePath.split('/').pop() || `素材_${Date.now()}`

  // 按扩展名判断媒体类型：视频入库 video，音频入库 audio，其余 image
  const mediaType = /\.(mp4|mov|avi|mkv|webm)$/i.test(filePath) ? 'video'
    : /\.(mp3|m4a|wav|amr|aac)$/i.test(filePath) ? 'audio'
    : 'image'

  // 图片压缩（视频不压缩）
  let uploadPath = filePath
  if (mediaType === 'image' && /\.(jpg|jpeg|png|webp|bmp)$/i.test(filePath)) {
    uni.showLoading({ title: `压缩中 ${index + 1}/${total}`, mask: true })
    try { uploadPath = await compressImage(filePath) } catch {}
    uni.hideLoading()
  }

  // 通过 @/api/request 封装的 uploadFile 上传（自动注入 token + X-Store-Id，自带 loading 与错误提示）
  try {
    const data: any = await uploadFile('/api/upload', uploadPath, 'file')
    const uploadedUrl = data?.url || data
    if (!uploadedUrl) throw new Error('未获取到文件地址')
    // 创建素材记录：上传时若已选用途则自动打标，命中用途筛选
    await post('/api/assets', {
      url: uploadedUrl, name: fileName, mediaType,
      assetCategory: activeCategory.value || 'other',
      tags: activePurpose.value ? [activePurpose.value] : [],
    })
  } catch (e) { throw e }
}

async function handlePickImages() {
  uni.chooseImage({
    count: 9, sizeType: ['original'], sourceType: ['album', 'camera'],
    success: (res: any) => {
      const files: string[] = res.tempFilePaths || []
      if (files.length === 0) return
      processUpload(files)
    },
  })
}

async function handlePickVideo() {
  uni.chooseVideo({
    sourceType: ['album', 'camera'], compressed: true, maxDuration: 120,
    success: (res: any) => {
      if (res.size && res.size > 200 * 1024 * 1024) {
        uni.showToast({ title: '视频不能超过200MB', icon: 'none' }); return
      }
      if (res.tempFilePath) processUpload([res.tempFilePath])
    },
  })
}

async function processUpload(files: string[]) {
  let success = 0; let fail = 0
  for (let i = 0; i < files.length; i++) {
    try { await uploadSingleFile(files[i], i, files.length); success++ }
    catch { fail++ }
  }
  uni.hideLoading()
  // 上传归属提示：当前分类筛选下自动归入，房型筛选下未自动绑定房型
  let toast = `上传完成：${success}成功${fail ? ' ' + fail + '失败' : ''}`
  if (activeCategory.value) {
    const cat = categories.find(c => c.value === activeCategory.value)
    if (cat) toast += `（已归入「${cat.label}」）`
  }
  if (activeRoomType.value && activeRoomType.value !== 'unbound') toast += '（未自动绑定房型）'
  uni.showToast({ title: toast, icon: 'none' })
  loadAssets()
}

function handleUpload() {
  uni.showActionSheet({
    itemList: ['选择图片', '选择视频'],
    success: (res) => {
      if (res.tapIndex === 0) handlePickImages()
      else if (res.tapIndex === 1) handlePickVideo()
    },
  })
}

onMounted(() => {
  loadRoomTypes()
  loadAssets()
})
</script>

<template>
  <view class="assets-page">
    <view class="toolbar">
      <scroll-view class="category-scroll" scroll-x :show-scrollbar="false">
        <view v-for="cat in categories" :key="cat.value"
          :class="['category-tab', { active: activeCategory === cat.value }]"
          @click="switchCategory(cat.value)">
          <text class="category-tab-text">{{ cat.label }}</text>
        </view>
      </scroll-view>
      <view class="upload-btn" @click="handleUpload">
        <text class="upload-btn-text">+ 上传</text>
      </view>
    </view>

    <!-- 用途筛选 -->
    <scroll-view class="purpose-scroll" scroll-x :show-scrollbar="false">
      <view v-for="p in purposeOptions" :key="p"
        :class="['purpose-chip', { active: activePurpose === p }]"
        @click="switchPurpose(p)">
        <text class="purpose-chip-text">{{ p }}</text>
      </view>
    </scroll-view>

    <!-- 房型筛选 -->
    <scroll-view v-if="roomTypes.length > 0" class="purpose-scroll" scroll-x :show-scrollbar="false">
      <view
        :class="['purpose-chip', { active: activeRoomType === '' }]"
        @click="switchRoomType('')">
        <text class="purpose-chip-text">全部</text>
      </view>
      <view
        :class="['purpose-chip', { active: activeRoomType === 'unbound' }]"
        @click="switchRoomType('unbound')">
        <text class="purpose-chip-text">未绑定</text>
      </view>
      <view v-for="rt in roomTypes" :key="rt.id"
        :class="['purpose-chip', { active: activeRoomType === rt.id }]"
        @click="switchRoomType(rt.id)">
        <text class="purpose-chip-text">{{ rt.name }}</text>
      </view>
    </scroll-view>

    <view v-if="loading && assets.length === 0" class="empty-state"><text class="empty-text">加载中...</text></view>

    <view v-else-if="assets.length === 0" class="empty-state">
      <text class="empty-icon">📁</text>
      <text class="empty-text">暂无素材，点击右上角上传</text>
    </view>

    <view v-else class="asset-grid">
      <view v-for="item in assets" :key="item.id" class="asset-card" @click="openSheet(item)">
        <view class="asset-thumb-wrap">
          <image :src="item.url" class="asset-thumb" mode="aspectFill" lazy-load />
          <!-- 视频素材叠加播放图标 -->
          <view v-if="item.mediaType === 'video'" class="video-badge">▶</view>
          <view v-if="item.quality === 'featured'" class="featured-badge">优</view>
          <!-- 房型角标：最多 2 个，超出 +N -->
          <view v-if="item.roomTypeNames && item.roomTypeNames.length > 0" class="rt-badge-wrap">
            <view class="rt-badge" v-for="(n, i) in item.roomTypeNames.slice(0, 2)" :key="i">{{ n }}</view>
            <view v-if="item.roomTypeNames.length > 2" class="rt-badge">+{{ item.roomTypeNames.length - 2 }}</view>
          </view>
        </view>
        <text class="asset-name">{{ item.name }}</text>
      </view>
    </view>

    <!-- 触底加载更多 / 无更多提示 -->
    <view v-if="loading && assets.length > 0" class="load-more-hint"><text class="load-more-text">加载中...</text></view>
    <view v-else-if="!hasMore && assets.length > 0" class="load-more-hint"><text class="load-more-text">没有更多了</text></view>

    <!-- 素材操作弹层 -->
    <view v-if="sheetItem" class="overlay" @click="closeSheet">
      <view class="sheet" @click.stop>
        <view class="sheet-close" @click="closeSheet"><text class="sheet-close-text">✕</text></view>
        <view class="sheet-preview" @click="previewSheet(sheetItem)">
          <video v-if="sheetItem.mediaType === 'video'" :src="sheetItem.url" class="sheet-preview-video" controls />
          <image v-else :src="sheetItem.url" class="sheet-preview-img" mode="aspectFit" />
        </view>
        <view class="sheet-info">
          <text class="sheet-name">{{ sheetItem.name }}</text>
          <text class="sheet-cat">{{ sheetItem.assetCategory }}</text>
        </view>

        <view class="sheet-section">
          <text class="sheet-section-title">绑定房型</text>
          <view class="rt-options">
            <view
              :class="['rt-opt', { active: selRoomTypeIds.length === 0 }]"
              @click="clearRoomType">
              <text class="rt-opt-text">不绑定</text>
            </view>
            <view
              v-for="rt in roomTypes" :key="rt.id"
              :class="['rt-opt', { active: selRoomTypeIds.includes(rt.id) }]"
              @click="toggleRoomType(rt)">
              <text class="rt-opt-text">{{ rt.name }}</text>
            </view>
          </view>
        </view>

        <!-- 用途标签多选：保存时连同 purposeTags 提交，命中用途筛选 -->
        <view class="sheet-section">
          <text class="sheet-section-title">用途标签</text>
          <view class="rt-options">
            <view
              v-for="p in purposeOptions" :key="p"
              :class="['rt-opt', { active: selPurposeTags.includes(p) }]"
              @click="togglePurpose(p)">
              <text class="rt-opt-text">{{ p }}</text>
            </view>
          </view>
        </view>

        <view class="sheet-actions">
          <view class="sheet-action-btn primary" @click="saveBinding"><text class="sheet-action-text">保存</text></view>
          <view class="sheet-action-btn" @click="toggleFeatured(sheetItem)">
            <text class="sheet-action-text">{{ sheetItem.quality === 'featured' ? '取消优' : '标优' }}</text>
          </view>
          <view class="sheet-action-btn danger" @click="handleDelete(sheetItem)">
            <text class="sheet-action-text">删除</text>
          </view>
        </view>
        <view class="safe-bottom" />
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.assets-page { min-height: 100vh; background: #F5F6FA; display: flex; flex-direction: column; }
.toolbar { display: flex; align-items: center; background: #fff; padding: 16rpx 24rpx; gap: 16rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.category-scroll { flex: 1; white-space: nowrap; min-width: 0; }
.category-tab { display: inline-flex; align-items: center; justify-content: center; padding: 12rpx 24rpx; margin-right: 16rpx; border-radius: 32rpx; background: #F5F6FA; min-height: 56rpx; }
.category-tab.active { background: rgba(7,193,96,0.1); }
.category-tab-text { font-size: 24rpx; color: #666; white-space: nowrap; }
.category-tab.active .category-tab-text { color: #07C160; font-weight: 600; }
.upload-btn { flex-shrink: 0; padding: 12rpx 28rpx; background: #07C160; border-radius: 32rpx; min-height: 56rpx; display: flex; align-items: center; justify-content: center; }
.upload-btn:active { background: #06AD56; }
.upload-btn-text { font-size: 24rpx; color: #fff; font-weight: 600; white-space: nowrap; }
.empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 160rpx 0; gap: 16rpx; }
.empty-icon { font-size: 80rpx; }
.empty-text { font-size: 28rpx; color: #888; }
.asset-grid { flex: 1; display: flex; flex-wrap: wrap; justify-content: flex-start; align-content: flex-start; padding: 20rpx 12rpx; box-sizing: border-box; }
.asset-card { width: calc(33.333% - 12rpx); height: auto; margin: 6rpx; margin-top: 20rpx; position: relative; }
.asset-thumb-wrap { width: 100%; padding-bottom: 100%; position: relative; background: #F0F0F0; border-radius: 16rpx; overflow: hidden; }
.asset-thumb { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; }
.asset-name { display: block; padding: 12rpx; font-size: 22rpx; color: #333; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.featured-badge { position: absolute; top: 8rpx; left: 8rpx; background: #F59E0B; color: #fff; font-size: 20rpx; padding: 2rpx 10rpx; border-radius: 8rpx; z-index: 2; }
/* 视频素材播放图标 */
.video-badge { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 56rpx; height: 56rpx; border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff; font-size: 24rpx; display: flex; align-items: center; justify-content: center; padding-left: 4rpx; z-index: 2; }
/* 房型角标 */
.rt-badge-wrap { position: absolute; bottom: 8rpx; left: 8rpx; display: flex; gap: 6rpx; z-index: 2; max-width: calc(100% - 16rpx); flex-wrap: nowrap; }
.rt-badge { background: rgba(0,0,0,0.55); color: #fff; font-size: 18rpx; padding: 2rpx 10rpx; border-radius: 8rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.purpose-scroll { white-space: nowrap; background: #fff; padding: 12rpx 24rpx; }
.purpose-chip { display: inline-flex; padding: 10rpx 24rpx; margin-right: 16rpx; border-radius: 32rpx; background: #F5F6FA; }
.purpose-chip.active { background: rgba(7,193,96,0.1); }
.purpose-chip-text { font-size: 24rpx; color: #666; }
.purpose-chip.active .purpose-chip-text { color: #07C160; font-weight: 600; }
.safe-bottom { height: 32rpx; }
.load-more-hint { padding: 24rpx 0 40rpx; text-align: center; }
.load-more-text { font-size: 24rpx; color: #9BA8B5; }

/* ======== 素材操作弹层 ======== */
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1100; display: flex; align-items: flex-end; }
.sheet { background: #fff; width: 100%; border-radius: 32rpx 32rpx 0 0; padding: 24rpx 32rpx 48rpx; max-height: 82vh; display: flex; flex-direction: column; position: relative; box-sizing: border-box; }
/* #ifndef APP-PLUS */
.sheet { padding-bottom: calc(48rpx + env(safe-area-inset-bottom)); }
/* #endif */
.sheet-close { position: absolute; top: 20rpx; right: 24rpx; width: 56rpx; height: 56rpx; border-radius: 28rpx; background: rgba(0,0,0,0.05); display: flex; align-items: center; justify-content: center; z-index: 3; }
.sheet-close-text { font-size: 26rpx; color: #666; }
.sheet-preview { width: 100%; height: 360rpx; background: #F0F0F0; border-radius: 20rpx; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.sheet-preview-img { width: 100%; height: 100%; }
.sheet-preview-video { width: 100%; height: 100%; }
.sheet-info { display: flex; align-items: baseline; gap: 16rpx; padding: 20rpx 4rpx 8rpx; }
.sheet-name { font-size: 30rpx; font-weight: 600; color: #191919; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sheet-cat { font-size: 22rpx; color: #9BA8B5; flex-shrink: 0; }
.sheet-section { padding: 8rpx 0 20rpx; }
.sheet-section-title { font-size: 26rpx; font-weight: 600; color: #191919; margin-bottom: 16rpx; display: block; }
.rt-options { display: flex; flex-wrap: wrap; gap: 14rpx; max-height: 200rpx; overflow-y: auto; }
.rt-opt { padding: 12rpx 26rpx; border-radius: 32rpx; background: #F5F6FA; }
.rt-opt.active { background: rgba(7,193,96,0.12); }
.rt-opt-text { font-size: 24rpx; color: #666; }
.rt-opt.active .rt-opt-text { color: #07C160; font-weight: 600; }
.sheet-actions { display: flex; gap: 16rpx; }
.sheet-action-btn { flex: 1; padding: 22rpx 0; border-radius: 20rpx; background: #F5F6FA; text-align: center; }
.sheet-action-btn.primary { background: #07C160; }
.sheet-action-btn.danger { background: #FFF1F1; }
.sheet-action-btn:active { opacity: 0.85; }
.sheet-action-text { font-size: 28rpx; color: #333; font-weight: 500; }
.sheet-action-btn.primary .sheet-action-text { color: #fff; }
.sheet-action-btn.danger .sheet-action-text { color: #FA5151; }
</style>
