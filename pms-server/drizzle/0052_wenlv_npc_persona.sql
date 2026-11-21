-- 0052：文旅 NPC 人格卡 + 跨章节记忆
--
-- persona：NPC 的人格定义（性格/语气/口头禅/背景/线索/禁忌），注入 LLM System Prompt。
-- memory：NPC 对玩家的跨章节印象摘要，每章完成后由 LLM 生成。
--
-- 幂等：ALTER ADD COLUMN IF NOT EXISTS，重跑零效果。
-- 不回填：存量 NPC 的 persona 保持 '{}'，memory 保持 NULL —— 老 NPC 无 AI 人格不影响。
ALTER TABLE pms_bui_wenlv_npcs ADD COLUMN IF NOT EXISTS persona jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pms_bui_wenlv_npcs ADD COLUMN IF NOT EXISTS memory text;
