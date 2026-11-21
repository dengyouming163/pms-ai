/** 房型价格来源字段 */
export interface RoomTypePrice {
  id: string;
  name: string;
  basePrice: number;
  weekendPrice?: number | null;
}

/** 枚举入住到退房之间的每一晚（'YYYY-MM-DD'，退房日不含） */
export function enumerateNights(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  const start = new Date(checkIn + 'T00:00:00');
  const end = new Date(checkOut + 'T00:00:00');
  for (let d = start; d < end; d = new Date(d.getTime() + 86400000)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    nights.push(`${y}-${m}-${day}`);
  }
  return nights;
}

/**
 * 逐晚算价：价格日历覆盖价 > 周末价（周五/周六） > 基础价
 * overrides: date → 覆盖价（元）
 */
export function calcNightlyPrices(
  dates: string[],
  overrides: Map<string, number>,
  roomType: RoomTypePrice,
): { date: string; price: number }[] {
  return dates.map((date) => {
    const override = overrides.get(date);
    if (override != null) return { date, price: override };
    const day = new Date(date + 'T00:00:00').getDay();
    const isWeekend = day === 5 || day === 6;
    const price = isWeekend && roomType.weekendPrice ? roomType.weekendPrice : roomType.basePrice;
    return { date, price };
  });
}

/** 从价格日历行构建某房型的覆盖价映射（roomTypes 为 [{name, roomTypeId?, price}] 数组） */
export function buildOverrideMap(
  calendarRows: { date: string; roomTypes: unknown }[],
  roomType: { id: string; name: string },
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of calendarRows) {
    const arr = Array.isArray(row.roomTypes) ? (row.roomTypes as any[]) : [];
    const hit = arr.find((r) => r.roomTypeId === roomType.id || r.name === roomType.name);
    if (hit?.price != null) map.set(String(row.date), Number(hit.price));
  }
  return map;
}
