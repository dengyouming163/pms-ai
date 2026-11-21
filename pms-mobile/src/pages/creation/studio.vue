<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import { get, post } from '@/api/request'

/* ===================================================================
 * 创作中心 Studio — AI 对话 + 热点 → 生成分镜方案 → 保存
 * =================================================================== */

// ========== 类型定义 ==========

/** 热点话题 */
interface HotTopic {
  id: string
  label: string
  icon?: string
  prompt?: string
}

/** 聊天消息 */
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 从 AI 响应中解析出的分镜方案 */
  plan?: ShotPlan | null
  /** 是否正在流式生成中 */
  streaming?: boolean
  createdAt: number
}

/** 分镜方案 */
interface ShotPlan {
  title: string
  shots: ShotItem[]
}

/** 分镜条目 */
interface ShotItem {
  index: number
  label: string
  script: string
  duration: number
}

/** 已保存的创作记录 */
interface CreationRecord {
  id: string
  title: string
  script?: string
  tags?: string[]
  createdAt?: string
}

// ========== 热点话题 ==========
const hotTopics = ref<HotTopic[]>([])
const topicsLoading = ref(false)

/** 加载今日热点话题 */
async function loadHotTopics() {
  topicsLoading.value = true
  try {
    const data = await get<HotTopic[]>('/api/hot-topics/today')
    hotTopics.value = data || []
  } catch {
    hotTopics.value = []
  } finally {
    topicsLoading.value = false
  }
}

/** 点击热点话题 → 填入输入框并触发 AI 生成 */
function handleTopicTap(topic: HotTopic) {
  const prompt = topic.prompt || `请为「${topic.label}」创作一个分镜脚本方案`
  inputText.value = prompt
  handleSend()
}

// ========== 聊天区域 ==========
const chatAreaRef = ref<any>(null)
const messages = ref<ChatMessage[]>([])
const sseAbortController = ref<AbortController | null>(null)
const isStreaming = ref(false)

/** 生成唯一 ID */
function genId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 滚动到聊天底部 */
async function scrollToBottom() {
  await nextTick()
  // #ifdef H5
  const container = document.querySelector('.chat-area')
  if (container) {
    container.scrollTop = container.scrollHeight
  }
  // #endif
  // #ifdef MP-WEIXIN
  uni.createSelectorQuery()
    .select('.chat-area')
    .boundingClientRect()
    .exec((res) => {
      if (res[0]) {
        uni.pageScrollTo({ scrollTop: res[0].height, duration: 200 })
      }
    })
  // #endif
}

/** 构建 AI 系统提示词 */
function buildSystemPrompt(): string {
  return `你是一个专业的短视频分镜脚本创作助手。请根据用户的需求，生成一个完整的分镜脚本方案。

你必须严格按照以下 JSON 格式输出，放在 \`\`\`json 代码块中：

\`\`\`json
{
  "title": "视频标题",
  "shots": [
    { "index": 1, "label": "镜头名称", "script": "镜头脚本内容描述", "duration": 5 },
    { "index": 2, "label": "镜头名称", "script": "镜头脚本内容描述", "duration": 3 }
  ]
}
\`\`\`

注意事项：
1. 每个分镜的 duration 单位是秒，建议 3-8 秒之间
2. 分镜数量建议 3-8 个
3. script 字段要详细描述画面内容、运镜方式、人物动作等
4. label 字段用简短中文描述镜头名称
5. 除了 JSON 代码块外，你可以在前后添加一些友好的说明文字`
}

