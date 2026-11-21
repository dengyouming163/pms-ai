-- 0072_wenlv_claims_qrcode.sql
ALTER TABLE pms_bui_wenlv_claims
  ADD COLUMN IF NOT EXISTS qrcode varchar(500);
