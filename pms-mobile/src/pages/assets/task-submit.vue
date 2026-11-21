<script setup lang="ts">
import { ref, computed } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { fetchTaskDetail, createAsset, submitTask } from '@/api/modules/assets'
import { uploadFile } from '@/api/request'
import { shotTypeLabel } from '@/constants/shotType'
import { SELF_CHECK_ITEMS } from '@/constants/shootGuide'

interface ShotReq {
  shotType: string
  mediaType?: 'image' | 'video'
  count: number
  guideText?: string
  movementText?: string
  avoidText?: string
  durationMin?: number
  durationMax?: number
}

const taskId = ref('')
const task = ref<any>(null)
const shotRequirements = ref<ShotReq[]>([])
const roomNames = ref<string[]>([])
const purposeTags = ref<string[]>([])
const loading = ref(true)
const uploading = ref(false)
// 任务截止时间戳（0 表示未设置截止），用于逾期拦截
const deadline = ref(0)
// 每类已选文件（key = `${shotType}|${mediaType}`，同类型图文分开计数）
const pickedMap = ref<Record<string, string[]>>({})
// 提交前自检清单弹窗
const showCheck = ref(false)
const checkState = ref<Record<string, boolean>>({})
// 任务是否含视频要求：纯图片任务隐藏 videoOnly 自检项，避免与 shootGuide 注释矛盾
const hasVideoReq = computed(() => shotRequirements.value.some(r => r.mediaType === 'video'))
const checkItems = computed(() => (hasVideoReq.value ? SELF_CHECK_ITEMS : SELF_CHECK_ITEMS.filter(it => !it.videoOnly)))

function pickedKey(r: ShotReq): string { return `${r.shotType}|${r.mediaType || 'image'}` }

onLoad((options: any) => { taskId.value = options?.id || ''; load() })

async function load() {
  loading.value = true
  try {
    const data = await fetchTaskDetail(taskId.value)
    const t = data?.task || data || {}
    task.value = t
    shotRequirements.value = t.shotRequirements || []
    roomNames.value = t.roomNames || []
    purposeTags.value = t.purposeTags || []
    shotRequirements.value.forEach(r => { pickedMap.value[pickedKey(r)] = [] })
    deadline.value = t.deadline ? new Date(t.deadline).getTime() : 0
    const isOverdue = deadline.value > 0 && deadline.value < Date.now() && t.mySubmission?.status !== 'completed'
    if (isOverdue) uni.showToast({ title: '任务已截止，无法打卡', icon: 'none' })
  } catch {}
  finally { loading.value = false }
}

/** 视频硬校验：时长 [min,max]（秒）与大小上限（字节），返回错误文案（空串=通过）
 * 时长/大小来自 uni.getVideoInfo（单位跨端一致），勿用 chooseVideo 返回的 duration（部分平台是毫秒） */
function validateVideo(info: { duration?: number; size?: number }, r: ShotReq): string {
  const min = r.durationMin ?? 5
  const max = r.durationMax ?? 10
  if (typeof info.duration === 'number' && (info.duration < min || info.duration > max)) {
    return `视频需 ${min}~${max} 秒，当前 ${Math.round(info.duration)} 秒`
  }
  if (typeof info.size === 'number' && info.size > 200 * 1024 * 1024) return '视频不能超过 200MB'
  return ''
}

