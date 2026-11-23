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

-- 审批单（Task 9 补索引；本任务先建表）
CREATE TABLE IF NOT EXISTS agent.agent_approvals (
    run_id       TEXT NOT NULL,
    proposal     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       TEXT NOT NULL DEFAULT 'pending',
    decided_by   TEXT,
    decided_at   TIMESTAMPTZ,
    reason       TEXT,
    executed_at  TIMESTAMPTZ,
    result       JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
