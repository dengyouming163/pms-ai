-- 回填存量「背景图」素材到 pms_bui_wenlv_nodes.image
--
-- 背景：S3 已生成的 background 素材只落在资源库（design_assets）与任务表（asset_jobs），
-- 业务表 nodes.image 一直是空的。新任务由 scheduler 回写；存量的靠这一条补。
--
-- 安全性：
--   · 幂等 —— 可重复执行，第二次起影响 0 行
--   · 不覆盖 —— 只填 image IS NULL 的行，人工上传/修正过的图不会被冲掉
--   · 只认成功任务 —— status='succeeded' 且 asset_id 非空
--   · 三段口径**同源**：① / ② / ③ 都要求 succeeded + asset_id 非空 + 资产行存在
--     + url 非空**且不是空串**（`a.url IS NOT NULL AND a.url <> ''`）
--
-- ⚠️ 口径同源不是洁癖，是运维信号的前提：
--   ① 的 would_fill 与 ③ 的 still_empty 是运维判断「这次回填成没成」的**唯一信号**。
--   若 ③ 只查 succeeded（不管 asset_id / 资产行 / url），那么「资产被删掉因而永远填不上」
--   与「回填没跑干净」会报成同一个数 —— 两种截然不同的处置（重跑 vs 别白费劲），
--   运维却区分不了。`src/routes/admin/wenlv-design.ts` 的 `DELETE /assets/:id` **不查引用**，
--   这条路径生产可达，所以这不是理论问题。
--
-- ⚠️ 已知盲区（记录在案，**故意不修**）：
--   1) `nodes.image = ''`（空串，非 NULL）对本文件的 ① / ② / ③ 完全隐形 —— `image IS NULL`
--      不匹配它，该节点永远轮不到回填、也不进复核。之所以**不**放宽成 `OR n.image = ''`：
--      现有写入方（`wenlv-asset-gen-scheduler.ts` 的回写、admin 的 assetSchema 白名单不含 image）
--      产生不了空串，而放宽会**扩大写面**（把人工清空过的节点重新写脏）。记录在案，不冒进。
--   2) 只有「url 为空/空串资产」的节点，会被三段**一并排除**因而既不被填、也不报 still_empty。
--      这是 `<> ''` 的必然代价：宁可让它静默不入候选，也不把空串当真图写进 image
--      （空串是最坏的一种：① / ② / ③ 会**三个数都报成功**，节点却渲染成空图）。
--
-- 执行姿势（生产）—— **必须带 `-v ON_ERROR_STOP=1`**：
--   不带它时 psql 即使遇到 ERROR 仍返回退出码 0（实测：同一文件两条语句报错，
--   无此参数 EXIT=0；带此参数 EXIT=3）。包进脚本里就是「打了 ERROR 但脚本绿灯」——
--   回填根本没跑成，却没有任何信号。本文件的自测用的是同一姿势，两边必须一致。
--   E:/putty/pscp.exe -pw "__PMS_SSH_PW__" scripts/backfill-node-image.sql root@132.232.166.40:/tmp/
--   E:/putty/plink.exe -batch -ssh root@132.232.166.40 -pw "__PMS_SSH_PW__" \
--     "docker exec -i wwwroot-postgres-1 psql -U gate -d aipms -v ON_ERROR_STOP=1 -f - < /tmp/backfill-node-image.sql"

-- ============ 1) 影响面预览 ============
-- ⚠️ 这**不是**「先看数再决定」的 dry-run：① 与 ② 在同一个文件、同一次 `psql -f` 里**顺序执行**，
--   psql 逐语句 autocommit、文件里也没有 BEGIN，所以你看到 would_fill 时 ② 已经提交完了。
--   **若要真的「先看数再决定」**：把下面这条 SELECT **单独**用 `-c` 跑一次（或用 1.5) 的清单法），
--   确认 would_fill 之后再跑本文件。
-- 口径 = **节点数**，不是 job 行数：一个节点可能有多条重生成 job，
-- count(*) 会把它们重复计数、报出比下面 UPDATE 更大的数。用 DISTINCT n.id
-- 与第二段 `UPDATE ... FROM latest WHERE n.id = latest.node_id` 的节点粒度对齐。
SELECT count(DISTINCT n.id) AS would_fill
FROM pms_bui_wenlv_nodes n
JOIN pms_bui_wenlv_asset_jobs j
  ON j.node_id = n.id
 AND j.asset_type = 'background'
 AND j.status = 'succeeded'
 AND j.asset_id IS NOT NULL
JOIN pms_bui_wenlv_design_assets a
  ON a.id = j.asset_id
 AND a.url IS NOT NULL AND a.url <> ''
WHERE n.image IS NULL;

