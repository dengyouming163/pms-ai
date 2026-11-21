-- 门店地域标签字段（地域标签固定库 REGION_TAGS 对应的列）
ALTER TABLE pms_bui_stores ADD COLUMN IF NOT EXISTS region_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
