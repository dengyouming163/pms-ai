import { ref, onMounted, onUnmounted } from 'vue'
import { ENV } from '@/config/env'

export interface PushDeviceInfo {
  clientid: string
  deviceId: string
  platform: string
  version: string
  pushEnabled: boolean
}

export interface PushMessage {
  id: string
  title: string
  content: string
  payload?: Record<string, any>
  timestamp: number
  read: boolean
}

export interface PushError {
  code: string
  message: string
}

type MessageCallback = (message: PushMessage) => void
type ErrorCallback = (error: PushError) => void

export function usePush() {
  const deviceInfo = ref<PushDeviceInfo | null>(null)
  const isInitialized = ref(false)
  const isConnecting = ref(false)
  const error = ref<PushError | null>(null)

  const messageCallbacks: MessageCallback[] = []
  const errorCallbacks: ErrorCallback[] = []

  let pushModule: any = null

  const getPushModule = () => {
    if (!pushModule) {
      #ifndef H5
      pushModule = uni.requireNativePlugin('uni-push') || uni.requireNativePlugin('个推')
      #endif
    }
    return pushModule
  }

  const initPush = async (): Promise<boolean> => {
    return new Promise((resolve) => {
      try {
        if (!ENV.UNIPUSH_ENABLED) {
          error.value = {
            code: 'DISABLED',
            message: '推送功能已禁用'
          }
          resolve(false)
          return
        }

        isConnecting.value = true
        error.value = null

        #ifndef H5
        const push = getPushModule()
        
        if (!push) {
          error.value = {
            code: 'MODULE_NOT_FOUND',
            message: '推送模块未找到'
          }
          isConnecting.value = false
          resolve(false)
          return
        }

        push.init({
          appid: getAppId(),
          appkey: '',
          debug: process.env.NODE_ENV === 'development',
          success: (res: any) => {
            console.log('Push init success:', res)
            isInitialized.value = true
            isConnecting.value = false
            
            getDeviceInfo()
            resolve(true)
          },
          fail: (err: any) => {
            console.error('Push init failed:', err)
            error.value = {
              code: 'INIT_FAILED',
              message: err.errMsg || '推送初始化失败'
            }
            isConnecting.value = false
            resolve(false)
          }
        })

        push.on('notification', (notify: any) => {
          handleNotification(notify)
        })

        push.on('message', (msg: any) => {
          handleMessage(msg)
        })

        push.on('error', (err: any) => {
          console.error('Push error:', err)
          error.value = {
            code: 'PUSH_ERROR',
            message: err.errMsg || '推送错误'
          }
          notifyError(error.value)
        })

        #else
        initUniPushH5()
        .then(() => {
          isInitialized.value = true
          isConnecting.value = false
          resolve(true)
        })
        .catch((err: any) => {
          error.value = {
            code: 'H5_INIT_FAILED',
            message: err.message || 'H5 推送初始化失败'
          }
          isConnecting.value = false
          resolve(false)
        })
        #endif

      } catch (e: any) {
        error.value = {
          code: 'UNKNOWN_ERROR',
          message: e.message || '初始化推送失败'
        }
        isConnecting.value = false
        resolve(false)
      }
    })
  }

  const getAppId = (): string => {
    try {
      return plus.runtime.appid
    } catch (e) {
      return ''
    }
  }

  const initUniPushH5 = async (): Promise<void> => {
    #ifdef H5
    if (typeof uni !== 'undefined' && uni.subscribePush) {
      const token = uni.getStorageSync('token')
      
      await new Promise<void>((resolve, reject) => {
        uni.subscribePush({
          provider: 'unipush',
          success: (res) => {
            console.log('H5 push subscribe success:', res)
            resolve()
          },
          fail: (err) => {
            console.error('H5 push subscribe failed:', err)
            reject(err)
          }
        })
      })
    }
    #endif
  }

  const getDeviceInfo = async (): Promise<PushDeviceInfo | null> => {
    try {
      #ifndef H5
      const push = getPushModule()
      
      if (!push) return null

      const info = await new Promise<any>((resolve, reject) => {
        push.getClientInfo({
          success: (res: any) => resolve(res),
          fail: (err: any) => reject(err)
        })
      })

      deviceInfo.value = {
        clientid: info.clientid || '',
        deviceId: info.deviceId || '',
        platform: info.platform || '',
        version: info.version || '',
        pushEnabled: true
      }

      if (deviceInfo.value.clientid) {
        await registerDevice(deviceInfo.value.clientid)
      }

      return deviceInfo.value
      #else
      return null
      #endif
    } catch (e: any) {
      console.error('获取设备信息失败:', e)
      return null
    }
  }

  const registerDevice = async (clientid: string): Promise<void> => {
    try {
      const token = uni.getStorageSync('token')
      
      uni.request({
        url: `${ENV.PMS_SERVER_URL}/api/push/register`,
        method: 'POST',
        header: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        data: {
          clientid: clientid,
          platform: uni.getSystemInfoSync().platform,
          version: plus.runtime.version
        }
      })
    } catch (e) {
      console.error('注册设备失败:', e)
    }
  }

  const handleNotification = (notify: any) => {
    const message: PushMessage = {
      id: notify.msgid || Date.now().toString(),
      title: notify.title || '',
      content: notify.content || '',
      payload: notify.payload,
      timestamp: notify.time || Date.now(),
      read: false
    }
    
    notifyMessage(message)
  }

  const handleMessage = (msg: any) => {
    const message: PushMessage = {
      id: msg.message_id || Date.now().toString(),
      title: msg.title || '',
      content: msg.content || '',
      payload: msg.payload,
      timestamp: msg.timestamp || Date.now(),
      read: false
    }
    
    notifyMessage(message)
  }

  const notifyMessage = (message: PushMessage) => {
    messageCallbacks.forEach(callback => {
      try {
        callback(message)
      } catch (e) {
        console.error('消息回调执行失败:', e)
      }
    })

    saveMessage(message)
  }

  const notifyError = (err: PushError) => {
    errorCallbacks.forEach(callback => {
      try {
        callback(err)
      } catch (e) {
        console.error('错误回调执行失败:', e)
      }
    })
  }

  const saveMessage = (message: PushMessage) => {
    try {
      const messages = getStoredMessages()
      messages.unshift(message)
      
      const maxMessages = 50
      const trimmedMessages = messages.slice(0, maxMessages)
      
      uni.setStorageSync('push_messages', JSON.stringify(trimmedMessages))
    } catch (e) {
      console.error('保存消息失败:', e)
    }
  }

  const getStoredMessages = (): PushMessage[] => {
    try {
      const stored = uni.getStorageSync('push_messages')
      if (stored) {
        return JSON.parse(stored)
      }
    } catch (e) {
      console.error('读取消息失败:', e)
    }
    return []
  }

  const onMessage = (callback: MessageCallback): (() => void) => {
    messageCallbacks.push(callback)
    
    const storedMessages = getStoredMessages()
    storedMessages.forEach(msg => {
      if (!msg.read) {
        callback(msg)
      }
    })
    
    return () => {
      const index = messageCallbacks.indexOf(callback)
      if (index > -1) {
        messageCallbacks.splice(index, 1)
      }
    }
  }

  const onError = (callback: ErrorCallback): (() => void) => {
    errorCallbacks.push(callback)
    
    if (error.value) {
      callback(error.value)
    }
    
    return () => {
      const index = errorCallbacks.indexOf(callback)
      if (index > -1) {
        errorCallbacks.splice(index, 1)
      }
    }
  }

  const setBadge = (number: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        #ifndef H5
        const push = getPushModule()
        
        if (push && push.setBadgeNumber) {
          push.setBadgeNumber({
            badgeNumber: number,
            success: () => resolve(),
            fail: (err: any) => reject(err)
          })
        } else {
          uni.setAppBadge({
            badge: number,
            success: () => resolve(),
            fail: (err: any) => reject(err)
          })
        }
        #else
        if (number > 0) {
          document.title = `(${number}) ${document.title}`
        }
        resolve()
        #endif
      } catch (e: any) {
        reject(e)
      }
    })
  }

  const clearBadge = (): Promise<void> => {
    return setBadge(0)
  }

  const getUnreadCount = (): number => {
    const messages = getStoredMessages()
    return messages.filter(msg => !msg.read).length
  }

  const markAsRead = (messageId: string): void => {
    try {
      const messages = getStoredMessages()
      const index = messages.findIndex(msg => msg.id === messageId)
      
      if (index > -1) {
        messages[index].read = true
        uni.setStorageSync('push_messages', JSON.stringify(messages))
      }
    } catch (e) {
      console.error('标记已读失败:', e)
    }
  }

  const clearAllMessages = (): void => {
    try {
      uni.removeStorageSync('push_messages')
    } catch (e) {
      console.error('清除消息失败:', e)
    }
  }

  const setSilentMode = async (enable: boolean, startTime?: string, endTime?: string): Promise<void> => {
    try {
      #ifndef H5
      const push = getPushModule()
      
      if (push) {
        await new Promise<void>((resolve, reject) => {
          push.setSilenceTime({
            enable: enable,
            beginHour: startTime ? parseInt(startTime.split(':')[0]) : 22,
            beginMinute: startTime ? parseInt(startTime.split(':')[1]) : 0,
            endHour: endTime ? parseInt(endTime.split(':')[0]) : 7,
            endMinute: endTime ? parseInt(endTime.split(':')[1]) : 0,
            success: () => resolve(),
            fail: (err: any) => reject(err)
          })
        })
      }
      #endif
    } catch (e) {
      console.error('设置静默模式失败:', e)
    }
  }

  onMounted(() => {
    if (ENV.UNIPUSH_ENABLED && !isInitialized.value) {
      initPush()
    }
  })

  onUnmounted(() => {
    #ifndef H5
    const push = getPushModule()
    if (push && push.off) {
      push.off('notification')
      push.off('message')
      push.off('error')
    }
    #endif
  })

  return {
    deviceInfo,
    isInitialized,
    isConnecting,
    error,
    initPush,
    onMessage,
    onError,
    setBadge,
    clearBadge,
    getUnreadCount,
    markAsRead,
    clearAllMessages,
    setSilentMode
  }
}
