<script setup lang="ts">
import { ref, nextTick } from 'vue'

interface Msg { role: 'user'|'assistant', content: string }

const messages = ref<Msg[]>([{ role: 'assistant', content: '你好！有什么可以帮助你的？' }])
const inputText = ref('')
const loading = ref(false)
const showChat = ref(false)

const categories = [
  { icon: '🏨', label: '房态管理', questions: ['如何办理入住？', '如何退房？', '续住怎么操作？', '如何换房？'] },
  { icon: '📋', label: '订单管理', questions: ['如何创建订单？', '订单怎么查看？'] },
  { icon: '👥', label: '人员管理', questions: ['如何新增员工？', '员工怎么编辑？'] },
  { icon: '💰', label: '价格房型', questions: ['如何修改价格？', '房型怎么管理？'] },
]

const quickAnswers: Record<string,string> = {
  '如何办理入住？': '1. 进入"房态"页面\n2. 点击空闲房间\n3. 选择"录单入住"\n4. 填写客人信息（姓名、手机号、日期等）\n5. 确认入住',
  '如何创建订单？': '1. 进入"订单"页面\n2. 点击右下角 ＋ 号\n3. 选择房型和房间号\n4. 填写客人姓名、手机号\n5. 选择入住/离店日期\n6. 点击"创建订单"',
  '如何新增员工？': '1. 进入"我的"→"员工管理"\n2. 点击底部"添加员工"\n3. 填写姓名、手机号\n4. 选择角色和管辖门店\n5. 点击保存',
  '如何退房？': '1. 进入"房态"页面\n2. 点击在住房间\n3. 选择"退房"\n4. 核对费用明细\n5. 确认退房',
  '续住怎么操作？': '1. 房态→点击在住房间\n2. 选择"续住"\n3. 选择新离店日期（快捷按钮+1/+2/+3晚）\n4. 确认续住',
  '如何换房？': '1. 房态→点击在住房间\n2. 选择"换房"\n3. 选择目标房间\n4. 填写换房原因\n5. 确认换房',
  '如何修改价格？': '1. 进入"我的"→"价格管理"\n2. 查看各房型当前价格\n3. 点击要修改的房型\n4. 修改价格后点击保存',
  '房型怎么管理？': '1. 进入"我的"→"房型管理"\n2. 查看房型列表\n3. 点击编辑可修改房型信息\n4. 展开可管理该房型下的房间',
  '订单怎么查看？': '1. 进入"订单"页面\n2. "全部订单"可筛选和搜索\n3. "渠道待确认"可查看OTA待处理订单\n4. 点击订单卡片查看详情',
  '员工怎么编辑？': '1. 进入"员工管理"\n2. 点击员工卡片直接编辑\n3. 长按可禁用账号或重置密码',
}

const HELP_PROMPT = '你是述椿云宿PMS平台的智能客服助手。请用友好的语气回答平台使用问题，不要访问任何业务数据。如果问题超出范围，建议联系客服。'

async function askQuestion(q: string) {
  showChat.value = true
  messages.value = [{ role: 'assistant', content: '你好！有什么可以帮助你的？' }]
  const a = quickAnswers[q]
  if (a) {
    messages.value.push({ role: 'user', content: q })
    messages.value.push({ role: 'assistant', content: a })
    return
  }
  inputText.value = q
  handleSend()
}

async function handleSend() {
  const t = inputText.value.trim()
  if (!t || loading.value) return
  inputText.value = ''
  messages.value.push({ role: 'user', content: t })
  loading.value = true
  await nextTick()

  // 模糊匹配快捷答案
  for (const [q, a] of Object.entries(quickAnswers)) {
    if (t.includes(q.replace(/[？?如何]/g, '').slice(0,4)) || q.includes(t.slice(0,4))) {
      messages.value.push({ role: 'assistant', content: a })
      loading.value = false; return
    }
  }

  const aiMsg: Msg = { role: 'assistant', content: '' }
  messages.value.push(aiMsg)
  try {
    const res: any = await uni.request({
      url: 'http://132.232.166.40:20002/api/ai/chat/stream', method: 'POST',
      header: { 'Content-Type': 'application/json', Authorization: `Bearer ${uni.getStorageSync('token')}` },
      data: { messages: [{ role: 'system', content: HELP_PROMPT }, ...messages.value.filter(m => m !== aiMsg).map(m => ({ role: m.role, content: m.content }))] },
    })
    const d = res.data as any
    aiMsg.content = d?.content || d?.data?.content || d?.message || '抱歉，请稍后重试'
  } catch { aiMsg.content = '网络错误，请稍后重试' }
  loading.value = false
}

function goBack() { showChat.value = false }
</script>

