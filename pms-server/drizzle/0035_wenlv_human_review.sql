-- 文旅素材创作台 §8.5「人工审核也是评价的一路」—— design_assets 的人工评审列族。
--
-- ⚠️ 本文件**必须纯幂等、无回填**：它进 `Dockerfile` 的 CMD 迁移清单末尾，容器
--    **每次启动**都重跑整份清单。任何非幂等语句都会在每次重启时静默改写现网数据
--    （前例：`0031` 的回填会把人类显式设的 `priority = 0` 静默盖掉；`0003` 的裸
--    `CREATE TABLE` / `CREATE INDEX` 每次重启刷 7 条 ERROR）。
--    本文件全部是 `ADD COLUMN IF NOT EXISTS` —— **无 CREATE TABLE、无 UPDATE 回填、
--    无 DROP、无 CREATE INDEX**。
--
-- ── 为什么已有 review_score / review_source 还要新列 ────────────────────────
--
-- ① `review_score` 一行只有一个数值，而 AI 分与人工分**必须并存**才能相减 ——
--    这个分差正是 §8.5 的副产品指标（两者长期背离 ⇒ 是**自动评价器不可信**，
--    而不是素材差）。让人工分去覆写 `review_score` 就等于把指标删掉。
--
-- ② `is_rejected` 是**显式**淘汰标记：`is_selected = false` **表达不了淘汰** ——
--    那只是「没被选中」，同样覆盖「还没人看过」。「人工明确否掉」与「尚未决定」
--    必须能分开，否则自动累积进评审 prompt 的负例集里会混进一批
--    「只是没轮上」的图，把评价器往错的方向校准。
--
-- ── 各列语义（⚠️ 新增列必须补全所有字段投影与映射表，漏了会静默变 null）──────
--
--   human_review_score  人工给的分。`numeric(4,2)` —— 与 `review_score` 同列宽、
--                       同精度，两个数才可比。
--   human_review_detail 人工意见的 jsonb 原文。
--   human_reviewed_at   人工评审的时间。**刻意不复用 `reviewed_at`**：那三列
--                       （`reviewed_at` / `review_detail` / `review_score`）属于
--                       **AI 评审**，人工动作一个字都不许改写它们（口径②）。
--   is_rejected         人工明确淘汰。`NOT NULL DEFAULT false`。
--
-- ⚠️ `ADD COLUMN … DEFAULT` 在 PG 11+ 是目录级操作、不重写表；且重跑时
--    `IF NOT EXISTS` 直接整句跳过 ⇒ 已经置 `true` 的行**不会**被改回 `false`。
ALTER TABLE pms_bui_wenlv_design_assets
  ADD COLUMN IF NOT EXISTS human_review_score numeric(4, 2);
ALTER TABLE pms_bui_wenlv_design_assets
  ADD COLUMN IF NOT EXISTS human_review_detail jsonb;
ALTER TABLE pms_bui_wenlv_design_assets
  ADD COLUMN IF NOT EXISTS human_reviewed_at timestamptz;
ALTER TABLE pms_bui_wenlv_design_assets
  ADD COLUMN IF NOT EXISTS is_rejected boolean NOT NULL DEFAULT false;
