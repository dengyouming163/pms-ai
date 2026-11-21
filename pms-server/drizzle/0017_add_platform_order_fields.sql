--> statement-breakpoint
ALTER TABLE "pms_bui_orders"
  ADD COLUMN IF NOT EXISTS "platform_order_id" varchar(50),
  ADD COLUMN IF NOT EXISTS "platform_order_no" varchar(50),
  ADD COLUMN IF NOT EXISTS "verify_code" varchar(6);
--> statement-breakpoint
-- 转化幂等：同一平台订单只生成一条住宿订单（部分索引：NULL 不参与唯一约束）
CREATE UNIQUE INDEX IF NOT EXISTS "uq_orders_platform_order" ON "pms_bui_orders" ("platform_order_id")
  WHERE "platform_order_id" IS NOT NULL;
