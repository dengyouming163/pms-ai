import { pgTable, varchar, text, timestamp, jsonb, integer, date, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ========== 素材表 ==========
export const mediaAssets = pgTable('media_assets', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }).notNull().default('default_store'),
  url: text('url').notNull(),
  name: varchar('name', { length: 200 }),
  thumbnailUrl: text('thumbnail_url'),
  mediaType: varchar('media_type', { length: 10 }).notNull().default('image'),
  category: varchar('category', { length: 30 }).notNull().default('other'),
  roomId: varchar('room_id', { length: 64 }),
  roomName: varchar('room_name', { length: 100 }),
  roomTypeId: varchar('room_type_id', { length: 64 }),
  roomTypeIds: jsonb('room_type_ids'),
  roomTypeNames: jsonb('room_type_names'),
  purposeTags: jsonb('purpose_tags'),
  shotType: varchar('shot_type', { length: 50 }),
  uploaderStaffId: varchar('uploader_staff_id', { length: 64 }),
  uploaderStaffName: varchar('uploader_staff_name', { length: 100 }),
  taskId: varchar('task_id', { length: 64 }),
  value: jsonb('value'),
  quality: varchar('quality', { length: 10 }).notNull().default('normal'),
  status: varchar('status', { length: 10 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ========== 拍摄模板/SOP 示例库 ==========
export const assetTemplates = pgTable('asset_templates', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }).notNull().default('default_store'),
  name: varchar('name', { length: 100 }).notNull(),
  shotType: varchar('shot_type', { length: 50 }).notNull(),
  mediaType: varchar('media_type', { length: 10 }).notNull().default('image'),
  category: varchar('category', { length: 30 }).notNull().default('room'),
  purposeTags: jsonb('purpose_tags'),
  exampleImageUrl: text('example_image_url'),
  exampleVideoUrl: text('example_video_url'),
  guideText: text('guide_text'),
  movementText: text('movement_text'),
  avoidText: text('avoid_text'),
  durationMin: integer('duration_min'),
  durationMax: integer('duration_max'),
  sortOrder: integer('sort_order').notNull().default(0),
  source: varchar('source', { length: 10 }).notNull().default('store'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ========== 打卡任务 ==========
export const assetTasks = pgTable('asset_tasks', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }).notNull().default('default_store'),
  title: varchar('title', { length: 200 }).notNull(),
  taskDate: date('task_date'),
  deadline: timestamp('deadline', { withTimezone: true }),
  templateRefs: jsonb('template_refs'),
  roomIds: jsonb('room_ids'),
  roomNames: jsonb('room_names'),
  shotRequirements: jsonb('shot_requirements'),
  roomTypeIds: jsonb('room_type_ids'),
  roomTypeNames: jsonb('room_type_names'),
  purposeTags: jsonb('purpose_tags'),
  guideText: text('guide_text'),
  assigneeScope: varchar('assignee_scope', { length: 10 }).notNull().default('all'),
  assigneeStaffIds: jsonb('assignee_staff_ids'),
  status: varchar('status', { length: 12 }).notNull().default('published'),
  publisherId: varchar('publisher_id', { length: 64 }),
  publisherName: varchar('publisher_name', { length: 100 }),
  ruleId: varchar('rule_id', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // 部分唯一索引：同一规则同一任务日只产一条（自动化幂等兜底，手动任务 rule_id 为 NULL 不受约束）
  uniqueIndex('idx_asset_tasks_rule_date').on(table.taskDate, table.ruleId)
    .where(sql`${table.ruleId} IS NOT NULL`),
]);

// ========== 员工打卡记录 ==========
export const assetTaskSubmissions = pgTable('asset_task_submissions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }).notNull().default('default_store'),
  taskId: varchar('task_id', { length: 64 }).notNull(),
  staffId: varchar('staff_id', { length: 64 }).notNull(),
  staffName: varchar('staff_name', { length: 100 }),
  status: varchar('status', { length: 12 }).notNull().default('pending'),
  assetIds: jsonb('asset_ids'),
  note: text('note'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ========== 自动化任务规则 ==========
export const assetTaskRules = pgTable('asset_task_rules', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 64 }).notNull().default('default_store'),
  name: varchar('name', { length: 100 }).notNull(),
  templateRefs: jsonb('template_refs'),
  roomTypeIds: jsonb('room_type_ids'),
  roomTypeNames: jsonb('room_type_names'),
  purposeTags: jsonb('purpose_tags'),
  guideText: text('guide_text'),
  assigneeScope: varchar('assignee_scope', { length: 10 }).notNull().default('all'),
  assigneeStaffIds: jsonb('assignee_staff_ids'),
  publishTime: varchar('publish_time', { length: 5 }).notNull().default('09:00'),
  status: varchar('status', { length: 12 }).notNull().default('disabled'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  publisherId: varchar('publisher_id', { length: 64 }),
  publisherName: varchar('publisher_name', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
