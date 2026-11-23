"""建议采纳与收益归因端点。

- GET  /insights?merchant_id=&limit=：列出采纳记录并汇总采纳率与归因增益；
- POST /insights/backfill?merchant_id=&days=7：对目标日期已过 N 天且未回填的记录，
  用 pms-server 当日实际营收（daily-revenue）回填 observed_revenue。

归因非因果：接口原样返回 attribution_note，前端必须展示。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from app.insights import (
    count_decisions,
    list_insights,
    pending_backfill,
    set_observed_revenue,
    summarize_insights,
)
from app.persistence.db import get_conn

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/insights", tags=["insights"])


@router.get("")
def get_insights(merchant_id: str | None = None, limit: int = 50):
    limit = min(max(limit, 1), 200)
    with get_conn() as conn:
        rows = list_insights(conn, merchant_id, limit)
        decided = count_decisions(conn, merchant_id)
    return {"summary": summarize_insights(rows, decided), "items": rows}


@router.post("/backfill")
async def backfill_insights(merchant_id: str | None = None, days: int = 7):
    if days < 1 or days > 30:
        raise HTTPException(status_code=422, detail="days 必须在 1..30")

    with get_conn() as conn:
        rows = pending_backfill(conn, merchant_id, days)

    tools = None
    filled = skipped = errors = 0
    for row in rows:
        target_date = row.get("target_date")
        if target_date is None:
            skipped += 1
            continue
        date_str = (
            target_date.isoformat() if hasattr(target_date, "isoformat") else str(target_date)
        )
        try:
            if tools is None:
                from app.tools.client import HttpToolClient
                tools = HttpToolClient()
            result = await tools.daily_revenue(row.get("tenant") or {}, date_str)
            if not (isinstance(result, dict) and result.get("ok")):
                errors += 1
                continue
            revenue = float((result.get("data") or {}).get("revenue") or 0)
            with get_conn() as conn:
                set_observed_revenue(conn, int(row["id"]), revenue)
            filled += 1
        except Exception:
            logger.warning("归因回填失败 insight_id=%s", row.get("id"), exc_info=True)
            errors += 1

    return {
        "checked": len(rows),
        "filled": filled,
        "skipped": skipped,
        "errors": errors,
    }


__all__ = ["router"]
