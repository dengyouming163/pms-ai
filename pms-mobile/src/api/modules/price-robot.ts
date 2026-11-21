// 自动收益管家 — 移动端 API 模块
import { get, post, put } from '@/api/request'

/** 获取今日建议底价 */
export function getRobotSuggestion(): Promise<any> {
  return get('/api/price-robot/suggestion')
}
/** 获取今日授权状态 */
export function getTodayAuth(): Promise<any> {
  return get('/api/price-robot/auth/today')
}
/** 确认今日执行计划 */
export function confirmRobotAuth(rooms: any[]): Promise<any> {
  return post('/api/price-robot/auth', { rooms })
}
/** 一键熔断（后端按门店+日期熔断当日全部授权） */
export function fuseRobotAuth(authId: string): Promise<any> {
  return post(`/api/price-robot/auth/${authId}/fuse`)
}
/** 今日任务时间轴 */
export function getRobotTasks(): Promise<any> {
  return get('/api/price-robot/tasks')
}
/** 今日效果 */
export function getRobotStats(): Promise<any> {
  return get('/api/price-robot/stats')
}
/** 获取未来价格计划（未来 14 天） */
export function getRobotPlan(): Promise<any> {
  return get('/api/price-robot/plan')
}
/** 更新某日某房型计划价 */
export function updatePlanPrice(data: { planDate: string; roomTypeId: string; price: number }): Promise<any> {
  return put('/api/price-robot/plan', data)
}
/** 确认计划（近端 3 天自动执行） */
export function confirmRobotPlan(): Promise<any> {
  return post('/api/price-robot/plan/confirm', { dates: [] })
}
/** 获取门店级设置（autoConfirm + globalFloor） */
export function getRobotSettings(): Promise<any> {
  return get('/api/price-robot/settings')
}
/** 更新门店级设置 */
export function updateRobotSettings(data: { autoConfirm?: boolean; globalFloor?: number | null }): Promise<any> {
  return put('/api/price-robot/settings', data)
}
