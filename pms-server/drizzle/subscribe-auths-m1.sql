-- 微信订阅消息授权表 M1 建表脚本（私域交易闭环：入住前 24h 提醒，生产环境手动执行）
CREATE TABLE IF NOT EXISTS pms_bui_subscribe_auths (
  id VARCHAR(50) PRIMARY KEY,
  mini_user_id VARCHAR(50) NOT NULL,
  openid VARCHAR(64) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 按用户查授权（调度器 / 列表用）
CREATE INDEX IF NOT EXISTS idx_subscribe_auths_user ON pms_bui_subscribe_auths(mini_user_id);
-- 同一用户同一模板只保留一条授权（upsert 幂等目标）
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscribe_auths_user_template ON pms_bui_subscribe_auths(mini_user_id, template_id);
