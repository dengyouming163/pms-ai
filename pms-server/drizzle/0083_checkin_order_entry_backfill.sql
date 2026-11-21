-- 0083：入住订单板块改造（平台端订单录入 / 历史补录 / 状态机 / 流转审计）
-- 生产手动执行，全部语句幂等（IF NOT EXISTS 保护），可重复执行。
-- 日期列改造分三步：本文件只做第 1 步（加影子列），回填与交换由
-- `npx tsx scripts/normalize-checkin-dates.ts --dry-run|--apply|--swap` 完成。

-- ============ 步骤 A：新增 18 列（可空或带默认值，不影响既有行与 H5 写入链路）============
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "order_no" varchar(32);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "created_channel" varchar(20) DEFAULT 'h5';
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "created_by" varchar(64);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "created_by_name" varchar(50);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "is_backfill" boolean NOT NULL DEFAULT false;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "room_no" varchar(50);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "room_count" integer NOT NULL DEFAULT 1;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "check_in_at" timestamp with time zone;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "check_out_at" timestamp with time zone;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "channel_order_no" varchar(64);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "cancel_reason" text;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "refund_reason" text;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "deposit_amount" numeric(10,2);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "contact_name" varchar(50);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "contact_phone" varchar(20);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "remark" text;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "property_id" varchar(64);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "customer_platform_id" varchar(64);

-- ============ 步骤 B：状态流转日志表 ============
CREATE TABLE IF NOT EXISTS "pms_bui_checkin_order_status_logs" (
  "id" varchar(50) PRIMARY KEY,
  "order_id" varchar(50) NOT NULL,
  "from_status" varchar(30),
  "to_status" varchar(30) NOT NULL,
  "reason" text,
  "operator_id" varchar(64),
  "operator_name" varchar(50),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "checkin_order_status_logs_order_idx"
  ON "pms_bui_checkin_order_status_logs" ("order_id", "created_at");

-- ============ 步骤 C：日期列影子列（三步法第 1 步）============
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "check_in_date_d" date;
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "check_out_date_d" date;

-- ============ 步骤 D：索引 ============
-- order_no 唯一索引：PG 的唯一索引允许多个 NULL，故既有历史行（order_no 为 NULL）不会冲突。
-- 该索引同时是「并发生成订单号」的最终兜底（冲突由应用层捕获后重试）。
CREATE UNIQUE INDEX IF NOT EXISTS "checkin_orders_order_no_uq"
  ON "pms_bui_checkin_orders" ("order_no");
-- (store_id, status, created_at)：列表页「门店 + 状态 + 按录入时间倒序分页」由一条索引同时覆盖过滤与排序。
CREATE INDEX IF NOT EXISTS "checkin_orders_store_status_idx"
  ON "pms_bui_checkin_orders" ("store_id", "status", "created_at");
-- 部分索引：布尔列的单列索引选择性极差（取值上限 2 个，规划器基本不会选它）；
-- 只索引「补录行」⇒ 体积≈只含补录行、选择性极高，服务列表页「补录三态 = 仅补录」的筛选。
CREATE INDEX IF NOT EXISTS "checkin_orders_backfill_idx"
  ON "pms_bui_checkin_orders" ("is_backfill") WHERE "is_backfill" = true;
