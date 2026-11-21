// 定价中心 — 今日推荐计算（路由与每日仪式共用的数据装配层）
import { db } from '../../db/index.js';
import {
  pmsBuiRoomTypes, pmsBuiRooms, pmsBuiOrders, pmsBuiDailyPrice, pmsBuiHolidays,
  pmsBuiCompetitorConfig, pmsPriceRobotConfig,
} from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { suggestToday, calcDefaultPrice } from './engine.js';
import { countBookedOnDate } from '../price-robot/engine.js';
import type { TenantScope } from '../../utils/tenant.js';

// 北京时间今天 YYYY-MM-DD
export function todayStr(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// 用 UTC 解析避免服务器时区偏移
export function isWeekend(date: string): boolean {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}
export function resolveStoreId(scope: TenantScope): string {
  return scope.storeId === '*' ? 'default_store' : scope.storeId;
}

// 门店级 config（room_type_id='*'），无则给默认值
export async function getStoreConfig(storeId: string) {
  const [cfg] = await db.select().from(pmsPriceRobotConfig)
    .where(and(eq(pmsPriceRobotConfig.storeId, storeId), eq(pmsPriceRobotConfig.roomTypeId, '*')))
    .limit(1);
  return {
    channels: cfg?.channels?.length ? cfg.channels : ['携程', '美团'],
    holidayMarkupPct: cfg?.holidayMarkupPct ?? 20,
    recommendationEnabled: cfg?.recommendationEnabled ?? true,
  };
}

// 今日推荐房型卡数据
export interface TodayRoom {
  roomTypeId: string; roomTypeName: string;
  currentPrice: number; defaultPrice: number; suggestedPrice: number | null; change: number;
  reasons: string[]; remaining: number; total: number; occupancyPct: number;
  minPrice: number | null; soldOut: boolean; holiday: string | null; dailySource: string | null;
}
export interface TodayData {
  date: string; dateLabel: string; recommendationEnabled: boolean; rooms: TodayRoom[];
}

// 计算某门店今日推荐（出卡/不出卡规则：建议价=现行价则不出卡）
export async function buildTodayData(storeId: string): Promise<TodayData> {
  const date = todayStr();
  const cfg = await getStoreConfig(storeId);
  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.storeId, storeId));
  const rooms = await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId));
  const orders = await db.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.storeId, storeId)) as any[];
  const daily = await db.select().from(pmsBuiDailyPrice)
    .where(and(eq(pmsBuiDailyPrice.storeId, storeId), eq(pmsBuiDailyPrice.date, date)));
  const holidays = await db.select().from(pmsBuiHolidays);
  const competitors = await db.select().from(pmsBuiCompetitorConfig)
    .where(and(eq(pmsBuiCompetitorConfig.storeId, storeId), eq(pmsBuiCompetitorConfig.status, 'active')));

  const isHol = holidays.some(h => h.date === date);
  const holidayName = holidays.find(h => h.date === date)?.name;
  const wend = isWeekend(date);

  const recs: TodayRoom[] = roomTypes
    .filter(rt => rt.status === 'active')
    .map((rt) => {
      const rtRooms = rooms.filter(r => r.roomTypeId === rt.id);
      const total = rtRooms.length || rt.roomCount || 0;
      const occupied = rtRooms.filter(r => r.status === 'occupied').length;
      const booked = countBookedOnDate(orders.filter(o => o.roomTypeId === rt.id), date);
      const dailyRow = daily.find(d => d.roomTypeId === rt.id);
      const defaultPrice = calcDefaultPrice({
        isWeekend: wend, isHoliday: isHol, holidayMarkupPct: cfg.holidayMarkupPct,
        baseWeekday: rt.weekdayPrice || rt.basePrice, baseWeekend: rt.weekendPrice || rt.basePrice,
        basePrice: rt.basePrice,
      });
      const currentPrice = dailyRow ? dailyRow.price : defaultPrice;
      const comp = competitors.find(c => c.ourRoomTypeId === rt.id);
      const s = suggestToday({
        isWeekend: wend, isHoliday: isHol, holidayMarkupPct: cfg.holidayMarkupPct,
        baseWeekday: rt.weekdayPrice || rt.basePrice, baseWeekend: rt.weekendPrice || rt.basePrice,
        basePrice: rt.basePrice,
        totalRooms: total, booked, occupied,
        competitorPrice: comp?.lastPrice ?? null,
        minPrice: rt.minPrice ?? null,
        currentPrice,
      });
      // 出卡/不出卡：有变化才建议；满房标 soldOut 由前端隐藏
      const suggested = s.change !== 0 ? s.suggestedPrice : null;
      return {
        roomTypeId: rt.id, roomTypeName: rt.name,
        currentPrice, defaultPrice, suggestedPrice: suggested, change: s.change,
        reasons: s.reasons, remaining: s.remaining, total, occupancyPct: s.occupancyPct,
        minPrice: rt.minPrice, soldOut: total > 0 && booked >= total,
        holiday: isHol ? (holidayName ?? null) : null,
        dailySource: dailyRow?.source ?? null,
      };
    });

  return {
    date,
    dateLabel: `${date} · ${isHol ? holidayName : (wend ? '周末' : '工作日')}`,
    recommendationEnabled: cfg.recommendationEnabled,
    rooms: recs,
  };
}
