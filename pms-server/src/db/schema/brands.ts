import { pgTable, varchar, text, integer, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

// 品牌表
export const pmsBuiBrands = pgTable('pms_bui_brands', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 20 }).notNull().default('platform'),
  logo: text('logo'),
  color: varchar('color', { length: 20 }),
  description: text('description'),
  storeCount: integer('store_count').notNull().default(0),
  totalRooms: integer('total_rooms').notNull().default(0),
  contactName: varchar('contact_name', { length: 50 }),
  contactPhone: varchar('contact_phone', { length: 20 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  facilities: jsonb('facilities').$type<string[]>().default([]),
  standards: jsonb('standards').$type<{
    checkInTime?: string; checkOutTime?: string;
    cancellationPolicy?: string; depositPolicy?: string;
    reviewReply?: string; childPolicy?: string;
    [key: string]: string | undefined;
  }>(),
  sops: jsonb('sops').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 门店表
export const pmsBuiStores = pgTable('pms_bui_stores', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  brandId: varchar('brand_id', { length: 50 }).notNull(),
  brandName: varchar('brand_name', { length: 100 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  address: text('address'),
  phone: varchar('phone', { length: 20 }),
  roomCount: integer('room_count').notNull().default(0),
  manager: varchar('manager', { length: 50 }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  facilities: jsonb('facilities').$type<string[]>().default([]),
  todayOccupancy: integer('today_occupancy').default(0),
  todayRevenue: integer('today_revenue').default(0),
  monthRevenue: integer('month_revenue').default(0),
  shortName: varchar('short_name', { length: 50 }),
  email: varchar('email', { length: 100 }),
  logo: text('logo'),
  description: text('description'),
  latitude: varchar('latitude', { length: 30 }),
  longitude: varchar('longitude', { length: 30 }),
  // 平台化需求匹配：门店所在城市（用于平台按城市筛选/匹配门店）
  city: varchar('city', { length: 50 }),
  // 平台化需求匹配：门店偏好标签（如 '亲子友好'、'商务接待' 等，用于平台按标签匹配需求）
  preferenceTags: jsonb('preference_tags').$type<string[]>().default([]),
  // 地域标签（如 '黄果树'、'安顺' 等，取自固定库 REGION_TAGS；平台需求匹配/发现页地域筛选用）
  regionTags: jsonb('region_tags').$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
