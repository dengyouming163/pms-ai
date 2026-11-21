-- 0056_wenlv_dialogues_team.sql
-- 多玩家协作 NPC 章节（模块 C）：dialogues 表加 team_id，团队模式下多个队员共享同一对话。
-- 单人模式 team_id 为 NULL，行为不变（向后兼容）。
ALTER TABLE pms_bui_wenlv_dialogues
  ADD COLUMN IF NOT EXISTS team_id varchar(64);
CREATE INDEX IF NOT EXISTS idx_wenlv_dialogues_team ON pms_bui_wenlv_dialogues(team_id);
