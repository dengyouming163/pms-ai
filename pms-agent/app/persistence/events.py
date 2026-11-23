"""事件仓储：agent_events 表的读写。

设计要点（便于单测与解耦）：
- next_seq 是纯函数，不连库，可直接断言。
- append_event / list_events 接收调用方传入的 psycopg 连接 conn，不在内部建连，
  测试可传 mock / 替换实现；生产由 app.persistence.db.get_conn() 提供。
- append_event 在事务内用 SELECT COALESCE(MAX(seq),0)+1 取下一序号再插入，
  遇 UNIQUE(run_id, seq) 冲突重试一次（并发双写竞态兜底）。
- payload 等 jsonb 列用 psycopg.types.json.Jsonb 包装，psycopg3 会自动适配为 jsonb。
"""
from __future__ import annotations

import logging
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

logger = logging.getLogger(__name__)

# 运行终态：SSE 轮询到这些状态且无新事件时结束连接
TERMINAL_STATUSES = frozenset({
    "succeeded", "failed", "rejected", "budget_exceeded", "conflict",
})


def next_seq(current_max: int | None) -> int:
    """纯函数：当前最大序号 + 1（None 视为 0）。不连库，便于单测。"""
    return (int(current_max) if current_max is not None else 0) + 1


def append_event(
    conn,
    run_id: str,
    node: str | None,
    type: str,
    payload: dict[str, Any] | None = None,
    **extra: Any,
) -> int:
    """事务内取下一 seq 并插入事件，返回新序号。UNIQUE 冲突重试一次。

    extra 支持：started_at / ended_at / tokens_in / tokens_out / trace_id。
    """
    payload = payload if payload is not None else {}
    last_seq = 0
    for attempt in range(2):
        try:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT COALESCE(MAX(seq), 0) FROM agent_events"
                        " WHERE run_id = %s",
                        (run_id,),
                    )
                    row = cur.fetchone()
                    current_max = row[0] if row else 0
                    seq = next_seq(current_max)
                    cur.execute(
                        "INSERT INTO agent_events"
                        " (run_id, seq, node, type, payload,"
                        "  started_at, ended_at, tokens_in, tokens_out, trace_id)"
                        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (
                            run_id, seq, node, type, Jsonb(payload),
                            extra.get("started_at"),
                            extra.get("ended_at"),
                            extra.get("tokens_in"),
                            extra.get("tokens_out"),
                            extra.get("trace_id"),
                        ),
                    )
                    last_seq = seq
            return seq
        except psycopg.errors.UniqueViolation:
            # 并发竞态：另一连接已占用该 seq，回滚后重算一次
            if attempt == 0:
                logger.debug("append_event seq 冲突，重试一次 run_id=%s", run_id)
                continue
            raise
    return last_seq  # 理论不可达（range(2) 第二次要么成功要么 raise）


def list_events(conn, run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
    """按 seq 升序返回 run_id 下 after_seq 之后的事件（不含 after_seq 本身）。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT seq, node, type, payload, started_at, ended_at,"
            " tokens_in, tokens_out, trace_id, created_at"
            " FROM agent_events"
            " WHERE run_id = %s AND seq > %s"
            " ORDER BY seq ASC",
            (run_id, after_seq),
        )
        cols = [desc.name for desc in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


__all__ = ["next_seq", "append_event", "list_events", "TERMINAL_STATUSES"]
