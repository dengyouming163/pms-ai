-- S4 商户现场端核销审计：claims 增核销门店列（redeemedBy 记经办员工 staffId）
ALTER TABLE pms_bui_wenlv_claims
  ADD COLUMN IF NOT EXISTS redeemed_store_id varchar(50);
COMMENT ON COLUMN pms_bui_wenlv_claims.redeemed_store_id IS '核销门店 storeId（S4 商户现场端核销审计；redeemedBy 记员工 staffId）';
