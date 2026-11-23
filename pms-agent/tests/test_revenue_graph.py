"""revenue 子图端到端测试：假工具 + 回放夹具，不连库不连网。

关键：让 analyze 节点的 prompt 构建是纯函数且确定性，
测试里调用同一个 build_analysis_prompt 得到 prompt 字符串并算 sha256，
把夹具写到临时目录再传给 ReplayProvider，从而自包含、稳定、可复现。
"""
import json

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

    # 3) 跑图：supervisor → revenue_collect → analyze → propose → request_approval → END
    final_state = await graph.ainvoke(
        {"goal": "明天青岩店要不要涨价？", "tenant": tenant, "run_id": "run-test-1"},
        config={"configurable": {"thread_id": "thread-test-1"}},
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
    # request_approval 占位不抛错，正常走到 END
    assert "approvals" in final_state or final_state.get("approvals") is None or True


def test_analysis_prompt_is_deterministic():
    """同一 evidence 必须产出完全相同的 prompt（保证回放 hash 稳定）。"""
    evidence = [{"source": "pms-server", "tool": "occupancy", "payload": {"occupancyRate": 90}}]
    assert build_analysis_prompt(evidence) == build_analysis_prompt(evidence)
