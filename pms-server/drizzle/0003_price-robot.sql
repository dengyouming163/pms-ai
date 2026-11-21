-- 自动收益管家 4 表迁移：配置 / 每日授权 / 改价任务 / 执行日志
-- 注：仓库 journal 与 schema 长期脱节导致 drizzle-kit generate 需交互确认，
--     本文件按 drizzle-kit 输出格式手工等价生成（CREATE TABLE + 唯一索引）。
--> statement-breakpoint
CREATE TABLE "pms_price_robot_config" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"room_type_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channels" jsonb DEFAULT '["携程","美团"]'::jsonb NOT NULL,
	"strategy" text DEFAULT 'standard' NOT NULL,
	"slots" jsonb DEFAULT '["17:00","19:00","21:00"]'::jsonb NOT NULL,
	"future_days" integer DEFAULT 14 NOT NULL,
	"floor_cap_ratio" numeric DEFAULT '1.5' NOT NULL,
	"max_deviation_pct" integer DEFAULT 30 NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "price_robot_config_store_room_uq" ON "pms_price_robot_config" USING btree ("store_id","room_type_id");
--> statement-breakpoint
CREATE TABLE "pms_price_robot_auth" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"merchant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"room_type_id" text NOT NULL,
	"floor_price" numeric NOT NULL,
	"strategy" text DEFAULT 'standard' NOT NULL,
	"slot_plans" jsonb NOT NULL,
	"auth_by" text,
	"auth_at" timestamptz,
	"expire_at" timestamptz NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "price_robot_auth_date_room_uq" ON "pms_price_robot_auth" USING btree ("date","store_id","room_type_id");
--> statement-breakpoint
CREATE TABLE "pms_price_robot_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"slot" text NOT NULL,
	"merchant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"room_type_id" text NOT NULL,
	"room_type_name" text NOT NULL,
	"channel" text NOT NULL,
	"current_price" numeric,
	"target_price" numeric NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_price" numeric,
	"error" text,
	"executed_at" timestamptz,
	"latency_ms" integer,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "price_robot_task_uq" ON "pms_price_robot_tasks" USING btree ("date","slot","store_id","room_type_id","channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_robot_tasks_store_date_status_idx" ON "pms_price_robot_tasks" USING btree ("store_id","date","status");
--> statement-breakpoint
CREATE TABLE "pms_price_robot_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"before_price" numeric,
	"after_price" numeric,
	"read_back_price" numeric,
	"attempts" integer DEFAULT 0 NOT NULL,
	"browser_snapshot" text,
	"operator" text,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_robot_logs_task_idx" ON "pms_price_robot_logs" USING btree ("task_id");
