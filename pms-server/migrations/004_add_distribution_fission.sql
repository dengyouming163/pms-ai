-- 二级分销裂变：promoters 加层级、commission_records 加溯源、新增分销配置、customers 加来源推广员
-- 佣金率单位：万分比（500 = 5%）

-- 1) 推广员表：加上级 + 层级
ALTER TABLE pms_bui_promoters
  ADD COLUMN IF NOT EXISTS parent_promoter_id varchar(50),
  ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 1;

-- 2) 佣金记录：加类型 + 套餐溯源 + 关联住宿订单
ALTER TABLE pms_bui_commission_records
  ADD COLUMN IF NOT EXISTS type varchar(20) NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS product_id varchar(50),
  ADD COLUMN IF NOT EXISTS product_name varchar(200),
  ADD COLUMN IF NOT EXISTS stay_order_id varchar(50);

-- 3) 分销配置表（平台级单行）
CREATE TABLE IF NOT EXISTS pms_bui_distribution_config (
  id varchar(50) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  default_lv1_rate integer NOT NULL DEFAULT 500,
  default_lv2_rate integer NOT NULL DEFAULT 200,
  min_withdraw_amount integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4) 门店客户表：加来源推广员 id
ALTER TABLE pms_bui_customers
  ADD COLUMN IF NOT EXISTS referrer_promoter_id varchar(50);
