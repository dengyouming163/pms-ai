ALTER TABLE pms_bui_wenlv_collectibles
  ADD COLUMN IF NOT EXISTS qr_code varchar(100);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_collectibles_qr_code
  ON pms_bui_wenlv_collectibles(qr_code)
  WHERE qr_code IS NOT NULL;
