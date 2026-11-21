-- 0076 导演 v1（spec §6.2 P1b）：跨夜运行时编排状态。惰性 tick，无调度器。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_director_states (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  progress_id varchar(50) NOT NULL,
  state jsonb NOT NULL DEFAULT '{}',
  alerts jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_director_progress ON pms_bui_wenlv_director_states(progress_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_director_product ON pms_bui_wenlv_director_states(product_id);
