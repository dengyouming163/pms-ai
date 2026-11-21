-- 素材创作台 ① 的数据模型增量（类型注册表 + 候选/评审 + 风格图集）
--
-- ⚠️ 本迁移**只可执行一次**。
--
-- 加列语句确实是幂等的（全部 IF NOT EXISTS），但 `is_selected` 的回填**不是**：
-- 迁移上线、用户在九宫格里改选之后（/select 会让 index 0 变 false、index 2 变 true），
-- 再跑一遍本文件会把 index 0 **静默选回去** —— 撤销用户的改选；
-- 若那一轮恰好有两行同 true，还会撞唯一索引报错。
-- （唯一索引挡住了真正的数据损坏，所以最坏情况是「改选被撤销 / 报错」，不是两张都被采纳。）
--
-- 故：执行一次即可。要重跑，先确认没有任何 job 被改选过。
--
-- ⚠️ 本迁移须**手工在生产执行** —— 它**故意不登记**进启动 CMD 迁移清单（理由见 `Dockerfile:33`）。

-- ── A. asset_jobs：通用回写键对 + 参考图快照 + 涂鸦输入图 ────────────────
--
-- 为什么把「一类型一列」（node_id / 迁移 0032 刚加的 collectible_id）换成通用对：
-- 本轮要新增 ending / reward / tier 三类回写目标，照旧路子就是第 3、4、5 个键列。
-- 通用对让注册表只写这一对，再加第 6 类也不用改表。
ALTER TABLE pms_bui_wenlv_asset_jobs ADD COLUMN IF NOT EXISTS target_kind varchar(32);
ALTER TABLE pms_bui_wenlv_asset_jobs ADD COLUMN IF NOT EXISTS target_id   varchar(64);
-- 本次**实际发出去**的参考图快照（string[]）。参考图会变（风格图集可编辑），
-- 没有快照就事后无法回答「这张图当时参考了什么」。
ALTER TABLE pms_bui_wenlv_asset_jobs ADD COLUMN IF NOT EXISTS reference_urls jsonb;
-- 涂鸦重绘时用户涂过的那张图（作为额外参考图发出，与风格参考图区分开）。
ALTER TABLE pms_bui_wenlv_asset_jobs ADD COLUMN IF NOT EXISTS edit_input_url varchar(500);
-- 请求的候选张数（**输入**）。实际张数由 design_assets 的行数得出 ——
-- 两者都要留：只留一个的话，「请求 4 张只得到 3 张」这件事就无从发现。
-- **NOT NULL DEFAULT 1**：新插入的行不可能是 null 或 0（除显式写 0，
-- 而 0 正是 `resolveCandidateCount` 该拦下的脏值——`?? 1` 挡不住 0，别改成 `|| 1`）。
ALTER TABLE pms_bui_wenlv_asset_jobs ADD COLUMN IF NOT EXISTS candidate_count integer NOT NULL DEFAULT 1;

