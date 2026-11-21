-- 自动收益管家二期：未来价计划表 pms_price_robot_plans + tasks.target_date 列 + 唯一索引扩列
-- 注：仓库 journal 与 schema 长期脱节导致 drizzle-kit generate 需交互确认，
--     本文件按 drizzle-kit 输出格式手工等价生成（CREATE TABLE IF NOT EXISTS + 唯一索引）。
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pms_price_robot_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_date" text NOT NULL,
	"merchant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"room_type_id" text NOT NULL,
	"room_type_name" text NOT NULL,
	"price" numeric NOT NULL,
	"predicted_occupancy" integer NOT NULL,
	"base_price" numeric NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_robot_plan_uq" ON "pms_price_robot_plans" USING btree ("plan_date","store_id","room_type_id");
--> statement-breakpoint
ALTER TABLE "pms_price_robot_tasks" ADD COLUMN IF NOT EXISTS "target_date" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "price_robot_task_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_robot_task_uq" ON "pms_price_robot_tasks" USING btree ("date","slot","store_id","room_type_id","channel","target_date");
