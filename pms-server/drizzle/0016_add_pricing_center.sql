--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pms_bui_daily_price" (
  "id" text PRIMARY KEY NOT NULL,
  "merchant_id" varchar(64) DEFAULT 'default' NOT NULL,
  "store_id" varchar(50) NOT NULL,
  "room_type_id" varchar(64) NOT NULL,
  "room_type_name" varchar(100) NOT NULL,
  "date" varchar(20) NOT NULL,
  "price" integer NOT NULL,
  "source" varchar(20) DEFAULT 'adopt' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_price_store_room_date_uq" ON "pms_bui_daily_price" USING btree ("store_id","room_type_id","date");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pms_bui_holidays" (
  "id" text PRIMARY KEY NOT NULL,
  "date" varchar(20) NOT NULL,
  "name" varchar(50) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "holidays_date_uq" ON "pms_bui_holidays" USING btree ("date");
--> statement-breakpoint
-- 定价中心设置：门店级 config 行(room_type_id='*')新增节假日加价%与推荐开关
ALTER TABLE "pms_price_robot_config" ADD COLUMN IF NOT EXISTS "holiday_markup_pct" integer DEFAULT 20 NOT NULL,
  ADD COLUMN IF NOT EXISTS "recommendation_enabled" boolean DEFAULT true NOT NULL;
