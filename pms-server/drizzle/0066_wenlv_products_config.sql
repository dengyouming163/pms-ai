-- 0066：products.config 拆解
-- validDays → valid_days 列
-- teamSize.{min,max} → team_size_min / team_size_max 列
-- 从 config 中删除 characters（AI快照，已被 characters 表取代）
-- 从 config 中删除 exclusiveClues（与 characters.hiddenQuest.collectible_ids 冗余）

ALTER TABLE pms_bui_wenlv_products ADD COLUMN IF NOT EXISTS valid_days integer;
ALTER TABLE pms_bui_wenlv_products ADD COLUMN IF NOT EXISTS team_size_min integer;
ALTER TABLE pms_bui_wenlv_products ADD COLUMN IF NOT EXISTS team_size_max integer;

-- 回填
UPDATE pms_bui_wenlv_products
SET valid_days = (config->>'validDays')::integer
WHERE config ? 'validDays' AND config->>'validDays' IS NOT NULL;

UPDATE pms_bui_wenlv_products
SET team_size_min = (config->'teamSize'->>'min')::integer
WHERE config ? 'teamSize' AND config->'teamSize'->>'min' IS NOT NULL;

UPDATE pms_bui_wenlv_products
SET team_size_max = (config->'teamSize'->>'max')::integer
WHERE config ? 'teamSize' AND config->'teamSize'->>'max' IS NOT NULL;

-- 从 config 中删除冗余键
UPDATE pms_bui_wenlv_products
SET config = config - 'characters' - 'exclusiveClues' - 'validDays' - 'teamSize'
WHERE config ?| ARRAY['characters','exclusiveClues','validDays','teamSize'];
