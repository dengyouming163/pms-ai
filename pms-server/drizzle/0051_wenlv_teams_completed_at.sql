-- 0051: 给 pms_bui_wenlv_teams 加 completed_at 列（团队结算时间）。
-- 幂等：IF NOT EXISTS 避免重复执行报错。
ALTER TABLE pms_bui_wenlv_teams
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN pms_bui_wenlv_teams.completed_at IS '团队结算时间（status=completed 时写入，NULL=未结算）';
