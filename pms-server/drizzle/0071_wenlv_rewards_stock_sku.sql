-- 0071_wenlv_rewards_stock_sku.sql
ALTER TABLE pms_bui_wenlv_rewards
  ADD COLUMN IF NOT EXISTS stock_limit integer,
  ADD COLUMN IF NOT EXISTS stock_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS merchandise_sku varchar(80),
  ADD COLUMN IF NOT EXISTS pickup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_enabled boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_wenlv_rewards_sku ON pms_bui_wenlv_rewards(merchandise_sku);
