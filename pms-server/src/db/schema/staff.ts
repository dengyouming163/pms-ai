import { pgTable, varchar, text, integer, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

// 员工表
export const pmsBuiStaff = pgTable('pms_bui_staff', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  name: varchar('name', { length: 50 }).notNull(),
  phone: varchar('phone', { length: 20 }).notNull(),
  wecomUserid: varchar('wecom_userid', { length: 64 }),
  email: varchar('email', { length: 100 }),
  avatar: varchar('avatar', { length: 200 }),
  department: varchar('department', { length: 50 }).notNull(),
  position: varchar('position', { length: 50 }).notNull(),
  roleName: varchar('role_name', { length: 50 }).notNull(),
  roleId: varchar('role_id', { length: 50 }).notNull(),
  stores: jsonb('stores').default([]),
  scope: varchar('scope', { length: 30 }).default('store'),
  password: varchar('password', { length: 200 }).notNull().default('$2a$10$placeholder'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 角色表
export const pmsBuiRoles = pgTable('pms_bui_roles', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  name: varchar('name', { length: 50 }).notNull(),
  description: text('description'),
  staffCount: integer('staff_count').notNull().default(0),
  scope: varchar('scope', { length: 30 }).notNull().default('store'),
  isPreset: boolean('is_preset').notNull().default(false),
  permissions: jsonb('permissions').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 操作日志表
export const pmsBuiOpLogs = pgTable('pms_bui_op_logs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }),
  staffId: varchar('staff_id', { length: 50 }).notNull(),
  staffName: varchar('staff_name', { length: 50 }).notNull(),
  module: varchar('module', { length: 50 }).notNull(),
  moduleLabel: varchar('module_label', { length: 50 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  target: varchar('target', { length: 100 }),
  detail: text('detail'),
  level: varchar('level', { length: 10 }).notNull().default('info'),
  ip: varchar('ip', { length: 50 }),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
});
