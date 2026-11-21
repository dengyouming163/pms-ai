import { get, post } from '../request'
import { ENV } from '@/config/env'

export interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface PriceSuggestion {
  id: string
  roomType: string
  currentPrice: number
  suggestedPrice: number
  confidence: number
  competitorAvg?: number
  reason: string
  status: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SSECallbacks {
  onAgentStart?: (agent: string, action: string) => void
  onToken?: (text: string) => void
  onDone?: (summary: string, elapsedMs: number) => void
  onError?: (error: string, retry: boolean) => void
}

/* ============ 跨端统一 SSE 流式对话 ============ */

/**
 * SSE 流式 AI 对话 — 对齐 pms-web chat-client.ts
 *
 * H5 端: fetch + ReadableStream (原生支持)
 * APP 端: RenderJS + XMLHttpRequest onprogress (豆包/DeepSeek 同款方案)
 *         通过 SseBridge.vue 组件桥接
 */
export async function streamAIChat(
  message: string,
  history: ChatMessage[],
  callbacks: SSECallbacks
): Promise<string> {
  const token = getToken()
  const url = ENV.AI_CHAT_URL

  // #ifdef H5
  return streamAIChatH5(url, message, history, token, callbacks)
  // #endif

  // #ifdef APP-PLUS
  return streamAIChatAPP(url, message, history, token, callbacks)
  // #endif

  // #ifndef H5 || APP-PLUS
  return streamAIChatFallback(url, message, history, token, callbacks)
  // #endif
}

/* ============ H5 端: fetch + ReadableStream ============ */

// #ifdef H5
async function streamAIChatH5(
  url: string,
  message: string,
  history: ChatMessage[],
  token: string,
  callbacks: SSECallbacks
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message, history }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (err.code === 'AI_DISABLED') throw new Error('AI 功能未开启')
    throw new Error(err.error || `AI 服务响应错误: ${res.status}`)
  }

  if (!res.body) throw new Error('AI 服务未返回流式数据')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullSummary = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const data = JSON.parse(line.slice(6))
        if (data.agent && data.action) {
          callbacks.onAgentStart?.(data.agent, data.action)
        } else if (data.text) {
          callbacks.onToken?.(data.text)
        } else if (data.summary) {
          fullSummary = data.summary
          callbacks.onDone?.(data.summary, data.elapsed_total_ms || 0)
        } else if (data.error) {
          callbacks.onError?.(data.error, data.retry || false)
        }
      } catch {
        // JSON 解析失败，跳过
      }
    }
  }

  return fullSummary
}
// #endif

/* ============ APP 端: RenderJS + XHR onprogress ============ */

// #ifdef APP-PLUS

interface SSEPending {
  resolve: (value: string) => void
  reject: (err: Error) => void
  callbacks: SSECallbacks
  fullSummary: string
}

let seqCounter = 0
const pendingMap = new Map<string, SSEPending>()
let _bridgeTrigger: ((data: any) => void) | null = null

/**
 * 设置 APP 端桥接触发器（由页面调用，将数据传给 SseBridge）
 */
export function setBridgeTrigger(trigger: (data: any) => void) {
  _bridgeTrigger = trigger
}

/**
 * APP 端发起 SSE 流式对话
 * 内部通过 SseBridge.vue 组件的 RenderJS 模块执行 XHR 请求
 */
async function streamAIChatAPP(
  url: string,
  message: string,
  history: ChatMessage[],
  token: string,
  callbacks: SSECallbacks
): Promise<string> {
  return new Promise((resolve, reject) => {
    seqCounter++
    const requestId = `sse_${Date.now()}_${seqCounter}`

    pendingMap.set(requestId, {
      resolve,
      reject,
      callbacks,
      fullSummary: '',
    })

    if (!_bridgeTrigger) {
      reject(new Error('SSE 桥接未初始化，请确认 SseBridge 组件已挂载'))
      return
    }

    _bridgeTrigger({
      type: 'connect',
      seq: seqCounter,
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: { message, history },
      requestId,
    })
  })
}

/**
 * SseBridge 回调: 接收到 SSE 数据行（由 ai/index.vue 调用）
 */
