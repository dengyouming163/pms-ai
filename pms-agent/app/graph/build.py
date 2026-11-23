"""组装 LangGraph 主图：supervisor → 按 route 分派 → revenue 子图 → END。

依赖（provider / tools / model）通过 build_graph 注入，测试可替换为假工具 + 回放 provider。
checkpointer 用 MemorySaver（内存），Task 9 接 interrupt；Task 8/9 再换 Postgres checkpointer。
"""
from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from app.config import settings
from app.graph import revenue, supervisor
from app.providers.replay import ReplayProvider
from app.state import AgentState
from app.tools.client import HttpToolClient


def _bind_async(node_fn, **kwargs):
    """把需要注入依赖的 async 节点包装成仅接收 state 的 async 节点。"""
    async def _wrapped(state: AgentState) -> dict:
        return await node_fn(state, **kwargs)
    return _wrapped


def _route_after_supervisor(state: AgentState) -> str:
    """条件边：按 supervisor 写入的 route 分派到对应节点。"""
    return state.get("route") or "direct"


def synthesize_stub(state: AgentState) -> dict:
    """非 revenue 路由的占位节点（ops/guest/ota/direct 子图在后续任务实现）。"""
    route = state.get("route") or "direct"
    return {"final": f"路由 {route} 的子图将在后续任务实现，当前为占位回复。"}


def build_graph(provider=None, tools=None, model: str | None = None):
    """工厂：构造并编译主图。测试注入假 provider/tools；生产缺省用回放 + HttpToolClient。"""
    provider = provider or ReplayProvider()
    tools = tools or HttpToolClient()
    model = model or settings.llm_model

    workflow = StateGraph(AgentState)

    workflow.add_node("supervisor", supervisor.supervisor_node)
    workflow.add_node("revenue_collect", _bind_async(revenue.collect, tools=tools))
    workflow.add_node("revenue_analyze", _bind_async(revenue.analyze, provider=provider, model=model))
    workflow.add_node("revenue_propose", revenue.propose)
    workflow.add_node("revenue_request_approval", _bind_async(revenue.request_approval))
    workflow.add_node("synthesize", synthesize_stub)

    workflow.set_entry_point("supervisor")

    # supervisor → 按 route 分派
    workflow.add_conditional_edges(
        "supervisor",
        _route_after_supervisor,
        {
            "revenue": "revenue_collect",
            "ops": "synthesize",
            "guest": "synthesize",
            "ota": "synthesize",
            "direct": "synthesize",
        },
    )

    # revenue 子图线性连接 → END
    workflow.add_edge("revenue_collect", "revenue_analyze")
    workflow.add_edge("revenue_analyze", "revenue_propose")
    workflow.add_edge("revenue_propose", "revenue_request_approval")
    workflow.add_edge("revenue_request_approval", END)

    # 其它路由经占位节点 → END
    workflow.add_edge("synthesize", END)

    # 编译：带 MemorySaver checkpointer（Task 9 接 interrupt 所需）
    graph = workflow.compile(checkpointer=MemorySaver())
    return graph


__all__ = ["build_graph"]
