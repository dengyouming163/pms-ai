"""运行 REST + SSE 端点。

路由挂在根路径 /runs（不加 /api），与 pms-server→agent 的遗留转发约定区分。
- POST /runs：创建运行，插入 agent_runs（status=running），后台异步执行图，立即返回。
- GET  /runs/{run_id}：返回运行行。
- GET  /runs/{run_id}/events?after=N：SSE，300ms 轮询新事件，终态且无新事件时结束。

图执行用 ReplayProvider + HttpToolClient + Postgres checkpointer + TraceCallbackHandler。
checkpointer 表由启动时 init_db() 建好；本模块每次执行开一条 saver（get_checkpointer）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from psycopg.types.json import Jsonb

from app.graph.build import build_graph
from app.persistence.db import get_checkpointer, get_conn
from app.persistence.events import TERMINAL_STATUSES, append_event, list_events
from app.runtime.trace import TraceCallbackHandler

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["runs"])

# 持有后台执行任务的强引用，防止被事件循环的弱引用 GC 回收导致任务中途消失
_RUN_TASKS: set[asyncio.Task] = set()


class CreateRunRequest(BaseModel):
    goal: str
    tenant: dict | None = None
    trace_id: str | None = None


def _now():
    return datetime.now(timezone.utc)


def _json_default(o):
    """json.dumps 默认值转换器：处理 datetime / Decimal 等非原生 JSON 类型。"""
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def _to_json_str(obj) -> str:
    return json.dumps(obj, default=_json_default, ensure_ascii=False)


# ---- 运行行读写 ----

def _insert_run(conn, run_id: str, goal: str, tenant: dict, trace_id: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO agent_runs (id, tenant, goal, status, trace_id, started_at)"
            " VALUES (%s, %s, %s, %s, %s, %s)",
            (run_id, Jsonb(tenant or {}), goal, "running", trace_id, _now()),
        )


def _get_run(conn, run_id: str) -> dict | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, tenant, goal, route, status, started_at, ended_at,"
            " total_tokens, cost, trace_id FROM agent_runs WHERE id = %s",
            (run_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


# 允许更新的白名单字段，避免拼接 SQL 时注入
_UPDATABLE_RUN_FIELDS = {"status", "route", "ended_at", "total_tokens", "cost"}


def _update_run(conn, run_id: str, **fields) -> None:
    fields = {k: v for k, v in fields.items() if k in _UPDATABLE_RUN_FIELDS}
    if not fields:
        return
    sets = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [run_id]
    with conn.cursor() as cur:
        cur.execute(f"UPDATE agent_runs SET {sets} WHERE id = %s", values)


# ---- 图执行（后台） ----

async def _execute_run(run_id: str, goal: str, tenant: dict, trace_id: str | None) -> None:
    """后台执行一次图：成功→succeeded，异常→failed。任何情况都更新状态并落事件。"""
    try:
        async with get_checkpointer() as checkpointer:
            handler = TraceCallbackHandler(run_id, trace_id=trace_id)
            graph = build_graph(checkpointer=checkpointer, callbacks=[handler])
            state = {
                "run_id": run_id,
                "tenant": tenant or {},
                "goal": goal,
                "messages": [],
            }
            result = await graph.ainvoke(
                state, config={"configurable": {"thread_id": run_id}}
            )
            route = result.get("route")
            final = result.get("final")
        with get_conn() as conn:
            _update_run(conn, run_id, status="succeeded", route=route, ended_at=_now())
            append_event(
                conn, run_id, node="run", type="run_succeeded",
                payload={"route": route, "final": final}, trace_id=trace_id,
            )
    except Exception as exc:
        logger.exception("run 执行失败 run_id=%s", run_id)
        with get_conn() as conn:
            _update_run(conn, run_id, status="failed", ended_at=_now())
            append_event(
                conn, run_id, node="run", type="run_failed",
                payload={"error": repr(exc)}, trace_id=trace_id,
            )


# ---- 端点 ----

@router.post("")
async def create_run(req: CreateRunRequest):
    run_id = str(uuid.uuid4())
    with get_conn() as conn:
        _insert_run(conn, run_id, req.goal, req.tenant or {}, req.trace_id)
        append_event(
            conn, run_id, node="run", type="run_started",
            payload={"goal": req.goal}, trace_id=req.trace_id,
        )
    # 后台执行：立即返回 running，SSE 另开连接轮询事件
    task = asyncio.create_task(
        _execute_run(run_id, req.goal, req.tenant or {}, req.trace_id)
    )
    _RUN_TASKS.add(task)
    task.add_done_callback(_RUN_TASKS.discard)
    return {"run_id": run_id, "status": "running"}


@router.get("/{run_id}")
def get_run(run_id: str):
    with get_conn() as conn:
        row = _get_run(conn, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="run not found")
    return jsonable_encoder(row)


@router.get("/{run_id}/events")
def stream_events(run_id: str, after: int = 0):
    """SSE：每 300ms 拉一次 after 之后的新事件，终态且无新事件时关闭连接。"""
    return StreamingResponse(
        _event_stream(run_id, after),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def _event_stream(run_id: str, after: int):
    last_seq = after
    # 整条流复用一条连接（读多写少，300ms 轮询），避免频繁建连
    with get_conn() as conn:
        while True:
            events = list_events(conn, run_id, after_seq=last_seq)
            run = _get_run(conn, run_id)
            for ev in events:
                last_seq = ev["seq"]
                data = _to_json_str(jsonable_encoder(ev))
                yield f"id: {last_seq}\ndata: {data}\n\n"
            # 运行不存在 → 结束
            if run is None:
                break
            # 进入终态且本轮无新事件 → 结束
            if run.get("status") in TERMINAL_STATUSES and not events:
                break
            await asyncio.sleep(0.3)


__all__ = ["router"]
