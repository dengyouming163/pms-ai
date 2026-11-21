-- 0075 实景解密体系 P1a（spec 2026-10-07-wenlv-immersive-puzzle-system-design §8）
-- 1) nodes 加 atoms 列：有序交互原子数组（jsonb 可空）。null/[] = 老剧本走 puzzle 路径，零行为变更。
-- 2) 场地能力档案表：每个 venue 一份（1:1），登记配合能力/可部署原子白名单/动线半径/时段。
-- 3) 合作商户表：暗号接头（cipher-contact）的回执码与三句培训卡载体。
-- 4) 实体道具登记表：暗码系统生成即登记，供履约清单与布房勾表。
-- 全部 IF NOT EXISTS 幂等，零回填。
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS atoms jsonb;

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_venue_profiles (
  id varchar(50) PRIMARY KEY,
  venue_id varchar(50) NOT NULL,
  support_actions jsonb NOT NULL DEFAULT '{}',
  deployable_atoms jsonb NOT NULL DEFAULT '[]',
  route_radius_m integer,
  time_windows jsonb NOT NULL DEFAULT '[]',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_venue_profiles_venue ON pms_bui_wenlv_venue_profiles(venue_id);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_merchant_partners (
  id varchar(50) PRIMARY KEY,
  venue_id varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'restaurant',
  cipher_dish varchar(100),
  reply_code varchar(40),
  staff_card text,
  time_windows jsonb NOT NULL DEFAULT '[]',
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_merchant_partners_venue ON pms_bui_wenlv_merchant_partners(venue_id);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_props (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  name varchar(100) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'letter',
  code varchar(40),
  place_note text,
  node_id varchar(50),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_props_product ON pms_bui_wenlv_props(product_id);
