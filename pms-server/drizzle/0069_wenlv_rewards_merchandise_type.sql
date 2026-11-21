-- 0069_wenlv_rewards_merchandise_type.sql
-- rewards.type 枚举扩展：coupon/merchant_rights/digital/merchandise
-- 数据迁移：merchant_rights → merchandise（语义统一为文创商品）
ALTER TABLE pms_bui_wenlv_rewards ALTER COLUMN type DROP DEFAULT;
ALTER TABLE pms_bui_wenlv_rewards
  ALTER COLUMN type SET DEFAULT 'coupon';
UPDATE pms_bui_wenlv_rewards SET type = 'merchandise' WHERE type = 'merchant_rights';
