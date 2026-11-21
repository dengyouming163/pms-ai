import { pgTable, varchar, text, integer, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

// 系统设置表 (key-value 结构)
export const pmsBuiSettings = pgTable('pms_bui_settings', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  category: varchar('category', { length: 30 }).notNull(),
  key: varchar('key', { length: 100 }).notNull(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
