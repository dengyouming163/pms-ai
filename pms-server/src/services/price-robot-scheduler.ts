// pms-server/src/services/price-robot-scheduler.ts
// 自动收益管家 — 调度器：授权确认后按 17/19/21 时点（北京时间）生成改价任务
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsPriceRobotAuth, pmsPriceRobotTasks, pmsPriceRobotConfig, pmsPriceRobotPlans, pmsPriceRobotLogs } from '../db/schema/price-robot.js';
import { pmsBuiRoomTypes, pmsBuiRooms, pmsBuiOrders, pmsBuiChannels, pmsBuiStores } from '../db/schema/index.js';
import {
  countBookedOnDate, calcRemainingRooms, calcFloatPct, calcTargetPrice, buildSlotTargets,
  DEFAULT_CAP_RATIO,
} from './price-robot/engine.js';
import { buildTodayData } from './pricing-center/recommend.js';
import type { Strategy } from './price-robot/engine.js';
import { generateFuturePlans, computeOccupancyAvg } from './price-robot/planner.js';

const BJ_OFFSET_MS = 8 * 3600 * 1000; // 北京时间 = UTC+8

let timer: NodeJS.Timeout | null = null;
let running = false; // 重入守卫：单次调度未跑完时跳过下一次 tick，避免并发重复产单
const STALE_MS = 2 * 60 * 60 * 1000; // 执行窗口已过 2 小时仍 pending 的任务视为过期（与客户端心跳阈值一致）

export function startPriceRobotScheduler(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(checkSlots, intervalMs);
  checkSlots();
}

export function stopPriceRobotScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 北京时间（东八区）当天日期 YYYY-MM-DD */
export function todayBj(): string {
  return new Date(Date.now() + BJ_OFFSET_MS).toISOString().split('T')[0];
}

// 保留：供未来恢复 auth 产单时使用（定价中心 v1 已停用 auth 时点产单，本函数不再被调用）
/** 判断北京时间时点是否已到达（时点后 15 分钟窗口内） */
function isSlotArrived(slot: string, now = new Date()): boolean {
  const [h, m] = slot.split(':').map(Number);
  // 把 now 平移至北京时间，取当天 0 点
  const nowBj = new Date(now.getTime() + BJ_OFFSET_MS);
  const dayStartUtc = Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate());
  const slotStart = dayStartUtc - BJ_OFFSET_MS + (h * 3600 + m * 60) * 1000;
  return now.getTime() >= slotStart && now.getTime() < slotStart + 15 * 60_000;
}

async function checkSlots() {
  if (running) return; // 重入守卫：上一次调度仍在执行时跳过本次 tick
  running = true;
  try {
    const date = todayBj();
    const now = new Date();
    // 定价中心 v1：今日产单统一由 /adopt 生成，停用 auth 时点产单（防止双轨重复改价）。代码保留以便日后启用。
    // const auths = await db.select().from(pmsPriceRobotAuth)
    //   .where(and(eq(pmsPriceRobotAuth.date, date), eq(pmsPriceRobotAuth.status, 'confirmed')));
    //
    // for (const auth of auths) {
    //   if (auth.expireAt && now > new Date(auth.expireAt)) {
    //     await db.update(pmsPriceRobotAuth).set({ status: 'expired' }).where(eq(pmsPriceRobotAuth.id, auth.id));
    //     continue;
    //   }
    //   const [cfg] = await db.select().from(pmsPriceRobotConfig)
    //     .where(and(eq(pmsPriceRobotConfig.storeId, auth.storeId), eq(pmsPriceRobotConfig.roomTypeId, auth.roomTypeId)))
    //     .limit(1);
    //   if (!cfg || !cfg.enabled) continue;
    //   const slots: string[] = (cfg.slots || [...DEFAULT_SLOTS]);
    //
    //   for (const slot of slots) {
    //     if (!isSlotArrived(slot, now)) continue;
    //     const [existing] = await db.select({ id: pmsPriceRobotTasks.id }).from(pmsPriceRobotTasks)
    //       .where(and(
    //         eq(pmsPriceRobotTasks.date, date), eq(pmsPriceRobotTasks.slot, slot),
    //         eq(pmsPriceRobotTasks.storeId, auth.storeId),
    //         eq(pmsPriceRobotTasks.roomTypeId, auth.roomTypeId),
    //       )).limit(1);
    //     if (existing) continue;
    //     await generateTasksForSlot(auth, cfg, slot, date);
    //   }
    // }

    // 清理：执行窗口已过 2 小时仍 pending 的任务标记 skipped（未在窗口内被客户端执行）
    const stale = await db.select({ id: pmsPriceRobotTasks.id, slot: pmsPriceRobotTasks.slot }).from(pmsPriceRobotTasks)
      .where(and(eq(pmsPriceRobotTasks.date, date), eq(pmsPriceRobotTasks.status, 'pending')));
    for (const t of stale) {
      const [h, m] = t.slot.split(':').map(Number);
      const nowBj = new Date(now.getTime() + BJ_OFFSET_MS);
      const dayStartUtc = Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate());
      const slotStart = dayStartUtc - BJ_OFFSET_MS + (h * 3600 + m * 60) * 1000;
      if (now.getTime() - slotStart > STALE_MS) {
        await db.update(pmsPriceRobotTasks).set({ status: 'skipped', error: '时点已过，未执行' }).where(eq(pmsPriceRobotTasks.id, t.id));
      }
    }
  } catch (e) {
    console.error('[price-robot] scheduler error:', e);
  } finally {
    running = false;
  }
}

