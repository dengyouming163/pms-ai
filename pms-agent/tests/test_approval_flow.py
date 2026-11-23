"""人审中断与恢复测试：决策校验 + 中断/恢复流程（内存 checkpointer + 假工具，不连库不联网）。

流程用例复用 test_revenue_graph 的夹具构造法：collect 拿 evidence → build_analysis_prompt
→ 算 hash 写夹具 → ReplayProvider，保证 analyze 命中回放且不连真实模型。
两次 ainvoke 必须用同一个 graph 实例（同一个 MemorySaver）+ 同一个 thread_id config。
"""
import json

import pytest
from langgraph.types import Command

from app.graph.approval import decide
from app.graph.build import build_graph
from app.graph.revenue import build_analysis_prompt, collect
from app.providers.replay import ReplayProvider, prompt_hash

MODEL = "deepseek-chat"

FAKE_PRICING = {
    "ok": True,
    "data": {
        "date": "2026-11-24",
        "items": [
            {"roomTypeId": "rt_001", "roomTypeName": "豪华大床房",
             "price": 300, "basePrice": 280, "available": 2}
        ],
    },
}
FAKE_OCCUPANCY = {"ok": True, "data": {"occupancyRate": 92, "total": 10, "occupied": 8, "booked": 1}}
FAKE_COMPETITOR = {"ok": True, "data": {"avgPrice": 420, "count": 3,
                                         "items": [{"hotelName": "竞品A", "price": 410}]}}
FAKE_CHANNEL = {"ok": True, "data": {"orderCount": 48, "revenue": 14400, "items": []}}


# ====== 决策校验 ======

@pytest.mark.parametrize("decision,reason,ok", [
    ("approve", "", True),
    ("approve", "价格合理", True),
    ("reject", "证据不足", True),
    ("reject", "", False),
    ("maybe", "x", False),
])
def test_decide(decision, reason, ok):
    result = decide(decision, reason)
    assert result["accepted"] is ok
    if not ok:
        assert result["error"]


# ====== 流程测试夹具 ======

class CountingFakeTools:
    """假工具：4 个只读工具返回固定结果；price_adjust 计数（不联网）。"""

    def __init__(self, price_adjust_result: dict | None = None):
        self.price_adjust_calls = 0
        self._price_adjust_result = price_adjust_result or {"ok": True, "data": {}}

    async def pricing_calendar(self, tenant, date=None, room_type_id=None):
        return FAKE_PRICING

    async def occupancy(self, tenant, date=None):
        return FAKE_OCCUPANCY

    async def competitor_prices(self, tenant, room_type_id=None, date=None):
        return FAKE_COMPETITOR

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        return FAKE_CHANNEL

    async def price_adjust(self, tenant, proposal, approval_id=None):
        self.price_adjust_calls += 1
        return self._price_adjust_result


async def _build_interruptible_graph(tmp_path, fake_tools, thread_id, content=None):
    """构造含 1 条提案的图 + 初始 state + config；首次 ainvoke 会在 request_approval 挂起。"""
    tenant = {"merchant_id": "m1", "store_id": "s1"}
    collected = await collect({"tenant": tenant}, tools=fake_tools)
    evidence = collected["evidence"]
    prompt = build_analysis_prompt(evidence)
    suggestion = {
        "roomTypeId": "rt_001", "currentPrice": 300, "suggestedPrice": 380,
        "reason": "入住率高达 92% 且竞品均价 420，存在提价空间",
        "confidence": 0.82, "level": "raise",
    }
    fixture_rec = {
        "prompt_hash": prompt_hash(prompt),
        "model": MODEL,
        "content": content or json.dumps([suggestion], ensure_ascii=False),
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }
    (tmp_path / "approval.jsonl").write_text(
        json.dumps(fixture_rec, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    provider = ReplayProvider(fixtures_dir=tmp_path)
    graph = build_graph(provider=provider, tools=fake_tools, model=MODEL)
    config = {"configurable": {"thread_id": thread_id}}
    state = {"goal": "明天青岩店要不要涨价？", "tenant": tenant, "run_id": "run-approval-1"}
    return graph, config, state


# ====== 流程用例 ======

async def test_approve_executes_once(tmp_path):
    """提案 → 中断 → 批准 → 执行被调用恰好一次。"""
    fake_tools = CountingFakeTools()
    graph, config, state = await _build_interruptible_graph(
        tmp_path, fake_tools, "thread-approve",
    )

    result = await graph.ainvoke(state, config=config)

    # 中断挂起：__interrupt__ 非空，get_state().next 非空，尚未执行工具
    assert result.get("__interrupt__")
    assert graph.get_state(config).next
    assert fake_tools.price_adjust_calls == 0

    final_state = await graph.ainvoke(
        Command(resume={"decision": "approve", "reason": "", "approval_id": "ap-1"}),
        config=config,
    )
    assert fake_tools.price_adjust_calls == 1
    assert final_state["execution_status"] == "succeeded"
    assert final_state["executions"][0]["status"] == "succeeded"


async def test_reject_skips_execution(tmp_path):
    """驳回 → 执行未被调用，execution_status=rejected。"""
    fake_tools = CountingFakeTools()
    graph, config, state = await _build_interruptible_graph(
        tmp_path, fake_tools, "thread-reject",
    )

    result = await graph.ainvoke(state, config=config)
    assert result.get("__interrupt__")

    final_state = await graph.ainvoke(
        Command(resume={"decision": "reject", "reason": "证据不足"}),
        config=config,
    )
    assert fake_tools.price_adjust_calls == 0
    assert final_state["execution_status"] == "rejected"


async def test_conflict_marks_conflict_without_retry(tmp_path):
    """批准但执行层 409：price_adjust 仅调 1 次（不重试），execution_status=conflict。"""
    fake_tools = CountingFakeTools(
        price_adjust_result={"ok": False, "error": "price_conflict", "conflict": True},
    )
    graph, config, state = await _build_interruptible_graph(
        tmp_path, fake_tools, "thread-conflict",
    )

    await graph.ainvoke(state, config=config)
    final_state = await graph.ainvoke(
        Command(resume={"decision": "approve", "reason": ""}),
        config=config,
    )
    assert fake_tools.price_adjust_calls == 1
    assert final_state["execution_status"] == "conflict"


async def test_no_proposal_does_not_interrupt(tmp_path):
    """无提案（模型输出解析失败）：不 interrupt，单次 ainvoke 直接到 END。"""
    fake_tools = CountingFakeTools()
    graph, config, _ = await _build_interruptible_graph(
        tmp_path, fake_tools, "thread-no-proposal", content="这不是合法的 JSON",
    )

    result = await graph.ainvoke(
        {"goal": "明天要不要涨价？", "tenant": {"merchant_id": "m1"}, "run_id": "run-bad"},
        config=config,
    )
    assert "__interrupt__" not in result
    assert result["proposals"] == []
    assert fake_tools.price_adjust_calls == 0
