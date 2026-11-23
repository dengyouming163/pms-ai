-- pms-agent 事件溯源 / 运行 / 审批 / 记忆 schema（M1 必需四张表）。
-- 全部 IF NOT EXISTS，可被 init_db() 幂等重复执行。
-- 注意：langgraph-checkpoint-postgres 的检查点表（checkpoints / checkpoint_blobs /
-- checkpoint_writes / checkpoint_migrations）由 AsyncPostgresSaver.setup() 自建，
-- 不要手写，避免与其迁移逻辑冲突。它们同样落在 agent schema（DSN 带 search_path=agent）。

CREATE SCHEMA IF NOT EXISTS agent;

-- 一次 Agent 运行
CREATE TABLE IF NOT EXISTS agent.agent_runs (
    id            TEXT PRIMARY KEY,
    tenant        JSONB NOT NULL DEFAULT '{}'::jsonb,
    goal          TEXT NOT NULL DEFAULT '',
    route         TEXT,
    status        TEXT NOT NULL DEFAULT 'running',
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at      TIMESTAMPTZ,
    total_tokens  INTEGER NOT NULL DEFAULT 0,
    cost          NUMERIC(12, 4) NOT NULL DEFAULT 0,
    trace_id      TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 事件流：seq 单调递增，UNIQUE(run_id, seq) 保证并发插入不重号
CREATE TABLE IF NOT EXISTS agent.agent_events (
    run_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    node        TEXT,
    type        TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at  TIMESTAMPTZ,
    ended_at    TIMESTAMPTZ,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    trace_id    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, seq)
);

-- 审批单
-- proposal_id：ON CONFLICT 幂等 upsert 需要唯一约束作为冲突目标，
-- 故新增该列并建 UNIQUE(run_id, proposal_id)：同一 run 下同一条提案重复审批只更新决策字段。
CREATE TABLE IF NOT EXISTS agent.agent_approvals (
    run_id       TEXT NOT NULL,
    proposal_id  TEXT NOT NULL DEFAULT '',
    proposal     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       TEXT NOT NULL DEFAULT 'pending',
    decided_by   TEXT,
    decided_at   TIMESTAMPTZ,
    reason       TEXT,
    executed_at  TIMESTAMPTZ,
    result       JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 兼容已建好的旧表（本任务前无 proposal_id 列）：幂等补列
ALTER TABLE agent.agent_approvals ADD COLUMN IF NOT EXISTS proposal_id TEXT NOT NULL DEFAULT '';
-- 幂等 upsert 的冲突目标（必须唯一，否则 ON CONFLICT 无法工作）
CREATE UNIQUE INDEX IF NOT EXISTS agent_approvals_run_proposal_uq
    ON agent.agent_approvals (run_id, proposal_id);
-- 按 run_id 查审批单（SSE / 运行详情）
CREATE INDEX IF NOT EXISTS agent_approvals_run_id_idx
    ON agent.agent_approvals (run_id);

-- 长期记忆
CREATE TABLE IF NOT EXISTS agent.agent_memories (
    tenant        TEXT NOT NULL,
    scope         TEXT NOT NULL,
    key           TEXT NOT NULL,
    value         JSONB NOT NULL DEFAULT '{}'::jsonb,
    importance    INTEGER NOT NULL DEFAULT 0,
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant, scope, key)
);

-- 建议采纳与收益归因（M2 Task 16）
-- baseline_revenue：采纳时按「当日预计售出间夜 × 原价」估算的基线营收；
-- observed_revenue：T+7 由 /insights/backfill 用当日实际营收回填；
-- attribution_note 明确「归因非因果」，避免把相关当因果。
CREATE TABLE IF NOT EXISTS agent.agent_insights (
    id               BIGSERIAL PRIMARY KEY,
    run_id           TEXT NOT NULL,
    proposal_ref     TEXT NOT NULL,
    tenant           JSONB NOT NULL DEFAULT '{}'::jsonb,
    room_type_id     TEXT,
    target_date      DATE,
    baseline_price   NUMERIC(10, 2),
    adopted_price    NUMERIC(10, 2),
    baseline_rooms   INTEGER NOT NULL DEFAULT 1,
    baseline_revenue NUMERIC(12, 2) NOT NULL DEFAULT 0,
    observed_revenue NUMERIC(12, 2),
    attribution_note TEXT,
    adopted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    observed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, proposal_ref)
);
CREATE INDEX IF NOT EXISTS agent_insights_target_date_idx
    ON agent.agent_insights (target_date);

