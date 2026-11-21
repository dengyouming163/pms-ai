-- =============================================================================
-- 多商户/多门店数据隔离 Migration
-- 为所有业务表添加 merchant_id 和 store_id 字段
-- =============================================================================

-- Phase 1: 为已有 store_id 的表添加 merchant_id
ALTER TABLE "pms_bui_brands" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_stores" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_room_types" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_rooms" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_room_devices" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_pricing_rules" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_pricing_calendar" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_promotions" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_channels" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
--> statement-breakpoint

-- Phase 2: 为已有 store_id (nullable) 的表添加 merchant_id 并修复 store_id 为 NOT NULL
ALTER TABLE "pms_bui_orders" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
UPDATE "pms_bui_orders" SET "store_id" = 'default_store' WHERE "store_id" IS NULL;
ALTER TABLE "pms_bui_orders" ALTER COLUMN "store_id" SET NOT NULL;
ALTER TABLE "pms_bui_orders" ALTER COLUMN "store_id" SET DEFAULT 'default_store';
--> statement-breakpoint

ALTER TABLE "pms_bui_reviews" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
UPDATE "pms_bui_reviews" SET "store_id" = 'default_store' WHERE "store_id" IS NULL;
ALTER TABLE "pms_bui_reviews" ALTER COLUMN "store_id" SET NOT NULL;
ALTER TABLE "pms_bui_reviews" ALTER COLUMN "store_id" SET DEFAULT 'default_store';
--> statement-breakpoint

-- Phase 3: 为完全没有 store_id 的表添加 merchant_id + store_id
ALTER TABLE "pms_bui_channel_orders" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_channel_orders" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_transactions" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_transactions" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_reconciliation_details" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_reconciliation_details" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_reconciliation_alerts" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_reconciliation_alerts" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_customers" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_customers" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_tags" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_tags" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_auto_tag_rules" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_auto_tag_rules" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_care_reminders" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_care_reminders" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_settings" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_settings" ADD COLUMN "store_id" varchar(50) DEFAULT '*' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_ai_chat_history" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_ai_chat_history" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_ai_suggestions" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_ai_suggestions" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_roles" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_op_logs" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_op_logs" ADD COLUMN "store_id" varchar(50) DEFAULT 'default_store' NOT NULL;
--> statement-breakpoint

ALTER TABLE "pms_bui_housekeeping_tasks" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
--> statement-breakpoint

-- Phase 4: 改造 staff 表 — 用关联表替代 JSONB stores 字段
ALTER TABLE "pms_bui_staff" ADD COLUMN "merchant_id" varchar(50) DEFAULT 'default' NOT NULL;
ALTER TABLE "pms_bui_staff" DROP COLUMN "stores";
--> statement-breakpoint

-- Phase 5: 创建员工-门店权限关联表
CREATE TABLE "pms_bui_staff_store_permissions" (
  "merchant_id" varchar(50) DEFAULT 'default' NOT NULL,
  "id" varchar(50) PRIMARY KEY NOT NULL,
  "staff_id" varchar(50) NOT NULL,
  "store_id" varchar(50) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE UNIQUE INDEX "staff_store_unique_idx" ON "pms_bui_staff_store_permissions" USING btree ("merchant_id", "staff_id", "store_id");
