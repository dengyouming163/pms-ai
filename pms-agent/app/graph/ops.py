"""ops 晨报子图：四路只读体检 → 确定性规则生成晨报。

- collect_checks: 并发调 4 个只读工具（营收/房态/渠道/评价），结果写入 evidence。
- build_report: 纯规则（不调模型）汇总为按优先级排序的晨报条目，写入 ops_report 与 final。

优先级排序：P0 > P1 > 不可用 > P2 > ok；「不可用」是单路工具失败，
排在待处理告警之后、一般信息项之前。
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import Any

from app.state import AgentState

logger = logging.getLogger(__name__)

# 四路体检的 evidence tool 名（与 pms-server 内部端点同名）
FINANCE = "finance-summary"
OCCUPANCY = "occupancy"
CHANNEL = "channel-performance"
REVIEWS = "reviews-summary"

# 排序权重：不可用夹在 P1 与 P2 之间
_PRIORITY_RANK = {"P0": 0, "P1": 1, "不可用": 2, "P2": 3, "ok": 4}

# 脏房积压阈值：达到即需要保洁排班介入
_DIRTY_BACKLOG_THRESHOLD = 5


# ====== 工具结果摘要 ======

def _summarize(tool_name: str, result: dict) -> str:
    """从工具信封中提取一句简短摘要（用于 evidence.summary，纯展示用）。"""
    data = result.get("data") if isinstance(result, dict) else None
    if tool_name == FINANCE:
        return f"营收 {(data or {}).get('revenue')}，RevPAR {(data or {}).get('revpar')}"
    if tool_name == OCCUPANCY:
        return f"入住率 {(data or {}).get('occupancyRate')}%"
    if tool_name == CHANNEL:
        return f"订单 {(data or {}).get('orderCount')} 笔"
    if tool_name == REVIEWS:
        return f"评价 {(data or {}).get('total')} 条，均分 {(data or {}).get('avgRating')}"
    return tool_name


# ====== 节点：采集 ======

async def collect_checks(state: AgentState, *, tools) -> dict:
    """并发调用 4 个只读体检工具，结果写入 evidence。tools 可注入（测试用假工具）。

    occupancy 不传日期：服务端默认今天，晨报关心的是当日实时房态；
    单路异常只落一条 payload=None 的失败证据，不抛异常拖垮整条晨报。
    """
    tenant = state.get("tenant") or {}
    calls = [
        (FINANCE, tools.finance_summary(tenant)),
        (OCCUPANCY, tools.occupancy(tenant)),
        (CHANNEL, tools.channel_performance(tenant)),
        (REVIEWS, tools.reviews_summary(tenant, days=30)),
    ]
    # gather 保持入参顺序，evidence 顺序确定
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


# ====== 规则：确定性晨报 ======

def _num(value: Any) -> float:
    """把工具返回值统一收敛为有限数字；非法值回落 0。"""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if math.isfinite(n) else 0.0


def _entry(priority: str, status: str, conclusion: str, evidence: str,
           action: str) -> dict[str, Any]:
    """晨报条目：priority 同时作为文本前缀（P0/P1/P2/ok/不可用）。"""
    return {
        "priority": priority,
        "status": status,
        "conclusion": conclusion,
        "evidence": evidence,
        "action": action,
    }


def _unavailable(item: dict | None, tool_name: str) -> dict[str, Any]:
    """单路工具失败/缺数据：结论统一为「该路数据不可用」。"""
    summary = (item or {}).get("summary") or f"未采集到 {tool_name} 数据"
    return _entry("不可用", "unavailable", "该路数据不可用", summary, "稍后重试或人工核查")


def _dirty_count(status_counts: dict) -> int:
    """脏房数：兼容 dirty / dirty_room / dirtyRoom 三种键名。"""
    for key in ("dirty", "dirty_room", "dirtyRoom"):
        if key in status_counts:
            return int(_num(status_counts[key]))
    return 0


def build_report(state: AgentState) -> dict:
    """基于 evidence 按确定性规则生成晨报（不调模型、无随机）。

    每条含 conclusion / evidence / action / priority / status；
    返回 final（多行中文晨报）并写入 state['ops_report']。
    """
    evidence_map: dict[str, dict] = {
        item.get("tool"): item for item in (state.get("evidence") or [])
    }

    def _data_of(tool_name: str) -> tuple[dict | None, dict | None]:
        """取工具信封里的 data；payload 缺失/None 视为不可用，返回 (None, evidence 条目)。"""
        item = evidence_map.get(tool_name)
        if not item or item.get("payload") is None:
            return None, item
        return (item.get("payload") or {}).get("data") or {}, item

    entries: list[dict[str, Any]] = []

    # 1) 渠道超时 → P0（items 各项 timeoutCount 求和）
    data, item = _data_of(CHANNEL)
    if data is None:
        entries.append(_unavailable(item, CHANNEL))
    else:
        timeout_total = int(sum(
            _num(channel.get("timeoutCount")) for channel in (data.get("items") or [])
        ))
        if timeout_total > 0:
            entries.append(_entry(
                "P0", "action_required",
                f"渠道有 {timeout_total} 笔订单超时",
                f"channel-performance 超时合计 {timeout_total} 笔",
                "联系渠道运营处理超时订单",
            ))
        else:
            entries.append(_entry(
                "ok", "ok", "渠道无超时订单",
                "channel-performance 无超时订单", "无需处理",
            ))

    # 2) 评价风险 → P1（低分与待回复合并为一条，证据写清数字）
    data, item = _data_of(REVIEWS)
    if data is None:
        entries.append(_unavailable(item, REVIEWS))
    else:
        low = int(_num(data.get("lowRatingCount")))
        pending_reply = int(_num(data.get("pendingReplyCount")))
        if low > 0 or pending_reply > 0:
            entries.append(_entry(
                "P1", "action_required",
                f"近期有 {low} 条低分评价、{pending_reply} 条待回复",
                f"reviews-summary lowRatingCount={low}，pendingReplyCount={pending_reply}",
                "跟进低分评价并回复客人",
            ))
        else:
            entries.append(_entry(
                "ok", "ok", "近期无低分评价与待回复评价",
                "reviews-summary 无低分与待回复", "无需处理",
            ))

    # 3) 脏房积压 → P1
    data, item = _data_of(OCCUPANCY)
    if data is None:
        entries.append(_unavailable(item, OCCUPANCY))
    else:
        dirty = _dirty_count(data.get("statusCounts") or {})
        if dirty >= _DIRTY_BACKLOG_THRESHOLD:
            entries.append(_entry(
                "P1", "action_required",
                f"脏房积压 {dirty} 间",
                f"occupancy statusCounts.dirty={dirty}",
                "安排保洁尽快清洁",
            ))
        else:
            entries.append(_entry(
                "ok", "ok", "房态无脏房积压",
                f"occupancy 脏房 {dirty} 间", "无需处理",
            ))

    # 4) 营收异常 → P2；营收正常但高入住下 ADR 偏低 → P2 信息项；其余 → ok
    data, item = _data_of(FINANCE)
    if data is None:
        entries.append(_unavailable(item, FINANCE))
    else:
        revenue = _num(data.get("revenue"))
        revpar = _num(data.get("revpar"))
        adr = _num(data.get("adr"))
        if revenue <= 0 or revpar <= 0:
            entries.append(_entry(
                "P2", "action_required",
                "营收为 0，需核查订单与账务同步",
                f"finance-summary revenue={revenue}，revpar={revpar}",
                "核查订单与财务同步",
            ))
        else:
            # 入住率优先取财务口径，缺失时回落到房态体检（真实 finance-summary 不含该字段）
            occupancy_rate = data.get("occupancyRate")
            if occupancy_rate is None:
                occupancy_rate = (_data_of(OCCUPANCY)[0] or {}).get("occupancyRate")
            if _num(occupancy_rate) >= 85 and adr > 0:
                entries.append(_entry(
                    "P2", "ok",
                    "高入住下 ADR 偏低，建议复核定价",
                    f"finance-summary occupancyRate={_num(occupancy_rate)}，adr={adr}",
                    "复核定价策略",
                ))
            else:
                entries.append(_entry(
                    "ok", "ok", "营收与定价正常",
                    f"finance-summary revenue={revenue}，adr={adr}，revpar={revpar}",
                    "无需处理",
                ))

    # 排序：P0 > P1 > 不可用 > P2 > ok（同级保持生成顺序）
    entries.sort(key=lambda entry: _PRIORITY_RANK.get(entry.get("priority"), len(_PRIORITY_RANK)))

    pending = sum(1 for entry in entries if entry.get("status") in ("action_required", "unavailable"))
    lines = [f"经营晨报（待处理 {pending} 项）", ""]
    for index, entry in enumerate(entries, start=1):
        lines.append(f"{index}. [{entry['priority']}] {entry['conclusion']}")
        lines.append(f"   证据：{entry['evidence']}")
        lines.append(f"   建议：{entry['action']}")
    final = "\n".join(lines)

    return {"final": final, "ops_report": entries}


__all__ = ["collect_checks", "build_report"]
