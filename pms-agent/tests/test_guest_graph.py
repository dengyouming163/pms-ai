"""guest 住中客服子图测试：假工具 + 确定性规则，不连库不连网。

覆盖：
- extract_keywords 从住客诉求中抽取知识库检索关键词；
- search_knowledge 命中/未命中/工具失败三种 evidence 形态；
- answer_guest 依据知识库作答，检索为空或失败时明确转人工、不编造；
- 图级集成：goal 命中 guest 路由，不调用模型、不调用写工具。
"""
import copy

from app.graph.build import build_graph
from app.graph.guest import (
    KB_SEARCH,
    TRANSFER_TEXT,
    answer_guest,
    extract_keywords,
    search_knowledge,
)

TENANT = {"merchant_id": "m1", "store_id": "s1"}

FAKE_KB = {
    "ok": True,
    "data": {
        "q": "退房",
        "tokens": ["退房"],
        "count": 1,
        "items": [
            {
                "id": "kb-s1-checkout",
                "title": "退房与延迟退房",
                "content": "标准退房时间 12:00；视房态可免费延迟至 14:00，请提前告知前台。",
                "guideType": "faq",
            }
        ],
    },
}
FAKE_KB_EMPTY = {
    "ok": True,
    "data": {"q": "演唱会", "tokens": ["演唱会"], "count": 0, "items": []},
}


class FakeGuestTools:
    """假工具客户端：kb_search 返回固定 dict，并记录查询串。"""

    def __init__(self, result=None, fail=False):
        self.result = copy.deepcopy(result if result is not None else FAKE_KB)
        self.fail = fail
        self.queries: list[str] = []

    async def kb_search(self, tenant, query):
        self.queries.append(query)
        if self.fail:
            raise RuntimeError("模拟 kb-search 工具超时")
        return copy.deepcopy(self.result)


def test_extract_keywords_hits_domain_terms():
    """中文长句里能抽出「退房」这类领域词，供知识库匹配。"""
    query = extract_keywords("住客询问能否延迟退房到 14 点，怎么回复？")
    assert "退房" in query


def test_extract_keywords_falls_back_to_cleaned_goal():
    """无领域词时回落为去标点的原句，保证仍有可检索内容。"""
    query = extract_keywords("附近演唱会几点结束？")
    assert "演唱会" in query
    assert "？" not in query


async def test_search_knowledge_records_query_and_evidence():
    """检索命中：evidence 记录工具名、命中条数与原始条目。"""
    tools = FakeGuestTools()
    state = await search_knowledge(
        {"goal": "住客询问能否延迟退房到 14 点，怎么回复？", "tenant": TENANT},
        tools=tools,
    )

    assert tools.queries and "退房" in tools.queries[0]
    evidence = state["evidence"]
    assert len(evidence) == 1
    assert evidence[0]["tool"] == KB_SEARCH
    assert evidence[0]["source"] == "pms-server"
    assert len(evidence[0]["payload"]) == 1


async def test_search_knowledge_handles_tool_failure():
    """工具失败：不抛异常，evidence.payload 为 None 并标注失败。"""
    state = await search_knowledge(
        {"goal": "住客咨询 WiFi 密码", "tenant": TENANT},
        tools=FakeGuestTools(fail=True),
    )

    evidence = state["evidence"]
    assert len(evidence) == 1
    assert evidence[0]["payload"] is None
    assert "失败" in evidence[0]["summary"]


async def test_answer_guest_uses_kb_content():
    """命中知识库时用条目原文作答，不引入额外事实。"""
    state = await search_knowledge(
        {"goal": "住客询问能否延迟退房到 14 点，怎么回复？", "tenant": TENANT},
        tools=FakeGuestTools(),
    )
    result = answer_guest(state)

    assert result["guest_transfer"] is False
    assert "退房与延迟退房" in result["final"]
    assert "14:00" in result["final"]
    assert TRANSFER_TEXT not in result["final"]


async def test_answer_guest_transfers_when_kb_empty():
    """知识库无命中：明确回答暂无相关信息并转人工，不编造。"""
    state = await search_knowledge(
        {"goal": "住客咨询附近演唱会信息", "tenant": TENANT},
        tools=FakeGuestTools(result=FAKE_KB_EMPTY),
    )
    result = answer_guest(state)

    assert result["guest_transfer"] is True
    assert result["final"] == TRANSFER_TEXT
    assert "暂无相关信息" in result["final"]


async def test_answer_guest_transfers_when_tool_failed():
    """知识检索失败：转人工并说明知识库暂不可用。"""
    state = await search_knowledge(
        {"goal": "住客咨询 WiFi 密码", "tenant": TENANT},
        tools=FakeGuestTools(fail=True),
    )
    result = answer_guest(state)

    assert result["guest_transfer"] is True
    assert "知识库暂时不可用" in result["final"]
    assert "转人工" in result["final"]


class StubProvider:
    """guest 子图不调模型：一旦被调用即失败，暴露误接入。"""

    def __init__(self):
        self.calls = 0

    async def complete(self, model, prompt):
        self.calls += 1
        raise AssertionError("guest 子图不应调用模型")


async def test_guest_graph_routes_and_answers():
    """图级集成：goal 含「退房」→ route=guest → final 非空且未调用模型。"""
    tools = FakeGuestTools()
    assert not hasattr(tools, "price_adjust")
    provider = StubProvider()
    graph = build_graph(provider=provider, tools=tools)

    state = await graph.ainvoke(
        {"goal": "住客询问能否延迟退房到 14 点，怎么回复？", "tenant": TENANT, "run_id": "run-guest"},
        config={"configurable": {"thread_id": "thread-guest"}},
    )

    assert state["route"] == "guest"
    assert state["final"]
    assert state["guest_transfer"] is False
    assert provider.calls == 0
