import { pgTable, varchar, text, integer, timestamp, jsonb, boolean, decimal, date, uniqueIndex } from 'drizzle-orm/pg-core';

// OTA 客户端设备注册表
export const pmsOtaClients = pgTable('pms_ota_clients', {
  id: varchar('id', { length: 50 }).primaryKey(),
  storeId: varchar('store_id', { length: 64 }).notNull(),
  platform: varchar('platform', { length: 32 }).notNull().default('meituan'),
  deviceId: varchar('device_id', { length: 128 }).notNull(),
  clientVersion: varchar('client_version', { length: 16 }),
  storeKey: varchar('store_key', { length: 64 }).unique(),
  sessionValid: boolean('session_valid').default(false),
  lastCaptureAt: timestamp('last_capture_at', { withTimezone: true }),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  status: varchar('status', { length: 32 }).default('offline'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // 客户端身份唯一约束：同一门店同一平台下设备唯一
  storePlatformDeviceUnique: uniqueIndex('pms_ota_clients_store_platform_device_idx').on(table.storeId, table.platform, table.deviceId),
}));

// OTA 原始订单表（独立于 PMS orders 表，通过人工审核或规则转换）
export const pmsOtaOrders = pgTable('pms_ota_orders', {
  id: varchar('id', { length: 50 }).primaryKey(),
  storeId: varchar('store_id', { length: 64 }).notNull(),
  source: varchar('source', { length: 32 }).notNull().default('meituan'),
  sourceOrderId: varchar('source_order_id', { length: 128 }).notNull(),
  sourceStoreId: varchar('source_store_id', { length: 128 }),
  guestName: varchar('guest_name', { length: 128 }),
  guestPhone: varchar('guest_phone', { length: 32 }),
  roomType: varchar('room_type', { length: 256 }),
  roomCount: integer('room_count').default(1),
  checkIn: date('check_in'),
  checkOut: date('check_out'),
  totalAmount: decimal('total_amount', { precision: 10, scale: 2 }),
  status: varchar('status', { length: 32 }),
  breakfast: boolean('breakfast').default(false),
  remark: text('remark'),
  guestIdNumber: varchar('guest_id_number', { length: 64 }),
  commission: decimal('commission', { precision: 10, scale: 2 }),
  arrivalTime: varchar('arrival_time', { length: 10 }),
  orderLabel: varchar('order_label', { length: 20 }),
  rawData: jsonb('raw_data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  clientVersion: varchar('client_version', { length: 16 }),
}, (table) => ({
  // 订单去重唯一约束：同一来源平台下订单号唯一
  sourceOrderUnique: uniqueIndex('pms_ota_orders_source_order_idx').on(table.source, table.sourceOrderId),
}));

// OTA 抓取日志表
export const pmsOtaCaptureLogs = pgTable('pms_ota_capture_logs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  storeId: varchar('store_id', { length: 64 }).notNull(),
  platform: varchar('platform', { length: 32 }).notNull(),
  deviceId: varchar('device_id', { length: 128 }),
  result: varchar('result', { length: 32 }), // 'success' | 'no_change' | 'session_expired' | 'error'
  newCount: integer('new_count').default(0),
  changeCount: integer('change_count').default(0),
  errorMessage: text('error_message'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
});