-- ============ 1.5) 【可选但建议】跑 ② 之前先存「待写清单」，留撤销依据 ============
-- 为什么要先存：② 跑完之后，库里**没有任何标记**能区分「回填写进去的图」与「本来就有的图」
--   —— nodes 上没有来源列、没有 updated_at 之外的痕迹。没有清单，事后想撤销只能靠猜，
--   或者整表回滚（会误伤人工上传的图）。清单是唯一的还原依据。
-- 旧值是可知的：② 只写 `image IS NULL` 的行，所以**旧值恒为 NULL**，撤销 = 把这批 id 置回 NULL。
-- 用法（在跑本文件之前单独执行；`\o` 把结果落盘成 TSV 清单。SELECT 与 ② 的取数口径一致，
--   记的就是「将要写进去的那张图」）：
--   docker exec -i wwwroot-postgres-1 psql -U gate -d aipms -v ON_ERROR_STOP=1 \
--     -c "\o /tmp/backfill-node-image.undo.tsv" \
--     -c "SELECT DISTINCT ON (j.node_id) j.node_id, a.url FROM pms_bui_wenlv_asset_jobs j JOIN pms_bui_wenlv_design_assets a ON a.id = j.asset_id AND a.url IS NOT NULL AND a.url <> '' WHERE j.asset_type = 'background' AND j.status = 'succeeded' AND j.asset_id IS NOT NULL AND j.node_id IS NOT NULL AND EXISTS (SELECT 1 FROM pms_bui_wenlv_nodes n WHERE n.id = j.node_id AND n.image IS NULL) ORDER BY j.node_id, j.finished_at DESC NULLS LAST, j.created_at DESC;"
-- 撤销（id 取自上面的清单；旧值恒为 NULL）：
--   UPDATE pms_bui_wenlv_nodes SET image = NULL WHERE id IN ('<node_id>', '<node_id>', ...);

-- ============ 2) 逐节点取最新一条成功背景图，写回 ============
-- 一个节点可能有多条成功任务（多次重生成）；取 finished_at 最新的一条。
-- `a.url IS NOT NULL AND a.url <> ''` —— ⚠️ **真正生效的只有 `<> ''`，`IS NOT NULL` 是冗余的**：
--   · 三值逻辑：`NULL <> ''` 求值为 **NULL**（不是 TRUE），JOIN 视其为假 ⇒ 空串与 NULL
--     都被 `<> ''` 一并挡掉（实测：`WHERE url <> ''` 只放过真实 url）。
--     所以**单独删掉 `IS NOT NULL` 没有任何变异能让自测变红** —— 它被 `<> ''` 逻辑蕴含，
--     保留只为让「排除 NULL」的意图显式可读，**不携带测试信号**。别以为它是第二道闸。
--   · 挡住 NULL url 是**幂等**的前提：url 置 NULL 的行若不挡，② 会把 image「更新」成 NULL，
--     值没变但算一行受影响，第二次跑仍是 UPDATE 1，幂等在真实数据上失真。（由 `<> ''` 提供。）
--   · 挡住空串是**正确性**的前提：`assetSchema.url` 是 `z.string()`，**空串是合法值**
--     （`wenlv-design.ts:84`，PATCH 可置空串）。若不挡，空串会被真写进 image，
--     而 ① would_fill / ② UPDATE / ③ still_empty **三个数都报「成功」** —— 最坏的一种：
--     看似回填完成，节点却渲染成空图。三段必须一起挡，否则口径又分叉。
WITH latest AS (
  SELECT DISTINCT ON (j.node_id)
         j.node_id,
         a.url
  FROM pms_bui_wenlv_asset_jobs j
  JOIN pms_bui_wenlv_design_assets a
    ON a.id = j.asset_id
   AND a.url IS NOT NULL AND a.url <> ''
  WHERE j.asset_type = 'background'
    AND j.status = 'succeeded'
    AND j.asset_id IS NOT NULL
    -- ⚠️ 下面这条**被 JOIN 逻辑蕴含**：键为 NULL 时 `n.id = latest.node_id` 求值为 NULL、
    --   永不匹配，所以去掉它结果完全一样。实测：整条删掉自测仍 `SELFTEST PASS`。
    --   保留只为让「只处理有键的任务」显式可读，**不携带测试信号**（同 `a.url IS NOT NULL`）。
    AND j.node_id IS NOT NULL
  ORDER BY j.node_id, j.finished_at DESC NULLS LAST, j.created_at DESC
)
UPDATE pms_bui_wenlv_nodes n
SET image = latest.url
FROM latest
WHERE n.id = latest.node_id
  AND n.image IS NULL;

-- ============ 3) 复核：应为 0 ============
-- 与 ① **逐字同源**（succeeded + asset_id 非空 + 资产行存在 + url 非空且非空串），只是跑在 ② 之后。
SELECT count(DISTINCT n.id) AS still_empty
FROM pms_bui_wenlv_nodes n
JOIN pms_bui_wenlv_asset_jobs j
  ON j.node_id = n.id
 AND j.asset_type = 'background'
 AND j.status = 'succeeded'
 AND j.asset_id IS NOT NULL
JOIN pms_bui_wenlv_design_assets a
  ON a.id = j.asset_id
 AND a.url IS NOT NULL AND a.url <> ''
WHERE n.image IS NULL;
