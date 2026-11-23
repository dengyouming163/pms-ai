"""revenue 子图端到端测试：假工具 + 回放夹具，不连库不连网。

关键：让 analyze 节点的 prompt 构建是纯函数且确定性，
测试里调用同一个 build_analysis_prompt 得到 prompt 字符串并算 sha256，
把夹具写到临时目录再传给 ReplayProvider，从而自包含、稳定、可复现。
"""
import copy
import json

from langgraph.types import Command

from app.graph.build import build_graph
from app.graph.revenue import build_analysis_prompt, collect
from app.providers.replay import ReplayProvider, prompt_hash

MODEL = "deepseek-chat"

# 假工具返回的固定 JSON（至少包含一个房型的 currentPrice）
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


class FakeTools:
    """假工具客户端：返回固定 dict，不发任何网络请求。"""

    async def pricing_calendar(self, tenant, date=None, room_type_id=None):
        return FAKE_PRICING

    async def occupancy(self, tenant, date=None):
        return FAKE_OCCUPANCY

    async def competitor_prices(self, tenant, room_type_id=None, date=None):
        return FAKE_COMPETITOR

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        return FAKE_CHANNEL

    async def price_adjust(self, tenant, proposal, approval_id=None):
        return {"ok": True, "data": {}}


async def test_revenue_graph_produces_one_proposal_with_raise(tmp_path):
    tenant = {"merchant_id": "m1", "store_id": "s1"}
    fake_tools = FakeTools()

    # 1) 直接调用 collect 拿到真实 evidence，保证与图内 collect 产出完全一致
    collected = await collect({"tenant": tenant}, tools=fake_tools)
    evidence = collected["evidence"]

    # 2) 用同一个纯函数构造 analyze 的 prompt，算 hash 写夹具（确定性 → hash 稳定）
    prompt = build_analysis_prompt(evidence)
    suggestion = {
        "roomTypeId": "rt_001",
        "currentPrice": 300,
        "suggestedPrice": 380,
        "reason": "入住率高达 92% 且竞品均价 420，存在提价空间",
        "confidence": 0.82,
        "level": "raise",
    }
    fixture_rec = {
        "prompt_hash": prompt_hash(prompt),
        "model": MODEL,
        "content": json.dumps([suggestion], ensure_ascii=False),
        "usage": {"prompt_tokens": 120, "completion_tokens": 60, "total_tokens": 180},
    }
    (tmp_path / "revenue.jsonl").write_text(
        json.dumps(fixture_rec, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    provider = ReplayProvider(fixtures_dir=tmp_path)
    graph = build_graph(provider=provider, tools=fake_tools, model=MODEL)
    config = {"configurable": {"thread_id": "thread-test-1"}}

    # 3) 跑图：有提案 → request_approval 中断挂起；resume approve 让 execute 跑完到 END
    final_state = await graph.ainvoke(
        {"goal": "明天青岩店要不要涨价？", "tenant": tenant, "run_id": "run-test-1"},
        config=config,
    )
    assert "__interrupt__" in final_state  # 有提案 → 挂起等待人审
    final_state = await graph.ainvoke(
        Command(resume={"decision": "approve", "reason": ""}), config=config,
    )

    # 路由正确
    assert final_state["route"] == "revenue"
    # 采集到 4 条证据
    assert len(final_state["evidence"]) == 4
    # 分析出 1 条建议，且 suggestedPrice > currentPrice
    analysis = final_state["analysis"]
    assert len(analysis) == 1
    assert analysis[0]["suggestedPrice"] > analysis[0]["currentPrice"]
    # 生成 1 条 proposal
    proposals = final_state["proposals"]
    assert len(proposals) == 1
    assert proposals[0]["after"]["price"] > proposals[0]["before"]["price"]
    assert proposals[0]["tool_name"] == "price-adjust"
    # 恢复后 approvals 记录决策，execute 执行成功
    assert final_state["approvals"] == [{"decision": "approve", "reason": ""}]
    assert final_state["execution_status"] == "succeeded"


def _write_fixture(tmp_path, prompt: str, content: str, filename: str = "fixture.jsonl"):
    """把给定 content 写到与 prompt hash 匹配的夹具文件，返回 ReplayProvider。"""
    fixture_rec = {
        "prompt_hash": prompt_hash(prompt),
        "model": MODEL,
        "content": content,
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    }
    (tmp_path / filename).write_text(
        json.dumps(fixture_rec, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return ReplayProvider(fixtures_dir=tmp_path)


class FakeToolsWithFailingOccupancy:
    """occupancy 抛异常，其余正常：验证单工具失败不拖垮 revenue 主流程。"""

    async def pricing_calendar(self, tenant, date=None, room_type_id=None):
        return FAKE_PRICING

    async def occupancy(self, tenant, date=None):
        raise RuntimeError("模拟 occupancy 工具超时")

    async def competitor_prices(self, tenant, room_type_id=None, date=None):
        return FAKE_COMPETITOR

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        return FAKE_CHANNEL

    async def price_adjust(self, tenant, proposal, approval_id=None):
        return {"ok": True, "data": {}}


async def test_revenue_graph_survives_single_tool_failure(tmp_path):
    """工具失败路径：图不崩溃、跑完；evidence 含 4 条且失败那条带错误标识；proposals 仍产出。"""
    tenant = {"merchant_id": "m1", "store_id": "s1"}
    fake_tools = FakeToolsWithFailingOccupancy()

    # 用与图内相同的 collect 拿真实 evidence（含失败条目），保证 prompt hash 对齐
    collected = await collect({"tenant": tenant}, tools=fake_tools)
    evidence = collected["evidence"]
    assert len(evidence) == 4

    prompt = build_analysis_prompt(evidence)
    suggestion = {
        "roomTypeId": "rt_001", "currentPrice": 300, "suggestedPrice": 360,
        "reason": "竞品更高且入住数据缺失但仍有提价空间", "confidence": 0.6, "level": "raise",
    }
    provider = _write_fixture(tmp_path, prompt, json.dumps([suggestion], ensure_ascii=False),
                              filename="revenue_fail.jsonl")
    graph = build_graph(provider=provider, tools=fake_tools, model=MODEL)
    config = {"configurable": {"thread_id": "thread-fail"}}

    # 有提案 → 中断挂起；resume approve 让 execute 跑完到 END
    final_state = await graph.ainvoke(
        {"goal": "明天要不要涨价？", "tenant": tenant, "run_id": "run-fail"},
        config=config,
    )
    assert "__interrupt__" in final_state
    final_state = await graph.ainvoke(
        Command(resume={"decision": "approve", "reason": ""}), config=config,
    )

    # 图正常跑完到 END
    assert final_state["route"] == "revenue"
    assert len(final_state["evidence"]) == 4
    # 失败的 occupancy 证据带「失败」标识
    occ = next(e for e in final_state["evidence"] if e["tool"] == "occupancy")
    assert "失败" in occ["summary"]
    assert occ["payload"] is None
    assert occ["payload_ref"].endswith(":error")
    # 主流程未中断：仍产出 proposal
    assert len(final_state["proposals"]) == 1
    assert final_state["proposals"][0]["after"]["price"] > final_state["proposals"][0]["before"]["price"]


async def test_analyze_handles_invalid_model_output(tmp_path):
    """模型输出解析失败：不抛异常终止图，analysis 为空且 evidence 记录解析错误。"""
    tenant = {"merchant_id": "m1", "store_id": "s1"}
    fake_tools = FakeTools()

    collected = await collect({"tenant": tenant}, tools=fake_tools)
    prompt = build_analysis_prompt(collected["evidence"])
    # 故意写一段无法解析为 JSON 的 content
    provider = _write_fixture(tmp_path, prompt, "这不是合法的 JSON", filename="bad_content.jsonl")
    graph = build_graph(provider=provider, tools=fake_tools, model=MODEL)

    final_state = await graph.ainvoke(
        {"goal": "明天要不要涨价？", "tenant": tenant, "run_id": "run-bad"},
        config={"configurable": {"thread_id": "thread-bad"}},
    )

    # 图不崩溃
    assert final_state["route"] == "revenue"
    # 无有效建议 → 无 proposal
    assert final_state["analysis"] == []
    assert final_state["proposals"] == []
    # evidence 中记了一条解析失败错误
    parse_error = next((e for e in final_state["evidence"] if "解析失败" in e.get("summary", "")), None)
    assert parse_error is not None


def test_analysis_prompt_is_deterministic():
    """同一 evidence 必须产出完全相同的 prompt（保证回放 hash 稳定）。"""
    evidence = [{"source": "pms-server", "tool": "occupancy", "payload": {"occupancyRate": 90}}]
    assert build_analysis_prompt(evidence) == build_analysis_prompt(evidence)


def _evidence_with(latency_ms=12, date="2026-11-24", price=300, occupancy_rate=92):
    """构造两份可调字段的 evidence：latency/date 属易变项，price/occupancyRate 属业务数据。"""
    return [
        {
            "source": "pms-server",
            "tool": "pricing-calendar",
            "summary": "1 个房型价格",
            "payload_ref": "pricing-calendar:0",
            "payload": {
                "ok": True,
                "data": {
                    "date": date,
                    "items": [{"roomTypeId": "rt_001", "price": price}],
                },
                "latency_ms": latency_ms,
            },
        },
        {
            "source": "pms-server",
            "tool": "occupancy",
            "summary": f"入住率 {occupancy_rate}%",
            "payload_ref": "occupancy:0",
            "payload": {
                "ok": True,
                "data": {"occupancyRate": occupancy_rate, "total": 10},
                "latency_ms": latency_ms,
            },
        },
    ]


def test_analysis_prompt_ignores_volatile_fields():
    """latency_ms 与 data.date 变化不得影响 prompt（否则回放夹具永远命中不了）。"""
    a = _evidence_with(latency_ms=12, date="2026-11-24")
    b = _evidence_with(latency_ms=987, date="2026-12-31")
    assert build_analysis_prompt(a) == build_analysis_prompt(b)


def test_analysis_prompt_changes_with_business_data():
    """业务数据（价格/入住率）变化必须反映到 prompt，避免过度归一化丢掉有效信息。"""
    a = _evidence_with(price=300, occupancy_rate=92)
    b = _evidence_with(price=360, occupancy_rate=75)
    assert build_analysis_prompt(a) != build_analysis_prompt(b)


async def test_collect_prompt_stable_across_volatile_mutation():
    """端到端回归：collect 出的 evidence 与其 latency/date 被改写后的副本，prompt 完全一致。"""
    collected = await collect({"tenant": {"merchant_id": "m1"}}, tools=FakeTools())
    evidence = collected["evidence"]

    mutated = copy.deepcopy(evidence)
    for item in mutated:
        payload = item.get("payload")
        if isinstance(payload, dict):
            payload["latency_ms"] = 4321
            data = payload.get("data")
            if isinstance(data, dict) and "date" in data:
                data["date"] = "2027-01-01"

    assert build_analysis_prompt(evidence) == build_analysis_prompt(mutated)
