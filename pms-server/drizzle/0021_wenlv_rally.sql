-- 文旅集章（S1）：products.mode + 运营窗口；nodes.geo（GPS 预留）；collectibles.stamp_meta；档位表；领取台账
ALTER TABLE pms_bui_wenlv_products
  ADD COLUMN IF NOT EXISTS mode varchar(20) NOT NULL DEFAULT 'narrative',
  ADD COLUMN IF NOT EXISTS ops_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS ops_end_at timestamptz;

ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS geo jsonb;

ALTER TABLE pms_bui_wenlv_collectibles
  ADD COLUMN IF NOT EXISTS stamp_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_reward_tiers (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  name varchar(200) NOT NULL,
  description text,
  "order" integer NOT NULL DEFAULT 0,
  condition jsonb,
  reward_id varchar(50),
  icon varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_claims (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  mini_user_id varchar(50) NOT NULL,
  progress_id varchar(50) NOT NULL,
  tier_id varchar(50) NOT NULL,
  reward_id varchar(50),
  code varchar(24) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  redeemed_by varchar(50),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_claims_progress ON pms_bui_wenlv_claims(progress_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_claims_progress_tier ON pms_bui_wenlv_claims(progress_id, tier_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_claims_code ON pms_bui_wenlv_claims(code);