/** 发送消息 & SSE 流式获取 AI 回复 */
async function handleSend() {
  const text = inputText.value.trim()
  if (!text || isStreaming.value) return

  // 添加用户消息
  const userMsg: ChatMessage = {
    id: genId(),
    role: 'user',
    content: text,
    createdAt: Date.now(),
  }
  messages.value.push(userMsg)
  inputText.value = ''
  await scrollToBottom()

  // 添加 AI 占位消息（流式填充）
  const aiMsg: ChatMessage = {
    id: genId(),
    role: 'assistant',
    content: '',
    streaming: true,
    createdAt: Date.now(),
  }
  messages.value.push(aiMsg)
  await scrollToBottom()

  // 构建消息历史（最近的 10 条）
  const history = messages.value
    .filter((m) => !m.streaming && m.role !== 'system')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content }))

  const chatMessages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
  ]

  // 发起 SSE 请求
  isStreaming.value = true
  const controller = new AbortController()
  sseAbortController.value = controller

  try {
    const token = uni.getStorageSync('token') || ''
    const storeId =
      uni.getStorageSync('currentStore')?.id ||
      uni.getStorageSync('storeId') ||
      ''

    const response = await fetch('/api/ai/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
        'X-Store-Id': String(storeId),
      },
      body: JSON.stringify({ messages: chatMessages }),
      signal: controller.signal,
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
            // 拼接内容增量
            if (json.content) {
              aiMsg.content += json.content
              await scrollToBottom()
            }
            // 完整结果直接替换
            if (json.done && json.fullContent) {
              aiMsg.content = json.fullContent
            }
          } catch {
            // 跳过解析失败的行
          }
        }
      }
    }

    // SSE 流结束，解析分镜方案
    aiMsg.streaming = false
    aiMsg.plan = parseShotPlan(aiMsg.content)
    await scrollToBottom()
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      // 用户主动取消
      aiMsg.content = aiMsg.content || '[已取消]'
    } else {
      aiMsg.content = aiMsg.content || `[网络错误] ${e?.message || '请重试'}`
    }
    aiMsg.streaming = false
  } finally {
    isStreaming.value = false
    sseAbortController.value = null
  }
}

/** 从 AI 回复文本中解析分镜方案 JSON */
function parseShotPlan(text: string): ShotPlan | null {
  // 尝试匹配 ```json ... ``` 代码块
  const jsonBlockRegex = /```json\s*\n?([\s\S]*?)\n?```/
  const match = text.match(jsonBlockRegex)

  if (match) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && parsed.title && Array.isArray(parsed.shots)) {
        // 验证 shots 结构
        const shots: ShotItem[] = parsed.shots.map((s: any, idx: number) => ({
          index: s.index ?? idx + 1,
          label: s.label || `镜头${idx + 1}`,
          script: s.script || '',
          duration: s.duration || 5,
        }))
        return { title: parsed.title, shots }
      }
    } catch {
      // JSON 解析失败，返回 null
    }
  }

  // 尝试直接匹配整个 JSON 对象
  const jsonRegex = /\{[\s\S]*"title"[\s\S]*"shots"[\s\S]*\}/
  const directMatch = text.match(jsonRegex)
  if (directMatch) {
    try {
      const parsed = JSON.parse(directMatch[0])
      if (parsed && parsed.title && Array.isArray(parsed.shots)) {
        const shots: ShotItem[] = parsed.shots.map((s: any, idx: number) => ({
          index: s.index ?? idx + 1,
          label: s.label || `镜头${idx + 1}`,
          script: s.script || '',
          duration: s.duration || 5,
        }))
        return { title: parsed.title, shots }
      }
    } catch {
      // 解析失败
    }
  }

  return null
}

/** 停止生成 */
function handleStopStreaming() {
  if (sseAbortController.value) {
    sseAbortController.value.abort()
    sseAbortController.value = null
  }
}

// ========== 输入区域 ==========
const inputText = ref('')

// ========== 保存方案 & 后续操作 ==========
const saving = ref(false)
/** 已保存的方案列表 */
const savedPlans = ref<CreationRecord[]>([])

/** 保存当前分镜方案到服务端 */
async function handleSavePlan(plan: ShotPlan) {
  saving.value = true
  try {
    await post('/api/creation-records', {
      type: 'copy',
      title: plan.title,
      script: JSON.stringify(plan),
      tags: plan.shots.map((s) => s.label),
      titles: plan.shots.map((s) => s.label),
    })
    uni.showToast({ title: '方案已保存', icon: 'success' })
    await loadSavedPlans()
  } catch (e: any) {
    uni.showToast({
      title: e?.msg || e?.message || '保存失败',
      icon: 'none',
    })
  } finally {
    saving.value = false
  }
}

