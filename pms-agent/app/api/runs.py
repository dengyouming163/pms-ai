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
import time
import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel
from psycopg.types.json import Jsonb

from app.graph.build import build_graph
from app.persistence.db import get_checkpointer, get_conn
from app.persistence.events import TERMINAL_STATUSES, append_event, list_events
from app.runtime.trace import TraceCallbackHandler
from app.runtime.utils import now_utc

logger = logging.getLogger(__name__)

# ---- SSE / 运行超时常量 ----
SSE_POLL_INTERVAL_SECONDS = 0.3  # SSE 轮询 DB 的间隔（秒）
# 空闲超时：run 非终态但超过该时长无新事件，结束连接（客户端 EventSource 会自动重连），
# 避免挂起 run 永久占用 HTTP 连接与 DB 连接。
SSE_IDLE_TIMEOUT_SECONDS = 60
# 心跳间隔：定期发一行注释保活，防止代理/网关因空闲断连；不更新 last_event_at。
SSE_HEARTBEAT_INTERVAL_SECONDS = 15
# 单次 run 图执行总超时：挂起时转 failed，避免 run 永远停在 running。
RUN_TIMEOUT_SECONDS = 120

router = APIRouter(prefix="/runs", tags=["runs"])

# 持有后台执行任务的强引用，防止被事件循环的弱引用 GC 回收导致任务中途消失
_RUN_TASKS: set[asyncio.Task] = set()


class CreateRunRequest(BaseModel):
    goal: str
    tenant: dict | None = None
    trace_id: str | None = None


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
            (run_id, Jsonb(tenant or {}), goal, "running", trace_id, now_utc()),
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

def _interrupt_payload(result: dict) -> dict | None:
    """从 ainvoke 返回 dict 取首个中断的 payload（Interrupt.value）；无中断返回 None。"""
    interrupts = result.get("__interrupt__") if isinstance(result, dict) else None
    if not interrupts:
        return None
    first = interrupts[0]
    value = getattr(first, "value", None)
    return value if value is not None else first


async def _execute_run(run_id: str, goal: str, tenant: dict, trace_id: str | None) -> None:
    """后台执行一次图：挂起→awaiting_approval，成功→succeeded，超时/异常→failed。"""
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
            # 总超时：图挂起时取消执行并转 failed，避免 run 永远停在 running。
            result = await asyncio.wait_for(
                graph.ainvoke(state, config={"configurable": {"thread_id": run_id}}),
                timeout=RUN_TIMEOUT_SECONDS,
            )
            # 中断挂起：图在 request_approval 等待人审，不标 succeeded；
            # awaiting_approval 非终态（不在 TERMINAL_STATUSES），SSE 流继续等待 approve 后续事件。
            interrupt_payload = _interrupt_payload(result)
            route = None if interrupt_payload is not None else result.get("route")
            final = None if interrupt_payload is not None else result.get("final")
        with get_conn() as conn:
            if interrupt_payload is not None:
                _update_run(conn, run_id, status="awaiting_approval")
                append_event(
                    conn, run_id, node="revenue_request_approval",
                    type="approval_required", payload=interrupt_payload,
                    trace_id=trace_id,
                )
                return
            _update_run(conn, run_id, status="succeeded", route=route, ended_at=now_utc())
            append_event(
                conn, run_id, node="run", type="run_succeeded",
                payload={"route": route, "final": final}, trace_id=trace_id,
            )
    except asyncio.TimeoutError:
        # 超时：wait_for 已取消图执行；标记 failed，事件明确记录 run_timeout。
        logger.error("run 执行超时（%ss） run_id=%s", RUN_TIMEOUT_SECONDS, run_id)
        with get_conn() as conn:
            _update_run(conn, run_id, status="failed", ended_at=now_utc())
            append_event(
                conn, run_id, node="run", type="run_failed",
                payload={"error": "run_timeout"}, trace_id=trace_id,
            )
    except Exception as exc:
        logger.exception("run 执行失败 run_id=%s", run_id)
        with get_conn() as conn:
            _update_run(conn, run_id, status="failed", ended_at=now_utc())
            append_event(
                conn, run_id, node="run", type="run_failed",
                payload={"error": repr(exc)}, trace_id=trace_id,
            )


# ---- 审批单执行结果回写（spec §8：审批记录需含执行结果） ----

# 图恢复后的合法执行状态；未命中（含 None）一律视为 succeeded（兼容旧状态）
VALID_EXEC_STATUSES = ("succeeded", "rejected", "conflict", "guard_rejected", "failed")


def normalize_exec_status(raw: str | None) -> str:
    """纯函数：把图返回的 execution_status 归一为合法终态，未知值回落 succeeded。"""
    return raw if raw in VALID_EXEC_STATUSES else "succeeded"


def run_event_type(exec_status: str) -> str:
    """纯函数：执行状态 → run 终态事件类型。"""
    if exec_status == "rejected":
        return "run_rejected"
    if exec_status in ("conflict", "guard_rejected", "failed"):
        return "run_failed"
    return "run_succeeded"


def run_error_code(exec_status: str) -> str | None:
    """纯函数：执行状态 → 事件 error 码；成功/驳回无 error。"""
    return {
        "conflict": "price_conflict",
        "guard_rejected": "guard_rejected",
        "failed": "execution_failed",
    }.get(exec_status)


def _write_approval_result(conn, run_id: str, proposal_id: str, result: dict) -> None:
    """把执行结果回写到 agent_approvals（按 run_id + proposal_id 定位审批单）。"""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE agent_approvals SET result = %s, executed_at = now()"
            " WHERE run_id = %s AND proposal_id = %s",
            (Jsonb(result), run_id, proposal_id),
        )


