import { pgTable, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { DEFAULT_MERCHANT_ID } from './constants';

/** 员工-门店权限关联表（N:M） */
export const pmsBuiStaffStorePermissions = pgTable('pms_bui_staff_store_permissions', {
  merchantId: varchar('merchant_id', { length: 50 }).notNull().default(DEFAULT_MERCHANT_ID),
  id: varchar('id', { length: 50 }).primaryKey(),
  staffId: varchar('staff_id', { length: 50 }).notNull(),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  staffStoreUnique: uniqueIndex('staff_store_unique_idx').on(table.merchantId, table.staffId, table.storeId),
}));
