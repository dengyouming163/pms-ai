import { pgTable, integer, jsonb, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * 公众号运营配置表（单行，id=1；菜单/自动回复可后台配置）。
 * 运营在 pms-platform-web 后台通过内部 API 读写；公众号回调（handleMpMessage）与菜单同步读本表，
 * 未配置/无行时回落到 config/mp-menu.ts、config/mp-reply.ts 的种子默认值。
 */
export const pmsBuiMpConfig = pgTable('pms_bui_mp_config', {
  id: integer('id').primaryKey(),
  menu: jsonb('menu').$type<any>(),
  welcome: text('welcome'),
  keywordReplies: jsonb('keyword_replies').$type<{ keywords: string[]; reply: string }[]>().default([]),
  defaultReply: text('default_reply'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
