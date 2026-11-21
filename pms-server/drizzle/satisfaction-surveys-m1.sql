-- 离店满意度回访记录表 M1 建表脚本（C2 差评预检：消息回访，生产环境手动执行）
CREATE TABLE IF NOT EXISTS pms_bui_satisfaction_surveys (
  id VARCHAR(50) PRIMARY KEY,
  mini_user_id VARCHAR(50) NOT NULL,
  order_id VARCHAR(50) NOT NULL,
  score INTEGER,
  complaints JSONB NOT NULL DEFAULT '[]',
  coupon_record_id VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同一订单只允许一条回访记录：回访调度器以此做幂等闸门（onConflictDoNothing），防重复推送问卷；
-- 差评补偿券也以该表 coupon_record_id 为空为守卫，保证每单至多补偿一次。
CREATE UNIQUE INDEX IF NOT EXISTS uq_survey_order ON pms_bui_satisfaction_surveys(order_id);