/** 加载已保存的方案 */
async function loadSavedPlans() {
  try {
    const data: any = await get('/api/creation-records', {
      type: 'copy',
      limit: 50,
    })
    savedPlans.value = data?.list || data?.data || data || []
  } catch {
    savedPlans.value = []
  }
}

/** 删除已保存方案 */
async function handleDeletePlan(id: string) {
  uni.showModal({
    title: '确认删除',
    content: '确定要删除这个分镜方案吗？',
    success: async (res) => {
      if (res.confirm) {
        try {
          await (await import('@/api/request')).del(`/api/creation-records/${id}`)
          uni.showToast({ title: '已删除', icon: 'success' })
          await loadSavedPlans()
        } catch {
          uni.showToast({ title: '删除失败', icon: 'none' })
        }
      }
    },
  })
}

/** 跳转到一键成片 */
function handleGoOneshot(plan?: CreationRecord) {
  const url = plan ? `/pages/creation/oneshot?planId=${plan.id}` : '/pages/creation/oneshot'
  uni.navigateTo({ url })
}

/** 跳转到数字人口播 */
function handleGoDigitalHuman(plan?: CreationRecord) {
  const url = plan
    ? `/pages/creation/digital-human?planId=${plan.id}`
    : '/pages/creation/digital-human'
  uni.navigateTo({ url })
}

/** 是否有方案可操作（最新 AI 生成或已保存） */
const hasActivePlan = computed(() => {
  // 检查聊天中是否有已解析的方案
  const lastAiMsg = [...messages.value].reverse().find((m) => m.role === 'assistant' && m.plan)
  return !!lastAiMsg || savedPlans.value.length > 0
})

/** 解析方案 JSON 字符串为 ShotPlan */
function parsePlanScript(scriptStr: string): ShotPlan | null {
  try {
    const parsed = JSON.parse(scriptStr)
    if (parsed && parsed.title && Array.isArray(parsed.shots)) {
      return parsed as ShotPlan
    }
    return null
  } catch {
    return null
  }
}

// ========== 生命周期 ==========
onMounted(async () => {
  await Promise.all([loadHotTopics(), loadSavedPlans()])
})
</script>

