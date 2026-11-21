// 已废弃：未来14天计划被定价中心 v1 砍掉，代码保留
// 自动收益管家 二期 — 未来窗口计划生成纯函数（可单测）
import { calculatePricing, isHoliday } from '../pricing-engine.js';
import { countBookedOnDate, forecastOccupancyWithTrend, computeTrendFactor, RobotOrderLike } from './engine.js';

export interface PlanRow {
  planDate: string; roomTypeId: string; roomTypeName: string;
  storeId: string; merchantId: string;
  price: number; predictedOccupancy: number; basePrice: number;
}

export interface GeneratePlansOpts {
  roomTypeId: string; roomTypeName: string; storeId: string; merchantId: string;
  basePrice: number; weekendPrice: number; weekdayPrice: number;
  totalRooms: number; occupiedToday: number;
  orders: RobotOrderLike[];
  startDate: string; days: number;
  commissionRate: number; competitorPrice: number;
  maxDeviationPct: number;
  recentAvg: number; priorAvg: number;
}

/** 计算 [fromDate, toDate) 区间内某房型的平均实际入住率（%），totalRooms<=0 返回 50 */
export function computeOccupancyAvg(
  orders: Array<RobotOrderLike & { roomTypeId?: string }>, roomTypeId: string, totalRooms: number, fromDate: string, toDate: string,
): number {
  if (totalRooms <= 0) return 50;
  let sum = 0, count = 0;
  for (let d = new Date(fromDate + 'T00:00:00Z'); d.toISOString().split('T')[0] < toDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().split('T')[0];
    sum += countBookedOnDate(orders.filter(o => o.roomTypeId === roomTypeId), ds);
    count++;
  }
  return count > 0 ? Math.round((sum / count / totalRooms) * 100) : 50;
}

/** 生成未来 N 天计划（六因子引擎 + 预测入住率 + maxDeviationPct 护栏） */
export function generateFuturePlans(opts: GeneratePlansOpts): PlanRow[] {
  const { roomTypeId, roomTypeName, storeId, merchantId, basePrice, weekendPrice, weekdayPrice,
    totalRooms, occupiedToday, orders, startDate, days, commissionRate, competitorPrice,
    maxDeviationPct, recentAvg, priorAvg } = opts;
  const trend = computeTrendFactor(recentAvg, priorAvg);
  const floor = Math.round(basePrice * (1 - maxDeviationPct / 100));
  const cap = Math.round(basePrice * (1 + maxDeviationPct / 100));
  const rows: PlanRow[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(startDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
    const ds = d.toISOString().split('T')[0];
    const booked = countBookedOnDate(orders, ds);
    const predicted = forecastOccupancyWithTrend(totalRooms, booked, occupiedToday, trend);
    const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    const advice = calculatePricing({
      basePrice: isWeekend ? weekendPrice : weekdayPrice,
      occupancyRate: predicted,
      daysToCheckin: i + 1,
      isWeekend,
      isHoliday: isHoliday(ds),
      commissionRate,
      competitorPrice,
      weatherGood: true,
      hasLocalEvent: false,
      totalRooms,
      occupiedRooms: Math.round(predicted / 100 * totalRooms),
    });
    rows.push({
      planDate: ds, roomTypeId, roomTypeName, storeId, merchantId,
      price: Math.max(floor, Math.min(cap, advice.suggestedPrice)),
      predictedOccupancy: predicted, basePrice,
    });
  }
  return rows;
}
