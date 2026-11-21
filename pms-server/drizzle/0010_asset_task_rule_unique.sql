-- 自动化任务幂等：同一规则同一任务日只产一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_tasks_rule_date
  ON asset_tasks (task_date, rule_id)
  WHERE rule_id IS NOT NULL;
