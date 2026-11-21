<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { post } from '@/api/request'
import { getDailyRooms } from '@/api/modules/rooms'
import { useRoomsStore } from '@/stores/rooms'

// 从房态页跳转的预填参数
const prefilledRoom = ref<Record<string, string>>({})
onLoad((opts: any) => {
  if (opts?.roomId) {
    // 解码 URL 参数，兼容单次/二次编码
    const decoded: Record<string, string> = {}
    for (const k of Object.keys(opts)) {
      let val = opts[k] || ''
      try { val = decodeURIComponent(val) } catch {}
      try { val = decodeURIComponent(val) } catch {} // 二次解码
      decoded[k] = val
    }
    prefilledRoom.value = decoded
  }
})

const isFromRoom = computed(() => !!prefilledRoom.value.roomId)
const isCheckIn = computed(() => prefilledRoom.value.mode === 'checkin')
const isBook = computed(() => prefilledRoom.value.mode === 'book')
const isCheckOut = computed(() => prefilledRoom.value.mode === 'checkout')
const isExtend = computed(() => prefilledRoom.value.mode === 'extend')
const isChange = computed(() => prefilledRoom.value.mode === 'change')

// 默认日期
const todayStr = new Date().toISOString().slice(0, 10)
const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10)

// 续住：当前离店日期 + 新日期
const currentCheckOut = ref(prefilledRoom.value.currentCheckOut || todayStr)
const extendNewDate = ref('')
const extendNights = computed(() => {
  if (!currentCheckOut.value || !extendNewDate.value) return 0
  const d1 = new Date(currentCheckOut.value).getTime()
  const d2 = new Date(extendNewDate.value).getTime()
  return Math.max(0, Math.round((d2 - d1) / 86400000))
})
const extendAmount = computed(() => extendNights.value * Number(prefilledRoom.value.roomPrice || 0))

// 退房费用计算
const checkoutNights = computed(() => {
  const ci = prefilledRoom.value.guestCheckIn
  const co = prefilledRoom.value.guestCheckOut
  if (!ci || !co) return 1
  return Math.max(1, Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000))
})
const checkoutRoomFee = computed(() => checkoutNights.value * Number(prefilledRoom.value.roomPrice || 0))

// 换房：可用房间列表
const availableRooms = ref<any[]>([])
const changeTargetId = ref('')
const changeReason = ref('')
const availableRoomGroups = computed(() => {
  const all = availableRooms.value.filter((r: any) => r.id !== prefilledRoom.value.roomId)
  const sameType = all.filter((r: any) => r.roomTypeId === prefilledRoom.value.roomTypeId)
  const diffType = all.filter((r: any) => r.roomTypeId !== prefilledRoom.value.roomTypeId)
  const groups: any[] = []
  if (sameType.length) groups.push({ label: `同房型 · ${prefilledRoom.value.roomTypeName}`, rooms: sameType })
  const diffGroups: Record<string, any[]> = {}
  diffType.forEach((r: any) => { const n = r.roomTypeName || '其他'; if (!diffGroups[n]) diffGroups[n] = []; diffGroups[n].push(r) })
  Object.entries(diffGroups).forEach(([name, rooms]) => groups.push({ label: name, rooms }))
  return groups
})

// 表单 — 与 pms-web 录单字段完全一致
const form = ref({
  guestName: '',
  guestPhone: '',
  guestIdCard: '',
  checkInDate: todayStr,
  checkOutDate: tomorrowStr,
  guestCount: 1,
  deposit: 0,
  paymentStatus: 'unpaid',
  amountPaid: 0,
  paymentMethod: '到店付',
  depositReceived: false,
  source: '到店',
  remark: '',
})

// 房型数据
const roomTypes = ref<any[]>([])
const loading = ref(false)

