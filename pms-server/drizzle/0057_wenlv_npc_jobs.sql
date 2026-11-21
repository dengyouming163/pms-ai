-- 0057_wenlv_npc_jobs.sql
-- AI 生成/优化 NPC 的任务持久化表。调度器领取 pending 行，调 AI crew 后写库并标记状态。
-- 服务重启不丢：所有状态在行上。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_npc_jobs (
  id          varchar(50) PRIMARY KEY,
  product_id  varchar(50) NOT NULL,
  npc_id      varchar(50),              -- single_optimize 时非空；batch_generate 时 NULL
  type        varchar(30) NOT NULL,     -- 'batch_generate' | 'single_optimize'
  status      varchar(20) NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed
  result      jsonb,                    -- succeeded 时存摘要 { npcCount, npcNames }
  error       text,                     -- failed 时存错误信息
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_npc_jobs_product ON pms_bui_wenlv_npc_jobs(product_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_npc_jobs_status ON pms_bui_wenlv_npc_jobs(status);
