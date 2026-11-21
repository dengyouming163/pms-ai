-- 微信入住订单表 M1 迁移（员工 H5 粘贴解析入库，平台端「入住订单」菜单展示；生产手动执行，幂等）
CREATE TABLE IF NOT EXISTS "pms_bui_checkin_orders" (
  "id" varchar(50) PRIMARY KEY,
  "merchant_id" varchar(64) NOT NULL DEFAULT 'default',
  "store_id" varchar(50) NOT NULL,
  "guest_name" varchar(50),
  "guest_phone" varchar(20),
  "adult_count" integer NOT NULL DEFAULT 1,
  "child_count" integer NOT NULL DEFAULT 0,
  "room_type" varchar(100),
  "check_in_date" varchar(20),
  "check_out_date" varchar(20),
  "nights" integer NOT NULL DEFAULT 1,
  "raw_text" text,
  "source" varchar(30) DEFAULT 'wechat',
  "status" varchar(30) NOT NULL DEFAULT 'checked_in',
  "staff_name" varchar(50),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "checkin_orders_store_created_idx"
  ON "pms_bui_checkin_orders" ("store_id", "created_at");