<template>
  <view class="studio-page">
    <!-- ========== 热点话题横滑区域 ========== -->
    <view v-if="hotTopics.length > 0" class="topics-section">
      <scroll-view class="topics-scroll" scroll-x :show-scrollbar="false" enable-flex>
        <view class="topics-inner">
          <view
            v-for="topic in hotTopics"
            :key="topic.id"
            class="topic-chip"
            @click="handleTopicTap(topic)"
          >
            <text v-if="topic.icon" class="topic-icon">{{ topic.icon }}</text>
            <text class="topic-label">{{ topic.label }}</text>
          </view>
        </view>
      </scroll-view>
    </view>

    <!-- ========== 聊天消息区域 ========== -->
    <scroll-view
      class="chat-area"
      scroll-y
      :show-scrollbar="false"
      :scroll-with-animation="true"
    >
      <!-- 空状态引导 -->
      <view v-if="messages.length === 0" class="chat-empty">
        <text class="empty-icon">🤖</text>
        <text class="empty-title">AI 分镜脚本创作</text>
        <text class="empty-desc">选择一个热点话题或输入你的需求，AI 将为你生成专业的分镜脚本方案</text>
      </view>

      <!-- 消息列表 -->
      <view v-for="msg in messages" :key="msg.id" class="msg-wrapper">
        <!-- 用户消息 -->
        <view v-if="msg.role === 'user'" class="msg-row user-row">
          <view class="msg-bubble user-bubble">
            <text class="bubble-text">{{ msg.content }}</text>
          </view>
        </view>

        <!-- AI 消息 -->
        <view v-else class="msg-row ai-row">
          <view class="msg-bubble ai-bubble">
            <!-- 流式生成中 & 内容为空 -->
            <view v-if="msg.streaming && !msg.content" class="streaming-indicator">
              <view class="dot" />
              <view class="dot" />
              <view class="dot" />
            </view>

            <!-- AI 文字内容 -->
            <view v-if="msg.content" class="ai-content">
              <text class="bubble-text">{{ msg.content }}</text>
              <!-- 流式生成中的光标 -->
              <text v-if="msg.streaming" class="streaming-cursor">|</text>
            </view>

            <!-- 分镜方案卡片 -->
            <view v-if="msg.plan && !msg.streaming" class="plan-card">
              <view class="plan-header">
                <text class="plan-icon">🎬</text>
                <text class="plan-title">{{ msg.plan.title }}</text>
              </view>
              <view class="plan-shots">
                <view
                  v-for="shot in msg.plan.shots"
                  :key="shot.index"
                  class="shot-item"
                >
                  <view class="shot-index">
                    <text class="shot-index-num">{{ shot.index }}</text>
                  </view>
                  <view class="shot-body">
                    <view class="shot-label-row">
                      <text class="shot-label">{{ shot.label }}</text>
                      <text class="shot-duration">{{ shot.duration }}s</text>
                    </view>
                    <text class="shot-script">{{ shot.script }}</text>
                  </view>
                </view>
              </view>

              <!-- 保存按钮 -->
              <view class="plan-actions">
                <view
                  :class="['plan-save-btn', { disabled: saving }]"
                  @click="!saving && handleSavePlan(msg.plan!)"
                >
                  <text>{{ saving ? '保存中...' : '💾 保存方案' }}</text>
                </view>
              </view>
            </view>
          </view>
        </view>
      </view>

      <!-- 底部留白 -->
      <view class="chat-bottom-spacer" />
    </scroll-view>

    <!-- ========== 已保存方案快捷入口 ========== -->
    <view v-if="savedPlans.length > 0" class="saved-plans-bar">
      <view class="saved-header">
        <text class="saved-title">已保存的方案（{{ savedPlans.length }}）</text>
      </view>
      <scroll-view class="saved-scroll" scroll-x :show-scrollbar="false">
        <view
          v-for="plan in savedPlans"
          :key="plan.id"
          class="saved-plan-chip"
        >
          <view class="saved-plan-info" @click="handleGoOneshot(plan)">
            <text class="saved-plan-title">{{ plan.title || '未命名' }}</text>
            <text class="saved-plan-date">{{
              plan.createdAt ? plan.createdAt.slice(0, 10) : ''
            }}</text>
          </view>
          <text class="saved-plan-delete" @click="handleDeletePlan(plan.id)">x</text>
        </view>
      </scroll-view>
    </view>

    <!-- ========== 底部操作栏 ========== -->
    <view class="bottom-bar">
      <!-- 快捷操作按钮（有方案时显示） -->
      <view v-if="hasActivePlan" class="quick-actions">
        <view class="quick-btn" @click="handleGoOneshot()">
          <text class="quick-btn-icon">⚡</text>
          <text class="quick-btn-text">一键成片</text>
        </view>
        <view class="quick-btn" @click="handleGoDigitalHuman()">
          <text class="quick-btn-icon">🎙️</text>
          <text class="quick-btn-text">数字人口播</text>
        </view>
      </view>

      <!-- 输入区域 -->
      <view class="input-row">
        <input
          v-model="inputText"
          class="chat-input"
          placeholder="输入创作需求，如：为海景民宿创作一个15秒推广视频脚本..."
          :maxlength="500"
          confirm-type="send"
          @confirm="handleSend"
        />
        <!-- 发送 / 停止按钮 -->
        <view v-if="!isStreaming" class="send-btn" @click="handleSend">
          <text class="send-icon">↑</text>
        </view>
        <view v-else class="stop-btn" @click="handleStopStreaming">
          <text class="stop-icon">■</text>
        </view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.studio-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: $bg-main;
}

