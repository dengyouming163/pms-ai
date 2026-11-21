/**
 * AI 智能定价引擎 — 六维因子加权模型
 * 每个建议包含完整的推理链（哪个因子贡献了多少），可解释、可审计、可信任
 */

export interface PriceFactor {
  name: string;       // 因子名称
  key: string;        // 因子键
  weight: number;     // 权重（百分比）
  value: number;      // 调整值（百分比，正=提价，负=降价）
  reason: string;     // 推理说明
  dataRef: string;    // 数据来源
}

export interface PricingAdvice {
  roomType: string;
  channel: string;
  basePrice: number;
  suggestedPrice: number;
  totalAdjust: number;   // 总调整百分比
  confidence: number;    // 置信度 0-100
  factors: PriceFactor[];
  expectedRevenue: number;  // 预计增收（元/晚）
  monthlyImpact: number;    // 预计月增收
}

// 天气查询（Open-Meteo 免费API，无需Key）
export async function checkWeatherGood(city: string = '杭州'): Promise<boolean> {
  const coords: Record<string, [number, number]> = {
    '杭州': [30.27, 120.15], '北京': [39.90, 116.41], '上海': [31.23, 121.47],
    '广州': [23.13, 113.26], '成都': [30.57, 104.07], '三亚': [18.25, 109.51],
  };
  const [lat, lon] = coords[city] || [30.27, 120.15];
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode&timezone=Asia/Shanghai&forecast_days=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json() as any;
      const code = data?.daily?.weathercode?.[0] || 0;
      // 0=晴天 1=大部晴 2=多云 → 好天气; 3+=阴雨雪 → 不太好
      return code <= 2;
    }
  } catch {}
  return true; // 查询失败默认乐观
}

/** WMO 天气代码 → 中文描述（Open-Meteo weathercode），供入住指引/提醒等文案使用 */
const WMO_TEXT: Record<number, string> = {
  0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴强冰雹',
};

/**
 * 按门店坐标查询「明日」天气的中文描述（Open-Meteo 免费API，无需Key）。
 * - 坐标缺失/空白/非法 → 直接返回 null（调用方降级为「不含天气」的文案）。
 *   关键：Number('')===0，若先 Number 再判空，空串坐标会以 (0,0) 查真实（错误的）天气（几内亚湾），
 *   故必须先 trim 判空、再 Number。
 * - 0,0 视为缺失：真实门店坐标不可能恰为 (0,0)，防空坐标门店误查。
 * - forecast_days=2 取 daily[1]（明日）：预约确认的入住日通常是未来（当天预约当天入住的很少），
 *   展示「明日/入住日」天气比今日更贴切。
 */
