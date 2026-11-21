import { defineStore } from 'pinia'

interface Notification {
  id: string
  type: 'order' | 'ai' | 'finance' | 'system'
  title: string
  content: string
  read: boolean
  createdAt: string
  data?: any
}

interface NotificationsState {
  list: Notification[]
  unreadCount: number
  loading: boolean
}

export const useNotificationsStore = defineStore('notifications', {
  state: (): NotificationsState => ({
    list: [],
    unreadCount: 0,
    loading: false
  }),
  
  actions: {
    addNotification(notification: Notification) {
      this.list.unshift(notification)
      if (!notification.read) {
        this.unreadCount++
      }
    },
    
    markAsRead(id: string) {
      const notification = this.list.find(n => n.id === id)
      if (notification && !notification.read) {
        notification.read = true
        this.unreadCount = Math.max(0, this.unreadCount - 1)
      }
    },
    
    markAllAsRead() {
      this.list.forEach(n => {
        n.read = true
      })
      this.unreadCount = 0
    },
    
    clearAll() {
      this.list = []
      this.unreadCount = 0
    },
    
    setNotifications(notifications: Notification[]) {
      this.list = notifications
      this.unreadCount = notifications.filter(n => !n.read).length
    }
  }
})