// 保留：供未来恢复 auth 产单时使用（定价中心 v1 已停用 auth 时点产单，本函数不再被调用）
async function generateTasksForSlot(auth: any, cfg: any, slot: string, date: string) {
  const [roomType] = await db.select().from(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.id, auth.roomTypeId)).limit(1);
  if (!roomType) return;

  const rtRooms = await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.roomTypeId, auth.roomTypeId));
  const total = rtRooms.length || roomType.roomCount || 10;
  const occupied = rtRooms.filter(r => r.status === 'occupied').length;
  const orders = await db.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.storeId, auth.storeId)) as any[];
  // 按房型统计该房型当天已订（与 /suggestion 口径一致，避免整店串算）
  const booked = countBookedOnDate(orders.filter((o: any) => o.roomTypeId === auth.roomTypeId), date);
  const remaining = calcRemainingRooms(total, booked, occupied);
  const remainingRatio = total > 0 ? remaining / total : 1;

  const floatPct = calcFloatPct(auth.strategy, slot, remainingRatio);
  const capRatio = Number(cfg.floorCapRatio) || DEFAULT_CAP_RATIO;
  const targetPrice = calcTargetPrice(Number(auth.floorPrice), floatPct, capRatio);

  const channels: string[] = (cfg.channels || ['携程', '美团']);
  await db.insert(pmsPriceRobotTasks).values(channels.map(ch => ({
    id: `prt_${auth.storeId}_${date}_${slot}_${auth.roomTypeId}_${ch}`,
    date, slot, merchantId: auth.merchantId, storeId: auth.storeId,
    roomTypeId: auth.roomTypeId, roomTypeName: roomType.name,
    channel: ch, targetPrice: String(targetPrice), status: 'pending',
    createdAt: new Date(),
  }) as any)).onConflictDoNothing();
}

// ===== 二期：每日 6:00（北京时间）为启用机器人的门店×房型生成未来 14 天计划价 =====

let planTimer: NodeJS.Timeout | null = null;
let lastPlanDate = '';

/** 启动未来窗口计划生成器：每天 6:00（北京时间）生成未来 14 天计划 */
export function startPriceRobotPlanner() {
  if (planTimer) return;
  planTimer = setInterval(checkPlanTime, 60_000);
  checkPlanTime();
}

export function stopPriceRobotPlanner() {
  if (planTimer) { clearInterval(planTimer); planTimer = null; }
}

/** 判断是否到 6:00~6:14（北京时间）窗口 */
function isPlanTime(now = new Date()): boolean {
  const nowBj = new Date(now.getTime() + BJ_OFFSET_MS);
  const h = nowBj.getUTCHours(), m = nowBj.getUTCMinutes();
  return h === 6 && m < 15;
}

async function checkPlanTime() {
  const date = todayBj();
  if (!isPlanTime() || lastPlanDate === date) return;
  lastPlanDate = date;
  try {
    // 一键模式：每日 6:00 为 autoConfirm 门店自动生成并确认当日授权（独立 try/catch，失败不影响计划生成）
    try {
      await autoConfirmToday(date);
    } catch (e) { console.error('[price-robot] autoConfirm error:', e); }
    const configs = await db.select().from(pmsPriceRobotConfig).where(eq(pmsPriceRobotConfig.enabled, true));
    const storeIds = [...new Set(configs.map(c => c.storeId))];
    for (const storeId of storeIds) {
      await generatePlansForStore(storeId, date);
    }
  } catch (e) { console.error('[price-robot] planner error:', e); }
}

// ===== 一期一键模式：每日 6:00 自动确认当日授权（autoConfirm 门店，底价 clamp 到门店 globalFloor） =====

/**
 * 一键模式自动确认：为所有开启 autoConfirm 的门店生成当日 confirmed 授权。
 * 幂等：某门店当日已存在 confirmed 授权则跳过（不重复生成）；auth 表 (date,store,roomType) 唯一索引兜底。
 * 建议底价与 GET /api/price-robot/suggestion 同口径（周中/周末基准，剩余 ≥ 50% 下调 15%）。
 * @returns 本次新增授权的房型条数
 */
