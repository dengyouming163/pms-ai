import { pgTable, varchar, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';

// 推广员
export const pmsBuiPromoters = pgTable('pms_bui_promoters', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  // 二级分销：上级推广员（一级为 null）+ 层级（1=一级 / 2=二级）
  parentPromoterId: varchar('parent_promoter_id', { length: 50 }),
  level: integer('level').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  promoCode: varchar('promo_code', { length: 32 }).notNull().unique(),
  commissionRate: integer('commission_rate'),
  totalCommission: integer('total_commission').notNull().default(0),
  pendingCommission: integer('pending_commission').notNull().default(0),
  withdrawnCommission: integer('withdrawn_commission').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 推广关系绑定（30天保护期，先到先得不覆盖）
export const pmsBuiReferralBindings = pgTable('pms_bui_referral_bindings', {
  id: varchar('id', { length: 50 }).primaryKey(),
  promoterId: varchar('promoter_id', { length: 50 }).notNull(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  protectedUntil: varchar('protected_until', { length: 20 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 佣金流水（金额单位：分）
export const pmsBuiCommissionRecords = pgTable('pms_bui_commission_records', {
  id: varchar('id', { length: 50 }).primaryKey(),
  promoterId: varchar('promoter_id', { length: 50 }).notNull(),
  orderId: varchar('order_id', { length: 50 }).notNull(),
  orderNo: varchar('order_no', { length: 50 }).notNull(),
  amount: integer('amount').notNull(),
  rate: integer('rate').notNull(),
  // 分销裂变：type=direct(一级直接)/team(二级团队)，套餐溯源，关联住宿订单（解冻用）
  type: varchar('type', { length: 20 }).notNull().default('direct'),
  productId: varchar('product_id', { length: 50 }),
  productName: varchar('product_name', { length: 200 }),
  stayOrderId: varchar('stay_order_id', { length: 50 }),
  status: varchar('status', { length: 20 }).notNull().default('frozen'),
  profitSharingNo: varchar('profit_sharing_no', { length: 64 }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 提现单（金额单位：分）
export const pmsBuiWithdrawals = pgTable('pms_bui_withdrawals', {
  id: varchar('id', { length: 50 }).primaryKey(),
  promoterId: varchar('promoter_id', { length: 50 }).notNull(),
  amount: integer('amount').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  wxTransferNo: varchar('wx_transfer_no', { length: 64 }),
  failReason: text('fail_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 分账单（金额单位：分）
export const pmsBuiProfitSharings = pgTable('pms_bui_profit_sharings', {
  id: varchar('id', { length: 50 }).primaryKey(),
  paymentId: varchar('payment_id', { length: 50 }).notNull(),
  outTradeNo: varchar('out_trade_no', { length: 64 }).notNull(),
  promoterId: varchar('promoter_id', { length: 50 }),
  promoterAmount: integer('promoter_amount'),
  platformAmount: integer('platform_amount'),
  status: varchar('status', { length: 30 }).notNull().default('pending'),
  wxOrderId: varchar('wx_order_id', { length: 64 }),
  failReason: text('fail_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
