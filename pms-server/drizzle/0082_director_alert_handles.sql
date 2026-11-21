-- 0082: 值守「标记已处理」闭环落库表（批 7 Task 23，spec 下册 §3）
-- why: 此前值守看板的「一键已处理」只是前端本地隐藏（dismissed 集合），刷新/轮询后
--   服务端仍返回同条报警。本表把「已处理」真落库：按 (progress_id, node_key) 一行，
--   node_key = 报警 id（导演 alerts 元素 id，形如 `stall:<nodeId>:<atomId>` / `static:<key>`）。
-- 幂等：ON CONFLICT (progress_id,node_key) DO UPDATE 覆盖 handled_by/handled_at/note
--   （重复标记 = 后值覆盖前值，与「重新指派处理人」同语义）。
-- 可重入：全部 IF NOT EXISTS，重复执行无副作用。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_director_alert_handles (
  id varchar(60) PRIMARY KEY,
  product_id varchar(60) NOT NULL,
  progress_id varchar(60) NOT NULL,
  node_key varchar(120) NOT NULL,
  handled_by varchar(60) NOT NULL,
  handled_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_director_handle_progress_node
  ON pms_bui_wenlv_director_alert_handles (progress_id, node_key);
CREATE INDEX IF NOT EXISTS idx_director_handle_product
  ON pms_bui_wenlv_director_alert_handles (product_id);

-- 0082 追加段（批 7 Task 24）：游客现场问题上报的处理闭环四列。
-- why: 创作台「现场问题」页此前只能看不能办 —— 上报永远堆在「新」状态，刷新后
--   「这条办过没有」无任何落库痕迹。四列把「处理中/已解决 + 备注 + 处理人 + 时间」
--   挂到上报行本体上（不走 Task 23 那种独立 handles 表：上报是单行工单，不是
--   按 (progress,node) 聚合的报警，状态就是行内属性）。
-- 可重入：全部 IF NOT EXISTS，重复执行无副作用。
ALTER TABLE pms_bui_wenlv_client_reports ADD COLUMN IF NOT EXISTS handle_status varchar(20) NOT NULL DEFAULT 'new';   -- new|processing|resolved
ALTER TABLE pms_bui_wenlv_client_reports ADD COLUMN IF NOT EXISTS handle_note text;
ALTER TABLE pms_bui_wenlv_client_reports ADD COLUMN IF NOT EXISTS handled_by varchar(60);
ALTER TABLE pms_bui_wenlv_client_reports ADD COLUMN IF NOT EXISTS handled_at timestamptz;