export async function autoConfirmToday(date = todayBj()): Promise<number> {
  // store 级设置行：room_type_id='*' 且 autoConfirm=true
  const storeRows = await db.select().from(pmsPriceRobotConfig)
    .where(and(eq(pmsPriceRobotConfig.roomTypeId, '*'), eq(pmsPriceRobotConfig.autoConfirm, true)));
  const storeIds = [...new Set(storeRows.map(r => r.storeId))];
  let created = 0;
  for (const storeId of storeIds) {
    created += await autoConfirmForStore(storeId, date);
  }
  return created;
}

/** 为单个门店生成当日 confirmed 授权（幂等：已有 confirmed 授权则跳过） */
async function autoConfirmForStore(storeId: string, date: string): Promise<number> {
  const [storeCfg] = await db.select().from(pmsPriceRobotConfig)
    .where(and(eq(pmsPriceRobotConfig.storeId, storeId), eq(pmsPriceRobotConfig.roomTypeId, '*')))
    .limit(1);
  if (!storeCfg?.autoConfirm) return 0;
  const globalFloor = storeCfg.globalFloor != null ? Number(storeCfg.globalFloor) : null;

  // 幂等：该门店当日已有 confirmed 授权则整体跳过（店主手动确认过 / 本函数已跑过）
  const [existing] = await db.select({ id: pmsPriceRobotAuth.id }).from(pmsPriceRobotAuth)
    .where(and(eq(pmsPriceRobotAuth.storeId, storeId), eq(pmsPriceRobotAuth.date, date), eq(pmsPriceRobotAuth.status, 'confirmed')))
    .limit(1);
  if (existing) return 0;

  // 与 /suggestion 同口径读取房型 / 房间 / 订单
  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.storeId, storeId));
  const rooms = await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId));
  const orders = await db.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.storeId, storeId)) as any[];
  const roomCfgRows = await db.select().from(pmsPriceRobotConfig)
    .where(and(eq(pmsPriceRobotConfig.storeId, storeId), eq(pmsPriceRobotConfig.enabled, true)));

  const expireAt = new Date(`${date}T22:00:00+08:00`); // 与授权日期对齐（东八区 22:00 失效），与手动 /auth 一致
  let created = 0;
  for (const rt of roomTypes) {
    const rtRooms = rooms.filter(r => r.roomTypeId === rt.id);
    const total = rtRooms.length || rt.roomCount || 10;
    const occupied = rtRooms.filter(r => r.status === 'occupied').length;
    const booked = countBookedOnDate(orders.filter((o: any) => o.roomTypeId === rt.id), date);
    const remaining = calcRemainingRooms(total, booked, occupied);
    // 建议底价口径：周中/周末基准价，剩余 ≥ 50% 则下调 15%（与 /suggestion 一致）
    const isWeekend = new Date(date).getDay() === 0 || new Date(date).getDay() === 6;
    const basePrice = Number((isWeekend ? rt.weekendPrice : rt.weekdayPrice) || rt.basePrice || 0);
    const suggested = remaining >= total * 0.5 ? Math.round(basePrice * 0.85) : basePrice;
    // clamp 到门店全局最低卖价（globalFloor 为 null 时不约束）
    const floorPrice = globalFloor != null ? Math.max(suggested, globalFloor) : suggested;
    if (!(floorPrice > 0)) continue;

    const cfg = roomCfgRows.find(cc => cc.roomTypeId === rt.id);
    const strategy = (cfg?.strategy || storeCfg.strategy || 'standard') as Strategy;
    const authId = `pra_${storeId}_${date}_${rt.id}`;
    const slotPlans = buildSlotTargets(floorPrice, strategy, 0); // 展示用计划（执行时重算浮动）
    const plans: Record<string, number> = {};
    for (const [slot, p] of Object.entries(slotPlans)) plans[slot] = p.targetPrice;

    await db.insert(pmsPriceRobotAuth).values({
      id: authId, date, merchantId: storeCfg.merchantId, storeId,
      roomTypeId: rt.id, floorPrice: String(floorPrice),
      strategy, slotPlans: plans, authBy: 'auto', authAt: new Date(),
      expireAt, status: 'confirmed',
    } as any).onConflictDoNothing();
    created++;
  }
  return created;
}

