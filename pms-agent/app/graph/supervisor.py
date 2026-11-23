"""Supervisor：把用户目标路由到对应子图。

当前为确定性关键词路由（M1）；后续可替换为模型路由，但必须保留规则兜底，
避免模型不可用时整条链路不可用。
"""
from app.state import AgentState

# 路由关键词表：顺序即优先级，命中即返回。
# 每条规则：(route, [关键词...])
_ROUTE_RULES: list[tuple[str, list[str]]] = [
    ("revenue", ["涨价", "定价", "房价", "调价"]),
    ("ops", ["晨报", "日报", "异常", "告警", "经营"]),
    ("guest", ["无线", "早餐", "退房", "咨询", "wifi", "WiFi"]),
    ("ota", ["渠道", "携程", "美团", "超时", "飞猪"]),
]


def route_goal(goal: str) -> str:
    """根据目标文本确定性地返回路由名（revenue/ops/guest/ota/direct）。"""
    text = goal or ""
    for route, keywords in _ROUTE_RULES:
        if any(kw in text for kw in keywords):
            return route
    # 兜底：无法分类的闲聊/其它走 direct
    return "direct"


def supervisor_node(state: AgentState) -> dict:
    """LangGraph 节点：把 route 写回 state，供条件边分派。"""
    return {"route": route_goal(state.get("goal", ""))}
