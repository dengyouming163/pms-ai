-- 素材库体系优化：自动化任务规则表 + 任务房型字段 + 模板 source
-- source 枚举：'store'=门店自建/导入副本，'system'=系统预置只读模板
CREATE TABLE IF NOT EXISTS asset_task_rules (
  id varchar(64) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  store_id varchar(64) NOT NULL DEFAULT 'default_store',
  name varchar(100) NOT NULL,
  template_refs jsonb,
  room_type_ids jsonb,
  room_type_names jsonb,
  purpose_tags jsonb,
  guide_text text,
  assignee_scope varchar(10) NOT NULL DEFAULT 'all',
  assignee_staff_ids jsonb,
  publish_time varchar(5) NOT NULL DEFAULT '09:00',
  status varchar(12) NOT NULL DEFAULT 'disabled',
  last_run_at timestamptz,
  next_run_at timestamptz,
  publisher_id varchar(64),
  publisher_name varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE asset_templates ADD COLUMN IF NOT EXISTS source varchar(10) NOT NULL DEFAULT 'store';
ALTER TABLE asset_tasks ADD COLUMN IF NOT EXISTS room_type_ids jsonb;
ALTER TABLE asset_tasks ADD COLUMN IF NOT EXISTS room_type_names jsonb;
