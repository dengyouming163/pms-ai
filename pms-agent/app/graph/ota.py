"""ota 渠道体检子图：价差扫描 + 库存快照 + 超时订单 + 同步状态（只读）。

- collect_ota: 并发调用 4 个只读工具（竞对价/价格日历/渠道表现/渠道同步状态）。
- build_report: 纯规则汇总为按优先级排序的体检报告；只给建议动作，不执行写操作。

与 ops 晨报同构：单路失败只落「该路数据不可用」，报告照常产出。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.state import AgentState

logger = logging.getLogger(__name__)

# 与 pms-server 内部端点同名
COMPETITOR = "competitor-prices"
CALENDAR = "pricing-calendar"
CHANNEL = "channel-performance"
SYNC = "channel-status"

# 排序权重：P0 > P1 > 不可用 > P2 > ok
_PRIORITY_RANK = {"P0": 0, "P1": 1, "不可用": 2, "P2": 3, "ok": 4}

# 价差阈值：与竞对均价偏离 ±10% 才值得动作
_PRICE_GAP_PCT = 10.0


def _num(value: Any) -> float:
    """把工具返回值统一收敛为有限数字；非法值回落 0。"""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if n == n and abs(n) != float("inf") else 0.0


def _summarize(tool_name: str, result: dict) -> str:
    """从工具信封中提取一句简短摘要（用于 evidence.summary）。"""
    data = result.get("data") if isinstance(result, dict) else None
    data = data if isinstance(data, dict) else {}
    if tool_name == COMPETITOR:
        return f"竞对均价 {data.get('avgPrice')}，样本 {data.get('count')} 个"
    if tool_name == CALENDAR:
        return f"在售房型 {len(data.get('items') or [])} 个"
    if tool_name == CHANNEL:
        return f"订单 {data.get('orderCount')} 笔，超时 {data.get('timeoutCount', 0)} 笔"
    if tool_name == SYNC:
        return f"同步超时 {data.get('overdueCount', 0)} 个，状态异常 {data.get('abnormalCount', 0)} 个"
    return tool_name


async def collect_ota(state: AgentState, *, tools) -> dict:
    """并发调用 4 个只读体检工具，结果写入 evidence（单路失败不抛异常）。"""
    tenant = state.get("tenant") or {}
    calls = [
        (COMPETITOR, tools.competitor_prices(tenant)),
        (CALENDAR, tools.pricing_calendar(tenant)),
        (CHANNEL, tools.channel_performance(tenant)),
        (SYNC, tools.channel_status(tenant)),
    ]
    results = await asyncio.gather(*[coro for _, coro in calls], return_exceptions=True)

    evidence: list[dict[str, Any]] = []
    for (tool_name, _), result in zip(calls, results):
        if isinstance(result, Exception):
            evidence.append({
                "source": "pms-server",
                "tool": tool_name,
                "summary": f"工具调用失败：{result!r}",
                "payload_ref": f"{tool_name}:error",
                "payload": None,
            })
        else:
            evidence.append({
                "source": "pms-server",
                "tool": tool_name,
                "summary": _summarize(tool_name, result),
                "payload_ref": f"{tool_name}:0",
                "payload": result,
            })
    return {"evidence": evidence}


def _entry(priority: str, status: str, conclusion: str, evidence: str,
           action: str) -> dict[str, Any]:
    return {
        "priority": priority,
        "status": status,
        "conclusion": conclusion,
        "evidence": evidence,
        "action": action,
    }


def _payload(state: AgentState, tool_name: str) -> dict[str, Any] | None:
    """取某工具的证据载荷；payload 为 None（失败）时返回 None。"""
    for item in state.get("evidence") or []:
        if item.get("tool") == tool_name:
            payload = item.get("payload")
            return payload if isinstance(payload, dict) else None
    return None


def _unavailable(tool_name: str, label: str) -> dict[str, Any]:
    return _entry("不可用", "unavailable", f"{label}不可用", "该路工具调用失败", "稍后重试或人工核查")


def _avg_our_price(calendar: dict[str, Any]) -> tuple[float, list[str], list[str]]:
    """返回（本店在售均价，售罄房型名，在售房型名）。"""
    items = calendar.get("data", {}).get("items") or []
    prices: list[float] = []
    sold_out: list[str] = []
    on_sale: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("roomTypeName") or item.get("name") or "未命名房型")
        price = _num(item.get("price"))
        available = item.get("available")
        if price > 0:
            prices.append(price)
            on_sale.append(name)
        if available is not None and _num(available) <= 0:
            sold_out.append(name)
    avg = round(sum(prices) / len(prices), 2) if prices else 0.0
    return avg, sold_out, on_sale


def _timeout_entry(channel: dict[str, Any]) -> dict[str, Any] | None:
    data = channel.get("data") or {}
    total = _num(data.get("timeoutCount"))
    names = [
        str(item.get("channel"))
        for item in (data.get("items") or [])
        if isinstance(item, dict) and _num(item.get("timeoutCount")) > 0
    ]
    if total <= 0:
        return None
    where = f"（{'、'.join(names)}）" if names else ""
    return _entry(
        "P0", "alert",
        f"渠道有 {int(total)} 笔订单超时{where}",
        f"超时订单 {int(total)} 笔",
        "立即联系渠道运营处理，避免超卖与平台罚单",
    )


def _sync_entry(sync: dict[str, Any]) -> dict[str, Any] | None:
    data = sync.get("data") or {}
    overdue = int(_num(data.get("overdueCount")))
    abnormal = int(_num(data.get("abnormalCount")))
    if overdue <= 0 and abnormal <= 0:
        return None
    overdue_names = [
        str(item.get("channel"))
        for item in (data.get("items") or [])
        if isinstance(item, dict) and item.get("overdue")
    ]
    where = f"（{'、'.join(overdue_names)}）" if overdue_names else ""
    return _entry(
        "P1", "warning",
        f"{overdue} 个渠道同步超时{where}，{abnormal} 个渠道状态异常",
        f"超时 {overdue} 个 / 异常 {abnormal} 个",
        "检查渠道授权与网络，必要时手动同步库存",
    )


def _inventory_entry(sold_out: list[str], on_sale: list[str]) -> dict[str, Any]:
    if sold_out:
        return _entry(
            "P1", "warning",
            f"{len(sold_out)} 个房型已售罄：{'、'.join(sold_out)}",
            f"可售房型 {len(on_sale)} 个，售罄 {len(sold_out)} 个",
            "与渠道核对库存同步，避免已满房仍继续接单",
        )
    return _entry("ok", "ok", "库存快照无售罄房型", f"在售房型 {len(on_sale)} 个", "保持日常巡检")


def _price_gap_entry(competitor: dict[str, Any], our_avg: float) -> dict[str, Any]:
    data = competitor.get("data") or {}
    comp_avg = _num(data.get("avgPrice"))
    count = int(_num(data.get("count")))
    if our_avg <= 0 or comp_avg <= 0:
        return _entry("不可用", "unavailable", "价差暂不可用", "本店或竞对缺少有效价格",
                      "补齐价格数据后重试")
    gap = (comp_avg - our_avg) / our_avg * 100
    gap_text = f"{gap:+.1f}%"
    if gap >= _PRICE_GAP_PCT:
        return _entry(
            "P2", "info",
            f"竞对均价高于本店 {gap:.1f}%，存在提价空间",
            f"竞对 {comp_avg} / 本店 {our_avg}（{gap_text}，样本 {count} 个）",
            "结合入住率评估提价，调价须走人工审批",
        )
    if gap <= -_PRICE_GAP_PCT:
        return _entry(
            "P2", "info",
            f"竞对均价低于本店 {abs(gap):.1f}%，本店价格偏高",
            f"竞对 {comp_avg} / 本店 {our_avg}（{gap_text}，样本 {count} 个）",
            "评估降价或增加权益，避免转化流失",
        )
    return _entry(
        "ok", "ok",
        f"渠道价差在合理区间（{gap_text}）",
        f"竞对 {comp_avg} / 本店 {our_avg}（样本 {count} 个）",
        "保持每周复查",
    )


def build_report(state: AgentState) -> dict:
    """节点：把 evidence 汇总为按优先级排序的渠道体检报告（纯规则，不调模型）。"""
    competitor = _payload(state, COMPETITOR)
    calendar = _payload(state, CALENDAR)
    channel = _payload(state, CHANNEL)
    sync = _payload(state, SYNC)

    entries: list[dict[str, Any]] = []
    # 超时与同步异常优先入列，保证 P0/P1 排在最前
    timeout = _timeout_entry(channel) if channel is not None else None
    if timeout:
        entries.append(timeout)
    else:
        entries.append(_entry("ok", "ok", "渠道无超时订单", "近 30 天无超时", "保持监控"))

    if sync is None:
        entries.append(_unavailable(SYNC, "渠道同步状态"))
    else:
        sync_entry = _sync_entry(sync)
        entries.append(sync_entry or _entry(
            "ok", "ok", "渠道库存同步正常", "无超时、无异常渠道", "保持自动同步",
        ))

    if calendar is None:
        entries.append(_unavailable(CALENDAR, "库存快照"))
        our_avg = 0.0
    else:
        our_avg, sold_out, on_sale = _avg_our_price(calendar)
        entries.append(_inventory_entry(sold_out, on_sale))

    if competitor is None:
        entries.append(_unavailable(COMPETITOR, "竞对价数据"))
    else:
        entries.append(_price_gap_entry(competitor, our_avg))

    entries.sort(key=lambda entry: _PRIORITY_RANK.get(entry["priority"], 9))

    lines = ["渠道体检报告（只读）："]
    for entry in entries:
        lines.append(
            f"- [{entry['priority']}] {entry['conclusion']}"
            f"（证据：{entry['evidence']}；建议：{entry['action']}）"
        )
    lines.append("本次体检仅读取数据，未执行任何写操作。")
    return {"ota_report": entries, "final": "\n".join(lines)}


__all__ = ["collect_ota", "build_report"]
