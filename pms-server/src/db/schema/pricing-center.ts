// 定价中心：每日卖价 + 节假日表（唯一价格真相）
import { pgTable, varchar, text, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// 每日卖价：采纳/手动后当天某房型的真实卖价；各端展示与 OTA 同步的唯一依据
export const pmsBuiDailyPrice = pgTable('pms_bui_daily_price', {
  id: text('id').primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  roomTypeId: varchar('room_type_id', { length: 64 }).notNull(),
  roomTypeName: varchar('room_type_name', { length: 100 }).notNull(),
  date: varchar('date', { length: 20 }).notNull(),                 // YYYY-MM-DD（北京日期）
  price: integer('price').notNull(),                               // 今日卖价（元整数）
  source: varchar('source', { length: 20 }).notNull().default('adopt'), // adopt | manual
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('daily_price_store_room_date_uq').on(t.storeId, t.roomTypeId, t.date),
]);

// 节假日表：标记哪些日期是节假日（数据化替代硬编码 2026 表）
export const pmsBuiHolidays = pgTable('pms_bui_holidays', {
  id: text('id').primaryKey(),
  date: varchar('date', { length: 20 }).notNull(),                 // YYYY-MM-DD
  name: varchar('name', { length: 50 }).notNull(),                 // 如 春节 / 中秋
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('holidays_date_uq').on(t.date),
]);
