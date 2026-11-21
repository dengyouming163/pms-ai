// pms-server/src/db/schema/price-robot.ts
// 自动收益管家 — 5 张表：配置 / 每日授权 / 改价任务 / 未来价计划 / 执行日志
import { pgTable, text, integer, numeric, boolean, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';

// 机器人配置（每门店×房型一条）
export const pmsPriceRobotConfig = pgTable('pms_price_robot_config', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull(),
  storeId: text('store_id').notNull(),
  roomTypeId: text('room_type_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  channels: jsonb('channels').$type<string[]>().notNull().default(['携程', '美团']),
  strategy: text('strategy').notNull().default('standard'),
  slots: jsonb('slots').$type<string[]>().notNull().default(['17:00', '19:00', '21:00']),
  futureDays: integer('future_days').notNull().default(14),
  floorCapRatio: numeric('floor_cap_ratio').notNull().default('1.5'),
  maxDeviationPct: integer('max_deviation_pct').notNull().default(30),
  // store 级设置（门店行 room_type_id='*'）：autoConfirm 一键自动确认；globalFloor 全局最低卖价（null 不 clamp）
  autoConfirm: boolean('auto_confirm').notNull().default(false),
  globalFloor: integer('global_floor'),
  // 定价中心 store 级设置（迁移 0016 已加列）：holidayMarkupPct 节假日加价%；recommendationEnabled 今日推荐开关
  holidayMarkupPct: integer('holiday_markup_pct').notNull().default(20),
  recommendationEnabled: boolean('recommendation_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('price_robot_config_store_room_uq').on(t.storeId, t.roomTypeId),
]);

// 每日授权单（老板确认底价 + 策略的证据）
export const pmsPriceRobotAuth = pgTable('pms_price_robot_auth', {
  id: text('id').primaryKey(),
  date: text('date').notNull(), // YYYY-MM-DD
  merchantId: text('merchant_id').notNull(),
  storeId: text('store_id').notNull(),
  roomTypeId: text('room_type_id').notNull(),
  floorPrice: numeric('floor_price').notNull(),
  strategy: text('strategy').notNull().default('standard'),
  slotPlans: jsonb('slot_plans').$type<Record<string, number>>().notNull(),
  authBy: text('auth_by'),
  authAt: timestamp('auth_at', { withTimezone: true }),
  expireAt: timestamp('expire_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('confirmed'), // confirmed/expired/fused
}, (t) => [
  uniqueIndex('price_robot_auth_date_room_uq').on(t.date, t.storeId, t.roomTypeId),
]);

// 改价任务单（下发/执行的凭证）
export const pmsPriceRobotTasks = pgTable('pms_price_robot_tasks', {
  id: text('id').primaryKey(),
  date: text('date').notNull(),
  targetDate: text('target_date'), // 写价的目标日期（二期未来窗用；一期=null 表示写当日）
  slot: text('slot').notNull(),
  merchantId: text('merchant_id').notNull(),
  storeId: text('store_id').notNull(),
  roomTypeId: text('room_type_id').notNull(),
  roomTypeName: text('room_type_name').notNull(),
  channel: text('channel').notNull(),
  currentPrice: numeric('current_price'),
  targetPrice: numeric('target_price').notNull(),
  status: text('status').notNull().default('pending'), // pending/sent/success/failed/rolled_back/skipped
  verifiedPrice: numeric('verified_price'),
  error: text('error'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  latencyMs: integer('latency_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('price_robot_task_uq').on(t.date, t.slot, t.storeId, t.roomTypeId, t.channel, t.targetDate),
  index('price_robot_tasks_store_date_status_idx').on(t.storeId, t.date, t.status),
]);

// 未来价计划（二期：6:00 生成 → 老板确认 → 近端 3 天应用）
export const pmsPriceRobotPlans = pgTable('pms_price_robot_plans', {
  id: text('id').primaryKey(),
  planDate: text('plan_date').notNull(), // 目标未来日期 YYYY-MM-DD
  merchantId: text('merchant_id').notNull(),
  storeId: text('store_id').notNull(),
  roomTypeId: text('room_type_id').notNull(),
  roomTypeName: text('room_type_name').notNull(),
  price: numeric('price').notNull(),
  predictedOccupancy: integer('predicted_occupancy').notNull(),
  basePrice: numeric('base_price').notNull(),
  status: text('status').notNull().default('pending'), // pending/confirmed/applied/ignored
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('price_robot_plan_uq').on(t.planDate, t.storeId, t.roomTypeId),
]);

// 执行日志（审计）
export const pmsPriceRobotLogs = pgTable('pms_price_robot_logs', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  beforePrice: numeric('before_price'),
  afterPrice: numeric('after_price'),
  readBackPrice: numeric('read_back_price'),
  attempts: integer('attempts').notNull().default(0),
  browserSnapshot: text('browser_snapshot'),
  operator: text('operator'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('price_robot_logs_task_idx').on(t.taskId),
]);