/* ========== 热点话题横滑 ========== */
.topics-section {
  padding: 16rpx 0;
  background: #fff;
  border-bottom: 2rpx solid #f0f0f0;
}

.topics-scroll {
  width: 100%;
  white-space: nowrap;
}

.topics-inner {
  display: inline-flex;
  gap: 16rpx;
  padding: 0 24rpx;
}

.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 6rpx;
  padding: 12rpx 24rpx;
  border-radius: 32rpx;
  background: rgba(7, 193, 96, 0.08);
  white-space: nowrap;
  transition: all 0.2s;

  &:active {
    background: $primary-green;
    .topic-label { color: #fff; }
  }
}

.topic-icon {
  font-size: 24rpx;
}

.topic-label {
  font-size: 24rpx;
  color: $text-primary;
  font-weight: 500;
}

/* ========== 聊天区域 ========== */
.chat-area {
  flex: 1;
  height: 0;
  overflow: hidden;
  padding: 24rpx;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 120rpx 48rpx 0;
  text-align: center;
}

.empty-icon {
  font-size: 80rpx;
  margin-bottom: 24rpx;
}

.empty-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $text-primary;
  margin-bottom: 12rpx;
}

.empty-desc {
  font-size: 24rpx;
  color: $text-tertiary;
  line-height: 1.6;
}

/* ========== 消息行 ========== */
.msg-wrapper {
  margin-bottom: 24rpx;
}

.msg-row {
  display: flex;
}

.user-row {
  justify-content: flex-end;
}

.ai-row {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 85%;
  border-radius: $radius-lg;
  padding: 20rpx 24rpx;
  word-break: break-all;
}

.user-bubble {
  background: $primary-green;
  border-bottom-right-radius: 8rpx;

  .bubble-text {
    color: #fff;
    font-size: 28rpx;
    line-height: 1.6;
  }
}

.ai-bubble {
  background: #fff;
  border-bottom-left-radius: 8rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.04);

  .bubble-text {
    color: $text-primary;
    font-size: 28rpx;
    line-height: 1.6;
    white-space: pre-wrap;
  }
}

