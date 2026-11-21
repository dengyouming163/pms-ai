-- =============================================================================
-- OTA Store Key Migration
-- 为 pms_ota_clients 表添加 store_key 字段，用于客户端独立 API Key 鉴权
-- =============================================================================

ALTER TABLE pms_ota_clients ADD COLUMN IF NOT EXISTS store_key VARCHAR(64) UNIQUE;
