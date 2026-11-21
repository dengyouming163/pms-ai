// 自动收益管家 — 定价内核纯函数（无副作用，可单测）

// 三档策略表：时点 → 相对底价的浮动百分比
export const SLOT_STRATEGIES = {
  aggressive: { '17:00': 25, '19:00': 10, '21:00': 0 },
  standard: { '17:00': 15, '19:00': 5, '21:00': 0 },
  conservative: { '17:00': 8, '19:00': 2, '21:00': 0 },
} as const;

export type Strategy = keyof typeof SLOT_STRATEGIES;
export const DEFAULT_SLOTS = ['17:00', '19:00', '21:00'] as const;
export const DEFAULT_CAP_RATIO = 1.5;

/**
 * 计算某时点的浮动百分比
 * @param strategy 策略档位
 * @param slot 时点，如 '17:00'
 * @param remainingRatio 剩余率 0..1（剩余房量/总房量），房越多浮动越低
 */
export function calcFloatPct(strategy: Strategy, slot: string, remainingRatio: number): number {
  const base = (SLOT_STRATEGIES[strategy] as Record<string, number | undefined>)[slot];
  if (base === undefined) throw new Error(`无效的时点 ${slot} 或策略 ${strategy}`);
  const ratio = Math.max(0, Math.min(1, remainingRatio));
  const coeff = 1 - ratio * 0.3; // 智能系数：剩余率越高，浮动越低（最多降低 30%）
  return Math.round(base * coeff);
}

/**
 * 目标价计算 + 硬护栏：结果 ∈ [floor, floor×capRatio]，超出即截断
 */
export function calcTargetPrice(floorPrice: number, floatPct: number, capRatio = DEFAULT_CAP_RATIO): number {
  const raw = Math.round(floorPrice * (1 + floatPct / 100));
  const cap = Math.round(floorPrice * capRatio);
  return Math.max(floorPrice, Math.min(cap, raw));
}

/**
 * 预测入住率（on-the-books 加权）：当日 = 已订 + 在住×0.3
 */
export function forecastOccupancy(totalRooms: number, bookedOnDate: number, occupiedToday = 0): number {
  if (totalRooms <= 0) return 50;
  const numerator = bookedOnDate + occupiedToday * 0.3;
  return Math.min(100, Math.round((numerator / totalRooms) * 100));
}

/** 今日剩余房量 = 总房量 − 已订覆盖 − 在住（不为负） */
export function calcRemainingRooms(totalRooms: number, bookedToday: number, occupiedToday: number): number {
  return Math.max(0, totalRooms - bookedToday - occupiedToday);
}

/**
 * 生成某授权的全部时点目标价计划
 * @returns { slot: { floatPct, targetPrice } }
 */
export function buildSlotTargets(
  floorPrice: number, strategy: Strategy, remainingRatio: number, capRatio = DEFAULT_CAP_RATIO,
): Record<string, { floatPct: number; targetPrice: number }> {
  const out: Record<string, { floatPct: number; targetPrice: number }> = {};
  for (const slot of Object.keys(SLOT_STRATEGIES[strategy])) {
    const floatPct = calcFloatPct(strategy, slot, remainingRatio);
    out[slot] = { floatPct, targetPrice: calcTargetPrice(floorPrice, floatPct, capRatio) };
  }
  return out;
}

/** 结构性订单类型（避免依赖 DB schema，便于单测） */
export interface RobotOrderLike {
  checkIn: string;
  checkOut: string;
  status: string;
}

/** 计算指定日期某房型已订房量（订单覆盖该日期：checkIn <= date < checkOut 且未取消/未到店） */
export function countBookedOnDate(orders: RobotOrderLike[], date: string): number {
  return orders.filter(o => {
    if (o.status === 'cancelled' || o.status === 'no_show') return false;
    return o.checkIn <= date && date < o.checkOut;
  }).length;
}

/**
 * 趋势因子：近 7 天实际入住率 − 前 7 天实际入住率，clamp [-10, +10]
 * 衡量需求趋势（上升/下降），用于未来窗口的预测入住率微调
 */
export function computeTrendFactor(recentAvg: number, priorAvg: number): number {
  if (!Number.isFinite(recentAvg) || !Number.isFinite(priorAvg)) return 0;
  return Math.max(-10, Math.min(10, Math.round(recentAvg - priorAvg)));
}

/** 预测入住率 + 趋势因子，clamp [5, 100] */
export function forecastOccupancyWithTrend(
  totalRooms: number, bookedOnDate: number, occupiedToday = 0, trendFactor = 0,
): number {
  const base = forecastOccupancy(totalRooms, bookedOnDate, occupiedToday);
  return Math.max(5, Math.min(100, base + trendFactor));
}
