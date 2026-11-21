import { get } from '../request'

export interface DashboardData {
  today: {
    occupancyRate: number
    occupancyRateChange: number
    revenue: number
    revenueChange: number
    monthRevenue: number
  }
  roomStats: {
    preCheckin: number
    checking: number
    preCheckout: number
    available: number
  }
  todos: {
    pendingOrders: number
    pendingReviews: number
    pendingReconciliation: number
  }
  aiReminders: AIReminder[]
  quickActions: QuickAction[]
}

export interface AIReminder {
  id: string
  type: 'price' | 'clean' | 'review' | 'analysis'
  title: string
  content: string
  action?: {
    text: string
    type: 'adopt' | 'ignore' | 'view'
    data?: any
  }
}

export interface QuickAction {
  id: string
  name: string
  icon: string
  path: string
}

export function getDashboard(storeId?: string): Promise<DashboardData> {
  return get('/api/dashboard', { store_id: storeId })
}
