-- 0077 文旅合作商户关联平台商户主数据（pms_platform_merchants 在 BFF 库，跨库不建外键，仅记 id）。
-- 可空：老数据未关联，不强制迁移。
ALTER TABLE pms_bui_wenlv_merchant_partners
  ADD COLUMN IF NOT EXISTS platform_merchant_id varchar(50);
CREATE INDEX IF NOT EXISTS idx_wenlv_merchant_platform ON pms_bui_wenlv_merchant_partners(platform_merchant_id);