-- 回填：旧列 → 通用键对。**旧列保留不删、继续可读**（回滚时要靠它）。
--
-- ⚠️ **三条纪律，缺一条就静默漏写。每条都对应一个真会发生的形态：**
--
--   ① **必须按类型白名单，不能写成「凡 node_id 非空就填 node」。**
--      旧代码里 **cover / stamp / icon 也曾经是节点级展开**（`node × type` 笛卡尔积，
--      见 asset-types.ts 里那几条「展开键由节点修正为条目/档位」的注释）。
--      而 `buildWritebackPlan` 只认 `assetType`（→注册表拿目标**表/列**）+ `targetId`（→拿**行**），
--      **从不读 `target_kind`** ⇒ 把它们的 target_id 填成**节点 id** 之后，回写变成
--      `UPDATE products SET cover_image … WHERE id = <一个节点 id>` —— 匹配不到任何行，
--      **静默 no-op，封面/印章/图标永不回写**（图已生成、钱已花、界面显示成功）。
--
--   ② **product 规则排在 node 规则之前**（写法上保留，但**顺序本身不承重**）。
--      承重的是第 ① 条的白名单：加了白名单之后两条规则的 `asset_type` 取值域
--      （`('anchor','cover')` 与 `('background','narration')`）**互不相交**，且都带
--      `target_kind IS NULL` ⇒ 交换顺序结果完全相同。保留这个顺序是**兜底**：
--      万一将来有人删掉白名单退回「凡 node_id 非空就填 node」，先跑 node 规则会把
--      同时有 node_id 与 product_id 的行钉成节点 id，撞上第 ① 条的静默 no-op ——
--      这个顺序能救回一部分。**别把它读成「顺序能替代白名单」。**
--
--   ③ **锚图必须显式补**（product_id 非空、node_id 恒为 NULL，两条旧规则都够不着它）。
--      漏了的后果最重：`products.style_anchor_url` 永不回写 ⇒ 消费方
--      `claimNextJobs({ requireAnchorReady: true })` 永远挡着 ⇒ **该产品全部图类 job
--      永远停在 pending**（claim.ts 的注释已写明「没有任何自动路径把 failed 变回 pending」）。
--      实测触达路径：`enqueueIteration` 原样继承 `parent.targetKind` / `parent.targetId`
--      （enqueue.ts），父行 target_id 为 NULL ⇒ 迭代行也是 NULL ⇒ 迭代版静默不回写。
--
-- ⚠️ `target_kind` 这一列**今天已被读取**（素材库「用在」列：`GET /assets` → BFF 白名单 →
--    前端 `asset-usage.ts`）。它**不是**回写的判据。填错它不影响回写，却会让「用在」列显示成
--    **错误的要素**或退回裸 id —— 危险的是**以为它决定目标表**，从而省掉 `target_id` 的正确性（第 ① 条）。
UPDATE pms_bui_wenlv_asset_jobs
   SET target_kind = 'product', target_id = product_id
 WHERE target_kind IS NULL AND product_id IS NOT NULL
   AND asset_type IN ('anchor', 'cover');

UPDATE pms_bui_wenlv_asset_jobs
   SET target_kind = 'node', target_id = node_id
 WHERE target_kind IS NULL AND node_id IS NOT NULL
   AND asset_type IN ('background', 'narration');

UPDATE pms_bui_wenlv_asset_jobs
   SET target_kind = 'collectible', target_id = collectible_id
 WHERE target_kind IS NULL AND collectible_id IS NOT NULL
   AND asset_type = 'collectible';

-- ── B. design_assets：候选 + 评审 ────────────────────────────────────
--
-- 候选与评分落在**这张表**而不是 asset_jobs：方舟一次调用返回 N 张图、**一次计费**。
-- 摊成 N 个 job 行 = 「一次计费」在账面上变成「N 次计费」，而成本是本子项目的交付判据。
-- 另外「候选（一次请求的 N 张）」与「版本（parent_job_id 串起的多次请求）」是两个概念。
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS job_id varchar(64);
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS candidate_index integer NOT NULL DEFAULT 0;
-- 默认 **false**：新写入的候选由应用显式指定哪一张被采纳。
-- 若默认 true：下面那条部分唯一索引（一个 job 至多一张 true）会让第 2..N 张 INSERT
-- 直接报 unique violation —— 落库形态是「1 张成功 + N-1 张失败」，不是静默全采纳。
-- 两种都不可接受，故取 false。
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS is_selected boolean NOT NULL DEFAULT false;
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS review_score numeric(4,2);
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS review_detail jsonb;
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS review_source varchar(10);
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN IF NOT EXISTS review_model varchar(64);

-- 历史行溯源：writeAsset 一直把 jobId 写进 meta（scheduler 的 writeAsset 第 301 行）。
UPDATE pms_bui_wenlv_design_assets
   SET job_id = meta->>'jobId'
 WHERE job_id IS NULL AND meta ? 'jobId';

-- 历史行都是各自 job 的唯一产物 ⇒ 全部是「被采纳」。
-- （顺序要紧：必须在 job_id 回填之后。）
UPDATE pms_bui_wenlv_design_assets
   SET is_selected = true
 WHERE is_selected = false AND candidate_index = 0 AND job_id IS NOT NULL;

-- 不变量：一个 job 至多一张被采纳。靠 DB 挡住「并发改选把两张都标成已选」。
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_design_assets_selected
  ON pms_bui_wenlv_design_assets (job_id) WHERE is_selected;

-- ── C. products：风格参考图集 ────────────────────────────────────────
ALTER TABLE pms_bui_wenlv_products ADD COLUMN IF NOT EXISTS style_references jsonb;
