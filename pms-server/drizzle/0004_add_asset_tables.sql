-- 素材库打卡任务体系 — 4 张新表（幂等）
-- 对应 src/db/schema/assets.ts：media_assets / asset_templates / asset_tasks / asset_task_submissions

CREATE TABLE IF NOT EXISTS media_assets (
  id varchar(64) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  store_id varchar(64) NOT NULL DEFAULT 'default_store',
  url text NOT NULL,
  thumbnail_url text,
  media_type varchar(10) NOT NULL DEFAULT 'image',
  category varchar(30) NOT NULL DEFAULT 'other',
  room_id varchar(64),
  room_name varchar(100),
  room_type_id varchar(64),
  purpose_tags jsonb,
  shot_type varchar(50),
  uploader_staff_id varchar(64),
  uploader_staff_name varchar(100),
  task_id varchar(64),
  quality varchar(10) NOT NULL DEFAULT 'normal',
  status varchar(10) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_templates (
  id varchar(64) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  store_id varchar(64) NOT NULL DEFAULT 'default_store',
  name varchar(100) NOT NULL,
  shot_type varchar(50) NOT NULL,
  media_type varchar(10) NOT NULL DEFAULT 'image',
  category varchar(30) NOT NULL DEFAULT 'room',
  purpose_tags jsonb,
  example_image_url text,
  example_video_url text,
  guide_text text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_tasks (
  id varchar(64) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  store_id varchar(64) NOT NULL DEFAULT 'default_store',
  title varchar(200) NOT NULL,
  task_date date,
  deadline timestamptz,
  template_refs jsonb,
  room_ids jsonb,
  room_names jsonb,
  shot_requirements jsonb,
  purpose_tags jsonb,
  guide_text text,
  assignee_scope varchar(10) NOT NULL DEFAULT 'all',
  assignee_staff_ids jsonb,
  status varchar(12) NOT NULL DEFAULT 'published',
  publisher_id varchar(64),
  publisher_name varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_task_submissions (
  id varchar(64) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  store_id varchar(64) NOT NULL DEFAULT 'default_store',
  task_id varchar(64) NOT NULL,
  staff_id varchar(64) NOT NULL,
  staff_name varchar(100),
  status varchar(12) NOT NULL DEFAULT 'pending',
  asset_ids jsonb,
  note text,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