function pickFor(r: ShotReq) {
  if (deadline.value > 0 && deadline.value < Date.now()) { uni.showToast({ title: '任务已截止，无法打卡', icon: 'none' }); return }
  const key = pickedKey(r)
  const remain = r.count - (pickedMap.value[key] || []).length
  if (remain <= 0) { uni.showToast({ title: '该类型已达上限', icon: 'none' }); return }
  if (r.mediaType === 'video') {
    // chooseVideo 每次返回单个视频，达标数靠多次拍摄累积
    uni.chooseVideo({
      sourceType: ['album', 'camera'], compressed: true, maxDuration: (r.durationMax ?? 10),
      success: (res: any) => {
        const path = res.tempFilePath
        if (!path) return
        // 用 getVideoInfo 拿标准化的时长（秒）/大小（字节）做硬校验
        uni.getVideoInfo({
          src: path,
          success: (info: any) => {
            const err = validateVideo({ duration: info.duration, size: info.size }, r)
            if (err) { uni.showToast({ title: err, icon: 'none' }); return }
            pickedMap.value[key] = [...(pickedMap.value[key] || []), path]
          },
          // 部分 H5 内置浏览器/WebView 未实现 getVideoInfo：放行并提示未校验，避免视频采集被锁死
          fail: () => {
            uni.showToast({ title: '无法读取视频信息，已加入（时长未校验）', icon: 'none' })
            pickedMap.value[key] = [...(pickedMap.value[key] || []), path]
          },
        })
      },
    })
  } else {
    uni.chooseImage({
      count: remain, sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (res: any) => {
        const paths: string[] = res.tempFilePaths || []
        pickedMap.value[key] = [...(pickedMap.value[key] || []), ...paths]
      },
    })
  }
}

function removePick(r: ShotReq, idx: number) {
  const arr = pickedMap.value[pickedKey(r)] || []
  arr.splice(idx, 1)
}

// 图片压缩 (<500KB)，逻辑与 profile/assets.vue 一致（保持原有实现不动）
function compressImage(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    uni.getImageInfo({
      src: filePath,
      success: (info) => {
        let maxSide = Math.max(info.width, info.height)
        if (maxSide > 2048) maxSide = 2048
        const ratio = maxSide / Math.max(info.width, info.height)
        const dw = Math.round(info.width * ratio); const dh = Math.round(info.height * ratio)
        // #ifdef H5
        const img = new Image(); img.crossOrigin = 'anonymous'
        img.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = dw; canvas.height = dh
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(img, 0, 0, dw, dh)
          let lo = 30, hi = 92, best = ''
          const tryCompress = (q: number) => canvas.toDataURL('image/jpeg', q / 100)
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2)
            const dataUrl = tryCompress(mid)
            const size = dataUrl.length * 0.75 / 1024
            if (size <= 500) { best = dataUrl; lo = mid + 1 } else { hi = mid - 1 }
          }
          resolve(best || tryCompress(40))
        }
        img.onerror = () => resolve(filePath)
        img.src = filePath
        // #endif
        // #ifndef H5
        uni.compressImage({
          src: filePath,
          quality: 80,
          success: (res: any) => resolve(res.tempFilePath || filePath),
          fail: () => resolve(filePath),
        })
        // #endif
      },
      fail: () => resolve(filePath),
    })
  })
}

async function uploadOne(filePath: string, r: ShotReq, idx: number, total: number): Promise<string> {
  uni.showLoading({ title: `上传中 ${idx + 1}/${total}`, mask: true })
  try {
    // 媒体类型以 req 为准（pickFor 已严格分流：video req 只进 chooseVideo）。
    // H5 端 chooseVideo 返回 blob URL 无扩展名，不能用扩展名正则判定，否则视频被当图片压缩并落库 mediaType:'image'
    const isVideo = r.mediaType === 'video'
    let target = filePath
    if (!isVideo) {
      try { target = await compressImage(filePath) } catch {}
    }
    const data: any = await uploadFile('/api/upload', target, 'file')
    const url = data?.url || data
    if (!url) throw new Error('未获取到地址')
    // 创建素材记录（后端用素材 id 做达标校验）
    const created: any = await createAsset({
      url, mediaType: isVideo ? 'video' : 'image', category: 'room',
      roomName: roomNames.value[0] || '', roomId: task.value?.roomIds?.[0] || null,
      roomTypeIds: task.value?.roomTypeIds || [],
      roomTypeNames: task.value?.roomTypeNames || [],
      purposeTags: purposeTags.value, shotType: r.shotType,
      taskId: taskId.value,
    })
    return created?.id || url
  } finally { uni.hideLoading() }
}

/** 提交前先过自检清单 */
function openCheck() {
  if (uploading.value) return
  if (deadline.value > 0 && deadline.value < Date.now()) { uni.showToast({ title: '任务已截止', icon: 'none' }); return }
  const total = shotRequirements.value.reduce((s, r) => s + (pickedMap.value[pickedKey(r)] || []).length, 0)
  if (total === 0) { uni.showToast({ title: '请先拍摄上传素材', icon: 'none' }); return }
  checkState.value = checkItems.value.reduce((acc, it) => { acc[it.id] = false; return acc }, {} as Record<string, boolean>)
  showCheck.value = true
}

