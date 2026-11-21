import { pgTable, varchar, boolean, integer, timestamp } from 'drizzle-orm/pg-core';

// 平台级分销配置（单行，id 固定 'default'）。佣金率单位：万分比（500 = 5%）
export const pmsBuiDistributionConfig = pgTable('pms_bui_distribution_config', {
  id: varchar('id', { length: 50 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  defaultLv1Rate: integer('default_lv1_rate').notNull().default(500),
  defaultLv2Rate: integer('default_lv2_rate').notNull().default(200),
  minWithdrawAmount: integer('min_withdraw_amount').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
