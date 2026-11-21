import { get, post } from '@/api/request'
import type { PriceRule } from '@/types/user'

/** 获取定价规则列表 */
export function getPricingRules(): Promise<PriceRule[]> {
  return get('/api/pricing', { type: 'rules' })
}

/** 获取价格日历 */
export function getPricingCalendar(): Promise<any[]> {
  return get('/api/pricing', { type: 'calendar' })
}

/** 更新定价规则 */
export function updatePricingRule(ruleId: string, data: {
  basePrice?: number
  weekdayPrice?: number
  weekendPrice?: number
  holidayPrice?: number
  minPrice?: number
}): Promise<any> {
  return post('/api/pricing', { action: 'updateRule', ruleId, ...data })
}

/** 获取渠道房价 */
export function getChannelPricing(): Promise<{
  channels: Array<{ id: string; name: string; type: string; markup: number; commission: number }>
  pricing: Array<{ roomTypeId: string; roomType: string; channelPrices: Record<string, number> }>
}> {
  return get('/api/pricing', { type: 'channel-pricing' })
}
