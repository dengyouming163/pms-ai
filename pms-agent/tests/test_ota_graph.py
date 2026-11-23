"""ota 渠道体检子图测试：假工具 + 确定性规则，不连库不连网。

覆盖：
- collect_ota 并发四路只读（竞对价/价格日历/渠道表现/渠道同步状态），单路失败不抛；
- build_report 优先级排序（P0 超时 > P1 同步/售罄 > 不可用 > P2 价差 > ok）；
- 价差正负、售罄、同步超时分别生成对应结论；
- 图级集成：goal 命中 ota 路由，不调用模型、不执行写操作。
"""
import copy

from app.graph.build import build_graph
from app.graph.ota import build_report, collect_ota

TENANT = {"merchant_id": "m1", "store_id": "s1"}

FAKE_COMPETITOR = {
    "ok": True,
    "data": {"date": "2026-11-24", "avgPrice": 470, "count": 4, "items": []},
}
FAKE_CALENDAR = {
    "ok": True,
    "data": {
        "date": "2026-11-24",
        "items": [
            {"roomTypeId": "rt1", "roomTypeName": "栖云大床房", "price": 428, "available": 3},
            {"roomTypeId": "rt2", "roomTypeName": "听雨双床房", "price": 388, "available": 0},
        ],
    },
}
FAKE_CHANNEL = {
    "ok": True,
    "data": {
        "orderCount": 20,
        "revenue": 8000,
        "timeoutCount": 3,
        "items": [
            {"channel": "携程", "orderCount": 12, "revenue": 5000, "timeoutCount": 2},
            {"channel": "美团", "orderCount": 8, "revenue": 3000, "timeoutCount": 1},
        ],
    },
}
FAKE_SYNC = {
    "ok": True,
    "data": {
        "overdueCount": 1,
        "abnormalCount": 0,
        "items": [
            {"channel": "携程", "status": "connected", "autoSync": True,
             "syncInterval": 30, "lastSyncAt": "2026-11-23T08:00:00+08:00",
             "overdue": True, "minutesSinceSync": 120},
        ],
    },
}


class FakeOtaTools:
    """假工具客户端：四路只读体检返回固定 dict，不实现任何写操作。"""

    def __init__(self):
        self.calls: list[str] = []

    async def competitor_prices(self, tenant, room_type_id=None, date=None):
        self.calls.append("competitor-prices")
        return copy.deepcopy(FAKE_COMPETITOR)

    async def pricing_calendar(self, tenant, date=None, room_type_id=None):
        self.calls.append("pricing-calendar")
        return copy.deepcopy(FAKE_CALENDAR)

    async def channel_performance(self, tenant, date_from=None, date_to=None):
        self.calls.append("channel-performance")
        return copy.deepcopy(FAKE_CHANNEL)

    async def channel_status(self, tenant):
        self.calls.append("channel-status")
        return copy.deepcopy(FAKE_SYNC)


async def test_collect_ota_covers_four_checks():
    tools = FakeOtaTools()
    state = await collect_ota({"tenant": TENANT}, tools=tools)

    evidence = state["evidence"]
    assert len(evidence) == 4
    assert {item["tool"] for item in evidence} == {
        "competitor-prices", "pricing-calendar", "channel-performance", "channel-status",
    }
    assert all(item["payload"] for item in evidence)


async def test_build_report_ranks_timeout_first_and_covers_all_checks():
    evidence = (await collect_ota({"tenant": TENANT}, tools=FakeOtaTools()))["evidence"]
    report = build_report({"evidence": evidence})

    entries = report["ota_report"]
    assert entries[0]["priority"] == "P0"
    assert "超时" in entries[0]["conclusion"]

    conclusions = "\n".join(entry["conclusion"] for entry in entries)
    assert "售罄" in conclusions
    assert "提价空间" in conclusions
    assert "同步超时" in conclusions

    final = report["final"]
    assert "渠道体检报告" in final
    for entry in entries:
        assert entry["conclusion"] in final
        assert entry["action"] in final
    assert "未执行任何写操作" in final


async def test_build_report_flags_negative_price_gap():
    class CheapCompetitorTools(FakeOtaTools):
        async def competitor_prices(self, tenant, room_type_id=None, date=None):
            data = copy.deepcopy(FAKE_COMPETITOR)
            data["data"]["avgPrice"] = 300
            return data

    evidence = (await collect_ota({"tenant": TENANT}, tools=CheapCompetitorTools()))["evidence"]
    report = build_report({"evidence": evidence})

    assert any("价格偏高" in entry["conclusion"] for entry in report["ota_report"])


async def test_build_report_survives_sync_failure():
    """同步状态工具失败：仍产出报告，并标注该路数据不可用、无写操作。"""
    class FailingSyncTools(FakeOtaTools):
        async def channel_status(self, tenant):
            raise RuntimeError("模拟 channel-status 工具超时")

    evidence = (await collect_ota({"tenant": TENANT}, tools=FailingSyncTools()))["evidence"]
    report = build_report({"evidence": evidence})

    unavailable = next(e for e in report["ota_report"] if e["status"] == "unavailable")
    assert unavailable["conclusion"] == "渠道同步状态不可用"
    assert "渠道体检报告" in report["final"]
    # 其它三路结论仍在
    assert "超时" in report["final"]
    assert "售罄" in report["final"]


class StubProvider:
    """ota 子图不调模型：一旦被调用即失败。"""

    def __init__(self):
        self.calls = 0

    async def complete(self, model, prompt):
        self.calls += 1
        raise AssertionError("ota 子图不应调用模型")


async def test_ota_graph_routes_and_reports():
    tools = FakeOtaTools()
    assert not hasattr(tools, "price_adjust")
    provider = StubProvider()
    graph = build_graph(provider=provider, tools=tools)

    state = await graph.ainvoke(
        {"goal": "帮我做一次渠道体检，看看价差和超时风险", "tenant": TENANT, "run_id": "run-ota"},
        config={"configurable": {"thread_id": "thread-ota"}},
    )

    assert state["route"] == "ota"
    assert state["final"]
    assert state["ota_report"]
    assert provider.calls == 0
