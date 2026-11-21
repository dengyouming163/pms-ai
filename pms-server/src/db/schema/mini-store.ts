import { pgTable, varchar, text, integer, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

// 私域门店配置表（每门店一条）
export const pmsBuiMiniStoreConfig = pgTable('pms_bui_mini_store_config', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull().unique(),
  // 是否上线（进件完成后才允许置 true）
  online: boolean('online').notNull().default(false),
  headerImages: jsonb('header_images').$type<string[]>().default([]),
  intro: text('intro'),
  gallery: jsonb('gallery').$type<string[]>().default([]),
  // 取消政策：入住日 00:00 前 freeHours 小时外免费取消，之内收 feeRate% 手续费
  cancelPolicy: jsonb('cancel_policy').$type<{ freeHours: number; feeRate: number }>()
    .default({ freeHours: 24, feeRate: 20 }),
  // M2 会员价折扣率（memberLevel → 折扣百分数，如 { gold: 95 }）；M1 建列不启用
  memberDiscounts: jsonb('member_discounts').$type<Record<string, number>>().default({}),
  // M3 分销佣金比例（万分比）；M1 建列不启用
  commissionRate: integer('commission_rate').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 套餐表（房型+权益打包一口价）
export const pmsBuiPackages = pgTable('pms_bui_packages', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  roomTypeIds: jsonb('room_type_ids').$type<string[]>().notNull(),
  benefits: jsonb('benefits').$type<string[]>().default([]),
  price: integer('price').notNull(),
  stock: integer('stock').notNull().default(-1),
  sellStart: varchar('sell_start', { length: 20 }),
  sellEnd: varchar('sell_end', { length: 20 }),
  useStart: varchar('use_start', { length: 20 }),
  useEnd: varchar('use_end', { length: 20 }),
  images: jsonb('images').$type<string[]>().default([]),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 优惠券模板表
export const pmsBuiCoupons = pgTable('pms_bui_coupons', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 30 }).notNull(),
  value: integer('value').notNull(),
  minAmount: integer('min_amount').notNull().default(0),
  scope: jsonb('scope').$type<string[]>().default([]),
  total: integer('total').notNull().default(-1),
  claimed: integer('claimed').notNull().default(0),
  perUser: integer('per_user').notNull().default(1),
  validDays: integer('valid_days').notNull().default(30),
  startDate: varchar('start_date', { length: 20 }),
  endDate: varchar('end_date', { length: 20 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 持券记录表
export const pmsBuiCouponRecords = pgTable('pms_bui_coupon_records', {
  id: varchar('id', { length: 50 }).primaryKey(),
  couponId: varchar('coupon_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedOrderId: varchar('used_order_id', { length: 50 }),
  expireAt: varchar('expire_at', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