async function handleSubmit() {
  if (uploading.value) return
  const allChecked = checkItems.value.every(it => checkState.value[it.id])
  if (!allChecked) { uni.showToast({ title: '请先逐项确认素材质量', icon: 'none' }); return }
  showCheck.value = false
  uploading.value = true
  try {
    const allAssetIds: string[] = []
    let failCount = 0
    for (const req of shotRequirements.value) {
      const files = pickedMap.value[pickedKey(req)] || []
      for (let i = 0; i < files.length; i++) {
        try {
          const asset = await uploadOne(files[i], req, i, files.length)
          allAssetIds.push(asset)
        } catch { failCount++ }
      }
    }
    if (allAssetIds.length === 0) {
      uni.showToast({ title: failCount ? '上传失败，请重试' : '请先拍摄上传素材', icon: 'none' })
      return
    }
    try {
      const res: any = await submitTask(taskId.value, { assetIds: allAssetIds })
      const title = res?.status === 'completed' ? '打卡完成 🎉' : (failCount ? `已提交（${failCount} 个失败）` : '已提交')
      uni.showToast({ title, icon: 'none' })
      setTimeout(() => uni.navigateBack(), 1000)
    } catch {
      uni.showToast({ title: '提交失败，请重试', icon: 'none' })
    }
  } finally { uploading.value = false }
}
</script>

<template>
  <view class="page">
    <view v-if="loading" class="empty"><text>加载中...</text></view>
    <view v-else>
      <view class="head">
        <text class="head-title">{{ task.title }}</text>
        <text v-if="roomNames.length" class="head-rooms">房源：{{ roomNames.join(' / ') }}</text>
      </view>

      <view class="shot-list">
        <view v-for="(r, i) in shotRequirements" :key="`${pickedKey(r)}-${i}`" class="shot-block">
          <view class="shot-head">
            <text class="shot-type">{{ shotTypeLabel(r.shotType) }}</text>
            <text :class="['media-badge', r.mediaType || 'image']">{{ (r.mediaType || 'image') === 'video' ? '视频' : '图片' }}</text>
            <text class="shot-count">{{ (pickedMap[pickedKey(r)] || []).length }}/{{ r.count }}</text>
          </view>
          <text v-if="r.guideText" class="shot-guide">{{ r.guideText }}</text>
          <text v-if="r.movementText" class="shot-guide">运镜：{{ r.movementText }}</text>
          <text v-if="r.avoidText" class="shot-avoid">禁拍：{{ r.avoidText }}</text>
          <view class="pick-row">
            <view v-for="(f, i) in pickedMap[pickedKey(r)]" :key="i" class="pick-item">
              <video v-if="(r.mediaType || 'image') === 'video'" :src="f" class="pick-video" />
              <image v-else :src="f" mode="aspectFill" class="pick-img" />
              <!-- 显式删除角标：H5 视频点击播放会冒泡误删、小程序原生 video 吞掉外层点击，统一走角标删除 -->
              <view class="pick-del" @click.stop="removePick(r, i)"><text class="pick-del-text">✕</text></view>
            </view>
            <view class="pick-add" @click="pickFor(r)">
              <text class="pick-add-text">+</text>
            </view>
          </view>
        </view>
      </view>

      <view class="bottom-bar">
        <view class="submit-btn" :class="{ disabled: uploading }" @click="openCheck">
          <text class="submit-btn-text">{{ uploading ? '上传中...' : '提交打卡' }}</text>
        </view>
      </view>

      <!-- 提交前自检清单弹窗 -->
      <t-popup v-model:visible="showCheck" placement="bottom">
        <view class="check-wrap">
          <view class="check-head">
            <text class="check-title">提交前素材自检</text>
            <text class="check-close" @click="showCheck = false">✕</text>
          </view>
          <scroll-view scroll-y class="check-scroll">
            <view v-for="it in checkItems" :key="it.id" class="check-item" @click="checkState[it.id] = !checkState[it.id]">
              <view :class="['check-box', { on: checkState[it.id] }]">
                <text v-if="checkState[it.id]" class="check-tick">✓</text>
              </view>
              <text class="check-label">{{ it.label }}</text>
              <text v-if="it.videoOnly" class="check-video-tag">视频</text>
            </view>
          </scroll-view>
          <view class="check-submit" :class="{ disabled: !checkItems.every(it => checkState[it.id]) }" @click="handleSubmit">
            <text class="check-submit-text">全部通过，提交打卡</text>
          </view>
        </view>
      </t-popup>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; padding-bottom: 140rpx; }
