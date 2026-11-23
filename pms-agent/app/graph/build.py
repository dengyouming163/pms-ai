"""组装 LangGraph 主图：supervisor → 按 route 分派 → revenue / ops 子图 → END。

依赖（provider / tools / model）通过 build_graph 注入，测试可替换为假工具 + 回放 provider。
checkpointer 默认 MemorySaver（测试用），生产传入 Postgres checkpointer 以支持 interrupt 中断/恢复。
"""
from __future__ import annotations

from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from app.config import settings
from app.graph import guest, ops, ota, revenue, supervisor
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
    """direct 路由的占位节点（子图已覆盖 revenue/ops/guest/ota）。"""
    route = state.get("route") or "direct"
    return {"final": f"路由 {route} 为直接回复，当前由占位节点处理。"}


def build_graph(provider=None, tools=None, model: str | None = None,
                checkpointer: BaseCheckpointSaver | None = None,
                callbacks: list | None = None):
    """工厂：构造并编译主图。测试注入假 provider/tools；生产缺省用回放 + HttpToolClient。

    - checkpointer：默认 MemorySaver（内存）；生产传入 Postgres saver 以支持中断/恢复。
    - callbacks：默认空列表；传入 trace callback 等。
      注意：langgraph 1.2.24 的 compile() 不接受 callbacks 参数，故通过 Runnable.with_config
      挂载（ainvoke 时生效）。callbacks 为空时不包装，行为与原先完全一致。
    """
    provider = provider or ReplayProvider()
    tools = tools or HttpToolClient()
    model = model or settings.llm_model
    checkpointer = checkpointer or MemorySaver()
    callbacks = callbacks or []

    workflow = StateGraph(AgentState)

    workflow.add_node("supervisor", supervisor.supervisor_node)
    workflow.add_node("revenue_collect", _bind_async(revenue.collect, tools=tools))
    workflow.add_node("revenue_analyze", _bind_async(revenue.analyze, provider=provider, model=model))
    workflow.add_node("revenue_propose", revenue.propose)
    workflow.add_node("revenue_request_approval", _bind_async(revenue.request_approval))
    workflow.add_node("revenue_execute", _bind_async(revenue.execute_approved, tools=tools))
    # ops 晨报：四路只读体检 → 确定性规则成文（不调模型）
    workflow.add_node("ops_collect", _bind_async(ops.collect_checks, tools=tools))
    workflow.add_node("ops_report", ops.build_report)
    # guest 住中客服：知识检索 → 确定性作答/转人工（只读，不调模型）
    workflow.add_node("guest_collect", _bind_async(guest.search_knowledge, tools=tools))
    workflow.add_node("guest_answer", guest.answer_guest)
    # ota 渠道体检：四路只读体检 → 确定性规则成文（不调模型、不写数据）
    workflow.add_node("ota_collect", _bind_async(ota.collect_ota, tools=tools))
    workflow.add_node("ota_report", ota.build_report)
    workflow.add_node("synthesize", synthesize_stub)

    workflow.set_entry_point("supervisor")

    # supervisor → 按 route 分派
    workflow.add_conditional_edges(
        "supervisor",
        _route_after_supervisor,
        {
            "revenue": "revenue_collect",
            "ops": "ops_collect",
            "guest": "guest_collect",
            "ota": "ota_collect",
            "direct": "synthesize",
        },
    )

    # revenue 子图线性连接 → END（request_approval 中断挂起，恢复后进 execute 执行）
    workflow.add_edge("revenue_collect", "revenue_analyze")
    workflow.add_edge("revenue_analyze", "revenue_propose")
    workflow.add_edge("revenue_propose", "revenue_request_approval")
    workflow.add_edge("revenue_request_approval", "revenue_execute")
    workflow.add_edge("revenue_execute", END)

    # ops 子图线性连接 → END（只读，无审批/执行）
    workflow.add_edge("ops_collect", "ops_report")
    workflow.add_edge("ops_report", END)

    # guest 子图线性连接 → END（只读，知识库未命中时转人工）
    workflow.add_edge("guest_collect", "guest_answer")
    workflow.add_edge("guest_answer", END)

    # ota 子图线性连接 → END（只读，给出建议动作但不执行）
    workflow.add_edge("ota_collect", "ota_report")
    workflow.add_edge("ota_report", END)

    # 其它路由经占位节点 → END
    workflow.add_edge("synthesize", END)

    # 编译：带 checkpointer（默认 MemorySaver；生产 Postgres saver，interrupt 中断/恢复必需）
    graph = workflow.compile(checkpointer=checkpointer)
    if callbacks:
        # langgraph 1.2.24 compile() 不接受 callbacks，经 with_config 挂载到 ainvoke
        graph = graph.with_config(callbacks=callbacks)
    return graph


__all__ = ["build_graph"]
