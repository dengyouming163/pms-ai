-- 补齐所有 Drizzle Schema 定义但数据库缺失的列
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS guest_id text;
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS original_amount text;
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS discount text;
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS extras text;
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS ota_timeout text;
ALTER TABLE pms_bui_orders ADD COLUMN IF NOT EXISTS ota_order_id text;

ALTER TABLE pms_bui_rooms ADD COLUMN IF NOT EXISTS room_id text;

ALTER TABLE pms_bui_room_types ADD COLUMN IF NOT EXISTS created_at text;
ALTER TABLE pms_bui_room_types ADD COLUMN IF NOT EXISTS updated_at text;

ALTER TABLE pms_bui_customers ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE pms_bui_customers ADD COLUMN IF NOT EXISTS level text;

ALTER TABLE pms_bui_stores ADD COLUMN IF NOT EXISTS created_at text;
ALTER TABLE pms_bui_stores ADD COLUMN IF NOT EXISTS updated_at text;

ALTER TABLE pms_bui_channels ADD COLUMN IF NOT EXISTS created_at text;
