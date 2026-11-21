ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS san_delta integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ar_asset_url varchar(500),
  ADD COLUMN IF NOT EXISTS ar_dialogue text;
