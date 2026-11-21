-- 文旅内容模型（8 表）
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_products (
  id varchar(50) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  name varchar(200) NOT NULL,
  subtitle varchar(200),
  cover_image varchar(500),
  status varchar(20) NOT NULL DEFAULT 'draft',
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_nodes (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  node_type varchar(20) NOT NULL DEFAULT 'scene',
  title varchar(200) NOT NULL,
  story_text text,
  trigger_type varchar(20) NOT NULL DEFAULT 'manual',
  trigger_credential varchar(100),
  unlock_condition jsonb,
  effects jsonb NOT NULL DEFAULT '{"grant":[],"complete":[]}'::jsonb,
  interactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  "order" integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_collectibles (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  type varchar(20) NOT NULL DEFAULT 'clue',
  rarity varchar(20) NOT NULL DEFAULT 'common',
  image varchar(500),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_storylines (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  title varchar(200) NOT NULL,
  "order" integer NOT NULL DEFAULT 0,
  node_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_endings (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  title varchar(200) NOT NULL,
  trigger_condition jsonb NOT NULL,
  text text,
  image varchar(500),
  reward_id varchar(50),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_rewards (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  name varchar(200) NOT NULL,
  type varchar(20) NOT NULL DEFAULT 'coupon',
  merchant_id varchar(64),
  store_id varchar(50),
  value varchar(100),
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_progress (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  mini_user_id varchar(50) NOT NULL,
  state jsonb NOT NULL DEFAULT '{"visited":{},"collected":{},"completed":{}}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'active',
  ending_id varchar(50),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_events (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  mini_user_id varchar(50) NOT NULL,
  event_type varchar(20) NOT NULL,
  node_id varchar(50),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_user_product
  ON pms_bui_wenlv_progress (mini_user_id, product_id);
