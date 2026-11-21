// 定价中心 — 移动端 API 模块
// request 层约定：{ success:true } 时 resolve 解包后的 data；{ success:false } 时 reject 原始响应（err.error 即后端提示语）。
// 统一传 showError:false，由页面 catch 自行展示 err.error，避免与页面内消息条重复弹出。
import { get, post } from '@/api/request'

/** 今日推荐房型卡 */
export interface PricingTodayRoom {
  roomTypeId: string
  roomTypeName: string
  currentPrice: number
  defaultPrice: number
  suggestedPrice: number | null
  change: number // suggestedPrice - currentPrice
  reasons: string[]
  remaining: number
  total: number
  occupancyPct: number
  minPrice: number | null
  soldOut: boolean
  holiday: string | null
  dailySource: string | null // 有值表示今日已采纳
}

/** 今日推荐数据 */
export interface PricingTodayData {
  date: string
  dateLabel: string
  recommendationEnabled: boolean
  rooms: PricingTodayRoom[]
}

/** 手动设置：基础价/最低价 */
export interface PricingBasePrice {
  roomTypeId: string
  roomTypeName: string
  basePrice: number
  weekdayPrice: number
  weekendPrice: number
  minPrice: number
}

/** 手动设置 */
export interface PricingSettings {
  holidayMarkupPct: number
  recommendationEnabled: boolean
  channels: string[]
  basePrices: PricingBasePrice[]
}

/** 价格一览（未来 N 天） */
export interface PricingOverviewDay {
  date: string
  label: string // 节假日名 / 周末 / 空串
  roomTypes: { roomTypeId: string; price: number; adopted: boolean }[]
}

const NO_ERROR_TOAST = { showError: false }

export const pricingCenterApi = {
  /** 今日推荐 */
  getToday: () => get<PricingTodayData>('/api/pricing-center/today', undefined, NO_ERROR_TOAST),
  /** 采纳：写每日卖价 + 为每个渠道生成 OTA 同步任务 */
  adopt: (data: { roomTypeId: string; price: number }) =>
    post<{ date: string; roomTypeId: string; price: number; channels: string[] }>(
      '/api/pricing-center/adopt',
      data,
      NO_ERROR_TOAST,
    ),
  /** 撤销采纳：删除今日卖价 → 回落默认价 */
  undo: (data: { roomTypeId: string }) =>
    post<{ date: string; roomTypeId: string; fallbackPrice: number }>('/api/pricing-center/undo', data, NO_ERROR_TOAST),
  /** 渠道同步失败重试 */
  retryTask: (taskId: string) => post(`/api/pricing-center/tasks/${taskId}/retry`, undefined, NO_ERROR_TOAST),
  /** 读取设置（基础价/节假日加价%/渠道/推荐开关） */
  getSettings: () => get<PricingSettings>('/api/pricing-center/settings', undefined, NO_ERROR_TOAST),
  /** 保存设置 */
  saveSettings: (data: unknown) => post('/api/pricing-center/settings', data, NO_ERROR_TOAST),
  /** 未来 N 天价格一览 */
  getOverview: (days = 7) =>
    get<{ days: PricingOverviewDay[] }>(`/api/pricing-center/overview?days=${days}`, undefined, NO_ERROR_TOAST),
}
