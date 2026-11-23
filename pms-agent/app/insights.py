"""建议采纳与收益归因领域逻辑（spec §12 agent_insights）。

- estimate_baseline_revenue：采纳时用「当日预计售出间夜 × 原价」估算基线营收；
- summarize_insights：汇总采纳率、归因增益与待回填数量；
- record_adoption / list_insights / backfill_observed：读写 agent_insights。

归因口径刻意保守：只比较同口径营收，不做对照实验，因此所有对外文案都
必须带 ATTRIBUTION_NOTE（归因非因果），避免把相关误读为因果。
"""
from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb

ATTRIBUTION_NOTE = "归因非因果：仅比较调价前后同口径营收，未做对照实验"
BASELINE_NOTE = "按门店当日预计售出间夜 × 原价估算"


def estimate_baseline_revenue(baseline_price: Any, occupancy_rate: Any,
                              total_rooms: Any) -> tuple[float, int]:
    """估算基线营收（纯函数），返回（营收，预计售出间夜）。

    - 售出间夜 = round(总房量 × 入住率%)，至少 1 间夜，避免 0 基线；
    - 缺少房量/入住率时回落为 1 间夜（单间夜口径，不放大也不编造）。
    """
    try:
        price = max(0.0, float(baseline_price or 0))
    except (TypeError, ValueError):
        price = 0.0
    try:
        rate = min(max(float(occupancy_rate or 0), 0.0), 100.0)
    except (TypeError, ValueError):
        rate = 0.0
    try:
        total = max(0.0, float(total_rooms or 0))
    except (TypeError, ValueError):
        total = 0.0

    rooms = max(1, round(total * rate / 100)) if total > 0 else 1
    return round(price * rooms, 2), rooms


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def summarize_insights(rows: list[dict[str, Any]], decided_count: int) -> dict[str, Any]:
    """汇总归因指标（纯函数）。

    - adoption_rate = 已采纳建议数 / 已决策审批数，无决策时记 0；
    - attribution_gain = Σ(observed_revenue - baseline_revenue)，只统计已回填行；
    - pending_backfill_count = observed_revenue 为空的行数。
    """
    observed = [row for row in rows if row.get("observed_revenue") is not None]
    gain = sum(
        _num(row.get("observed_revenue")) - _num(row.get("baseline_revenue"))
        for row in observed
    )
    return {
        "adopted_count": len(rows),
        "decided_count": decided_count,
        "adoption_rate": round(len(rows) / decided_count, 4) if decided_count > 0 else 0.0,
        "observed_count": len(observed),
        "pending_backfill_count": len(rows) - len(observed),
        "attribution_gain": round(gain, 2),
        "attribution_note": ATTRIBUTION_NOTE,
    }


def record_adoption(conn, *, run_id: str, proposal: dict, tenant: dict,
                    occupancy_rate: Any, total_rooms: Any) -> bool:
    """写入一条采纳记录（按 run_id + proposal_ref 幂等）。

    只有调价执行成功（succeeded）后才会调用；重复调用不会产生重复行。
    返回是否新插入。
    """
    params = (proposal or {}).get("params") or {}
    proposal_ref = proposal.get("proposal_id") or ""
    if not proposal_ref:
        return False
    baseline_price = params.get("expectedCurrentPrice")
    adopted_price = params.get("nextPrice")
    baseline_revenue, rooms = estimate_baseline_revenue(
        baseline_price, occupancy_rate, total_rooms,
    )
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO agent_insights"
            " (run_id, proposal_ref, tenant, room_type_id, target_date,"
            "  baseline_price, adopted_price, baseline_rooms, baseline_revenue,"
            "  attribution_note)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (run_id, proposal_ref) DO NOTHING",
            (
                run_id, proposal_ref, Jsonb(tenant or {}),
                params.get("roomTypeId"), params.get("date") or None,
                baseline_price, adopted_price, rooms, baseline_revenue,
                ATTRIBUTION_NOTE,
            ),
        )
        return cur.rowcount == 1


def list_insights(conn, merchant_id: str | None = None,
                  limit: int = 50) -> list[dict[str, Any]]:
    """按商户（可选）倒序列出归因记录。"""
    sql = (
        "SELECT id, run_id, proposal_ref, tenant, room_type_id, target_date,"
        " baseline_price, adopted_price, baseline_rooms, baseline_revenue,"
        " observed_revenue, attribution_note, adopted_at, observed_at"
        " FROM agent_insights"
    )
    params: list[Any] = []
    if merchant_id:
        sql += " WHERE tenant->>'merchant_id' = %s"
        params.append(merchant_id)
    sql += " ORDER BY adopted_at DESC, id DESC LIMIT %s"
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]


def count_decisions(conn, merchant_id: str | None = None) -> int:
    """统计已决策审批数（approve + reject），作为采纳率分母。"""
    sql = (
        "SELECT count(*) AS n FROM agent_approvals a"
        " JOIN agent_runs r ON r.id = a.run_id"
        " WHERE a.status IN ('approve', 'reject')"
    )
    params: list[Any] = []
    if merchant_id:
        sql += " AND r.tenant->>'merchant_id' = %s"
        params.append(merchant_id)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
    return int((row or {}).get("n") or 0)


def pending_backfill(conn, merchant_id: str | None = None,
                     older_than_days: int = 7, limit: int = 100) -> list[dict[str, Any]]:
    """取需要 T+7 回填的记录：目标日期已过且 observed_revenue 为空。"""
    sql = (
        "SELECT id, run_id, proposal_ref, tenant, target_date"
        " FROM agent_insights"
        " WHERE observed_revenue IS NULL"
        "   AND target_date IS NOT NULL"
        "   AND target_date <= (CURRENT_DATE - %s::int)"
    )
    params: list[Any] = [older_than_days]
    if merchant_id:
        sql += " AND tenant->>'merchant_id' = %s"
        params.append(merchant_id)
    sql += " ORDER BY target_date ASC LIMIT %s"
    params.append(limit)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]


def set_observed_revenue(conn, insight_id: int, revenue: float) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE agent_insights SET observed_revenue = %s, observed_at = now()"
            " WHERE id = %s AND observed_revenue IS NULL",
            (revenue, insight_id),
        )


__all__ = [
    "ATTRIBUTION_NOTE", "BASELINE_NOTE",
    "estimate_baseline_revenue", "summarize_insights", "record_adoption",
    "list_insights", "count_decisions", "pending_backfill", "set_observed_revenue",
]
