-- 0053：文旅节点 NPC 驱动模式
--
-- driver_type：'traditional'（老模式：文本+旁白+谜题）/ 'npc'（NPC 驱动对话章节）。
--   存量节点默认 'traditional'，零行为变更。
-- chapter_goal：NPC 驱动章节的对话目标（类型/描述/判据/最小轮次/选项/线索）。
-- opening_line：NPC 开场白，NULL 则由 AI 生成。
--
-- 幂等：ADD COLUMN IF NOT EXISTS。不回填。
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS driver_type varchar(20) NOT NULL DEFAULT 'traditional';
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS chapter_goal jsonb;
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS opening_line text;
