-- 文旅团队剧本：队伍进度列
-- 存储全员进度并集 + 协作题答题状态
-- 幂等：IF NOT EXISTS

ALTER TABLE pms_bui_wenlv_teams
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN pms_bui_wenlv_teams.progress IS '队伍共享进度（visited/collected/completed/collaborativeAnswers）';
