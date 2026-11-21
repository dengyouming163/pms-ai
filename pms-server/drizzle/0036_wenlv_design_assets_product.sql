-- 文旅素材归属：design_assets 的剧本级真列。
--
-- ⚠️ 本文件进 `Dockerfile` 的 CMD 迁移清单末尾，容器**每次启动**都重跑整份清单。
--    故全部语句必须幂等（`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
--    / 只补空的 `UPDATE`）。前例：`0031` 的非幂等回填会把人类显式设的值静默盖掉。
--
-- ── 为什么加真列，而不是继续用 meta->>'productId' ──────────────────────────
--
-- ① 切源前 `meta->>'productId'` **无索引**，`GET /assets?productId=` 是全表扫
--    （那一版注释自己说「上量后加表达式索引」——该句已随 Task C6 从源码删掉，故此处
--    只留文本、不复述行号）。本列把该需求变成一条普通 btree；C6 起该端点已走本列。
-- ② 归属是**结构**，不该藏在 jsonb 的一个键里 —— 读代码的人看不见它，
--    而「这份素材属于哪个剧本」正是用户要一目了然的东西。
-- ③ C 端要按剧本聚合素材（即创即用），表达式索引的表达力和可维护性都更差。
--
-- ── 与 venue_id 的关系（**不是替代**）────────────────────────────────────
--
--   venue_id  非空 = 该场地私有（写实素材）；NULL = 公共池（风格化素材，跨场地复用）。
--   product_id 非空 = 由哪个剧本的生成任务产出的。
--   两个维度正交：公共池素材也**有** productId（writeAsset 对两类都写 meta.productId，
--   见 wenlv-design.ts 里 `GET /assets` 那条注释）。故**不能**用 product_id 取代 venue_id 做过滤，
--   反过来也不行。
--
-- ── 回填 ────────────────────────────────────────────────────────────────
--
-- 只补 `product_id IS NULL` 的行，从 `meta->>'productId'` 取。
-- 幂等性：首跑把能补的补齐；再跑时那些行已非 NULL，被 WHERE 排除。
-- 回填只覆盖「meta->>'productId' 非空」的行；其余行永久保持 NULL，那是正确终态。
--   ⚠️ **别把「留 NULL」读成「没有 job」**（C1 质量审查 M1）：实测那几行**带 jobId**，
--      是**旁白**（narration）任务的正常产物，只是那些 job 自己**没有 productId**
--      —— 旁白不归属某个剧本。「没有产出剧本」与「没有任务」是两件事。
--   ⚠️ 「公共池（venue_id IS NULL）」**不属**这一类：writeAsset 对公共池与私有池**都**写
--      meta.productId（同上，见 `wenlv-design.ts` 里 `GET /assets` 的注释），公共池素材照样会被回填 ——
--      两个维度正交，别拿 venue_id 去推 product_id。
--   ⚠️ 本文**不写「有多少条内置资产」**这类计数。那个数在本仓**只有一处出处**：
--      `src/db/schema/wenlv.ts:339` 自己的注释（「11 条内置资产是公共资源」）——
--      而它无从核起，且**代码路径上近乎不可达**：本表 `is_builtin` 的每个写入者都写死
--      `false`（**只认这两处 `isBuiltin: false,` 文本 + 文件路径，别认行号** ——
--      分别在 `services/wenlv/asset-gen/candidate-store.ts` 与
--      `services/wenlv-asset-gen-scheduler.ts`，各一处；
--      📌 2026-09-21 实测：同一文本在**后者**里的行号已从 `1b3fc578` 的 `:316`，
--      经 `0c6cacc1` 的 `:318`，漂到 HEAD 的 **`:327`** —— 行号必漂、文本不漂，
--      故此处**只留文本与路径、不留行号**），
--      列默认值也是 `false`，`drizzle/*.sql` 全量无 INSERT；
--      `src/db/seed-wenlv-design.ts` 里那个 `isBuiltin: true` 写的是 **templates** 表
--      ——**另一张表**。
--      ⇒ 「素材表里有 N 条内置资产」这句话，代码上造不出来；连带
--      `routes/admin/wenlv-design.ts` 里那句「内置资产不可删除」的 409 闸
--      （**认这句文本**；行号只是**那一刻的快照**，不是定位符 —— `c0d6f7c0` 上是 `:156`、
--      `1b3fc578` 上是 `:171`、HEAD（`0347c6e3`）已是 `:200`。别拿数字去找），
--      对素材行是**不可达**的（它只对模板行可达，见同文件 `:74`）。
--      写一个查不到写者的数，会让下一个人以为有据可依。
--
-- ⚠️ 回填语句必须放在 ADD COLUMN 之后、且带 `AND meta->>'productId' IS NOT NULL`：
--    少了后半句，`meta->>'productId'` 为 NULL 的行会被写成 NULL
--    —— 结果**无害**（本就是 NULL），代价只是那几行被**白白重写一遍**（`UPDATE` 的计数会变大）。
--
-- ⚠️ `->>` 与 `?` **不是一回事**，本文件**只**用 `->>`（C1 质量审查 I1/M5）：
--    `meta->>'productId'` 取的是**字符串值**，`meta ? 'productId'` 问的是**键在不在**。
--    PG 16.14 实测**三类**分歧：① JSON null（`?` 为真、`->>` 却是 NULL）
--    ② JSON 数组元素的键命中 ③ JSON 标量串。回填要的是**值**，所以只能 `->>`。
--
-- ⚠️ **不要 DROP COLUMN。** 回滚旧 build 时库里留着这一列是**无害**的
--    （旧 schema 不声明它，drizzle 就不会把它带进 SQL）；而 `DROP COLUMN` 会**真丢数据**、
--    且不可逆。**回滚 = 重发旧 build，不是改库。**
--
-- 📌 **本文件只负责建列与回填；把读侧的查询源从 `meta->>'productId'` 切到本列是 Task C6 的事。**
--    在 C6 之前读侧仍走 `meta->>'productId'`，两条路**同时存在**是有意的（C1 质量审查 M4）。

ALTER TABLE pms_bui_wenlv_design_assets
  ADD COLUMN IF NOT EXISTS product_id varchar(50);

UPDATE pms_bui_wenlv_design_assets
  SET product_id = meta->>'productId'
  WHERE product_id IS NULL
    AND meta->>'productId' IS NOT NULL;

-- 按剧本筛素材 / C 端按剧本聚合。
CREATE INDEX IF NOT EXISTS idx_wenlv_design_assets_product
  ON pms_bui_wenlv_design_assets (product_id);
