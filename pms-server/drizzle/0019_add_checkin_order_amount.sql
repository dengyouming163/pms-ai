-- 入住订单编辑字段 M2 迁移：订单总金额 + 结算金额 + 退款金额（生产手动执行，幂等）
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "total_amount" numeric(10,2);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "settlement_amount" numeric(10,2);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "refund_amount" numeric(10,2);
ALTER TABLE "pms_bui_checkin_orders" ADD COLUMN IF NOT EXISTS "payment_method" varchar(20);