export function onAPPChunk(requestId: string, data: any) {
  const pending = pendingMap.get(requestId)
  if (!pending) return

  const c = pending.callbacks
  if (data.agent && data.action) {
    c.onAgentStart?.(data.agent, data.action)
  } else if (data.text) {
    c.onToken?.(data.text)
  } else if (data.summary) {
    pending.fullSummary = data.summary
    c.onDone?.(data.summary, data.elapsed_total_ms || 0)
  } else if (data.error) {
    c.onError?.(data.error, data.retry || false)
  }
}

/**
 * SseBridge 回调: 请求完成
 */
export function onAPPDone(requestId: string, _payload: any) {
  const pending = pendingMap.get(requestId)
  if (!pending) return
  pendingMap.delete(requestId)
  pending.resolve(pending.fullSummary)
}

/**
 * SseBridge 回调: 请求出错
 */
export function onAPPError(requestId: string, payload: any) {
  const pending = pendingMap.get(requestId)
  if (!pending) return
  pendingMap.delete(requestId)
  pending.reject(new Error(payload?.message || 'AI 请求失败'))
}

// #endif

/* ============ 降级方案: 非 H5/APP 端 ============ */

// #ifndef H5 || APP-PLUS
async function streamAIChatFallback(
  url: string,
  message: string,
  history: ChatMessage[],
  token: string,
  callbacks: SSECallbacks
): Promise<string> {
  return new Promise((resolve, reject) => {
    uni.request({
      url,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        'Authorization': token ? `Bearer ${token}` : '',
      },
      data: { message, history },
      success: (res: any) => {
        if (res.statusCode === 200) {
          const data = res.data
          const text = data?.summary || data?.text || data?.content || ''
          if (text) {
            callbacks.onToken?.(text)
            callbacks.onDone?.(text, 0)
            resolve(text)
          } else {
            callbacks.onError?.('AI 未返回内容', false)
            reject(new Error('AI 未返回内容'))
          }
        } else if (res.statusCode === 401) {
          reject(new Error('登录已过期'))
        } else {
          reject(new Error(`AI 服务响应错误: ${res.statusCode}`))
        }
      },
      fail: (err: any) => {
        reject(new Error(err.errMsg || '网络连接失败'))
      },
    })
  })
}
// #endif

/* ============ 工具函数 ============ */

function getToken(): string {
  try {
    return uni.getStorageSync('token') || ''
  } catch {
    return ''
  }
}

/** 获取 AI 对话历史 */
export function getChatHistory(sessionType: string = 'general'): Promise<AIMessage[]> {
  return get('/api/ai/chat/history', { sessionType }).then((res: any) => {
    const messages = res?.messages || []
    return messages.map((m: any) => ({
      id: m.id,
      role: m.role as 'user' | 'assistant',
      content: m.content,
      createdAt: m.time,
    }))
  }).catch(() => [])
}

export function getPriceSuggestions(): Promise<PriceSuggestion[]> {
  return get('/api/pricing', { type: 'ai' }).then((res: any) => {
    return res.suggestions || res || []
  })
}

export function adoptPriceSuggestion(suggestionId: string): Promise<void> {
  return post('/api/pricing', {
    action: 'adoptSuggestion',
    suggestionId,
  })
}

export function ignorePriceSuggestion(suggestionId: string): Promise<void> {
  return post('/api/pricing', {
    action: 'ignoreSuggestion',
    suggestionId,
  })
}

/** 获取 AI 快捷提示列表 */
export function getAIPrompts(): Promise<{ prompts: Array<{ id: string; label: string; message: string }> }> {
  return get('/api/ai/prompts')
}

/* ============ 模型切换 ============ */

export interface ModelPreset {
  id: string
  label: string
  model: string
  provider: string
  api_key_masked: string
}

export interface ModelConfig {
  active: string
  config: {
    label: string
    model: string
    provider: string
    base_url: string
    api_key_masked: string
  }
  presets: ModelPreset[]
}

/** 获取当前模型配置和可用预设 */
export function getModelConfig(): Promise<ModelConfig> {
  return get('/api/ai/model-config')
}

/** 切换模型预设 */
export function switchModel(preset: string): Promise<{ success: boolean; active: string; model: string; label: string }> {
  return post('/api/ai/model-config/switch', { preset })
}