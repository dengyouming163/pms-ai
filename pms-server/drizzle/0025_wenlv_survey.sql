-- 文旅 S2：采风与生成
-- 点位加现场照片；新增场地级文化素材表；产品加 AI 输入快照
ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS photos jsonb;

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_culture_materials (
  id varchar(50) PRIMARY KEY,
  venue_id varchar(50) NOT NULL,
  venue_point_id varchar(50),
  type varchar(30) NOT NULL,
  title varchar(100) NOT NULL,
  content text NOT NULL,
  source varchar(100),
  photos jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wenlv_culture_materials_venue
  ON pms_bui_wenlv_culture_materials(venue_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_culture_materials_point
  ON pms_bui_wenlv_culture_materials(venue_point_id);

ALTER TABLE pms_bui_wenlv_products
  ADD COLUMN IF NOT EXISTS ai_input jsonb;
