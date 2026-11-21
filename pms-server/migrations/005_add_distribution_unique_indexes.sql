-- 分销幂等：佣金记录/绑定/推广员唯一约束（spec §9：重复回调不产生重复佣金）
CREATE UNIQUE INDEX IF NOT EXISTS uq_commission_order_promoter_type ON pms_bui_commission_records (order_id, promoter_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_binding_user_store ON pms_bui_referral_bindings (mini_user_id, store_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_promoter_store_user ON pms_bui_promoters (store_id, mini_user_id);
