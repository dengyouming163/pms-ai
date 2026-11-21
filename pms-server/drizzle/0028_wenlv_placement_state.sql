-- 文旅 S4 块 C：点位铺码四态（1 表加 6 列 + 1 个索引）。
--
-- 为什么是 6 个可空时间戳 + 人名，而不是一个 status 列：
-- 四态是**派生的**（未印/已印/已铺/已验），存一份冗余 status 必然与时间戳打架。
-- 本项目已有「守卫文案与条件不一致」的先例，不重复同一个错。
-- 派生与单向流转的**唯一实现**在 src/services/wenlv-placement.ts。
--
-- 全可空、无默认、**不回填**：历史行的 NULL = 「这六列引入前没人记录过」，
-- 与「确实没印」是两回事。回填等于编造现场事实，比留空更糟。与 0026 加 created_by 同处理。
--
-- 幂等：IF NOT EXISTS，可重复执行。

ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS printed_at  timestamptz;
ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS printed_by  varchar(50);
ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS placed_at   timestamptz;
ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS placed_by   varchar(50);
ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS verified_by varchar(50);

-- nodes.venue_point_id 是块 B 的扫码候选查询与块 D1 走场 lookup 的反查键。
-- 0024 加这一列时漏了索引 —— 对照：culture_materials 有 idx_wenlv_culture_materials_point
-- （schema/wenlv.ts:414）。当前数据量极小，但这是**每一次二维码扫描**都会走的一次全表扫描。
CREATE INDEX IF NOT EXISTS idx_wenlv_nodes_venue_point
  ON pms_bui_wenlv_nodes(venue_point_id);
