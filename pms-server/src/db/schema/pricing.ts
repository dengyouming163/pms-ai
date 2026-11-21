import { pgTable, varchar, text, integer, timestamp, jsonb, boolean, numeric } from 'drizzle-orm/pg-core';

// 定价规则表（基础房价）
export const pmsBuiPricingRules = pgTable('pms_bui_pricing_rules', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  roomTypeId: varchar('room_type_id', { length: 64 }).notNull(),
  roomType: varchar('room_type', { length: 100 }).notNull(),
  basePrice: integer('base_price').notNull(),
  weekdayPrice: integer('weekday_price').notNull(),
  weekendPrice: integer('weekend_price').notNull(),
  holidayPrice: integer('holiday_price'),
  minPrice: integer('min_price'),
  priceHistory: jsonb('price_history').$type<Array<{ date: string; price: number }>>().default([]),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 价格日历表
export const pmsBuiPricingCalendar = pgTable('pms_bui_pricing_calendar', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  date: varchar('date', { length: 20 }).notNull(),
  roomTypes: jsonb('room_types').notNull(),
  isWeekend: boolean('is_weekend').notNull().default(false),
  isHoliday: boolean('is_holiday').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 限时特价表
export const pmsBuiPromotions = pgTable('pms_bui_promotions', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 30 }).notNull(),
  discount: integer('discount').notNull(),
  startDate: varchar('start_date', { length: 20 }).notNull(),
  endDate: varchar('end_date', { length: 20 }).notNull(),
  description: text('description'),
  roomTypes: jsonb('room_types').$type<string[]>().default([]),
  channels: jsonb('channels').$type<string[]>().default([]),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
