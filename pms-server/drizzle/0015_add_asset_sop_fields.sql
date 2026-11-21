-- 拍摄模板 SOP 固化：新增运镜/禁拍/时长字段
ALTER TABLE asset_templates
  ADD COLUMN IF NOT EXISTS movement_text text,
  ADD COLUMN IF NOT EXISTS avoid_text text,
  ADD COLUMN IF NOT EXISTS duration_min integer,
  ADD COLUMN IF NOT EXISTS duration_max integer;