/* ========== 流式生成动画 ========== */
.streaming-indicator {
  display: flex;
  gap: 8rpx;
  padding: 8rpx 0;

  .dot {
    width: 12rpx;
    height: 12rpx;
    border-radius: 50%;
    background: $primary-green;
    animation: blink 1.4s infinite;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
}

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.streaming-cursor {
  display: inline;
  color: $primary-green;
  font-weight: 700;
  animation: blink 0.8s infinite;
}

/* ========== 分镜方案卡片 ========== */
.plan-card {
  margin-top: 20rpx;
  background: rgba(7, 193, 96, 0.04);
  border: 2rpx solid rgba(7, 193, 96, 0.15);
  border-radius: $radius-md;
  overflow: hidden;
}

.plan-header {
  display: flex;
  align-items: center;
  gap: 10rpx;
  padding: 20rpx 24rpx;
  border-bottom: 2rpx solid rgba(7, 193, 96, 0.1);
}

.plan-icon {
  font-size: 28rpx;
}

.plan-title {
  font-size: 26rpx;
  font-weight: 700;
  color: $primary-green;
}

.plan-shots {
  padding: 8rpx 0;
}

.shot-item {
  display: flex;
  gap: 16rpx;
  padding: 16rpx 24rpx;

  & + & {
    border-top: 1rpx solid rgba(0, 0, 0, 0.05);
  }
}

.shot-index {
  flex-shrink: 0;
  width: 40rpx;
  height: 40rpx;
  border-radius: 50%;
  background: $primary-green;
  display: flex;
  align-items: center;
  justify-content: center;
}

.shot-index-num {
  font-size: 22rpx;
  color: #fff;
  font-weight: 700;
}

.shot-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.shot-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.shot-label {
  font-size: 24rpx;
  font-weight: 600;
  color: $text-primary;
}

.shot-duration {
  font-size: 20rpx;
  padding: 2rpx 12rpx;
  border-radius: 10rpx;
  background: rgba(7, 193, 96, 0.1);
  color: $primary-green;
  font-weight: 500;
}

.shot-script {
  font-size: 22rpx;
  color: $text-secondary;
  line-height: 1.5;
}

/* ========== 方案操作按钮 ========== */
.plan-actions {
  padding: 16rpx 24rpx;
  border-top: 2rpx solid rgba(7, 193, 96, 0.1);
}

.plan-save-btn {
  width: 100%;
  padding: 18rpx 0;
  border: 2rpx solid $primary-green;
  border-radius: $radius-md;
  text-align: center;
  background: #fff;
  transition: all 0.2s;

  text {
    font-size: 26rpx;
    font-weight: 600;
    color: $primary-green;
  }

  &.disabled {
    opacity: 0.5;
  }

  &:active {
    background: rgba(7, 193, 96, 0.05);
  }
}

/* ========== 已保存方案快捷栏 ========== */
.saved-plans-bar {
  background: #fff;
  border-top: 2rpx solid #f0f0f0;
  padding: 16rpx 0 12rpx;
}

.saved-header {
  padding: 0 24rpx 10rpx;
}

.saved-title {
  font-size: 24rpx;
  color: $text-secondary;
  font-weight: 500;
}

.saved-scroll {
  white-space: nowrap;
  padding: 0 24rpx;
}

.saved-plan-chip {
  display: inline-flex;
  align-items: center;
  gap: 8rpx;
  padding: 10rpx 20rpx;
  margin-right: 12rpx;
  border-radius: 20rpx;
  background: $bg-main;
  white-space: nowrap;
}

.saved-plan-info {
  display: inline-flex;
  flex-direction: column;
  gap: 2rpx;
}

.saved-plan-title {
  font-size: 22rpx;
  color: $text-primary;
  font-weight: 500;
  max-width: 160rpx;
  overflow: hidden;
  text-overflow: ellipsis;
}

.saved-plan-date {
  font-size: 18rpx;
  color: $text-tertiary;
}

.saved-plan-delete {
  font-size: 20rpx;
  color: $text-tertiary;
  padding: 4rpx 8rpx;
}

/* ========== 底部操作栏 ========== */
.bottom-bar {
  background: #fff;
  border-top: 2rpx solid #f0f0f0;
  padding: 12rpx 24rpx;
  padding-bottom: calc(12rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(12rpx + env(safe-area-inset-bottom));
}

.quick-actions {
  display: flex;
  gap: 16rpx;
  margin-bottom: 12rpx;
}

.quick-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  padding: 16rpx 0;
  border-radius: $radius-md;
  background: rgba(7, 193, 96, 0.06);
  transition: all 0.2s;

  &:first-child {
    background: $gradient-primary;
    .quick-btn-text { color: #fff; }
  }

  &:active {
    opacity: 0.85;
  }
}

.quick-btn-icon {
  font-size: 26rpx;
}

.quick-btn-text {
  font-size: 24rpx;
  font-weight: 600;
  color: $primary-green;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.chat-input {
  flex: 1;
  height: 72rpx;
  padding: 0 24rpx;
  border-radius: 36rpx;
  background: $bg-main;
  font-size: 26rpx;
  color: $text-primary;
  box-sizing: border-box;
}

.send-btn {
  flex-shrink: 0;
  width: 72rpx;
  height: 72rpx;
  border-radius: 50%;
  background: $primary-green;
  display: flex;
  align-items: center;
  justify-content: center;

  &:active {
    opacity: 0.85;
  }
}

.send-icon {
  font-size: 32rpx;
  color: #fff;
  font-weight: 700;
}

.stop-btn {
  flex-shrink: 0;
  width: 72rpx;
  height: 72rpx;
  border-radius: 50%;
  background: $price-red;
  display: flex;
  align-items: center;
  justify-content: center;

  &:active {
    opacity: 0.85;
  }
}

.stop-icon {
  font-size: 24rpx;
  color: #fff;
}

/* ========== 聊天底部留白 ========== */
.chat-bottom-spacer {
  height: 32rpx;
}
</style>