const paymentStatusOpts = ['unpaid', 'paid', 'partial']
const paymentStatusLabels: Record<string, string> = { unpaid: '未支付', paid: '已支付', partial: '部分支付' }
const paymentMethodOpts = ['到店付', '现金', '微信', '支付宝', '银行卡', '对公转账']
const channelOpts = ['到店', '携程', '美团', '飞猪', '直营', '电话预订', '企业协议']

function validate(): string | null {
  if (isCheckOut.value || isExtend.value || isChange.value) return null
  if (!form.value.guestName.trim()) return '请输入客人姓名'
  if (!form.value.guestPhone.trim()) return '请输入手机号'
  if (!/^1[3-9]\d{9}$/.test(form.value.guestPhone.trim())) return '手机号格式不正确'
  if (!form.value.checkInDate) return '请选择入住日期'
  if (!form.value.checkOutDate) return '请选择退房日期'
  if (form.value.checkOutDate <= form.value.checkInDate) return '退房日期必须晚于入住日期'
  if (!isFromRoom.value && !prefilledRoom.value.roomTypeId) return '请选择房型'
  return null
}

const submitting = ref(false)
const showSuccess = ref(false)
const resultOrderNo = ref('')

async function handleSubmit() {
  const err = validate()
  if (err) { uni.showToast({ title: err, icon: 'none' }); return }

  submitting.value = true
  uni.showLoading({ title: '提交中...', mask: true })

  try {
    const f = form.value
    let body: any = {}

    if (isCheckOut.value) {
      body = { action: 'checkOut', roomId: prefilledRoom.value.roomId, extraCharges: Number(f.amountPaid) || 0, refundMethod: f.paymentMethod }
    } else if (isExtend.value) {
      if (!extendNewDate.value) { uni.showToast({ title: '请选择新离店日期', icon: 'none' }); submitting.value = false; uni.hideLoading(); return }
      body = { action: 'extendStay', roomId: prefilledRoom.value.roomId, checkOutDate: extendNewDate.value }
    } else if (isChange.value) {
      if (!changeTargetId.value) { uni.showToast({ title: '请选择目标房间', icon: 'none' }); submitting.value = false; uni.hideLoading(); return }
      body = { action: 'changeRoom', fromRoomId: prefilledRoom.value.roomId, toRoomId: changeTargetId.value, reason: changeReason.value || undefined }
    } else {
      body = {
        action: isCheckIn.value ? 'checkIn' : isBook.value ? 'book' : 'create',
        roomId: prefilledRoom.value.roomId,
        guestName: f.guestName.trim(),
        guestPhone: f.guestPhone.trim(),
        checkInDate: f.checkInDate,
        checkOutDate: f.checkOutDate,
        source: f.source,
        paymentMethod: f.paymentMethod,
        remark: f.remark.trim() || undefined,
      }
    }

    if (isCheckIn.value) {
      if (f.guestIdCard.trim()) body.guestIdCard = f.guestIdCard.trim()
      body.deposit = Number(f.deposit) || 0
      body.guestCount = Number(f.guestCount) || 1
      body.paymentStatus = f.paymentStatus
      body.amountPaid = Number(f.amountPaid) || 0
    } else if (isBook.value) {
      body.roomId = prefilledRoom.value.roomId
    } else if (!isCheckOut.value) {
      // 新建订单：从 picker 取房间和金额
      body.roomId = prefilledRoom.value.roomId
      body.roomNumber = prefilledRoom.value.roomNumber
      body.roomTypeId = prefilledRoom.value.roomTypeId
      body.roomType = prefilledRoom.value.roomTypeName
      body.channel = form.value.source
      if (prefilledRoom.value.roomPrice) body.amount = Number(prefilledRoom.value.roomPrice) || undefined
    }

    const apiUrl = isCheckIn.value || isBook.value || isCheckOut.value || isExtend.value || isChange.value ? '/api/rooms' : '/api/orders'
    const result = await post<any>(apiUrl, body, { showLoading: false })
    // 兼容 response.data 解包：checkOut 返回 { success: true, data: {...} }，解包后 data 无 success 字段
    const ok = result.success !== false && !result.error
    if (ok) {
      resultOrderNo.value = result.orderNo || result.data?.orderNo || result.message || ''
      showSuccess.value = true
    } else {
      uni.showToast({ title: result.error || result.message || '提交失败', icon: 'none' })
    }
  } catch (e: any) {
    uni.showToast({ title: e?.message || e?.error || '提交失败', icon: 'none' })
  } finally {
    submitting.value = false
    uni.hideLoading()
  }
}

