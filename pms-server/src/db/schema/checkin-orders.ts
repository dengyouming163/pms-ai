import { pgTable, varchar, integer, text, timestamp, numeric, date, boolean } from 'drizzle-orm/pg-core';

// 微信入住订单表（员工 H5 粘贴解析入库 / 平台端客服后台录入 / 历史补录）
export const pmsBuiCheckinOrders = pgTable('pms_bui_checkin_orders', {
  id: varchar('id', { length: 50 }).primaryKey(),
  // 人类可读订单号：CK + 录入日 yyyyMMdd + 4 位当日序号（既有历史行 NULL，不回填）
  orderNo: varchar('order_no', { length: 32 }),
  // 录入渠道：h5=员工H5 / platform=平台录入 / backfill=历史补录
  createdChannel: varchar('created_channel', { length: 20 }).default('h5'),
  // 操作人（审计用；权限全放开，此处仅留痕）
  createdBy: varchar('created_by', { length: 64 }),
  createdByName: varchar('created_by_name', { length: 50 }),
  isBackfill: boolean('is_backfill').notNull().default(false),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  guestName: varchar('guest_name', { length: 50 }),
  guestPhone: varchar('guest_phone', { length: 20 }),
  adultCount: integer('adult_count').notNull().default(1),
  childCount: integer('child_count').notNull().default(0),
  roomType: varchar('room_type', { length: 100 }),
  // 房号（自由文本，仅记录意图，不做房间占用联动）
  roomNo: varchar('room_no', { length: 50 }),
  roomCount: integer('room_count').notNull().default(1),
  // 入住日 / 退房日（改造后为 date；迁移走影子列三步法，见 drizzle/0083）
  checkInDate: date('check_in_date'),
  checkOutDate: date('check_out_date'),
  // 实际入住 / 离店时刻（与「业务日期」check_in_date 语义不同，勿混用）
  checkInAt: timestamp('check_in_at', { withTimezone: true }),
  checkOutAt: timestamp('check_out_at', { withTimezone: true }),
  nights: integer('nights').notNull().default(1),
  rawText: text('raw_text'),
  source: varchar('source', { length: 30 }).default('wechat'),
  // 渠道侧订单号
  channelOrderNo: varchar('channel_order_no', { length: 64 }),
  // 状态：booked 待入住 / checked_in 已入住 / checked_out 已离店 / completed 已结算 / cancelled 已取消 / refunded 有退款
  status: varchar('status', { length: 30 }).notNull().default('checked_in'),
  staffName: varchar('staff_name', { length: 50 }),
  // 金额（元，numeric(10,2)）：订单总金额 / 定金 / 结算金额 / 退款金额
  totalAmount: numeric('total_amount', { precision: 10, scale: 2 }),
  depositAmount: numeric('deposit_amount', { precision: 10, scale: 2 }),
  settlementAmount: numeric('settlement_amount', { precision: 10, scale: 2 }),
  refundAmount: numeric('refund_amount', { precision: 10, scale: 2 }),
  // 支付方式：online=线上支付 / offline=线下支付
  paymentMethod: varchar('payment_method', { length: 20 }),
  // 取消 / 退款原因（转入 cancelled / refunded 时必填）
  cancelReason: text('cancel_reason'),
  refundReason: text('refund_reason'),
  // 下单联系人（可与入住人不同）
  contactName: varchar('contact_name', { length: 50 }),
  contactPhone: varchar('contact_phone', { length: 20 }),
  remark: text('remark'),
  // 与 platform 侧房源 / 客户软关联（跨库，不建外键）
  propertyId: varchar('property_id', { length: 64 }),
  customerPlatformId: varchar('customer_platform_id', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 入住订单状态流转日志（创建 / 补录 / 每次流转各写一条，供详情抽屉时间轴）
export const pmsBuiCheckinOrderStatusLogs = pgTable('pms_bui_checkin_order_status_logs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  orderId: varchar('order_id', { length: 50 }).notNull(),
  // 创建时为 NULL（表示「无前置状态」）
  fromStatus: varchar('from_status', { length: 30 }),
  toStatus: varchar('to_status', { length: 30 }).notNull(),
  reason: text('reason'),
  operatorId: varchar('operator_id', { length: 64 }),
  operatorName: varchar('operator_name', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
