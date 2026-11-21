CREATE TABLE IF NOT EXISTS pms_bui_wenlv_triggers (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  type varchar(20) NOT NULL,
  node_id varchar(50),
  collectible_id varchar(50),
  beacon_uuid varchar(36),
  beacon_major integer,
  beacon_minor integer,
  ar_asset_url varchar(500),
  ar_dialogue text,
  trigger_condition jsonb,
  unlock_content jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_triggers_product ON pms_bui_wenlv_triggers(product_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_triggers_type ON pms_bui_wenlv_triggers(type);
CREATE INDEX IF NOT EXISTS idx_wenlv_triggers_node ON pms_bui_wenlv_triggers(node_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_triggers_collectible ON pms_bui_wenlv_triggers(collectible_id);
