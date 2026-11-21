-- 文旅 S3 素材生产：生成明细表（1 张）+ 既有三表各加列（4 处 ALTER，共 5 条语句）。
-- 这些必须同批生效：拆开就会出现「代码在、列不在」的 42703 中间态 ——
-- schema 里声明了列而库里没有，drizzle 整行 select 会直接炸，该模块读接口全 500。

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_asset_jobs (
  id varchar(64) PRIMARY KEY,
  batch_id varchar(64) NOT NULL,
  venue_id varchar(50),
  product_id varchar(50),
  asset_type varchar(20) NOT NULL,
  name varchar(100) NOT NULL,
  -- 生成时从源头取的**快照**，必须落在行上，不能靠事后回查。
  -- 理由与 style_bible_snapshot 同：源文本会被编辑、节点会被重命名，而这一版
  -- 素材必须永远能解释自己是用什么文本生成的。轮询器直接从 RETURNING * 里读它们。
  node_id varchar(64),             -- 旁白/插画归属的点位；写回 narration_url 靠它，不靠标题字符串匹配
  source_text text,                -- 该素材对应的故事文本（图类的画面描述、旁白的朗读词都由它来）
  community_style_tag varchar(50),-- design_assets.style_tag 的来源
  prompt text,
  style_bible_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  iteration integer NOT NULL DEFAULT 1,
  parent_job_id varchar(64),
  guidance text,
  status varchar(20) NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  provider varchar(30),
  model varchar(50),
  -- 留给未来的**异步** provider（如文生视频的 task_id 轮询）。
  -- 当前四个素材类型都是同步 generate()，因此这一列恒为 null，不是漏写代码。
  provider_task_id varchar(128),
  cost_amount numeric(10,4) NOT NULL DEFAULT 0,
  asset_id varchar(50),
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wenlv_asset_jobs_batch ON pms_bui_wenlv_asset_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_asset_jobs_parent ON pms_bui_wenlv_asset_jobs(parent_job_id);
-- 两个热查询各配一条复合索引，形状与 claim.ts 里的 WHERE 逐字对应：
--   领取：WHERE status='pending' AND attempt<N ORDER BY created_at LIMIT n
--   超时收口：WHERE status='running' AND started_at < cutoff
-- 单列 (status) 选择性极低，两条都得先扫出整个状态集再排序/过滤。
CREATE INDEX IF NOT EXISTS idx_wenlv_asset_jobs_claim ON pms_bui_wenlv_asset_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_wenlv_asset_jobs_sweep ON pms_bui_wenlv_asset_jobs(status, started_at);

-- 资源库归属：NULL = 公共池（跨场地复用），非空 = 该场地私有
ALTER TABLE pms_bui_wenlv_design_assets
  ADD COLUMN IF NOT EXISTS venue_id varchar(50);

-- 点位旁白：与 0023 加 image 完全同构（素材落资源库，点位存 URL）
ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS narration_url varchar(500);

-- 风格基线：防迭代漂移的第一层（文本约束）
ALTER TABLE pms_bui_wenlv_products
  ADD COLUMN IF NOT EXISTS style_bible jsonb;

-- 风格锚图：防迭代漂移的第二层（视觉锚定）。存 OSS URL。
-- 每次图类生成都把它作为参考图带上 —— 比纯文本约束强一个数量级。
ALTER TABLE pms_bui_wenlv_products
  ADD COLUMN IF NOT EXISTS style_anchor_url varchar(500);
