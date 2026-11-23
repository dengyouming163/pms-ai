"""guest 住中客服子图：检索知识库 → 回答或转人工（只读，无写操作）。

- search_knowledge: 从住客诉求中抽取关键词，调用 pms-server 的 kb-search（知识检索）。
- answer_guest: 只用命中的知识库原文作答；未命中或检索失败时明确转人工，禁止编造。

两条节点都是确定性的，不调用模型：住客答复必须可追溯到知识库条目，
这是「不编造」在实现层的保证（与 spec §7.3 的证据可追溯要求一致）。
"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.state import AgentState

logger = logging.getLogger(__name__)

# 与 pms-server 内部端点同名
KB_SEARCH = "kb-search"

# 知识库未命中时的固定话术（用例与演示都以此断言，不允许模型自由发挥）
TRANSFER_TEXT = "暂无相关信息，已为您转人工，请稍候。"
# 检索链路本身不可用（超时/报错）时的固定话术
UNAVAILABLE_TEXT = "知识库暂时不可用，已为您转人工，请稍候。"

# 垂直领域关键词表：中文诉求没有空格，先把领域词抽出来再交给服务端做 OR 匹配。
# 顺序即输出顺序；「延迟退房」放在「退房」前，保证更具体的词先被保留。
_GUEST_KEYWORDS = [
    "wifi", "无线", "网络", "密码",
    "早餐", "延迟退房", "退房", "入住",
    "宠物", "停车", "车位", "押金",
    "接送", "发票", "加床", "儿童", "景点", "交通",
]


def extract_keywords(goal: str) -> str:
    """把住客诉求转成知识库检索串（纯函数，便于测试）。

    优先返回命中的领域词（空格分隔，去重保序）；一个都没命中时回落为
    去掉常见标点后的原句，避免把整句话直接当关键词造成零命中。
    """
    text = (goal or "").lower()
    hits: list[str] = []
    for keyword in _GUEST_KEYWORDS:
        if keyword in text and keyword not in hits:
            hits.append(keyword)
    if hits:
        return " ".join(hits)
    return re.sub(r"[，。？！,.?!；;：:\s]+", " ", text).strip()


async def search_knowledge(state: AgentState, *, tools) -> dict:
    """节点：检索知识库，结果写入 evidence。

    evidence.payload 语义：
    - list：检索成功（可能为空列表 = 未命中）；
    - None：检索链路失败，answer_guest 据此走「知识库暂不可用」话术。
    """
    goal = state.get("goal") or ""
    tenant = state.get("tenant") or {}
    query = extract_keywords(goal)
    try:
        result = await tools.kb_search(tenant, query)
    except Exception as exc:  # noqa: BLE001 - 单次检索失败不拖垮运行，转人工兜底
        logger.warning("kb-search 调用失败: %r", exc)
        return {"evidence": [{
            "source": "pms-server",
            "tool": KB_SEARCH,
            "summary": f"知识检索失败：{exc!r}",
            "payload_ref": f"{KB_SEARCH}:error",
            "payload": None,
        }]}

    ok = isinstance(result, dict) and result.get("ok", False)
    data = (result or {}).get("data") if isinstance(result, dict) else None
    items = (data or {}).get("items") if isinstance(data, dict) else None
    if not ok or not isinstance(items, list):
        return {"evidence": [{
            "source": "pms-server",
            "tool": KB_SEARCH,
            "summary": "知识检索失败：返回结构非法",
            "payload_ref": f"{KB_SEARCH}:error",
            "payload": None,
        }]}

    summary = f"知识库命中 {len(items)} 条" if items else "知识库未命中"
    return {"evidence": [{
        "source": "pms-server",
        "tool": KB_SEARCH,
        "summary": summary,
        "payload_ref": f"{KB_SEARCH}:0",
        "payload": items,
    }]}


def _kb_evidence(state: AgentState) -> dict[str, Any] | None:
    for item in state.get("evidence") or []:
        if item.get("tool") == KB_SEARCH:
            return item
    return None


def answer_guest(state: AgentState) -> dict:
    """节点：依据知识库条目作答；无命中/失败时转人工（纯规则，不调模型）。"""
    evidence = _kb_evidence(state)
    if evidence is None or evidence.get("payload") is None:
        return {"final": UNAVAILABLE_TEXT, "guest_transfer": True}

    items = evidence.get("payload") or []
    if not items:
        return {"final": TRANSFER_TEXT, "guest_transfer": True}

    lines = ["根据知识库为您解答："]
    for item in items[:3]:
        title = str(item.get("title") or "").strip()
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        lines.append(f"- {title}：{content}" if title else f"- {content}")
    # 条目全为空内容时仍不编造，直接转人工
    if len(lines) == 1:
        return {"final": TRANSFER_TEXT, "guest_transfer": True}
    lines.append("如仍需帮助，请联系前台。")
    return {"final": "\n".join(lines), "guest_transfer": False}


__all__ = [
    "KB_SEARCH", "TRANSFER_TEXT", "UNAVAILABLE_TEXT",
    "extract_keywords", "search_knowledge", "answer_guest",
]