async function goBack() {
  // 房态相关操作后刷新数据
  if (isCheckIn.value || isCheckOut.value || isExtend.value || isBook.value || isChange.value) {
    try { await useRoomsStore().fetchDailyData() } catch {}
  }
  uni.navigateBack()
}

onMounted(async () => {
  if (isChange.value) {
    // 换房模式：加载可用房间
    try { const r = await getDailyRooms(todayStr); availableRooms.value = (r as any)?.rooms || [] } catch {}
  }
  if (!isFromRoom.value) {
    try {
      const r = await getDailyRooms(todayStr)
      const rooms = (r as any)?.rooms || []
      const m = new Map<string, any>()
      rooms.forEach((rm: any) => {
        const tid = rm.roomTypeId; if (!tid) return
        if (!m.has(tid)) m.set(tid, { id: tid, name: rm.roomTypeName, rooms: [] })
        m.get(tid).rooms.push({ id: rm.id, name: rm.roomNumber })
      })
      roomTypes.value = Array.from(m.values())
    } catch {}
  }
})
</script>

<template>
  <view class="page">
    <template v-if="showSuccess">
      <view class="success-box">
        <text class="s-icon">✅</text>
        <text class="s-title">操作成功</text>
        <text v-if="resultOrderNo" class="s-no">{{ resultOrderNo }}</text>
        <view class="s-btn" @click="goBack"><text>返回</text></view>
      </view>
    </template>

    <template v-else>
      <scroll-view class="scroll" scroll-y>
        <!-- 房间信息（从房态跳转） -->
        <view v-if="isFromRoom" class="card">
          <view class="card-title">{{ isCheckOut ? '退房结算' : isChange ? '换房' : '房间信息' }}</view>
          <view v-if="isChange && prefilledRoom.guestName" class="guest-info-bar">
            <text class="change-hint">👤 {{ prefilledRoom.guestName }} · 从 {{ prefilledRoom.roomNumber }} 换到</text>
          </view>
          <!-- 退房模式：显示客人信息 -->
          <view v-if="isCheckOut && prefilledRoom.guestName" class="guest-info-bar">
            <view class="gir"><text class="gil">客人</text><text class="giv">{{ prefilledRoom.guestName }}</text></view>
            <view class="gir"><text class="gil">房间</text><text class="giv">{{ prefilledRoom.roomNumber }}</text></view>
            <view v-if="prefilledRoom.guestCheckIn" class="gir"><text class="gil">入住</text><text class="giv">{{ prefilledRoom.guestCheckIn }}</text></view>
            <view v-if="prefilledRoom.guestCheckOut" class="gir"><text class="gil">离店</text><text class="giv">{{ prefilledRoom.guestCheckOut }}</text></view>
          </view>
          <view class="room-prefill">
            <view class="rp-r"><text class="rp-l">{{ prefilledRoom.roomTypeName }}</text><text class="rp-v">房号 {{ prefilledRoom.roomNumber }}</text></view>
            <view class="rp-r"><text class="rp-l">¥{{ prefilledRoom.roomPrice }}/晚</text><text class="rp-v">{{ prefilledRoom.roomFloor }}楼</text></view>
          </view>
        </view>

        <!-- 客人信息（退房模式隐藏） -->
        <view v-if="!isCheckOut && !isExtend && !isChange" class="card">
          <view class="card-title">客人信息</view>
          <view class="fi"><text class="fl">姓名</text><text class="fstar">*</text><input v-model="form.guestName" class="fin" placeholder="请输入姓名" /></view>
          <view class="fi"><text class="fl">手机号</text><text class="fstar">*</text><input v-model="form.guestPhone" class="fin" type="number" placeholder="请输入手机号" maxlength="11" /></view>
          <view class="fi"><text class="fl">身份证号</text><input v-model="form.guestIdCard" class="fin" placeholder="选填" maxlength="18" /></view>
        </view>

        <!-- 入住信息（退房模式隐藏） -->
        <view v-if="!isCheckOut && !isExtend" class="card">
          <view class="card-title">入住信息</view>
          <view class="fi">
            <text class="fl">入店日期</text><text class="fstar">*</text>
            <picker mode="date" :value="form.checkInDate" :start="todayStr" @change="(e: any) => form.checkInDate = e.detail.value">
              <text :class="['fv', { empty: !form.checkInDate }]">{{ form.checkInDate || '请选择' }}</text>
            </picker>
          </view>
          <view class="fi">
            <text class="fl">离店日期</text><text class="fstar">*</text>
            <picker mode="date" :value="form.checkOutDate" :start="form.checkInDate || todayStr" @change="(e: any) => form.checkOutDate = e.detail.value">
              <text :class="['fv', { empty: !form.checkOutDate }]">{{ form.checkOutDate || '请选择' }}</text>
            </picker>
          </view>
          <view v-if="isCheckIn" class="fi">
            <text class="fl">入住人数</text>
            <input v-model.number="form.guestCount" class="fin" type="number" placeholder="1" />
          </view>
        </view>

        <!-- 退房结算（退房模式） -->
        <view v-if="isCheckOut" class="card">
          <view class="card-title">费用明细</view>
          <view class="checkout-row">
            <text class="co-label">房费</text>
            <text class="co-val">¥{{ prefilledRoom.roomPrice || 0 }} × {{ checkoutNights }}晚 = ¥{{ checkoutRoomFee }}</text>
          </view>
          <view class="checkout-row">
            <text class="co-label">押金</text>
            <input v-model.number="form.deposit" class="co-input" type="digit" placeholder="0" />
          </view>
          <view class="checkout-row">
            <text class="co-label">其他消费</text>
            <input v-model.number="form.amountPaid" class="co-input" type="digit" placeholder="0" />
          </view>
          <view class="checkout-total">
            <text class="co-label">应退押金</text>
            <text class="co-val co-refund">¥{{ Math.max(0, Number(form.deposit || 0) - Number(form.amountPaid || 0)) }}</text>
          </view>
          <view class="fi" style="margin-top:16rpx;">
            <text class="fl">退款方式</text>
            <picker :range="paymentMethodOpts" @change="(e: any) => form.paymentMethod = paymentMethodOpts[e.detail.value]">
              <text class="fv">{{ form.paymentMethod }}</text>
            </picker>
          </view>
        </view>

        <!-- 续住（续住模式） -->
        <view v-if="isExtend" class="card">
          <view class="card-title">续住信息</view>
          <view class="checkout-row"><text class="co-label">当前离店</text><text class="co-val">{{ currentCheckOut }}</text></view>
          <view class="checkout-row"><text class="co-label">每晚房价</text><text class="co-val">¥{{ prefilledRoom.roomPrice || 0 }}</text></view>
          <!-- 快捷天数 -->
          <view class="quick-days">
            <view v-for="n in [1,2,3,5,7]" :key="n" :class="['qd-btn', { on: extendNights === n }]" @click="() => { const d = new Date(currentCheckOut); d.setDate(d.getDate() + n); extendNewDate = d.toISOString().split('T')[0] }">
              <text>+{{ n }}晚</text>
            </view>
          </view>
          <view class="checkout-row"><text class="co-label">新离店日期</text>
            <picker mode="date" :value="extendNewDate" :start="currentCheckOut" @change="(e: any) => extendNewDate = e.detail.value">
              <text :class="['fv', { empty: !extendNewDate }]">{{ extendNewDate || '请选择' }}</text>
            </picker>
          </view>
          <view class="checkout-row"><text class="co-label">续住天数</text><text class="co-val co-refund">{{ extendNights }}晚</text></view>
          <view class="checkout-row"><text class="co-label">续住费用</text><text class="co-val co-refund">¥{{ extendAmount }}</text></view>
        </view>

        <!-- 换房（换房模式） -->
        <template v-if="isChange">
          <view class="card">
            <view class="card-title">选择目标房间</view>
            <template v-if="availableRoomGroups.length === 0">
              <text class="empty-hint">无空闲房间可换</text>
            </template>
            <view v-for="g in availableRoomGroups" :key="g.label" class="change-group">
              <text class="change-group-label">{{ g.label }}（{{ g.rooms.length }}间）</text>
              <view class="change-room-grid">
                <view v-for="r in g.rooms" :key="r.id"
                  :class="['change-room', { selected: changeTargetId === r.id }]"
                  @click="changeTargetId = r.id">
                  <text class="cr-no">{{ r.roomNumber }}</text>
                  <text class="cr-price">¥{{ r.price }}</text>
                </view>
              </view>
            </view>
          </view>

          <view class="card">
            <view class="card-title">换房原因</view>
            <input v-model="changeReason" class="fin" style="text-align:left;width:100%;height:44rpx;" placeholder="如：客人要求换房、设备故障等" />
          </view>

          <view class="card" style="background:rgba(87,107,149,0.06);">
            <text style="font-size:24rpx;color:#576B95;">💡 换房后原房间将变为"脏房"状态，需清洁后方可再次入住</text>
          </view>
        </template>

        <!-- 收款信息（录单模式） -->
        <view v-if="isCheckIn" class="card">
          <view class="card-title">收款信息</view>
          <view class="fi">
            <text class="fl">押金</text>
            <input v-model.number="form.deposit" class="fin" type="digit" placeholder="0" />
          </view>
          <view class="fi">
            <text class="fl">收款状态</text>
            <view class="tags">
              <view v-for="s in paymentStatusOpts" :key="s" :class="['tag', { on: form.paymentStatus === s }]" @click="form.paymentStatus = s">
                <text>{{ paymentStatusLabels[s] }}</text>
              </view>
            </view>
          </view>
          <view class="fi">
            <text class="fl">收款金额</text>
            <input v-model.number="form.amountPaid" class="fin" type="digit" placeholder="0" />
          </view>
          <view class="fi">
            <text class="fl">收款方式</text>
            <view class="tags">
              <view v-for="m in paymentMethodOpts" :key="m" :class="['tag', { on: form.paymentMethod === m }]" @click="form.paymentMethod = m">
                <text>{{ m }}</text>
              </view>
            </view>
          </view>
        </view>

        <!-- 新建订单模式 — 房间选择 + 订单信息 -->
        <template v-if="!isCheckIn && !isBook">
          <view class="card">
            <view class="card-title">房间信息</view>
            <view class="fi">
              <text class="fl">房型</text><text class="fstar">*</text>
              <picker :range="roomTypes.map(t => t.name)" @change="(e: any) => { const t = roomTypes[e.detail.value]; if (t) { prefilledRoom.value.roomTypeId = t.id; prefilledRoom.value.roomTypeName = t.name; prefilledRoom.value.roomId = ''; prefilledRoom.value.roomNumber = '' } }">
                <text :class="['fv', { empty: !prefilledRoom.roomTypeId }]">{{ prefilledRoom.roomTypeName || (roomTypes.length ? '请选择房型' : '加载中...') }}</text>
              </picker>
            </view>
            <view class="fi">
              <text class="fl">房间号</text>
              <picker :range="(roomTypes.find(t => t.id === prefilledRoom.roomTypeId)?.rooms || []).map((r: any) => r.name)" @change="(e: any) => { const rooms = roomTypes.find(t => t.id === prefilledRoom.roomTypeId)?.rooms || []; const r = rooms[e.detail.value]; if (r) { prefilledRoom.value.roomId = r.id; prefilledRoom.value.roomNumber = r.name } }">
                <text :class="['fv', { empty: !prefilledRoom.roomId }]">{{ prefilledRoom.roomNumber || '请选择房间（可选）' }}</text>
              </picker>
            </view>
          </view>

          <view class="card">
            <view class="card-title">订单信息</view>
            <view class="fi">
              <text class="fl">预订渠道</text>
              <picker :range="channelOpts" @change="(e: any) => form.source = channelOpts[e.detail.value]">
                <text class="fv">{{ form.source }}</text>
              </picker>
            </view>
            <view class="fi">
              <text class="fl">房价</text>
              <input v-model="prefilledRoom.roomPrice" class="fin" type="digit" placeholder="0" />
            </view>
            <view class="fi">
              <text class="fl">支付方式</text>
              <picker :range="paymentMethodOpts" @change="(e: any) => form.paymentMethod = paymentMethodOpts[e.detail.value]">
                <text class="fv">{{ form.paymentMethod }}</text>
              </picker>
            </view>
          </view>
        </template>

        <!-- 备注（退房模式隐藏） -->
        <view v-if="!isCheckOut" class="card">
          <view class="card-title">备注</view>
          <textarea v-model="form.remark" class="ta" placeholder="选填" maxlength="200" />
        </view>

        <view class="ph" />
      </scroll-view>

      <!-- 提交 -->
      <view class="bar">
        <view class="btn" :class="{ loading: submitting }" @click="handleSubmit">
          <text>{{ submitting ? '提交中...' : isCheckIn ? '确认入住' : isChange ? '确认换房' : isExtend ? '确认续住' : isCheckOut ? '确认退房' : isBook ? '确认预订' : '创建订单' }}</text>
        </view>
      </view>
    </template>
  </view>
