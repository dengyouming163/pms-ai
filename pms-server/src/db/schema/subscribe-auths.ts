import { pgTable, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * 微信订阅消息授权表（私域交易闭环：入住前 24h 提醒等一次性订阅消息）。
 * 用户在小程序内点击「允许」订阅后，前端调用 POST /api/mini/subscribe 登记；
 * 调度器据 `mini_user_id` 反查 `openid` 调微信 subscribe/send。
 * 同 (mini_user_id, template_id) 唯一，重复授权为幂等更新（onConflictDoUpdate）。
 */
export const pmsBuiSubscribeAuths = pgTable('pms_bui_subscribe_auths', {
  id: varchar('id', { length: 50 }).primaryKey(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  openid: varchar('openid', { length: 64 }).notNull(),
  templateId: varchar('template_id', { length: 64 }).notNull(),
  authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_subscribe_auths_user').on(t.miniUserId),
  uniqueIndex('uq_subscribe_auths_user_template').on(t.miniUserId, t.templateId),
]);
