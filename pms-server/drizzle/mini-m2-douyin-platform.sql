-- pms-douyin M2 平台维度迁移（生产环境手动执行）
-- 目的：pms_bui_mini_users 支持多平台（wx=微信小程序 / douyin=抖音小程序），
-- 唯一约束从 openid 单列改为 (platform, openid) 复合。
-- 存量数据默认 platform='wx'，向后兼容，无需数据搬迁。

-- 1. 加 platform 列（存量行默认 wx）
ALTER TABLE pms_bui_mini_users ADD COLUMN IF NOT EXISTS platform VARCHAR(20) NOT NULL DEFAULT 'wx';

-- 2. 去掉旧的单列 openid 唯一约束（防御性同时处理约束与索引两种命名）
ALTER TABLE pms_bui_mini_users DROP CONSTRAINT IF EXISTS pms_bui_mini_users_openid_key;
DROP INDEX IF EXISTS pms_bui_mini_users_openid_unique;

-- 3. 建 (platform, openid) 复合唯一索引
CREATE UNIQUE INDEX IF NOT EXISTS pms_bui_mini_users_platform_openid_idx
  ON pms_bui_mini_users (platform, openid);

-- 4. 支付单加渠道列（wx=微信支付 / douyin=抖音支付），存量默认 wx
ALTER TABLE pms_bui_mini_payments ADD COLUMN IF NOT EXISTS channel VARCHAR(10) NOT NULL DEFAULT 'wx';