def _write_approval_result_best_effort(run_id: str, proposal_id: str, result: dict) -> None:
    """异常分支用：单独连接尽力回写，失败只记日志，绝不掩盖原始错误。"""
    if not proposal_id:
        return
    try:
        with get_conn() as conn:
            _write_approval_result(conn, run_id, proposal_id, result)
    except Exception:
        logger.warning(
            "审批单执行结果回写失败 run_id=%s proposal_id=%s", run_id, proposal_id,
            exc_info=True,
        )


async def resume_run(run_id: str, resume_payload: dict, trace_id: str | None) -> None:
    """恢复挂起的图（人审决策后由 approvals 端点后台调用），并终结 run。

    - Command(resume=resume_payload) 让挂起的 request_approval 节点重新执行、interrupt 返回该 payload。
    - result["execution_status"]：conflict/rejected/guard_rejected/failed 对应非成功态，其余视为 succeeded。
    - 事件落 executions 与 final；异常/超时按 _execute_run 风格置 failed。
    - 执行结果同时回写审批单（agent_approvals.result / executed_at）。
    """
    proposal_id = resume_payload.get("proposal_id") or ""
    try:
        async with get_checkpointer() as checkpointer:
            handler = TraceCallbackHandler(run_id, trace_id=trace_id)
            graph = build_graph(checkpointer=checkpointer, callbacks=[handler])
            result = await asyncio.wait_for(
                graph.ainvoke(
                    Command(resume=resume_payload),
                    config={"configurable": {"thread_id": run_id}},
                ),
                timeout=RUN_TIMEOUT_SECONDS,
            )
            exec_status = normalize_exec_status(result.get("execution_status"))
            executions = result.get("executions") or []
            final = result.get("final")
        event_type = run_event_type(exec_status)
        payload: dict = {
            "execution_status": exec_status,
            "executions": executions,
            "final": final,
        }
        error_code = run_error_code(exec_status)
        if error_code:
            payload["error"] = error_code
        # guard_rejected 为终态（TERMINAL_STATUSES），直接以执行状态作为 run 状态
        with get_conn() as conn:
            _update_run(conn, run_id, status=exec_status, ended_at=now_utc())
            append_event(
                conn, run_id, node="run", type=event_type,
                payload=payload, trace_id=trace_id,
            )
            if proposal_id:
                _write_approval_result(conn, run_id, proposal_id, {
                    "execution_status": exec_status,
                    "executions": executions,
                    "final": final,
                })
    except asyncio.TimeoutError:
        logger.error("run 恢复超时（%ss） run_id=%s", RUN_TIMEOUT_SECONDS, run_id)
        with get_conn() as conn:
            _update_run(conn, run_id, status="failed", ended_at=now_utc())
            append_event(
                conn, run_id, node="run", type="run_failed",
                payload={"error": "run_timeout"}, trace_id=trace_id,
            )
        _write_approval_result_best_effort(run_id, proposal_id, {
            "execution_status": "failed",
            "executions": [],
            "final": "run 恢复超时",
        })
    except Exception as exc:
        logger.exception("run 恢复失败 run_id=%s", run_id)
        with get_conn() as conn:
            _update_run(conn, run_id, status="failed", ended_at=now_utc())
            append_event(
                conn, run_id, node="run", type="run_failed",
                payload={"error": repr(exc)}, trace_id=trace_id,
            )
        _write_approval_result_best_effort(run_id, proposal_id, {
            "execution_status": "failed",
            "executions": [],
            "final": repr(exc),
        })


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
    """SSE：轮询 after 之后的新事件，终态且无新事件时关闭连接。

    可靠性：run 非终态但空闲过久（SSE_IDLE_TIMEOUT_SECONDS）也会结束，由客户端重连；
    期间定期发心跳注释行保活（SSE_HEARTBEAT_INTERVAL_SECONDS），防止代理断连。
    """
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
    last_event_at = time.monotonic()  # 上次收到新事件的时刻，用于空闲超时
    last_heartbeat_at = time.monotonic()  # 上次发心跳的时刻
    # 整条流复用一条连接（读多写少，轮询），避免频繁建连
    with get_conn() as conn:
        while True:
            now = time.monotonic()
            events = list_events(conn, run_id, after_seq=last_seq)
            run = _get_run(conn, run_id)
            for ev in events:
                last_seq = ev["seq"]
                last_event_at = now  # 有新事件，刷新空闲计时
                data = _to_json_str(jsonable_encoder(ev))
                yield f"id: {last_seq}\ndata: {data}\n\n"
            # 运行不存在 → 结束
            if run is None:
                break
            # 进入终态且本轮无新事件 → 结束
            if run.get("status") in TERMINAL_STATUSES and not events:
                break
            # 空闲超时：run 仍非终态但太久没新事件，结束连接（客户端会自动重连）
            if not events and now - last_event_at >= SSE_IDLE_TIMEOUT_SECONDS:
                break
            # 心跳保活，防止代理/网关因空闲断连；不更新 last_event_at
            if now - last_heartbeat_at >= SSE_HEARTBEAT_INTERVAL_SECONDS:
                yield ": ping\n\n"
                last_heartbeat_at = now
            await asyncio.sleep(SSE_POLL_INTERVAL_SECONDS)


__all__ = [
    "router", "resume_run", "normalize_exec_status", "run_event_type", "run_error_code",
]
