-- 0070_wenlv_merch_redeems.sql
-- 文创商品兑换记录表（兑换 + 核销 + 物流）
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_merch_redeems (
  id              varchar(50) PRIMARY KEY,
  product_id      varchar(50) NOT NULL,
  mini_user_id    varchar(50) NOT NULL,
  progress_id    varchar(50) NOT NULL,
  reward_id       varchar(50) NOT NULL,
  tier_id         varchar(50) NOT NULL,
  claim_code      varchar(24) NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'pending',
  receiver_name   varchar(100),
  receiver_phone  varchar(30),
  receiver_address text,
  shipment_no     varchar(80),
  shipment_carrier varchar(50),
  shipped_at      timestamptz,
  completed_at    timestamptz,
  redeemed_by     varchar(50),
  redeemed_store_id varchar(50),
  redeemed_at     timestamptz,
  meta            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_merch_redeems_code ON pms_bui_wenlv_merch_redeems(claim_code);
CREATE INDEX IF NOT EXISTS idx_wenlv_merch_redeems_progress ON pms_bui_wenlv_merch_redeems(progress_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_merch_redeems_product ON pms_bui_wenlv_merch_redeems(product_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_merch_redeems_status ON pms_bui_wenlv_merch_redeems(status);
