-- 0050_wenlv_venue_cover_image.sql
-- 场地表加封面图字段（C 端场地卡片展示）。纯 ADD COLUMN IF NOT EXISTS，零回填。
ALTER TABLE pms_bui_wenlv_venues ADD COLUMN IF NOT EXISTS cover_image varchar(500);
