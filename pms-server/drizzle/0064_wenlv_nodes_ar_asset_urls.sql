-- 0064: pms_bui_wenlv_nodes 加 ar_asset_urls jsonb 列（P3-C Task 2：多人独有视角）
-- 用途：按玩家角色（characterId）分发不同 AR 素材，结构 { default: url, [characterId]: url, ... }
-- 保留旧列 ar_asset_url 不删：作为 default fallback，存量数据无需迁移。
-- 读取链：arAssetUrls[playerRole] || arAssetUrls.default || arAssetUrl || null

ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS ar_asset_urls jsonb DEFAULT '{}'::jsonb;
