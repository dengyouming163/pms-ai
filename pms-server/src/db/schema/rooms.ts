import { pgTable, varchar, text, integer, timestamp, jsonb, boolean, numeric } from 'drizzle-orm/pg-core';

// 房型表
export const pmsBuiRoomTypes = pgTable('pms_bui_room_types', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  bedType: varchar('bed_type', { length: 50 }).notNull(),
  area: varchar('area', { length: 20 }),
  maxGuests: integer('max_guests').notNull().default(2),
  facilities: jsonb('facilities').$type<string[]>().default([]),
  roomCount: integer('room_count').notNull().default(0),
  basePrice: integer('base_price').notNull(),
  weekdayPrice: integer('weekday_price'),
  weekendPrice: integer('weekend_price'),
  holidayPrice: integer('holiday_price'),
  minPrice: integer('min_price'),
  description: text('description'),
  images: jsonb('images').$type<string[]>().default([]),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 房间表
export const pmsBuiRooms = pgTable('pms_bui_rooms', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  roomTypeId: varchar('room_type_id', { length: 50 }).notNull(),
  roomTypeName: varchar('room_type_name', { length: 100 }).notNull(),
  roomNumber: varchar('room_number', { length: 20 }).notNull(),
  floor: integer('floor').notNull().default(1),
  status: varchar('status', { length: 20 }).notNull().default('available'),
  price: integer('price'),
  guestName: varchar('guest_name', { length: 50 }),
  guestPhone: varchar('guest_phone', { length: 20 }),
  checkInDate: varchar('check_in_date', { length: 20 }),
  checkOutDate: varchar('check_out_date', { length: 20 }),
  bookingId: varchar('booking_id', { length: 50 }),
  lockReason: text('lock_reason'),
  dirtyType: varchar('dirty_type', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 房间设备表
export const pmsBuiRoomDevices = pgTable('pms_bui_room_devices', {
  id: varchar('id', { length: 50 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  roomNumber: varchar('room_number', { length: 20 }).notNull(),
  deviceName: varchar('device_name', { length: 100 }).notNull(),
  deviceType: varchar('device_type', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('normal'),
  lastCheckDate: varchar('last_check_date', { length: 20 }),
  remark: text('remark'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
