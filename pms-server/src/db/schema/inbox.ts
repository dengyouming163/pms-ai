import { pgTable, varchar, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// 站内消息表（私域交易闭环：订单状态 / 支付 / 提醒）
// 唯一键 (mini_user_id, order_id, type)：入住提醒调度器以「插入成功与否」作为幂等闸门（onConflictDoNothing），
// 防并发/多实例重复投递同一订单的提醒。order_id 必须非空 —— PG 唯一索引中 NULL 彼此不相等，
// 若 order_id 为 NULL，同一 (mini_user_id, NULL, type) 可写多条，去重会静默失效。
export const pmsBuiInboxMessages = pgTable('pms_bui_inbox_messages', {
  id: varchar('id', { length: 50 }).primaryKey(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  orderId: varchar('order_id', { length: 50 }).notNull(),
  // 消息类型：order_status 订单状态 / payment 支付 / remind 提醒
  type: varchar('type', { length: 20 }).notNull(),
  title: varchar('title', { length: 100 }).notNull(),
  content: text('content'),
  isRead: boolean('is_read').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_inbox_user').on(t.miniUserId),
  uniqueIndex('uq_inbox_user_order_type').on(t.miniUserId, t.orderId, t.type),
]);
