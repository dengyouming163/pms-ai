import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ENV } from '@/config/env'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isLoading?: boolean
  error?: string
}

export interface ChatOptions {
  streaming?: boolean
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
}

export interface ChatError {
  code: string
  message: string
}

const MAX_HISTORY_LENGTH = 50
const STORAGE_KEY = 'ai_chat_history'

export function useAIChat(options: ChatOptions = {}) {
  const messages = ref<ChatMessage[]>([])
  const isLoading = ref(false)
  const error = ref<ChatError | null>(null)
  const streaming = ref(options.streaming ?? false)

  const systemPrompt = ref(options.systemPrompt || '')

  let abortController: AbortController | null = null
  let messageIdCounter = 0

  const generateId = (): string => {
    return `msg_${Date.now()}_${++messageIdCounter}`
  }

  const userMessages = computed(() => {
    return messages.value.filter(msg => msg.role === 'user')
  })

  const assistantMessages = computed(() => {
    return messages.value.filter(msg => msg.role === 'assistant')
  })

  const loadHistory = () => {
    try {
      const stored = uni.getStorageSync(STORAGE_KEY)
      if (stored) {
        const history = JSON.parse(stored) as ChatMessage[]
        messages.value = history.slice(-MAX_HISTORY_LENGTH)
      }
    } catch (e) {
      console.error('加载聊天历史失败:', e)
    }
  }

  const saveHistory = () => {
    try {
      const history = messages.value.slice(-MAX_HISTORY_LENGTH)
      uni.setStorageSync(STORAGE_KEY, JSON.stringify(history))
    } catch (e) {
      console.error('保存聊天历史失败:', e)
    }
  }

  const addMessage = (message: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage => {
    const newMessage: ChatMessage = {
      ...message,
      id: generateId(),
      timestamp: Date.now()
    }
    messages.value.push(newMessage)
    return newMessage
  }

  const updateMessage = (messageId: string, updates: Partial<ChatMessage>) => {
    const index = messages.value.findIndex(msg => msg.id === messageId)
    if (index > -1) {
      messages.value[index] = { ...messages.value[index], ...updates }
    }
  }

  const deleteMessage = (messageId: string) => {
    const index = messages.value.findIndex(msg => msg.id === messageId)
    if (index > -1) {
      messages.value.splice(index, 1)
    }
  }

  const clearHistory = () => {
    messages.value = []
    try {
      uni.removeStorageSync(STORAGE_KEY)
    } catch (e) {
      console.error('清除聊天历史失败:', e)
    }
  }

  const getConversationHistory = (limit?: number): ChatMessage[] => {
    if (limit) {
      return messages.value.slice(-limit)
    }
    return [...messages.value]
  }

  const formatMessagesForAPI = (): Array<{ role: string; content: string }> => {
    const formatted: Array<{ role: string; content: string }> = []

    if (systemPrompt.value) {
      formatted.push({
        role: 'system',
        content: systemPrompt.value
      })
    }

    const chatHistory = messages.value.filter(msg => !msg.isLoading && !msg.error)
    chatHistory.forEach(msg => {
      formatted.push({
        role: msg.role,
        content: msg.content
      })
    })

    return formatted
  }

  const sendMessage = async (content: string): Promise<ChatMessage | null> => {
    if (!content.trim()) {
      error.value = {
        code: 'EMPTY_MESSAGE',
        message: '消息内容不能为空'
      }
      return null
    }

    if (isLoading.value) {
      error.value = {
        code: 'ALREADY_LOADING',
        message: '正在等待上一条消息响应'
      }
      return null
    }

    try {
      isLoading.value = true
      error.value = null

      const userMessage = addMessage({
        role: 'user',
        content: content.trim()
      })

      if (streaming.value) {
        return await handleStreamingResponse(userMessage)
      } else {
        return await handleNormalResponse(userMessage)
      }
    } catch (e: any) {
      error.value = {
        code: 'SEND_ERROR',
        message: e.message || '发送消息失败'
      }
      return null
    } finally {
      isLoading.value = false
      saveHistory()
    }
  }

  const handleNormalResponse = async (userMessage: ChatMessage): Promise<ChatMessage | null> => {
    try {
      const token = uni.getStorageSync('token')

      const response = await new Promise<any>((resolve, reject) => {
        uni.request({
          url: `${ENV.PMS_AI_URL}/api/data-center/chat`,
          method: 'POST',
          header: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          data: {
            message: userMessage.content,
            history: formatMessagesForAPI(),
            temperature: options.temperature || 0.7,
            max_tokens: options.maxTokens || 2000
          },
          success: (res: any) => {
            if (res.statusCode === 200) {
              resolve(res.data)
            } else {
              reject(new Error(`请求失败: ${res.statusCode}`))
            }
          },
          fail: (err) => {
            reject(new Error(err.errMsg || '网络请求失败'))
          }
        })
      })

      if (response.code === 0 && response.data) {
        const assistantMessage = addMessage({
          role: 'assistant',
          content: response.data.content || response.data.text || ''
        })

        return assistantMessage
      } else {
        throw new Error(response.message || 'AI 响应失败')
      }
    } catch (e: any) {
      error.value = {
        code: 'API_ERROR',
        message: e.message || 'AI 请求失败'
      }
      updateMessage(userMessage.id, {
        error: error.value.message
      })
      return null
    }
  }

  const handleStreamingResponse = async (userMessage: ChatMessage): Promise<ChatMessage | null> => {
    try {
      const token = uni.getStorageSync('token')
      
      abortController = new AbortController()

      const assistantMessage = addMessage({
        role: 'assistant',
        content: '',
        isLoading: true
      })

      const response = await fetch(`${ENV.PMS_AI_URL}/api/data-center/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          message: userMessage.content,
          history: formatMessagesForAPI(),
          temperature: options.temperature || 0.7,
          max_tokens: options.maxTokens || 2000
        }),
        signal: abortController.signal
      })

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let fullContent = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          
          if (done) {
            break
          }

          const chunk = decoder.decode(value)
          const lines = chunk.split('\n')

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              
              if (data === '[DONE]') {
                break
              }

              try {
                const parsed = JSON.parse(data)
                if (parsed.content || parsed.text) {
                  fullContent += parsed.content || parsed.text
                  updateMessage(assistantMessage.id, {
                    content: fullContent
                  })
                }
              } catch (e) {
                console.error('解析流式数据失败:', e)
              }
            }
          }
        }
      }

      updateMessage(assistantMessage.id, {
        isLoading: false,
        content: fullContent || '未收到有效响应'
      })

      if (!fullContent) {
        throw new Error('流式响应为空')
      }

      return assistantMessage

    } catch (e: any) {
      if (e.name === 'AbortError') {
        error.value = {
          code: 'ABORTED',
          message: '请求已取消'
        }
      } else {
        error.value = {
          code: 'STREAM_ERROR',
          message: e.message || '流式响应失败'
        }
      }
      
      updateMessage(userMessage.id, {
        error: error.value.message
      })
      
      return null
    } finally {
      abortController = null
    }
  }

  const stopGeneration = () => {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    isLoading.value = false
  }

  const regenerateResponse = async (messageId: string): Promise<ChatMessage | null> => {
    const messageIndex = messages.value.findIndex(msg => msg.id === messageId)
    
    if (messageIndex < 0 || messageIndex === 0) {
      error.value = {
        code: 'INVALID_MESSAGE',
        message: '无法重新生成该消息'
      }
      return null
    }

    const userMessageIndex = messageIndex - 1
    const userMessage = messages.value[userMessageIndex]

    if (userMessage.role !== 'user') {
      error.value = {
        code: 'INVALID_PAIR',
        message: '消息对无效'
      }
      return null
    }

    messages.value.splice(messageIndex, 1)

    return await sendMessage(userMessage.content)
  }

  const setSystemPrompt = (prompt: string) => {
    systemPrompt.value = prompt
  }

  const exportConversation = (): string => {
    return JSON.stringify({
      messages: messages.value,
      systemPrompt: systemPrompt.value,
      exportedAt: new Date().toISOString()
    }, null, 2)
  }

  const importConversation = (data: string): boolean => {
    try {
      const parsed = JSON.parse(data)
      
      if (parsed.messages && Array.isArray(parsed.messages)) {
        messages.value = parsed.messages.map((msg: any) => ({
          ...msg,
          isLoading: false,
          error: undefined
        }))
      }
      
      if (parsed.systemPrompt) {
        systemPrompt.value = parsed.systemPrompt
      }
      
      saveHistory()
      return true
    } catch (e) {
      error.value = {
        code: 'IMPORT_ERROR',
        message: '导入会话失败，格式错误'
      }
      return false
    }
  }

  onMounted(() => {
    loadHistory()
  })

  onUnmounted(() => {
    if (abortController) {
      abortController.abort()
    }
  })

  return {
    messages,
    isLoading,
    error,
    streaming,
    systemPrompt,
    userMessages,
    assistantMessages,
    sendMessage,
    clearHistory,
    stopGeneration,
    regenerateResponse,
    getConversationHistory,
    addMessage,
    deleteMessage,
    updateMessage,
    setSystemPrompt,
    exportConversation,
    importConversation,
    loadHistory,
    saveHistory
  }
}
