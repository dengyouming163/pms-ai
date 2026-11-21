-- 0081: 商户主数据表（/merchants 模块承接）+ merchant_partners.merchant_id 引用列
-- why: 文旅创作台商户列表需要「商户主数据」（名称/类型/联系人/合作状态/关联场地数），
-- 现有 pms_bui_wenlv_merchant_partners 是场地级合作挂接行（暗号接头载体）而非主数据。
-- merchant_id 引用列为 Task 21 场地档案切换做承接：档案切换后写入；切换前全表为 NULL，
-- 仅被商户主数据列表/详情按它计数关联场地（services/wenlv/merchant-master.ts）。
-- 可重入：全部 IF NOT EXISTS，重复执行无副作用。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_merchants (
  id varchar(50) PRIMARY KEY,
  name varchar(100) NOT NULL,
  type varchar(20),
  contact_name varchar(50),
  contact_phone varchar(20),
  status varchar(20) NOT NULL DEFAULT 'active',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pms_bui_wenlv_merchant_partners ADD COLUMN IF NOT EXISTS merchant_id varchar(50);
CREATE INDEX IF NOT EXISTS idx_wenlv_merchant_partners_master ON pms_bui_wenlv_merchant_partners(merchant_id);
