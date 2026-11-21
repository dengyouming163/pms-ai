// 定价中心 — 前端 API 封装
// apiGet/apiPost 直接返回后端响应体（{ success, data } 原样透传，未解包）
import { apiGet, apiPost } from './api-client';

// 今日推荐房型卡
export interface PricingTodayRoom {
  roomTypeId: string;
  roomTypeName: string;
  currentPrice: number;
  defaultPrice: number;
  suggestedPrice: number | null;
  change: number; // suggestedPrice - currentPrice
  reasons: string[];
  remaining: number;
  total: number;
  occupancyPct: number;
  minPrice: number | null;
  soldOut: boolean;
  holiday: string | null;
  dailySource: string | null; // 有值表示今日已采纳
}

export interface PricingTodayData {
  date: string;
  dateLabel: string;
  recommendationEnabled: boolean;
  rooms: PricingTodayRoom[];
}

// 手动设置：基础价/最低价
export interface PricingBasePrice {
  roomTypeId: string;
  roomTypeName: string;
  basePrice: number;
  weekdayPrice: number;
  weekendPrice: number;
  minPrice: number;
}

export interface PricingSettings {
  holidayMarkupPct: number;
  recommendationEnabled: boolean;
  channels: string[];
  basePrices: PricingBasePrice[];
}

// 价格一览（未来 N 天）
export interface PricingOverviewDay {
  date: string;
  label: string; // 节假日名 / 周末 / 空串
  roomTypes: { roomTypeId: string; price: number; adopted: boolean }[];
}

export const pricingCenterApi = {
  getToday: (): Promise<{ success: boolean; data: PricingTodayData }> =>
    apiGet('/api/pricing-center/today'),
  adopt: (data: { roomTypeId: string; price: number }): Promise<{ success: boolean; data: { date: string; roomTypeId: string; price: number; channels: string[] } }> =>
    apiPost('/api/pricing-center/adopt', data),
  undo: (data: { roomTypeId: string }): Promise<{ success: boolean; data: { date: string; roomTypeId: string; fallbackPrice: number } }> =>
    apiPost('/api/pricing-center/undo', data),
  retryTask: (taskId: string): Promise<{ success: boolean; data: unknown }> =>
    apiPost(`/api/pricing-center/tasks/${taskId}/retry`),
  getSettings: (): Promise<{ success: boolean; data: PricingSettings }> =>
    apiGet('/api/pricing-center/settings'),
  saveSettings: (data: unknown): Promise<{ success: boolean; data: unknown }> =>
    apiPost('/api/pricing-center/settings', data),
  getOverview: (days = 7): Promise<{ success: boolean; data: { days: PricingOverviewDay[] } }> =>
    apiGet(`/api/pricing-center/overview?days=${days}`),
};
