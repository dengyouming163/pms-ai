// 自动收益管家 — 前端 API 封装
import { apiGet, apiPost, apiPut } from './api-client';

export function getRobotConfig(): Promise<any> { return apiGet('/api/price-robot/config'); }
export function saveRobotConfig(data: any): Promise<any> { return apiPut('/api/price-robot/config', data); }
export function getSuggestion(date?: string): Promise<any> {
  return apiGet(`/api/price-robot/suggestion${date ? `?date=${date}` : ''}`);
}
export function confirmAuth(rooms: any[]): Promise<any> { return apiPost('/api/price-robot/auth', { rooms }); }
export function getTodayAuth(): Promise<any> { return apiGet('/api/price-robot/auth/today'); }
export function fuseAuth(authId: string): Promise<any> { return apiPost(`/api/price-robot/auth/${authId}/fuse`); }
export function getTasks(): Promise<any> { return apiGet('/api/price-robot/tasks'); }
export function getRobotStats(): Promise<any> { return apiGet('/api/price-robot/stats'); }
// 未来价格日历：14 天计划预览（start 缺省为今天）
export function getPlan(start?: string, days = 14): Promise<any> {
  return apiGet(`/api/price-robot/plan?start=${start || ''}&days=${days}`);
}
// 更新某天某房型的计划价
export function updatePlanPrice(data: { planDate: string; roomTypeId: string; price: number }): Promise<any> {
  return apiPut('/api/price-robot/plan', data);
}
// 确认近端若干天执行（空数组 = 默认近端 3 天）
export function confirmPlan(dates?: string[]): Promise<any> {
  return apiPost('/api/price-robot/plan/confirm', { dates: dates || [] });
}
