-- 素材库体系优化：任务记录来源规则（用于自动化幂等查重）
ALTER TABLE asset_tasks ADD COLUMN IF NOT EXISTS rule_id varchar(64);

-- DB 级幂等兜底：同一规则同一天最多一个任务（手动任务 rule_id 为 NULL 不受约束）
CREATE UNIQUE INDEX IF NOT EXISTS asset_tasks_rule_date_idx ON asset_tasks (rule_id, task_date) WHERE rule_id IS NOT NULL;
