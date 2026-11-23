"""revenue 子图：collect → analyze → propose → request_approval → execute。

- collect: 并发调 4 个只读工具，结果写入 evidence（可注入 tools，测试用假工具）。
- analyze: 用 provider 生成结构化建议；prompt 由 evidence 确定性构造（无随机/时间戳）。
- propose: 每条建议生成一条待审批 proposal，写入 proposals（含执行层必需的 date/expectedCurrentPrice）。
- request_approval: 有提案时 interrupt 挂起等待人审；无提案直通 END。
- execute_approved: 恢复后执行被批准的调价（approve→调 price_adjust；reject→跳过；conflict→标记冲突）。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from langgraph.types import interrupt

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


def _calendar_date(evidence: list[dict[str, Any]]) -> str | None:
    """从 pricing-calendar 证据取目标日期（执行层调价必需，格式 YYYY-MM-DD）。"""
    for item in evidence:
        if item.get("tool") != "pricing-calendar":
            continue
        data = (item.get("payload") or {}).get("data") or {}
        return data.get("date")
    return None


def propose(state: AgentState) -> dict:
    """对每条建议生成 proposal，追加到 state['proposals']。"""
    analysis = state.get("analysis") or []
    run_id = state.get("run_id") or "run"
    evidence = list(state.get("evidence") or [])
    evidence_refs = [e.get("payload_ref") for e in evidence]
    # 执行层（price-adjust）硬校验需要 date 与 expectedCurrentPrice，propose 时补齐
    date = _calendar_date(evidence)

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
                "date": date,
                "expectedCurrentPrice": current_price,
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
    """有提案时 interrupt 挂起等待人审；无提案则直通 END。

    - interrupt payload: {"type":"approval_required","proposal": proposals[0]}，
      ainvoke 返回的 state 会带 "__interrupt__" 键（runs.py 据此标记 awaiting_approval）。
    - 恢复后 interrupt(...) 的返回值即 approve 端点 Command(resume=...) 传入的决策 dict
      （{decision, reason, approval_id}），写入 state["approvals"] 供 execute_approved 消费。
    - 无提案：不 interrupt，返回 {"approvals": []}，让无建议的运行正常结束
      （避免 test_analyze_handles_invalid_model_output 这类无提案运行被无意义挂起）。
    """
    proposals = state.get("proposals") or []
    if not proposals:
        return {"approvals": []}
    decision = interrupt({
        "type": "approval_required",
        "proposal": proposals[0],
    })
    return {"approvals": [decision]}


async def execute_approved(state: AgentState, *, tools) -> dict:
    """执行被批准的调价提案（恢复后由 revenue_execute 节点调用）。

    - 无 approval → 视为无提案，直接 succeeded（不调工具）。
    - decision != "approve" → rejected，绝不调工具。
    - decision == "approve" → 对首条 proposal 调 tools.price_adjust(tenant, proposal, approval_id)：
      · 返回 conflict → execution_status="conflict"（不重试）。
      · 返回 ok → "succeeded"；其它 → "failed"。
      · 任何异常被捕获 → "failed"（不让图崩）。
    """
    approvals = state.get("approvals") or []
    if not approvals:
        return {"execution_status": "succeeded", "final": "无提案，跳过执行"}

    approval = approvals[-1] or {}
    if approval.get("decision") != "approve":
        reason = approval.get("reason") or ""
        return {
            "execution_status": "rejected",
            "final": f"提案已驳回：{reason}",
        }

    proposal = (state.get("proposals") or [{}])[0]
    tenant = state.get("tenant") or {}
    try:
        result = await tools.price_adjust(
            tenant, proposal, approval_id=approval.get("approval_id"),
        )
    except Exception as exc:
        logger.warning("revenue 调价执行失败：%r", exc)
        return {
            "execution_status": "failed",
            "executions": [{
                "status": "failed",
                "proposal_id": proposal.get("proposal_id"),
                "error": repr(exc),
            }],
            "final": f"调价执行失败：{exc!r}",
        }

    if isinstance(result, dict) and (result.get("conflict") or result.get("error") == "price_conflict"):
        status = "conflict"
    elif isinstance(result, dict) and result.get("ok"):
        status = "succeeded"
    else:
        status = "failed"
    return {
        "execution_status": status,
        "executions": [{
            "status": status,
            "proposal_id": proposal.get("proposal_id"),
            "result": result,
        }],
        "final": "调价已执行" if status == "succeeded" else "调价执行未成功",
    }
