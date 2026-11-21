-- 站内消息表 M1 建表脚本（私域交易闭环：订单状态/支付/提醒，生产环境手动执行）
CREATE TABLE IF NOT EXISTS pms_bui_inbox_messages (
  id VARCHAR(50) PRIMARY KEY,
  mini_user_id VARCHAR(50) NOT NULL,
  order_id VARCHAR(50),
  type VARCHAR(20) NOT NULL,
  title VARCHAR(100) NOT NULL,
  content TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 支撑「我的消息」按用户查询
CREATE INDEX IF NOT EXISTS idx_inbox_user ON pms_bui_inbox_messages(mini_user_id);
-- 同 (mini_user_id, order_id, type) 只一条：入住提醒调度器以此做幂等闸门（onConflictDoNothing），防重复投递
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbox_user_order_type ON pms_bui_inbox_messages(mini_user_id, order_id, type);
