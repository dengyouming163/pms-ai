-- pms-nimi M1 建表脚本（生产环境手动执行）
CREATE TABLE IF NOT EXISTS pms_bui_mini_users (
  id VARCHAR(50) PRIMARY KEY,
  openid VARCHAR(64) NOT NULL UNIQUE,
  unionid VARCHAR(64),
  phone VARCHAR(20),
  nickname VARCHAR(50),
  avatar VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_mini_store_config (
  id VARCHAR(50) PRIMARY KEY,
  merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  store_id VARCHAR(50) NOT NULL UNIQUE,
  online BOOLEAN NOT NULL DEFAULT false,
  header_images JSONB DEFAULT '[]',
  intro TEXT,
  gallery JSONB DEFAULT '[]',
  cancel_policy JSONB DEFAULT '{"freeHours":24,"feeRate":20}',
  member_discounts JSONB DEFAULT '{}',
  commission_rate INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_mini_payments (
  id VARCHAR(50) PRIMARY KEY,
  merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  store_id VARCHAR(50) NOT NULL,
  order_id VARCHAR(50) NOT NULL,
  order_no VARCHAR(50) NOT NULL,
  out_trade_no VARCHAR(64) NOT NULL UNIQUE,
  transaction_id VARCHAR(64),
  amount INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  refund_no VARCHAR(64),
  refund_amount INTEGER,
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  notify_raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mini_payments_order_id ON pms_bui_mini_payments(order_id);
-- 部分唯一索引：同一订单最多一条 pending 支付单（防并发 jsapi 双开支付单）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mini_payments_order_pending
  ON pms_bui_mini_payments(order_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS pms_bui_merchant_applications (
  id VARCHAR(50) PRIMARY KEY,
  merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  store_id VARCHAR(50) NOT NULL UNIQUE,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  business_license JSONB,
  legal_person JSONB,
  settlement_account JSONB,
  contact JSONB,
  applyment_id VARCHAR(64),
  sub_mchid VARCHAR(32),
  reject_reason TEXT,
  sign_url VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pms_bui_customers ADD COLUMN IF NOT EXISTS mini_user_id VARCHAR(50);
-- 支撑预订单支付超时释放的定时查询（mini-scheduler 按 source+status+ota_timeout 扫描）
CREATE INDEX IF NOT EXISTS idx_orders_mini_timeout ON pms_bui_orders(source, status, ota_timeout);

-- 支撑锁内可用性查询（checkAvailability 按 store+room_type+status 过滤），防订单量增长拉长锁持有时间
CREATE INDEX IF NOT EXISTS idx_orders_availability ON pms_bui_orders(store_id, room_type_id, status);

-- M2 Phase 2: 套餐 + 优惠券
CREATE TABLE IF NOT EXISTS pms_bui_packages (
  id VARCHAR(50) PRIMARY KEY, merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  store_id VARCHAR(50) NOT NULL, name VARCHAR(100) NOT NULL, description TEXT,
  room_type_ids JSONB NOT NULL DEFAULT '[]', benefits JSONB DEFAULT '[]',
  price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT -1,
  sell_start VARCHAR(20), sell_end VARCHAR(20),
  use_start VARCHAR(20), use_end VARCHAR(20),
  images JSONB DEFAULT '[]', status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_coupons (
  id VARCHAR(50) PRIMARY KEY, merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  store_id VARCHAR(50) NOT NULL, name VARCHAR(100) NOT NULL,
  type VARCHAR(30) NOT NULL, value INTEGER NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 0, scope JSONB DEFAULT '[]',
  total INTEGER NOT NULL DEFAULT -1, claimed INTEGER NOT NULL DEFAULT 0,
  per_user INTEGER NOT NULL DEFAULT 1, valid_days INTEGER NOT NULL DEFAULT 30,
  start_date VARCHAR(20), end_date VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_coupon_records (
  id VARCHAR(50) PRIMARY KEY, coupon_id VARCHAR(50) NOT NULL,
  mini_user_id VARCHAR(50) NOT NULL, store_id VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  used_at TIMESTAMPTZ, used_order_id VARCHAR(50),
  expire_at VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupon_records_user ON pms_bui_coupon_records(mini_user_id, status);

-- M3: 分销体系
CREATE TABLE IF NOT EXISTS pms_bui_promoters (
  id VARCHAR(50) PRIMARY KEY, merchant_id VARCHAR(64) NOT NULL DEFAULT 'default',
  store_id VARCHAR(50) NOT NULL, mini_user_id VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  promo_code VARCHAR(32) NOT NULL UNIQUE,
  commission_rate INTEGER, total_commission INTEGER NOT NULL DEFAULT 0,
  pending_commission INTEGER NOT NULL DEFAULT 0, withdrawn_commission INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_referral_bindings (
  id VARCHAR(50) PRIMARY KEY, promoter_id VARCHAR(50) NOT NULL,
  mini_user_id VARCHAR(50) NOT NULL, store_id VARCHAR(50) NOT NULL,
  protected_until VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_mini_user ON pms_bui_referral_bindings(mini_user_id, store_id);

CREATE TABLE IF NOT EXISTS pms_bui_commission_records (
  id VARCHAR(50) PRIMARY KEY, promoter_id VARCHAR(50) NOT NULL,
  order_id VARCHAR(50) NOT NULL, order_no VARCHAR(50) NOT NULL,
  amount INTEGER NOT NULL, rate INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'frozen',
  profit_sharing_no VARCHAR(64),
  released_at TIMESTAMPTZ, withdrawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_promoter ON pms_bui_commission_records(promoter_id, status);

CREATE TABLE IF NOT EXISTS pms_bui_withdrawals (
  id VARCHAR(50) PRIMARY KEY, promoter_id VARCHAR(50) NOT NULL,
  amount INTEGER NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
  wx_transfer_no VARCHAR(64), fail_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pms_bui_profit_sharings (
  id VARCHAR(50) PRIMARY KEY, payment_id VARCHAR(50) NOT NULL,
  out_trade_no VARCHAR(64) NOT NULL,
  promoter_id VARCHAR(50), promoter_amount INTEGER, platform_amount INTEGER,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  wx_order_id VARCHAR(64), fail_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 客人信息持久化：下单后保存常用客人姓名/手机到用户表，下次打开小程序直接回显
ALTER TABLE pms_bui_mini_users ADD COLUMN IF NOT EXISTS guest_name VARCHAR(50);
ALTER TABLE pms_bui_mini_users ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(20);
