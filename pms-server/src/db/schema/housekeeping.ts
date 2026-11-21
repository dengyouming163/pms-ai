import { pgTable, varchar, text, integer, timestamp } from 'drizzle-orm/pg-core';

/** 客房服务任务表 */
export const pmsBuiHousekeepingTasks = pgTable('pms_bui_housekeeping_tasks', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  roomId: varchar('room_id', { length: 50 }).notNull(),
  roomNumber: varchar('room_number', { length: 20 }).notNull(),
  roomTypeName: varchar('room_type_name', { length: 100 }).notNull(),
  floor: integer('floor').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  // pending | assigned | in_progress | completed | inspected | cancelled
  taskType: varchar('task_type', { length: 30 }).notNull(),
  // 退房清洁 | 日常保洁 | 维修 | 深度清洁 | 定期检修
  priority: varchar('priority', { length: 10 }).notNull().default('normal'),
  // urgent | high | normal | low
  assigneeId: varchar('assignee_id', { length: 50 }),
  assigneeName: varchar('assignee_name', { length: 50 }),
  remark: text('remark'),
  estimatedDuration: integer('estimated_duration'), // 预计耗时（分钟）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  inspectedAt: timestamp('inspected_at', { withTimezone: true }),
  inspectorId: varchar('inspector_id', { length: 50 }),
  inspectorName: varchar('inspector_name', { length: 50 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
