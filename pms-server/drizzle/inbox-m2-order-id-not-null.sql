-- 站内消息表 M2（私域交易闭环）：order_id 改为非空
-- 背景：幂等唯一索引 (mini_user_id, order_id, type) 依赖 order_id 非空才有意义 ——
--   PG 唯一索引中 NULL 彼此不相等，若 order_id 为 NULL，同一 (mini_user_id, NULL, type) 可写多条，
--   幂等闸门（onConflictDoNothing）会静默失效。
-- 生产环境手动执行（同 inbox-m1.sql 模式）。
-- 历史 NULL 行无法参与去重且无幂等意义，直接清除后再加约束（本表为 D3 新表，正常情况下无 NULL 行）。
DELETE FROM pms_bui_inbox_messages WHERE order_id IS NULL;
ALTER TABLE pms_bui_inbox_messages ALTER COLUMN order_id SET NOT NULL;
