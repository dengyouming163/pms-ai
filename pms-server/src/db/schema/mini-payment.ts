import { pgTable, varchar, text, integer, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// 小程序支付单表（金额单位：分）
export const pmsBuiMiniPayments = pgTable('pms_bui_mini_payments', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  orderId: varchar('order_id', { length: 50 }).notNull(),
  orderNo: varchar('order_no', { length: 50 }).notNull(),
  // 支付渠道：wx=微信支付 / douyin=抖音支付
  channel: varchar('channel', { length: 10 }).notNull().default('wx'),
  // 商户订单号（传给支付平台，唯一）
  outTradeNo: varchar('out_trade_no', { length: 64 }).notNull().unique(),
  // 微信支付交易号（回调时写入）
  transactionId: varchar('transaction_id', { length: 64 }),
  amount: integer('amount').notNull(), // 分
  // pending 待支付 / paid 已支付 / refunding 退款中 / refunded 已退款 / closed 已关闭
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  refundNo: varchar('refund_no', { length: 64 }),
  refundAmount: integer('refund_amount'), // 分
  paidAt: timestamp('paid_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  // 回调原文（审计用）
  notifyRaw: jsonb('notify_raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // 部分唯一索引：同一订单最多一条 pending 支付单（防并发 jsapi 双开支付单）
  uniqueIndex('uniq_mini_payments_order_pending').on(t.orderId).where(sql`${t.status} = 'pending'`),
]);

// 特约商户进件表（每门店一条进行中的申请）
export const pmsBuiMerchantApplications = pgTable('pms_bui_merchant_applications', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull().unique(),
  // draft 草稿 / reviewing 平台审核中 / rejected 平台驳回 /
  // wx_submitted 已提交微信 / wx_verifying 待账户验证 / wx_signing 待签约 /
  // finished 完成 / wx_rejected 微信驳回
  status: varchar('status', { length: 30 }).notNull().default('draft'),
  businessLicense: jsonb('business_license').$type<{ number: string; name: string; imageUrl: string }>(),
  legalPerson: jsonb('legal_person').$type<{ name: string; idNumber: string; idFrontUrl: string; idBackUrl: string }>(),
  settlementAccount: jsonb('settlement_account').$type<{ bankName: string; accountName: string; accountNumber: string }>(),
  contact: jsonb('contact').$type<{ name: string; phone: string }>(),
  // 微信申请单号（人工进件时可留空）
  applymentId: varchar('applyment_id', { length: 64 }),
  // 进件完成后的特约商户号
  subMchid: varchar('sub_mchid', { length: 32 }),
  rejectReason: text('reject_reason'),
  signUrl: varchar('sign_url', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
