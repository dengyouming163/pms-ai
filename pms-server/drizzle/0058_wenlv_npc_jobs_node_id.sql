-- 0058_wenlv_npc_jobs_node_id.sql
-- 节点一键迁移为 NPC 驱动（异步任务）：npc_jobs 表加 node_id 列。
-- 仅 node_migrate 类型的 job 使用此列，其余类型为 NULL。
ALTER TABLE pms_bui_wenlv_npc_jobs
  ADD COLUMN IF NOT EXISTS node_id varchar(50);
