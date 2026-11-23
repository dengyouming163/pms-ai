"""人审恢复端点：POST /runs/{run_id}/approve（Task 9）。

流程：决策校验 → 读运行状态 → 幂等写 agent_approvals → 置 running → 后台恢复图 → 立即返回。
- 非法 decision → 422；run 不存在 → 404；非 awaiting_approval → 409（含重复审批）。
- 恢复在后台任务中执行（与 POST /runs 一致），避免 HTTP 阻塞最长 RUN_TIMEOUT_SECONDS；
  客户端通过 GET /runs/{id} 或 SSE 事件流看到最终态。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from app.api.runs import _RUN_TASKS, _get_run, _update_run, resume_run
from app.graph.approval import decide
from app.persistence.db import get_conn
from app.persistence.events import append_event, list_events

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["approvals"])


class ApproveRequest(BaseModel):
    decision: str
    reason: str | None = None
    approval_id: str | None = None
    decided_by: str | None = None


def _latest_proposal(conn, run_id: str) -> dict:
    """取该 run 最新一条 approval_required 事件的 proposal；找不到返回 {}。"""
    for ev in reversed(list_events(conn, run_id)):
        if ev.get("type") != "approval_required":
            continue
        payload = ev.get("payload") or {}
        proposal = payload.get("proposal") if isinstance(payload, dict) else None
        return proposal or {}
    return {}


def _upsert_approval(conn, run_id: str, proposal_id: str, proposal: dict,
                     req: ApproveRequest) -> None:
    """幂等写审批单：依赖 UNIQUE(run_id, proposal_id)，重复审批只更新决策字段。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO agent_approvals"
            " (run_id, proposal_id, proposal, status, decided_by, decided_at, reason)"
            " VALUES (%s, %s, %s, %s, %s, now(), %s)"
            " ON CONFLICT (run_id, proposal_id) DO UPDATE SET"
            "   status = EXCLUDED.status,"
            "   decided_by = EXCLUDED.decided_by,"
            "   decided_at = EXCLUDED.decided_at,"
            "   reason = EXCLUDED.reason",
            (run_id, proposal_id, Jsonb(proposal), req.decision,
             req.decided_by, req.reason),
        )


@router.post("/{run_id}/approve")
async def approve_run(run_id: str, req: ApproveRequest):
    # 1. 决策校验：非法值直接 422，不写库不恢复图
    decision_result = decide(req.decision, req.reason)
    if not decision_result["accepted"]:
        raise HTTPException(status_code=422, detail=decision_result["error"])

    # 2~5. 读 run、取 proposal、幂等写审批单；先置 running 防重复审批并发进入
    with get_conn() as conn:
        run = _get_run(conn, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        if run.get("status") != "awaiting_approval":
            raise HTTPException(
                status_code=409, detail="run is not awaiting approval",
            )
        proposal = _latest_proposal(conn, run_id)
        proposal_id = proposal.get("proposal_id") or req.approval_id or ""
        _upsert_approval(conn, run_id, proposal_id, proposal, req)
        _update_run(conn, run_id, status="running")
        append_event(
            conn, run_id, node="approval", type="approval_decided",
            payload={
                "decision": req.decision,
                "reason": req.reason,
                "approval_id": req.approval_id or proposal_id,
                "decided_by": req.decided_by,
            },
            trace_id=run.get("trace_id"),
        )

    # 6. 后台恢复图（与 POST /runs 一致）：立即返回 resuming，SSE 继续推事件
    resume_payload = {
        "decision": req.decision,
        "reason": req.reason,
        "approval_id": req.approval_id or proposal_id,
        # 供 resume_run 回写审批单执行结果（agent_approvals.result / executed_at）
        "proposal_id": proposal_id,
    }
    task = asyncio.create_task(
        resume_run(run_id, resume_payload, run.get("trace_id"))
    )
    _RUN_TASKS.add(task)
    task.add_done_callback(_RUN_TASKS.discard)
    return {"run_id": run_id, "status": "resuming"}


__all__ = ["router"]
