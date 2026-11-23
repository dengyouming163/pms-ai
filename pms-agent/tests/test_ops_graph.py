"""ops 晨报子图测试：假工具 + 确定性规则，不连库不连网。

覆盖：
- collect_checks 并发四路只读体检（营收/房态/渠道/评价），单路失败不抛异常；
- build_report 纯规则排序（P0 > P1 > 不可用 > P2 > ok）与晨报文本；
- 图级集成：goal 命中 ops 路由，不调用模型、不调用 price_adjust。
"""
import copy

from app.graph.build import build_graph
from app.graph.ops import build_report, collect_checks

TENANT = {"merchant_id": "m1", "store_id": "s1"}

# 假工具返回的固定 JSON（与 pms-server 内部端点信封一致）
FAKE_FINANCE = {
    "ok": True,
    "data": {
        "month": "2026-11",
        "revenue": 128760,
        "adr": 428,
        "revpar": 312,
        "occupancyRate": 72,
        "orderCount": 301,
        "nights": 301,
        "roomCount": 40,
        "daysInMonth": 30,
    },
}
FAKE_OCCUPANCY = {
    "ok": True,
    "data": {
        "occupancyRate": 78,
        "total": 40,
        "occupied": 31,
        "booked": 2,
        "statusCounts": {"dirty": 6, "available": 3, "occupied": 31},
    },
}
FAKE_CHANNEL = {
    "ok": True,
    "data": {
        "orderCount": 20,
        "revenue": 8000,
        "items": [
            {"channel": "携程", "orderCount": 12, "revenue": 5000, "timeoutCount": 2},
            {"channel": "美团", "orderCount": 8, "revenue": 3000, "timeoutCount": 0},
        ],
    },
}
FAKE_REVIEWS = {
    "ok": True,
    "data": {
        "days": 30,
        "from": "2026-10-25",
        "total": 12,
        "avgRating": 4.1,
        "lowRatingCount": 3,
        "pendingReplyCount": 4,
        "items": [
            {"id": "rv1", "channelName": "携程", "rating": 2, "content": "隔音差",
             "reviewTime": "2026-11-20", "replyStatus": "pending"},
        ],
    },
}


class FakeOpsTools:
    """假工具客户端：四路只读体检返回固定 dict，不发网络请求。

    刻意不实现 price_adjust：ops 子图只读，任何写操作调用都会暴露为 AttributeError。
    """

    async def finance_summary(self, tenant, month=None):
        return FAKE_FINANCE

    async def occupancy(self, tenant, date=None):
        return FAKE_OCCUPANCY

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        return FAKE_CHANNEL

    async def reviews_summary(self, tenant, days=30):
        return FAKE_REVIEWS


async def test_collect_checks_covers_four_checks():
    """四路体检全部落 evidence：source/tool 齐全且 payload 非空。"""
    state = await collect_checks({"tenant": TENANT}, tools=FakeOpsTools())
    evidence = state["evidence"]

    assert len(evidence) == 4
    assert {item["tool"] for item in evidence} == {
        "finance-summary", "occupancy", "channel-performance", "reviews-summary",
    }
    assert all(item["source"] == "pms-server" for item in evidence)
    assert all(item["payload"] for item in evidence)
    # 摘要为一句话，供晨报证据行展示
    assert all(item["summary"] for item in evidence)


async def test_build_report_ranks_channel_timeout_first():
    """渠道超时 P0 排第一；低分评价/脏房条目存在；常规检查输出 ok 条目。"""
    evidence = (await collect_checks({"tenant": TENANT}, tools=FakeOpsTools()))["evidence"]
    report = build_report({"evidence": evidence})

    entries = report["ops_report"]
    assert entries[0]["priority"] == "P0"
    assert "超时" in entries[0]["conclusion"]

    conclusions = "\n".join(entry["conclusion"] for entry in entries)
    assert "低分评价" in conclusions
    assert "脏房积压 6 间" in conclusions
    # 财务正常 → 一条 ok 简短条目
    assert any(entry["status"] == "ok" for entry in entries)

    final = report["final"]
    assert "经营晨报" in final
    assert "待处理" in final
    for entry in entries:
        assert entry["conclusion"] in final
        assert entry["action"] in final


async def test_build_report_flags_zero_revenue():
    """营收/RevPAR 为 0 → P2 异常条目，并进入晨报文本。"""
    class ZeroRevenueTools(FakeOpsTools):
        async def finance_summary(self, tenant, month=None):
            data = copy.deepcopy(FAKE_FINANCE)
            data["data"].update({"revenue": 0, "adr": 0, "revpar": 0})
            return data

    evidence = (await collect_checks({"tenant": TENANT}, tools=ZeroRevenueTools()))["evidence"]
    report = build_report({"evidence": evidence})

    entry = next(e for e in report["ops_report"] if "营收为 0" in e["conclusion"])
    assert entry["priority"] == "P2"
    assert "营收为 0" in report["final"]


async def test_build_report_flags_low_adr_under_high_occupancy():
    """入住率 >=85 且 ADR > 0 → P2 信息项（复核定价），排序在 ok 之前。"""
    class HighOccupancyTools(FakeOpsTools):
        async def finance_summary(self, tenant, month=None):
            data = copy.deepcopy(FAKE_FINANCE)
            data["data"].update({"occupancyRate": 90, "adr": 420})
            return data

    evidence = (await collect_checks({"tenant": TENANT}, tools=HighOccupancyTools()))["evidence"]
    entries = build_report({"evidence": evidence})["ops_report"]

    assert any("ADR 偏低" in e["conclusion"] for e in entries)


async def test_collect_checks_survives_reviews_failure():
    """单路（reviews-summary）失败：不抛异常、evidence 仍 4 条、其余结论照常输出。"""
    class FailingReviewsTools(FakeOpsTools):
        async def reviews_summary(self, tenant, days=30):
            raise RuntimeError("模拟 reviews-summary 工具超时")

    state = await collect_checks({"tenant": TENANT}, tools=FailingReviewsTools())
    evidence = state["evidence"]

    assert len(evidence) == 4
    failed = next(item for item in evidence if item["tool"] == "reviews-summary")
    assert failed["payload"] is None
    assert "失败" in failed["summary"]

    report = build_report({"evidence": evidence})
    entries = report["ops_report"]
    unavailable = next(e for e in entries if e["status"] == "unavailable")
    assert unavailable["conclusion"] == "该路数据不可用"

    final = report["final"]
    assert "该路数据不可用" in final
    # 其它三路结论仍在
    assert "超时" in final
    assert "脏房" in final
    assert "营收与定价正常" in final


class StubProvider:
    """ops 子图不调模型：一旦被调用即失败，暴露误接入。"""

    def __init__(self):
        self.calls = 0

    async def complete(self, model, prompt):
        self.calls += 1
        raise AssertionError("ops 子图不应调用模型")


async def test_ops_graph_routes_and_produces_report():
    """图级集成：goal 含「晨报」→ route=ops → final 非空，且未调用模型/price_adjust。"""
    tools = FakeOpsTools()
    assert not hasattr(tools, "price_adjust")
    provider = StubProvider()
    graph = build_graph(provider=provider, tools=tools)

    state = await graph.ainvoke(
        {"goal": "帮我出一份今天的经营晨报", "tenant": TENANT, "run_id": "run-ops"},
        config={"configurable": {"thread_id": "thread-ops"}},
    )

    assert state["route"] == "ops"
    assert state["final"]
    assert state["ops_report"]
    assert provider.calls == 0
