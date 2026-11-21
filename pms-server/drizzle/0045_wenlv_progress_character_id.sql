-- 0045：文旅「角色机制」—— 在 pms_bui_wenlv_progress 上加 character_id
--
-- 玩家选中的角色 id，供 role/skill 条件求值使用。
-- 可空：老数据/未选角的剧本为 NULL，角色条件保守不满足。
-- 软引用不加外键（与 venue_point_id / npc_id 同口径）。
--
-- 幂等性：ALTER 带 IF NOT EXISTS，重跑零效果零报错。
-- ⚠️ 不回填：存量 progress 行 character_id 保持 NULL。
ALTER TABLE pms_bui_wenlv_progress ADD COLUMN IF NOT EXISTS character_id varchar(50);

COMMENT ON COLUMN pms_bui_wenlv_progress.character_id IS '玩家选中的角色 id（角色机制深度1）。NULL=未选角';
