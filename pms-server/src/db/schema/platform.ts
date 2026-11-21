import { pgTable, varchar, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';

// ============================================================
//  平台表只读映射（供 platformGuard 中间件使用）
//  Migration 由 pms-platform-server 管理，此处仅定义列结构用于查询
// ============================================================

/** 平台运营账号 */
export const pmsPlatformUsers = pgTable('pms_platform_users', {
  id: varchar('id', { length: 50 }).primaryKey(),
  phone: varchar('phone', { length: 20 }).notNull(),
  role: varchar('role', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
});

/** 商户档案 */
export const pmsPlatformMerchants = pgTable('pms_platform_merchants', {
  id: varchar('id', { length: 50 }).primaryKey(),
  companyName: varchar('company_name', { length: 100 }).notNull(),
  contactName: varchar('contact_name', { length: 50 }).notNull(),
  contactPhone: varchar('contact_phone', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  currentPackage: varchar('current_package', { length: 50 }),
});

/** SaaS  套餐定义 */
export const pmsPlatformPackages = pgTable('pms_platform_packages', {
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  permissions: jsonb('permissions').$type<string[]>().default([]),
  trialDays: integer('trial_days').notNull().default(14),
  status: varchar('status', { length: 20 }).notNull(),
});

/**  订阅记录 */
export const pmsPlatformSubscriptions = pgTable('pms_platform_subscriptions', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 50 }).notNull(),
  packageId: varchar('package_id', { length: 50 }).notNull(),
  packageName: varchar('package_name', { length: 50 }).notNull(),
  duration: varchar('duration', { length: 10 }).notNull(),
  amount: integer('amount').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }),
  endAt: timestamp('end_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

/**  收款确认 */
export const pmsPlatformPayments = pgTable('pms_platform_payments', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 50 }).notNull(),
  amount: integer('amount').notNull(),
  status: varchar('status', { length: 20 }).notNull(),
});