<template>
  <view class="page">
    <!-- 首页：分类帮助 -->
    <view v-if="!showChat" class="home">
      <!-- 搜索入口 -->
      <view class="search-bar">
        <text class="search-icon">🔍</text>
        <input v-model="inputText" class="search-inp" placeholder="输入问题，快速查找答案" confirm-type="search" @confirm="handleSend" />
        <view class="search-btn" @tap="handleSend" v-if="inputText.trim()"><text>提问</text></view>
      </view>

      <!-- 分类卡片 -->
      <view class="cat-list">
        <view v-for="cat in categories" :key="cat.label" class="cat-card">
          <view class="cat-head">
            <text class="cat-icon">{{ cat.icon }}</text>
            <text class="cat-title">{{ cat.label }}</text>
          </view>
          <view class="cat-qs">
            <view v-for="q in cat.questions" :key="q" class="cat-q" @tap="askQuestion(q)"><text>{{ q }}</text></view>
          </view>
        </view>
      </view>

      <!-- 底部信息 -->
      <view class="home-footer">
        <text>未能解决您的问题？</text>
        <text class="footer-link">联系我们：714284292@qq.com</text>
      </view>
    </view>

    <!-- 聊天页 -->
    <view v-else class="chat-page">
      <view class="chat-header" @tap="goBack">
        <text class="back-icon">←</text>
        <text class="chat-title">帮助中心</text>
        <text class="new-btn" @tap.stop="messages=[{role:'assistant', content:'你好！有什么可以帮助你的？'}]">新对话</text>
      </view>
      <scroll-view class="chat-body" scroll-y :scroll-into-view="'msg-'+(messages.length-1)">
        <view v-for="(m,i) in messages" :key="i" :id="'msg-'+i" :class="['msg', m.role]">
          <text class="bubble">{{ m.content }}</text>
        </view>
        <view v-if="loading" class="msg assistant"><text class="bubble typing">...</text></view>
      </scroll-view>
    </view>

    <!-- 底部输入框（固定浮动） -->
    <view class="bottom-bar" v-if="showChat">
      <input v-model="inputText" class="bar-inp" placeholder="输入问题..." confirm-type="send" @confirm="handleSend" :disabled="loading" />
      <view :class="['bar-send', { on: inputText.trim() }]" @tap="handleSend"><text>发送</text></view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.page { height: 100vh; background: #F5F6FA; display: flex; flex-direction: column; }

/* ====== 首页 ====== */
.home { flex: 1; overflow-y: auto; }
.search-bar { display: flex; align-items: center; gap: 12rpx; padding: 24rpx; background: #fff; }
.search-icon { font-size: 32rpx; }
.search-inp { flex: 1; height: 72rpx; padding: 0 24rpx; background: #F5F6FA; border-radius: 36rpx; font-size: 26rpx; }
.search-btn { padding: 12rpx 24rpx; background: #07C160; border-radius: 32rpx; }
.search-btn text { font-size: 26rpx; color: #fff; }

.cat-list { padding: 20rpx 24rpx; }
.cat-card { background: #fff; border-radius: 24rpx; padding: 24rpx; margin-bottom: 16rpx; box-shadow: 0 2rpx 12rpx rgba(0,0,0,0.04); }
.cat-head { display: flex; align-items: center; gap: 12rpx; margin-bottom: 16rpx; }
.cat-icon { font-size: 36rpx; }
.cat-title { font-size: 30rpx; font-weight: 600; color: #191919; }
.cat-qs { display: flex; flex-wrap: wrap; gap: 10rpx; }
.cat-q { padding: 12rpx 20rpx; border-radius: 20rpx; background: #F5F6FA; font-size: 24rpx; color: #666; }
.cat-q:active { background: rgba(7,193,96,0.08); color: #07C160; }

.home-footer { text-align: center; padding: 32rpx 0 48rpx; }
.home-footer text { display: block; font-size: 24rpx; color: #888; }
.footer-link { color: #576B95; margin-top: 8rpx; }

/* ====== 聊天页 ====== */
.chat-page { flex: 1; display: flex; flex-direction: column; }
.chat-header { display: flex; align-items: center; justify-content: space-between; padding: 16rpx 24rpx; background: #fff; border-bottom: 1rpx solid #EDEDED; }
.back-icon { font-size: 32rpx; color: #191919; padding: 8rpx; }
.chat-title { font-size: 30rpx; font-weight: 600; color: #191919; }
.new-btn { font-size: 24rpx; color: #07C160; }
.chat-body { flex: 1; padding: 24rpx; overflow-y: auto; }
.msg { margin-bottom: 24rpx; display: flex; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 80%; padding: 20rpx 24rpx; border-radius: 24rpx; font-size: 28rpx; line-height: 1.6; white-space: pre-wrap; }
.user .bubble { background: #07C160; color: #fff; border-bottom-right-radius: 8rpx; }
.assistant .bubble { background: #fff; color: #191919; border-bottom-left-radius: 8rpx; box-shadow: 0 2rpx 8rpx rgba(0,0,0,0.04); }
.typing { color: #888; }

/* ====== 底部输入 ====== */
.bottom-bar { display: flex; align-items: center; gap: 12rpx; padding: 16rpx 24rpx; background: #fff; border-top: 1rpx solid #EDEDED; flex-shrink: 0; }
.bar-inp { flex: 1; height: 72rpx; padding: 0 24rpx; background: #F5F6FA; border-radius: 36rpx; font-size: 26rpx; }
.bar-send { padding: 12rpx 24rpx; border-radius: 32rpx; background: #EDEDED; font-size: 26rpx; color: #999; }
.bar-send.on { background: #07C160; color: #fff; }
</style>
