import { pgTable, varchar, text, integer, timestamp, jsonb, boolean, numeric } from 'drizzle-orm/pg-core';

// 收支流水表
export const pmsBuiTransactions = pgTable('pms_bui_transactions', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  type: varchar('type', { length: 20 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  amount: integer('amount').notNull(),
  channel: varchar('channel', { length: 50 }),
  orderNo: varchar('order_no', { length: 50 }),
  guestName: varchar('guest_name', { length: 50 }),
  storeName: varchar('store_name', { length: 100 }),
  paymentMethod: varchar('payment_method', { length: 30 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('completed'),
  remark: text('remark'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 对账明细表
export const pmsBuiReconciliationDetails = pgTable('pms_bui_reconciliation_details', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  channelName: varchar('channel_name', { length: 100 }).notNull(),
  orderNo: varchar('order_no', { length: 50 }).notNull(),
  guestName: varchar('guest_name', { length: 50 }).notNull(),
  systemAmount: integer('system_amount').notNull(),
  channelAmount: integer('channel_amount').notNull(),
  difference: integer('difference').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('matched'),
  orderDate: varchar('order_date', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 对账预警表
export const pmsBuiReconciliationAlerts = pgTable('pms_bui_reconciliation_alerts', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  type: varchar('type', { length: 30 }).notNull(),
  channel: varchar('channel', { length: 50 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  count: integer('count').notNull().default(0),
  amount: integer('amount').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
