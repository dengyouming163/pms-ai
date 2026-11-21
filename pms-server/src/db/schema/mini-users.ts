import { pgTable, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// C端小程序用户表（平台级，跨商家唯一，按 platform + openid 识别）
// platform: wx=微信小程序, douyin=抖音小程序, wx_mp=公众号, h5=手机号验证码(H5 普通浏览器) —— 各端账号独立，靠手机号绑定合并
export const pmsBuiMiniUsers = pgTable('pms_bui_mini_users', {
  id: varchar('id', { length: 50 }).primaryKey(),
  platform: varchar('platform', { length: 20 }).notNull().default('wx'),
  openid: varchar('openid', { length: 64 }).notNull(),
  unionid: varchar('unionid', { length: 64 }),
  phone: varchar('phone', { length: 20 }),
  nickname: varchar('nickname', { length: 50 }),
  avatar: varchar('avatar', { length: 500 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  guestName: varchar('guest_name', { length: 50 }),
  guestPhone: varchar('guest_phone', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // (platform, openid) 复合唯一：同一 openid 可存在于不同平台
  uniqueIndex('pms_bui_mini_users_platform_openid_idx').on(t.platform, t.openid),
]);