export async function fetchWeatherDescription(latitude: string, longitude: string): Promise<string | null> {
  const latStr = (latitude || '').trim();
  const lonStr = (longitude || '').trim();
  if (!latStr || !lonStr) return null;
  const lat = Number(latStr);
  const lon = Number(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null; // 空坐标门店误查防护
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode&timezone=Asia/Shanghai&forecast_days=2`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json() as any;
      const code = data?.daily?.weathercode?.[1];
      if (typeof code === 'number') return WMO_TEXT[code] ?? null;
    }
  } catch {}
  return null; // 查询失败降级
}

// 中国法定节假日判断（精确到日）
const HOLIDAYS_2026: Record<string, string> = {
  '2026-01-01': '元旦', '2026-01-02': '元旦', '2026-01-03': '元旦',
  '2026-02-17': '除夕', '2026-02-18': '春节', '2026-02-19': '春节', '2026-02-20': '春节', '2026-02-21': '春节', '2026-02-22': '春节', '2026-02-23': '春节',
  '2026-04-05': '清明', '2026-04-06': '清明', '2026-04-07': '清明',
  '2026-05-01': '劳动节', '2026-05-02': '劳动节', '2026-05-03': '劳动节', '2026-05-04': '劳动节', '2026-05-05': '劳动节',
  '2026-06-19': '端午', '2026-06-20': '端午', '2026-06-21': '端午',
  '2026-09-25': '中秋', '2026-09-26': '中秋', '2026-09-27': '中秋',
  '2026-10-01': '国庆', '2026-10-02': '国庆', '2026-10-03': '国庆', '2026-10-04': '国庆', '2026-10-05': '国庆', '2026-10-06': '国庆', '2026-10-07': '国庆',
};

export function isHoliday(dateStr: string): boolean {
  return !!HOLIDAYS_2026[dateStr];
}

export function getHolidayName(dateStr: string): string {
  return HOLIDAYS_2026[dateStr] || '';
}

/** 六维因子计算 */
export function calculatePricing(params: {
  basePrice: number;
  occupancyRate: number;    // 0-100
  daysToCheckin: number;    // 距入住天数
  isWeekend: boolean;
  isHoliday: boolean;
  commissionRate: number;   // 渠道佣金率
  competitorPrice: number;  // 竞品均价
  weatherGood: boolean;     // 天气是否好
  hasLocalEvent: boolean;   // 是否有本地活动
  totalRooms: number;       // 总房量
  occupiedRooms: number;    // 已占房量
}): PricingAdvice {
  const factors: PriceFactor[] = [];
  let totalAdjust = 0;
  let confidenceSum = 0;
  let confidenceWeight = 0;

  // ====== 因子1: 入住率 (权重30%) ======
  const occWeight = 30;
  let occAdjust = 0;
  let occReason = '';
  if (params.occupancyRate >= 85) {
    occAdjust = 5 + Math.min(10, (params.occupancyRate - 85) * 0.5);
    occReason = `入住率${params.occupancyRate}%高于85%，需求旺盛，建议提价`;
  } else if (params.occupancyRate >= 60) {
    occAdjust = -2 + (params.occupancyRate - 60) * 0.15;
    occReason = `入住率${params.occupancyRate}%处于正常区间，微调`;
  } else if (params.occupancyRate >= 30) {
    occAdjust = -5 - (60 - params.occupancyRate) * 0.2;
    occReason = `入住率${params.occupancyRate}%偏低，适度降价促销`;
  } else {
    occAdjust = -15 - (30 - params.occupancyRate) * 0.3;
    occReason = `入住率${params.occupancyRate}%极低，急需降价引流`;
  }
  totalAdjust += occAdjust * occWeight / 100;
  confidenceSum += Math.min(95, 60 + params.occupancyRate * 0.3) * occWeight;
  confidenceWeight += occWeight;
  factors.push({
    name: '入住率因子', key: 'occupancy', weight: occWeight,
    value: Math.round(occAdjust * 10) / 10,
    reason: occReason,
    dataRef: `${params.occupiedRooms}/${params.totalRooms}间已占`,
  });

  // ====== 因子2: 时间窗口 (权重25%) ======
  const timeWeight = 25;
  let timeAdjust = 0;
  let timeReason = '';
  if (params.daysToCheckin <= 1) {
    timeAdjust = 5 + (1 - params.daysToCheckin) * 3;
    timeReason = '今日/明日入住，临期溢价';
  } else if (params.daysToCheckin <= 3) {
    timeAdjust = 2 + (3 - params.daysToCheckin) * 1.5;
    timeReason = `距入住仅${params.daysToCheckin}天，适度提价`;
  } else if (params.daysToCheckin <= 7) {
    timeAdjust = 0;
    timeReason = `距入住${params.daysToCheckin}天，维持现价`;
  } else if (params.daysToCheckin <= 14) {
    timeAdjust = params.occupancyRate < 50 ? -3 : 1;
    timeReason = params.occupancyRate < 50
      ? `距入住${params.daysToCheckin}天且入住率低，提前降价锁客`
      : `距入住${params.daysToCheckin}天，微调试探市场`;
  } else {
    timeAdjust = params.occupancyRate < 40 ? -5 : -1;
    timeReason = params.occupancyRate < 40
      ? `远期空房多，早鸟降价引流`
      : `远期预订，保守定价`;
  }
  totalAdjust += timeAdjust * timeWeight / 100;
  confidenceSum += 70 * timeWeight;
  confidenceWeight += timeWeight;
  factors.push({
    name: '时间因子', key: 'time_window', weight: timeWeight,
    value: Math.round(timeAdjust * 10) / 10,
    reason: timeReason,
    dataRef: `距入住${params.daysToCheckin}天`,
  });

  // ====== 因子3: 周期因子 (权重20%) ======
  const cycleWeight = 20;
  let cycleAdjust = 0;
  let cycleReason = '';
  if (params.isHoliday) {
    cycleAdjust = 30;
    cycleReason = '节假日期间，大幅提价';
  } else if (params.isWeekend) {
    cycleAdjust = 15;
    cycleReason = '周末需求高，自然溢价';
  } else {
    cycleAdjust = 0;
    cycleReason = '工作日，基准定价';
  }
  totalAdjust += cycleAdjust * cycleWeight / 100;
  confidenceSum += 85 * cycleWeight;
  confidenceWeight += cycleWeight;
  factors.push({
    name: '周期因子', key: 'cycle', weight: cycleWeight,
    value: Math.round(cycleAdjust * 10) / 10,
    reason: cycleReason,
    dataRef: params.isHoliday ? '节假日' : params.isWeekend ? '周末' : '工作日',
  });

  // ====== 因子4: 渠道佣金 (权重10%) ======
  const chWeight = 10;
  let chAdjust = 0;
  let chReason = '';
  if (params.commissionRate >= 15) {
    chAdjust = 3 + (params.commissionRate - 15) * 0.3;
    chReason = `佣金率${params.commissionRate}%较高，需提价覆盖渠道成本`;
  } else if (params.commissionRate >= 10) {
    chAdjust = 1;
    chReason = `佣金率${params.commissionRate}%适中，微调`;
  } else if (params.commissionRate <= 5) {
    chAdjust = -2;
    chReason = `佣金率${params.commissionRate}%低，可更激进定价`;
  } else {
    chAdjust = 0;
    chReason = `佣金率${params.commissionRate}%，正常定价`;
  }
  totalAdjust += chAdjust * chWeight / 100;
  confidenceSum += 75 * chWeight;
  confidenceWeight += chWeight;
  factors.push({
    name: '渠道因子', key: 'channel', weight: chWeight,
    value: Math.round(chAdjust * 10) / 10,
    reason: chReason,
    dataRef: `佣金率${params.commissionRate}%`,
  });

  // ====== 因子5: 竞品因子 (权重10%) ======
  const compWeight = 10;
  let compAdjust = 0;
  let compReason = '';
  if (params.competitorPrice > 0) {
    const diff = ((params.competitorPrice - params.basePrice) / params.basePrice) * 100;
    if (diff > 10) {
      compAdjust = 3 + Math.min(5, (diff - 10) * 0.3);
      compReason = `竞品均价¥${params.competitorPrice}高于我${Math.round(diff)}%，有提价空间`;
    } else if (diff > 0) {
      compAdjust = 1;
      compReason = `竞品均价¥${params.competitorPrice}略高，可微提`;
    } else if (diff > -10) {
      compAdjust = -1;
      compReason = `竞品均价¥${params.competitorPrice}略低，保持竞争力`;
    } else {
      compAdjust = -3;
      compReason = `竞品均价¥${params.competitorPrice}低于我${Math.round(-diff)}%，需降价跟随`;
    }
  } else {
    compReason = '暂无竞品数据';
  }
  totalAdjust += compAdjust * compWeight / 100;
  confidenceSum += compAdjust !== 0 ? 60 * compWeight : 40 * compWeight;
  confidenceWeight += compWeight;
  factors.push({
    name: '竞品因子', key: 'competitor', weight: compWeight,
    value: Math.round(compAdjust * 10) / 10,
    reason: compReason,
    dataRef: params.competitorPrice > 0 ? `竞品均价¥${params.competitorPrice}` : '无竞品数据',
  });

  // ====== 因子6: 事件因子 (权重5%) ======
  const eventWeight = 5;
  let eventAdjust = 0;
  let eventReason = '';
  if (params.hasLocalEvent) {
    eventAdjust = 3;
    eventReason = '本地有活动，可能带来额外客流';
  } else if (!params.weatherGood) {
    eventAdjust = -3;
    eventReason = '天气不佳，可能影响出行意愿';
  } else {
    eventReason = '无特殊事件影响';
  }
  totalAdjust += eventAdjust * eventWeight / 100;
  confidenceSum += 50 * eventWeight;
  confidenceWeight += eventWeight;
  factors.push({
    name: '事件因子', key: 'event', weight: eventWeight,
    value: Math.round(eventAdjust * 10) / 10,
    reason: eventReason,
    dataRef: params.hasLocalEvent ? '有本地活动' : params.weatherGood ? '天气晴好' : '天气不佳',
  });

  // ====== 综合计算 ======
  const suggestedPrice = Math.round(params.basePrice * (1 + totalAdjust / 100));
  const confidence = Math.round(confidenceSum / confidenceWeight);
  const expectedRevenue = suggestedPrice - params.basePrice;
  const monthlyImpact = params.totalRooms > 0
    ? Math.round(expectedRevenue * (params.occupiedRooms / params.totalRooms) * 30)
    : Math.round(expectedRevenue * 10);

  return {
    roomType: '',
    channel: '',
    basePrice: params.basePrice,
    suggestedPrice: Math.max(params.basePrice * 0.5, suggestedPrice),
    totalAdjust: Math.round(totalAdjust * 10) / 10,
    confidence: Math.max(30, Math.min(98, confidence)),
    factors,
    expectedRevenue,
    monthlyImpact,
  };
}
