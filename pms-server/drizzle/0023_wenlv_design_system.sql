-- 文旅 AI 创作平台 · 全局设计系统（Plan 1）：两张新表 + 三处既有表扩展
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_design_templates (
  id varchar(50) PRIMARY KEY,
  name varchar(100) NOT NULL,
  style_tag varchar(50) NOT NULL,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_design_assets (
  id varchar(50) PRIMARY KEY,
  type varchar(20) NOT NULL,
  style_tag varchar(50),
  name varchar(100) NOT NULL,
  url varchar(500),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS image varchar(500),
  ADD COLUMN IF NOT EXISTS location varchar(200);

ALTER TABLE pms_bui_wenlv_rewards
  ADD COLUMN IF NOT EXISTS image varchar(500);

CREATE INDEX IF NOT EXISTS idx_wenlv_design_assets_type ON pms_bui_wenlv_design_assets(type);
CREATE INDEX IF NOT EXISTS idx_wenlv_design_assets_style_tag ON pms_bui_wenlv_design_assets(style_tag);
