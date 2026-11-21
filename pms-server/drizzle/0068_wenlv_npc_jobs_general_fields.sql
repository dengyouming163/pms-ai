-- 0068_wenlv_npc_jobs_general_fields.sql
-- 通用化 npc_jobs 表：支持非 NPC 类目标（角色/节点/线索/结局/奖励）
-- 兼容现有 npcId/nodeId 字段（保留），新业务用 target_type+target_id
ALTER TABLE pms_bui_wenlv_npc_jobs
  ADD COLUMN IF NOT EXISTS target_type varchar(20),  -- character/npc/node/collectible/ending/reward
  ADD COLUMN IF NOT EXISTS target_id varchar(50),
  ADD COLUMN IF NOT EXISTS stage varchar(40);        -- AI Crew stage 名
CREATE INDEX IF NOT EXISTS idx_wenlv_npc_jobs_target ON pms_bui_wenlv_npc_jobs(target_type, target_id);
