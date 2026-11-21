-- 0065：文旅节点表重构
-- 1. 删除废弃列：trigger_type, trigger_credential, location（已被 venue_point_id 取代）
-- 2. 删除 driver_type（并入 node_type）
-- 3. 重命名 unlock_condition → requires
-- 4. effects 拆为 grants（仅保留 grant 数组，丢弃 complete）
-- 5. interactions 数组 → puzzle 单对象

-- 步骤 1：重命名 unlock_condition → requires
ALTER TABLE pms_bui_wenlv_nodes RENAME COLUMN unlock_condition TO requires;

-- 步骤 2：effects → grants（提取 grant 数组，丢弃 complete）
ALTER TABLE pms_bui_wenlv_nodes RENAME COLUMN effects TO grants;
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN grants DROP DEFAULT;
UPDATE pms_bui_wenlv_nodes SET grants = COALESCE(grants->'grant', '[]'::jsonb) WHERE grants IS NOT NULL;
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN grants SET DEFAULT '[]'::jsonb;
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN grants SET NOT NULL;

-- 步骤 3：interactions → puzzle（取第一条，其余丢弃；空数组 → null）
ALTER TABLE pms_bui_wenlv_nodes RENAME COLUMN interactions TO puzzle;
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN puzzle DROP NOT NULL;
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN puzzle DROP DEFAULT;
UPDATE pms_bui_wenlv_nodes SET puzzle = NULL WHERE puzzle = '[]'::jsonb OR puzzle IS NULL;
UPDATE pms_bui_wenlv_nodes SET puzzle = puzzle->0 WHERE puzzle IS NOT NULL AND jsonb_typeof(puzzle) = 'array';

-- 步骤 4：driver_type='npc' → node_type='npc'；其余保持原值
UPDATE pms_bui_wenlv_nodes SET node_type = 'npc' WHERE driver_type = 'npc';

-- 步骤 5：删除废弃列
ALTER TABLE pms_bui_wenlv_nodes DROP COLUMN IF EXISTS trigger_type;
ALTER TABLE pms_bui_wenlv_nodes DROP COLUMN IF EXISTS trigger_credential;
ALTER TABLE pms_bui_wenlv_nodes DROP COLUMN IF EXISTS location;
ALTER TABLE pms_bui_wenlv_nodes DROP COLUMN IF EXISTS driver_type;
