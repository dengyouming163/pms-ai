-- 结局解析优先级。语义：**数值大者胜**。
--
-- 为什么需要它：本引擎的条件语言无否定、state 单调（只增不减），故任意两个可满足的
-- 结局条件必然**同时可满足** —— 「互斥的多结局」不可能存在。而旧实现是
-- `settleEndings` 落 `hit[0]`、`select` 又无 orderBy ⇒ 游客拿到哪个结局由 PG 行序决定。
-- 本列把"哪一档"变成作者显式声明 + 解析确定。
--
-- 先备份：CREATE TABLE _s4_ending_priority_backup_20260918 AS SELECT id, product_id, priority FROM pms_bui_wenlv_endings;（本迁移执行前手工跑）
ALTER TABLE pms_bui_wenlv_endings ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN pms_bui_wenlv_endings.priority IS
  '解析优先级，数值大者胜；改动即改变玩家获得的结局';

-- 回填：按「引用的 collected 引用数」升序赋 1..n（引用越多 = 越专属 = 优先级越高）。
-- 幂等：只回填**尚未被人工设置过**的行（priority 仍为默认 0）。
WITH n AS (
  SELECT id, product_id,
         jsonb_array_length(jsonb_path_query_array(trigger_condition, '$.** ? (@.kind == "collected")')) AS refs
  FROM pms_bui_wenlv_endings
  WHERE priority = 0
), ranked AS (
  SELECT id, row_number() OVER (PARTITION BY product_id ORDER BY refs ASC, id ASC) AS rn
  FROM n
)
UPDATE pms_bui_wenlv_endings e SET priority = r.rn FROM ranked r WHERE e.id = r.id;

-- 复核：**必须与上面的 UPDATE 谓词逐字相同**（前科：复核查询比 UPDATE 窄，会把"本来就填不上"混成"没跑干净"）
\echo '=== 残留 priority=0 的行（应为 0）==='
SELECT count(*) FROM pms_bui_wenlv_endings WHERE priority = 0;
\echo '=== 各产品 priority 是否唯一（重复数，应为 0）==='
SELECT product_id, priority, count(*) FROM pms_bui_wenlv_endings GROUP BY 1,2 HAVING count(*) > 1;
