import { pgTable, varchar, timestamp, boolean } from 'drizzle-orm/pg-core';

/** 商家后台用户登录会话表 */
export const pmsBuiSessions = pgTable('pms_bui_sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  userId: varchar('user_id', { length: 64 }).notNull(),
  device: varchar('device', { length: 256 }).default('未知设备'),
  ip: varchar('ip', { length: 64 }).default(''),
  token: varchar('token', { length: 512 }).notNull(),
  current: boolean('current').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActiveAt: timestamp('last_active_at').defaultNow().notNull(),
});