</template>

<style lang="scss" scoped>
.page { min-height: 100vh; background: #F5F6FA; display: flex; flex-direction: column; }
.scroll { flex: 1; height: 0; padding: 24rpx; }
.card { background: #fff; border-radius: 24rpx; padding: 24rpx; margin-bottom: 16rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.card-title { font-size: 28rpx; font-weight: 600; color: #191919; margin-bottom: 16rpx; }
.fi { display: flex; align-items: center; padding: 16rpx 0; border-bottom: 1rpx solid #F5F6FA; }
.fi:last-child { border-bottom: none; }
.fl { font-size: 26rpx; color: #191919; width: 130rpx; flex-shrink: 0; }
.fstar { color: #FA5151; font-size: 26rpx; margin-left: -8rpx; margin-right: 8rpx; }
.fin { flex: 1; font-size: 26rpx; color: #191919; text-align: right; height: 44rpx; }
.fv { flex: 1; font-size: 26rpx; color: #191919; text-align: right; }
.fv.empty { color: #ccc; }

/* room prefill */
.room-prefill { background: rgba(7,193,96,0.05); border-radius: 16rpx; padding: 16rpx 20rpx; }
.rp-r { display: flex; justify-content: space-between; padding: 10rpx 0; border-bottom: 1rpx solid rgba(0,0,0,0.04); }
.rp-r:last-child { border-bottom: none; }
.rp-l { font-size: 26rpx; color: #191919; font-weight: 500; }
.rp-v { font-size: 24rpx; color: #888; }

/* guest info bar */
.guest-info-bar { background: rgba(7,193,96,0.05); border-radius: 16rpx; padding: 16rpx 20rpx; margin-bottom: 16rpx; }
.gir { display: flex; align-items: center; padding: 8rpx 0; border-bottom: 1rpx solid rgba(0,0,0,0.04); }
.gir:last-child { border-bottom: none; }
.gil { font-size: 24rpx; color: #888; width: 80rpx; }
.giv { font-size: 26rpx; font-weight: 500; color: #191919; }
.change-hint { font-size: 26rpx; color: #576B95; }

/* checkout */
.checkout-row { display: flex; align-items: center; justify-content: space-between; padding: 16rpx 0; border-bottom: 1rpx solid #F5F6FA; }
.checkout-total { display: flex; align-items: center; justify-content: space-between; padding: 16rpx 0; margin-top: 8rpx; border-top: 2rpx solid #EDEDED; }
.co-label { font-size: 26rpx; color: #191919; }
.co-val { font-size: 26rpx; color: #191919; font-weight: 500; }
.co-refund { color: #07C160; font-size: 30rpx; font-weight: 700; }

/* quick extend days */
.quick-days { display: flex; gap: 12rpx; padding: 16rpx 0; }
.qd-btn { padding: 10rpx 24rpx; border-radius: 20rpx; border: 2rpx solid #EDEDED; font-size: 24rpx; color: #666; }
.qd-btn.on { border-color: #07C160; background: rgba(7,193,96,0.06); color: #07C160; font-weight: 500; }

/* change room */
.change-group { margin-bottom: 20rpx; }
.change-group-label { font-size: 24rpx; color: #888; margin-bottom: 10rpx; display: block; }
.change-room-grid { display: flex; flex-wrap: wrap; gap: 10rpx; }
.change-room { width: calc(25% - 8rpx); padding: 16rpx 8rpx; border-radius: 14rpx; border: 2rpx solid #EDEDED; text-align: center; }
.change-room.selected { border-color: #576B95; background: rgba(87,107,149,0.08); }
.cr-no { font-size: 26rpx; font-weight: 700; color: #191919; display: block; }
.cr-price { font-size: 20rpx; color: #07C160; display: block; margin-top: 4rpx; }
.empty-hint { font-size: 26rpx; color: #ccc; display: block; text-align: center; padding: 40rpx 0; }
.change-room .fin { text-align: left; }
.co-input { width: 200rpx; font-size: 26rpx; color: #191919; text-align: right; height: 44rpx; }

/* tags */
.tags { flex: 1; display: flex; flex-wrap: wrap; gap: 10rpx; justify-content: flex-end; }
.tag { padding: 8rpx 18rpx; border-radius: 16rpx; background: #F5F6FA; font-size: 24rpx; color: #666; }
.tag.on { background: rgba(7,193,96,0.1); color: #07C160; font-weight: 500; }
.ta { width: 100%; min-height: 80rpx; font-size: 26rpx; color: #191919; padding: 8rpx 0; box-sizing: border-box; }

/* submit */
.ph { height: 120rpx; }
.bar { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; padding: 16rpx 24rpx; padding-bottom: calc(16rpx + env(safe-area-inset-bottom)); box-shadow: 0 -4rpx 16rpx rgba(0,0,0,0.06); z-index: 100; }
.btn { width: 100%; height: 88rpx; background: #07C160; border-radius: 44rpx; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 30rpx; font-weight: 600; }
.btn.loading { opacity: 0.7; }

/* success */
.success-box { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16rpx; background: #fff; margin: 48rpx; border-radius: 24rpx; padding: 80rpx 48rpx; }
.s-icon { font-size: 80rpx; }
.s-title { font-size: 32rpx; font-weight: 600; color: #191919; }
.s-no { font-size: 24rpx; color: #888; background: #F5F6FA; padding: 8rpx 24rpx; border-radius: 8rpx; }
.s-btn { width: 100%; height: 80rpx; background: #07C160; border-radius: 40rpx; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 28rpx; margin-top: 24rpx; }
</style>
