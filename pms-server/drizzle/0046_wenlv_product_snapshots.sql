-- 0046：文旅「发布快照与回滚」—— pms_bui_wenlv_product_snapshots
--
-- P4 创作台体验：每次发布时存一份全量 JSON 快照，支持回滚到任意已发布版本。
-- snapshot_data 形状 = { product, nodes, collectibles, characters, npcs, endings, rewards, tiers }。
--
-- 幂等性：CREATE TABLE IF NOT EXISTS，重跑零效果。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_product_snapshots (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  version integer NOT NULL,
  snapshot_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS wenlv_snapshots_product_version_uniq
  ON pms_bui_wenlv_product_snapshots (product_id, version);

CREATE INDEX IF NOT EXISTS wenlv_snapshots_product_id_idx
  ON pms_bui_wenlv_product_snapshots (product_id);

COMMENT ON TABLE pms_bui_wenlv_product_snapshots IS 'P4 发布快照：每次发布存全量 JSON，支持回滚';
COMMENT ON COLUMN pms_bui_wenlv_product_snapshots.version IS '对应的 publishedVersion，同 productId 唯一';
