"""Agent 全局状态（LangGraph StateGraph 的状态 schema）。

字段与 docs/plans 计划保持一致；total=False 表示所有字段可选，
节点只返回需要更新的字段即可。
"""
from typing import Annotated, Any, TypedDict

from langgraph.graph.message import add_messages


class AgentState(TypedDict, total=False):
    # 运行标识
    run_id: str
    # 租户上下文：{ merchant_id, store_id? }
    tenant: dict[str, str]
    # 用户目标（自然语言）
    goal: str
    # 路由结果：revenue / ops / guest / ota / direct
    route: str
    # 对话消息（add_messages 累加 reducer）
    messages: Annotated[list, add_messages]
    # token / 步数预算
    budget: dict[str, int]
    # 工具采集的证据列表：[{ source, tool, summary, payload_ref }]
    evidence: list[dict[str, Any]]
    # 模型分析产出的结构化建议（revenue 子图写入）
    analysis: list[dict[str, Any]]
    # 待审批提案列表：[{ proposal_id, tool_name, params, before, after, ... }]
    proposals: list[dict[str, Any]]
    # 审批记录（恢复时 interrupt 返回的决策 dict：{decision, reason, approval_id}）
    approvals: list[Any]
    # 执行结果：[{ status: succeeded/conflict/failed, proposal_id, result/error }]（execute 节点写入）
    executions: list[dict[str, Any]]
    # 执行状态：succeeded / rejected / conflict / failed（approve 端点据此定 run 终态）
    execution_status: str | None
    # 最终对用户的回复
    final: str | None
