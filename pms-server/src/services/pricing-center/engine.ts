// 定价中心推荐引擎（纯函数，v1 简单可解释规则）
// 规则：默认价(基础×节假日) → 需求因子(剩余率) → 竞对因子(真实数据) → 护栏钳制
// 理由只来自真实计算因子，禁止硬编码假因子。

export interface DefaultPriceInput {
  baseWeekday: number;
  baseWeekend: number;
  basePrice: number;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayMarkupPct: number; // 0-100，如 40 表示 +40%
}

export interface SuggestInput extends DefaultPriceInput {
  totalRooms: number;
  booked: number;              // 覆盖该日的已订
  occupied: number;            // 在住
  competitorPrice: number | null; // 真实竞对价（无则 null）
  minPrice: number | null;     // 最低卖价护栏（无则默认基础价×0.7）
  maxPrice?: number;           // 上限（默认基础价×1.5）
  currentPrice: number;        // 今日现行价（采纳价或默认价）
}

export interface SuggestResult {
  defaultPrice: number;   // 无采纳时的默认价
  suggestedPrice: number; // 建议价
  change: number;         // suggestedPrice - currentPrice
  remaining: number;
  occupancyPct: number;
  reasons: string[];      // 大白话理由（≤2 条，仅真实因子）
}

/**
 * 计算默认价（无采纳时的兜底价）：基础价(平日/周末) × (1+节假日加价%)
 * @param i 基础价/周末/节假日等输入
 * @returns 无采纳时的默认价（整数）
 */
export function calcDefaultPrice(i: DefaultPriceInput): number {
  const base = i.isWeekend ? (i.baseWeekend || i.basePrice) : (i.baseWeekday || i.basePrice);
  return i.isHoliday ? Math.round(base * (1 + i.holidayMarkupPct / 100)) : base;
}

/**
 * 生成今日推荐：返回建议价/改动幅度/剩余房量/入住率/大白话理由。
 * 建议价已受 [最低卖价, 上限] 护栏钳制；未配置房型（totalRooms<=0）返回哨兵结果（change=0，调用方不出卡）。
 * @param i 需求/竞对/护栏/现行价等输入
 * @returns 推荐结果（建议价受护栏钳制；哨兵结果建议价=默认价且 change=0）
 */
export function suggestToday(i: SuggestInput): SuggestResult {
  const defaultPrice = calcDefaultPrice(i);
  // 未配置房型（totalRooms=0）：不产无意义建议，返回默认价且 change=0（调用方据此不出卡）
  if (i.totalRooms <= 0) {
    return { defaultPrice, suggestedPrice: defaultPrice, change: 0, remaining: 0, occupancyPct: 0, reasons: [] };
  }
  const remaining = Math.max(0, i.totalRooms - i.booked - i.occupied);
  const occupancyPct = i.totalRooms > 0
    ? Math.round(((i.booked + i.occupied * 0.3) / i.totalRooms) * 100)
    : 0;
  const remainingRatio = i.totalRooms > 0 ? remaining / i.totalRooms : 0;

  let price = defaultPrice;
  const reasons: string[] = [];

  // 需求因子
  if (remainingRatio < 0.3) {
    const lift = Math.max(8, Math.round(20 * (1 - remainingRatio / 0.3)));
    price = Math.round(price * (1 + lift / 100));
    reasons.push(`已订${i.booked}/${i.totalRooms}间，剩余不多`);
  } else if (remainingRatio > 0.7) {
    price = Math.round(price * 0.92);
    reasons.push(`剩余${remaining}间较多，小幅下调促单`);
  }

  // 竞对因子（仅真实数据）——基准用 defaultPrice（未经需求因子调整）：竞对与需求为独立信号，
  // 互不抑制；叠加后由护栏兜底上限。
  if (i.competitorPrice && i.competitorPrice > 0) {
    const diff = ((i.competitorPrice - defaultPrice) / defaultPrice) * 100;
    // 阈值用开区间（>5 / <-5），恰好等于阈值时不触发，避免价格抖动
    if (diff > 5) { price = Math.round(price * 1.05); reasons.push(`竞对¥${i.competitorPrice}高于你`); }
    else if (diff < -5) { price = Math.round(price * 0.97); reasons.push(`竞对¥${i.competitorPrice}低于你`); }
  }

  // 护栏
  const floor = i.minPrice ?? Math.round(defaultPrice * 0.7);
  const cap = i.maxPrice ?? Math.round(defaultPrice * 1.5);
  const suggestedPrice = Math.min(Math.max(price, floor), cap);

  // 去重、截断理由
  const uniq = [...new Set(reasons)].slice(0, 2);
  return {
    defaultPrice,
    suggestedPrice,
    change: suggestedPrice - i.currentPrice,
    remaining,
    occupancyPct,
    reasons: uniq,
  };
}
