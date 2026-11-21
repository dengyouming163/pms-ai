-- 0055_wenlv_npc_relationships.sql
-- NPC 关系网（模块 B）：创作者配置 NPC 之间的关系，prompt-builder 注入 LLM。
-- pending_mentions：跨 NPC 记忆队列，mentionNpc 工具调用时写入，目标 NPC 下次出场时读取并清空。
ALTER TABLE pms_bui_wenlv_npcs
  ADD COLUMN IF NOT EXISTS relationships jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS pending_mentions jsonb NOT NULL DEFAULT '[]';
