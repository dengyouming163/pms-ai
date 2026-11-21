-- 文旅 S1：场地与点位底座
-- 新表 venues / venue_points；products 加归属与交付时间戳；nodes 加 venuePointId
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_venues (
  id varchar(50) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL DEFAULT 'default',
  name varchar(100) NOT NULL,
  address text,
  city varchar(50),
  latitude varchar(30),
  longitude varchar(30),
  status varchar(20) NOT NULL DEFAULT 'lead',
  owner_staff_id varchar(50),
  contact_name varchar(50),
  contact_phone varchar(20),
  remark text,
  survey_started_at timestamptz,
  surveyed_at timestamptz,
  deployed_at timestamptz,
  live_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_venue_points (
  id varchar(50) PRIMARY KEY,
  venue_id varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  code varchar(100),
  trigger_type varchar(20) NOT NULL DEFAULT 'qrcode',
  geo jsonb,
  address varchar(200),
  sort_order integer NOT NULL DEFAULT 0,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- code 唯一：PG 的 unique index 允许多个 NULL，正好表达「还没铺码的点位」
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_venue_points_code ON pms_bui_wenlv_venue_points(code);
CREATE INDEX IF NOT EXISTS idx_wenlv_venue_points_venue ON pms_bui_wenlv_venue_points(venue_id);

ALTER TABLE pms_bui_wenlv_products
  ADD COLUMN IF NOT EXISTS venue_id varchar(50),
  ADD COLUMN IF NOT EXISTS generation_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS content_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS venue_point_id varchar(50);