async function generatePlansForStore(storeId: string, startDate: string) {
  const roomTypes = await db.select().from(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.storeId, storeId));
  const rooms = await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId));
  const orders = await db.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.storeId, storeId)) as any[];
  const channels = await db.select().from(pmsBuiChannels).where(and(eq(pmsBuiChannels.storeId, storeId), eq(pmsBuiChannels.status, 'active')));
  const [store] = await db.select().from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId));
  const merchantId = store?.merchantId || '';

  // 近 14 天实际入住率（近 7 天 vs 前 7 天），用于趋势因子
  const dayStr = (offset: number) => { const d = new Date(startDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().split('T')[0]; };
  const avg = (fromOff: number, toOff: number, rtId: string, total: number) =>
    computeOccupancyAvg(orders, rtId, total, dayStr(fromOff), dayStr(toOff));

  for (const rt of roomTypes) {
    const rtRooms = rooms.filter(r => r.roomTypeId === rt.id);
    const total = rtRooms.length || rt.roomCount || 10;
    const occupied = rtRooms.filter(r => r.status === 'occupied').length;
    const recentAvg = avg(-7, 0, rt.id, total);
    const priorAvg = avg(-14, -7, rt.id, total);
    const commission = channels[0]?.commissionRate ? Number(channels[0].commissionRate) : 10;
    const basePrice = Number(rt.basePrice || 0);
    const plans = generateFuturePlans({
      roomTypeId: rt.id, roomTypeName: rt.name, storeId, merchantId,
      basePrice, weekendPrice: Number(rt.weekendPrice || basePrice), weekdayPrice: Number(rt.weekdayPrice || basePrice),
      totalRooms: total, occupiedToday: occupied,
      orders, startDate, days: 14,
      commissionRate: commission, competitorPrice: Math.round((rt.weekdayPrice || rt.basePrice || 0) * 1.05),
      maxDeviationPct: 30, recentAvg, priorAvg,
    });
    for (const p of plans) {
      const id = `prp_${storeId}_${p.planDate}_${rt.id}`;
      // 已 confirmed/applied 的计划不覆盖（老板已确认的价值）
      const [existing] = await db.select({ status: pmsPriceRobotPlans.status }).from(pmsPriceRobotPlans).where(eq(pmsPriceRobotPlans.id, id)).limit(1);
      if (existing && (existing.status === 'confirmed' || existing.status === 'applied')) continue;
      await db.insert(pmsPriceRobotPlans).values({
        id, planDate: p.planDate, merchantId, storeId, roomTypeId: rt.id, roomTypeName: rt.name,
        price: String(p.price), predictedOccupancy: p.predictedOccupancy, basePrice: String(p.basePrice),
        status: 'pending', createdAt: new Date(), updatedAt: new Date(),
      } as any).onConflictDoUpdate({
        target: pmsPriceRobotPlans.id,
        set: { price: String(p.price), predictedOccupancy: p.predictedOccupancy, updatedAt: new Date() } as any,
      });
    }
  }
}

// ===== 定价中心 v1：每日 8:00（北京时间）出卡仪式 =====
let ritualTimer: NodeJS.Timeout | null = null;
let lastRitualDate = '';
let ritualRunning = false; // 重入守卫：单次仪式未跑完时跳过下一次 tick，避免并发重复留痕

export function startDailyRitual() {
  if (ritualTimer) return;
  ritualTimer = setInterval(checkRitualTime, 60_000);
  checkRitualTime(); // 启动即检查：防止 8:00-8:14 窗口内服务重启导致当日仪式被跳过
}

function isRitualTime(now = new Date()): boolean {
  const nowBj = new Date(now.getTime() + BJ_OFFSET_MS);
  const h = nowBj.getUTCHours(), m = nowBj.getUTCMinutes();
  return h === 8 && m < 15;
}

async function checkRitualTime() {
  if (ritualRunning) return; // 重入守卫：上一次仪式仍在执行时跳过本次 tick
  ritualRunning = true;
  try {
    const date = todayBj();
    if (!isRitualTime() || lastRitualDate === date) return;
    lastRitualDate = date;
    const stores = await db.select({ id: pmsBuiStores.id }).from(pmsBuiStores);
    for (const { id: storeId } of stores) {
      try {
        const data = await buildTodayData(storeId);
        const changes = data.rooms.filter(r => r.suggestedPrice !== null);
        if (changes.length === 0) continue; // 无变化不打扰
        await db.insert(pmsPriceRobotLogs).values({
          id: `ritual_${storeId}_${date}`,
          taskId: `ritual_${storeId}_${date}`,
          browserSnapshot: JSON.stringify({
            date, storeId,
            changes: changes.map(r => ({ roomTypeId: r.roomTypeId, roomTypeName: r.roomTypeName, from: r.currentPrice, to: r.suggestedPrice, reasons: r.reasons })),
          }),
          createdAt: new Date(),
        } as any).onConflictDoNothing();
      } catch (e) { console.error(`[pricing-center] ritual ${storeId} error:`, e); }
    }
  } catch (e) { console.error('[pricing-center] ritual error:', e); }
  finally {
    ritualRunning = false;
  }
}
