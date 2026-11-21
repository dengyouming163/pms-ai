CREATE TABLE IF NOT EXISTS pms_bui_wenlv_player_progress (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  mini_user_id varchar(50) NOT NULL,
  dialogue_id varchar(50),
  san integer NOT NULL DEFAULT 100,
  collected_collectibles jsonb NOT NULL DEFAULT '[]',
  unlocked_triggers jsonb NOT NULL DEFAULT '[]',
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_player_progress_user ON pms_bui_wenlv_player_progress(mini_user_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_player_progress_product ON pms_bui_wenlv_player_progress(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_player_progress_user_product
  ON pms_bui_wenlv_player_progress(product_id, mini_user_id);
