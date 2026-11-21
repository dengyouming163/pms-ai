import { pgTable, varchar, text, integer, timestamp, jsonb, boolean, numeric } from 'drizzle-orm/pg-core';

// 客户表
export const pmsBuiCustomers = pgTable('pms_bui_customers', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  name: varchar('name', { length: 50 }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  gender: varchar('gender', { length: 10 }),
  birthday: varchar('birthday', { length: 20 }),
  memberLevel: varchar('member_level', { length: 20 }).notNull().default('regular'),
  memberLevelName: varchar('member_level_name', { length: 30 }).notNull().default('普通会员'),
  memberLevelIcon: varchar('member_level_icon', { length: 10 }),
  memberLevelDiscount: integer('member_level_discount').notNull().default(100),
  valueScore: integer('value_score').notNull().default(0),
  totalSpent: integer('total_spent').notNull().default(0),
  avgSpent: integer('avg_spent').notNull().default(0),
  stayCount: integer('stay_count').notNull().default(0),
  lastStayDate: varchar('last_stay_date', { length: 20 }),
  source: varchar('source', { length: 30 }),
  referrerPromoterId: varchar('referrer_promoter_id', { length: 50 }),
  tags: jsonb('tags').$type<string[]>().default([]),
  preferences: jsonb('preferences').$type<string[]>().default([]),
  remark: text('remark'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  // 关联的小程序用户 id（私域渠道客户）
  miniUserId: varchar('mini_user_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 标签表
export const pmsBuiTags = pgTable('pms_bui_tags', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  name: varchar('name', { length: 50 }).notNull(),
  color: varchar('color', { length: 20 }).notNull(),
  description: text('description'),
  count: integer('count').notNull().default(0),
  isAuto: boolean('is_auto').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 自动打标规则表
export const pmsBuiAutoTagRules = pgTable('pms_bui_auto_tag_rules', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  name: varchar('name', { length: 100 }).notNull(),
  rule: varchar('rule', { length: 50 }).notNull(),
  field: varchar('field', { length: 50 }).notNull(),
  tag: varchar('tag', { length: 50 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 客户关怀表
export const pmsBuiCareReminders = pgTable('pms_bui_care_reminders', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  customerId: varchar('customer_id', { length: 50 }).notNull(),
  customerName: varchar('customer_name', { length: 50 }).notNull(),
  type: varchar('type', { length: 30 }).notNull(),
  content: text('content').notNull(),
  priority: varchar('priority', { length: 10 }).notNull().default('medium'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  dueDate: varchar('due_date', { length: 20 }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