.head { background: #fff; padding: 28rpx 24rpx; }
.head-title { font-size: 34rpx; font-weight: 700; }
.head-rooms { font-size: 26rpx; color: #888; margin-top: 8rpx; display: block; }
.shot-list { padding: 20rpx 24rpx; }
.shot-block { background: #fff; border-radius: 20rpx; padding: 24rpx; margin-bottom: 20rpx; }
.shot-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8rpx; }
.shot-type { font-size: 30rpx; font-weight: 600; }
.shot-count { font-size: 26rpx; color: #07C160; font-weight: 600; }
.shot-guide { font-size: 24rpx; color: #888; display: block; margin-bottom: 16rpx; }
.pick-row { display: flex; flex-wrap: wrap; gap: 16rpx; }
.pick-item, .pick-add { width: 160rpx; height: 160rpx; border-radius: 16rpx; overflow: hidden; position: relative; }
.pick-item image { width: 100%; height: 100%; }
.pick-add { border: 2rpx dashed #ccc; display: flex; align-items: center; justify-content: center; }
.pick-add-text { font-size: 60rpx; color: #ccc; }
.bottom-bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 20rpx 24rpx calc(20rpx + env(safe-area-inset-bottom)); background: #fff; }
.submit-btn { background: #07C160; border-radius: 44rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; }
.submit-btn.disabled { opacity: 0.5; }
.submit-btn-text { color: #fff; font-size: 30rpx; font-weight: 600; }
.empty { display: flex; justify-content: center; padding: 200rpx 0; color: #888; }
.media-badge { font-size: 20rpx; padding: 2rpx 12rpx; border-radius: 8rpx; }
.media-badge.image { color: #4F6EF7; background: rgba(79,110,247,0.1); }
.media-badge.video { color: #07C160; background: rgba(7,193,96,0.1); }
.shot-avoid { font-size: 22rpx; color: #D35A5A; display: block; margin-bottom: 12rpx; }
.pick-item video.pick-video { width: 100%; height: 100%; object-fit: cover; }
.pick-del { position: absolute; top: 0; right: 0; width: 44rpx; height: 44rpx; background: rgba(0,0,0,0.45); border-radius: 0 16rpx 0 16rpx; display: flex; align-items: center; justify-content: center; z-index: 2; }
.pick-del-text { color: #fff; font-size: 24rpx; }
.check-wrap { background: #fff; border-radius: 24rpx 24rpx 0 0; padding: 32rpx 24rpx 32rpx; }
.check-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16rpx; }
.check-title { font-size: 32rpx; font-weight: 700; }
.check-close { font-size: 32rpx; color: #999; }
.check-scroll { max-height: 50vh; }
.check-item { display: flex; align-items: center; gap: 16rpx; padding: 20rpx 8rpx; border-bottom: 1rpx solid #F5F5F5; }
.check-box { width: 40rpx; height: 40rpx; border-radius: 8rpx; border: 2rpx solid #ddd; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.check-box.on { background: #07C160; border-color: #07C160; }
.check-tick { color: #fff; font-size: 26rpx; }
.check-label { flex: 1; font-size: 26rpx; color: #333; }
.check-video-tag { font-size: 20rpx; color: #07C160; background: rgba(7,193,96,0.1); padding: 2rpx 10rpx; border-radius: 8rpx; }
.check-submit { background: #07C160; border-radius: 44rpx; height: 88rpx; display: flex; align-items: center; justify-content: center; margin-top: 20rpx; }
.check-submit.disabled { opacity: 0.4; }
.check-submit-text { color: #fff; font-size: 30rpx; font-weight: 600; }
</style>
