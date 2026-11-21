-- 门店平台化需求匹配字段 M1 迁移（平台化套餐销售：按城市/偏好标签匹配门店，生产环境手动执行，幂等）
ALTER TABLE pms_bui_stores ADD COLUMN IF NOT EXISTS city varchar(50);
ALTER TABLE pms_bui_stores ADD COLUMN IF NOT EXISTS preference_tags jsonb DEFAULT '[]'::jsonb;
