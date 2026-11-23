"""revenue 子图：collect → analyze → propose → request_approval。

- collect: 并发调 4 个只读工具，结果写入 evidence（可注入 tools，测试用假工具）。
- analyze: 用 provider 生成结构化建议；prompt 由 evidence 确定性构造（无随机/时间戳）。
- propose: 每条建议生成一条待审批 proposal，写入 proposals。
- request_approval: Task 7 占位，不调用 interrupt（Task 9 接通）。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from app.state import AgentState

logger = logging.getLogger(__name__)


# ====== prompt 构建（纯函数，确定性） ======

ANALYZE_SYSTEM_PROMPT = (
    "你是酒店收益管理助手。根据以下经营证据，输出调价建议。\n"
    "只输出 JSON 数组，不要输出多余文字或 Markdown 代码块。\n"
    "数组每个元素必须包含字段：roomTypeId, currentPrice, suggestedPrice, reason, confidence, level。"
)


def build_analysis_prompt(evidence: list[dict[str, Any]]) -> str:
    """由 evidence 确定性构造 analyze 的 prompt。

    确定性要求：sort_keys=True 保证 dict 序列化顺序稳定；
    不含时间戳、随机数、运行时 id，从而 sha256(prompt) 在回放中可复现。
    """
    payload = json.dumps(evidence, ensure_ascii=False, sort_keys=True)
    return f"{ANALYZE_SYSTEM_PROMPT}\n证据：\n{payload}"


# ====== 工具结果摘要 ======

def _summarize(tool_name: str, result: dict) -> str:
    """从工具信封中提取一句简短摘要（用于 evidence.summary，纯展示用）。"""
    data = result.get("data") if isinstance(result, dict) else None
    if tool_name == "pricing-calendar":
        items = (data or {}).get("items") or []
        return f"{len(items)} 个房型价格"
    if tool_name == "occupancy":
        return f"入住率 {(data or {}).get('occupancyRate')}%"
    if tool_name == "competitor-prices":
        return f"竞品均价 {(data or {}).get('avgPrice')}（{(data or {}).get('count')} 条）"
    if tool_name == "channel-performance":
        return f"订单 {(data or {}).get('orderCount')} 笔"
    return tool_name


# ====== 节点 ======

async def collect(state: AgentState, *, tools) -> dict:
    """并发调用 4 个工具，结果追加到 evidence。tools 可注入（测试用假工具）。"""
    tenant = state.get("tenant") or {}
    calls = [
        ("pricing-calendar", tools.pricing_calendar(tenant)),
        ("occupancy", tools.occupancy(tenant)),
        ("competitor-prices", tools.competitor_prices(tenant)),
        ("channel-performance", tools.channel_performance(tenant)),
    ]
    # gather 保持入参顺序，evidence 顺序确定 → prompt hash 稳定
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


def _parse_suggestions(content: str) -> list[dict[str, Any]]:
    """解析 provider 返回的 content 为建议列表；兼容 ```json 包裹。"""
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    data = json.loads(text)
    if isinstance(data, dict):
        data = [data]
    return data


async def analyze(state: AgentState, *, provider, model: str) -> dict:
    """用 provider 生成结构化建议，写入 state['analysis']。

    模型输出解析失败时不抛异常终止图：返回空建议列表，并在 evidence 追加一条
    「模型输出解析失败」错误（回放模式 content 固定不会触发，LiveProvider 接入后需要）。
    """
    evidence = list(state.get("evidence") or [])
    prompt = build_analysis_prompt(evidence)
    resp = await provider.complete(model, prompt)
    try:
        suggestions = _parse_suggestions(resp["content"])
    except (json.JSONDecodeError, TypeError, KeyError, ValueError) as exc:
        logger.warning("revenue analyze 模型输出解析失败：%r", exc)
        return {
            "analysis": [],
            "evidence": evidence + [{
                "source": "agent",
                "tool": "analyze",
                "summary": f"模型输出解析失败：{exc!r}",
                "payload_ref": "analyze:parse-error",
                "payload": None,
            }],
        }
    return {"analysis": suggestions}


def propose(state: AgentState) -> dict:
    """对每条建议生成 proposal，追加到 state['proposals']。"""
    analysis = state.get("analysis") or []
    run_id = state.get("run_id") or "run"
    evidence_refs = [e.get("payload_ref") for e in (state.get("evidence") or [])]

    proposals: list[dict[str, Any]] = []
    for i, s in enumerate(analysis):
        # roomTypeId 缺失时兜底为 'unknown'，避免 idempotency_key 出现 'None' 字样
        room_type_id = s.get("roomTypeId") or "unknown"
        current_price = s.get("currentPrice")
        suggested_price = s.get("suggestedPrice")
        proposals.append({
            "proposal_id": f"{run_id}-proposal-{i}",
            "tool_name": "price-adjust",
            "params": {
                "roomTypeId": room_type_id,
                "nextPrice": suggested_price,
                "reason": s.get("reason"),
            },
            "before": {"price": current_price},
            "after": {"price": suggested_price},
            "reason": s.get("reason"),
            "evidence_refs": list(evidence_refs),
            # 加索引 i 避免同房型多条建议冲突（如分时调价）
            "idempotency_key": f"{run_id}-{room_type_id}-price-adjust-{i}",
        })
    return {"proposals": proposals}


async def request_approval(state: AgentState) -> dict:
    """Task 7 占位：读取 proposals 但不调用 interrupt。

    TODO: Task 9 接入 interrupt({...}) 实现人工审批中断与恢复；
    届时用 checkpointer（MemorySaver / Postgres）持久化，approve 端点恢复执行。
    """
    _ = state.get("proposals")
    return {}
