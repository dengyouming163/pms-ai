"""场地网络调研的测试：纯函数（来源编号校验 / 精确去重 / 联系信息抹除）+ 五节流水线编排。

编排那一组（文末 `run_research` / `assemble_report`）**全部用假 search / agent / 持久层**，
不真调 LLM、不花钱、不联网 —— 与 `wenlv_material_assist` 同款的分层。

⚠️ 本仓测试**不位置无关**：必须从 pms-ai-crew/ 跑（所有 import 都是 `from src...`）。
"""
from src.services.venue_research import (
    SOURCE_COUNT_MAX, build_section_query, scrub_contact, split_items_by_source,
    number_sources, dedupe_items, section_query_hint,
    run_research, assemble_report, WATCHDOG_NOTE, resolve_venue,
)


def test_build_section_query_把城市与场地名都带上():
    q = build_section_query("history", "镇山村", "贵阳")
    assert "镇山村" in q and "贵阳" in q


def test_build_section_query_五个节互不相同():
    qs = {s: build_section_query(s, "镇山村", "贵阳") for s in
          ("history", "materials", "points", "people", "context")}
    assert len(set(qs.values())) == 5


def test_number_sources_编号从1起且去重():
    src = [{"title": "a", "site_name": "x", "url": "https://a"},
           {"title": "b", "site_name": "y", "url": "https://b"},
           {"title": "a2", "site_name": "x", "url": "https://a"}]
    numbered, uniq = number_sources(src)
    assert uniq == [{"title": "a", "site_name": "x", "url": "https://a"},
                    {"title": "b", "site_name": "y", "url": "https://b"}]
    assert numbered.startswith("1. ") and "2. " in numbered
    assert "https://a" not in numbered.split("\n")[1]      # 去重后 2 号不是 a


def test_split_items_by_source_无来源的条目一律进待核实_不丢弃():
    """设计文档 §6.3 第 1 条：无来源的内容**只能进 verify**（「只能」是排他的，全文无丢弃条款）。

    `inferred` 标没标**不影响去留** —— 它只决定措辞来源。丢掉未标注的条目是
    **静默的信息损失**：业务人员根本不知道曾经查到过这条。
    """
    items = [
        {"title": "有来源", "content": "c", "sources": [1]},
        {"title": "标了推断", "content": "c", "sources": [], "inferred": True},
        {"title": "没标推断", "content": "c", "sources": []},
        {"title": "sources 键都没有", "content": "c"},
    ]
    kept, verify, unrenderable = split_items_by_source(items, source_count=2)
    assert [i["title"] for i in kept] == ["有来源"]
    assert [i["title"] for i in verify] == ["标了推断", "没标推断", "sources 键都没有"]
    assert all(i["note"] == "AI 推断，无来源" for i in verify)
    assert unrenderable == []


def test_split_items_by_source_非对象条目进第三桶_它不是被丢弃的内容():
    """第三个返回值只收**结构上无法展示**的条目（不是 dict ⇒ 连标题都取不出）。

    与上面那条是一对：它证的是「有内容但无来源」**不会**落进这里。
    """
    kept, verify, unrenderable = split_items_by_source(["不是对象", 42], source_count=2)
    assert kept == [] and verify == []
    assert len(unrenderable) == 2


def test_split_items_by_source_越界编号被剔除条目降级为推断():
    items = [{"title": "越界", "content": "c", "sources": [3]}]
    kept, verify, dropped = split_items_by_source(items, source_count=2)
    assert kept == [] and dropped == []
    assert verify[0]["title"] == "越界"
    assert verify[0]["note"] == "AI 推断，无来源"


def test_split_items_by_source_混编_部分越界仍可保留():
    items = [{"title": "半越界", "content": "c", "sources": [1, 9]}]
    kept, verify, _ = split_items_by_source(items, source_count=2)
    assert [i["title"] for i in kept] == ["半越界"]
    assert kept[0]["sources"] == [1]


def test_split_items_by_source_来源数上限_超出的丢弃():
    items = [{"title": "t", "content": "c", "sources": list(range(1, SOURCE_COUNT_MAX + 3))}]
    kept, _, _ = split_items_by_source(items, source_count=SOURCE_COUNT_MAX + 5)
    assert len(kept[0]["sources"]) == SOURCE_COUNT_MAX


def test_scrub_contact_手机号被抹除():
    assert "13800138000" not in scrub_contact("联系人电话 13800138000。")


def test_scrub_contact_不误伤年份与门牌():
    s = "该村 1985 年建，门牌 12 号。"
    assert scrub_contact(s) == s


def test_dedupe_items_按标题精确相等去重_保留先出现的():
    """标题**逐字相同** ⇒ 合并，留先出现的（后一条的内容整条不再出现）。"""
    items = [{"title": "古井", "content": "a", "sources": [1]},
             {"title": "古井", "content": "b", "sources": [2]}]
    out = dedupe_items(items)
    assert [i["content"] for i in out] == ["a"]


def test_dedupe_items_不做模糊匹配_只差一个空格就不合并():
    """「古井」与「古井 」是**不同**的标题（宁可不合并，不可错合）。

    ⚠️ 本条与上一条**必须分开写**：原先它们被合并成一个用例，夹具里放了
    两个逐字相同的「古井」却又断言三条全部保留 —— 那个断言与「按精确相等去重」
    自相矛盾（等于要求函数什么都不做）。分开后两条各自只证一件事。
    """
    items = [{"title": "古井", "content": "a", "sources": [1]},
             {"title": "古井 ", "content": "c", "sources": [3]}]
    out = dedupe_items(items)
    assert [i["content"] for i in out] == ["a", "c"]


def test_section_query_hint_给手填地名时用它():
    assert section_query_hint("石头寨") == "石头寨"
    assert section_query_hint("   ") == ""


# ═══════════════════════════════════════════════════════════════════════════
# Task 7：五节流水线编排 + 逐节累积回写
# ═══════════════════════════════════════════════════════════════════════════


class FakePersister:
    """记录每次回写。**逐节回写**是设计取舍 A ⇒ 这里断言的是「调用了几次、带了什么」。"""

    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on or []

    def save_research(self, research_id, **fields):
        self.calls.append({"research_id": research_id, **fields})
        if fields.get("status") in self.fail_on:
            raise RuntimeError("回写失败（模拟）")
        return {"ok": True}


def _fake_search(ok=True, sources=None, answer="答案", truncated=False):
    def _s(query):
        if not ok:
            return {"ok": False, "answer": "", "sources": [], "truncated": truncated,
                    "error": "检索失败"}
        return {"ok": True, "answer": answer, "truncated": truncated,
                "sources": sources if sources is not None else [
                    {"title": "t1", "site_name": "s1", "url": "https://a"},
                    {"title": "t2", "site_name": "s2", "url": "https://b"},
                ], "error": ""}
    return _s


def _fake_agent(items_by_section):
    def _a(section, desc, **kw):
        return {"items": items_by_section.get(section, []),
                "not_found": not items_by_section.get(section), "note": f"{section} note"}
    return _a


def test_run_research_逐节回写_五节各写一次():
    p = FakePersister()
    items = {"history": [{"title": "沿革", "content": "c", "sources": [1]}]}
    out = run_research(
        research_id="r1", venue_name="镇山村", city="贵阳", anchor={"name": "镇山村"},
        search_fn=_fake_search(), agent_fn=_fake_agent(items), persist_fn=p.save_research,
    )
    # 5 次 running 回写 + 1 次终态回写
    assert [c.get("status") for c in p.calls] == ["running"] * 5 + ["ready"]
    assert out["status"] == "ready"
    done = {s for c in p.calls for s, v in (c.get("progress") or {}).items() if v == "done"}
    assert done == {"history", "materials", "points", "people", "context"}


def test_run_research_回写的是累积快照_后面几次包含前面的节():
    p = FakePersister()
    items = {"history": [{"title": "沿革", "content": "c", "sources": [1]}],
             "context": [{"title": "现状", "content": "c", "sources": [1]}]}
    run_research(research_id="r1", venue_name="镇山村", city="贵阳", anchor={"name": "镇山村"},
                 search_fn=_fake_search(), agent_fn=_fake_agent(items), persist_fn=p.save_research)
    last_running = [c for c in p.calls if c.get("status") == "running"][-1]
    assert "history" in last_running["report"] and "context" in last_running["report"]


def test_run_research_单节检索失败不传染其余节():
    calls = {"n": 0}
    def flaky(q):
        calls["n"] += 1
        if calls["n"] == 2:                      # 第 2 节（materials）失败
            return {"ok": False, "answer": "", "sources": [], "truncated": False,
                    "error": "检索超时，未取到内容"}
        return _fake_search()(q)
    p = FakePersister()
    out = run_research(research_id="r1", venue_name="镇山村", city="贵阳", anchor={"name": "镇山村"},
                       search_fn=flaky, agent_fn=_fake_agent({}), persist_fn=p.save_research)
    # ⚠️ 必须用 `.get`：**第一条**台账行（history 完成后那次回写）的 progress 里
    # 还没有 materials 键 —— 直接下标会在第一行就 KeyError，那是**读台账读错了**，
    # 不是流水线的问题（原稿就是这样红掉的）。
    prog = [c["progress"].get("materials") for c in p.calls if "progress" in c]
    assert "failed" in prog          # 失败在**中途**就写进去了，不是攒到终态才写
    assert out["status"] == "partial"            # 部分成功，不是 failed
    assert out["progress"]["history"] == "done"


def test_run_research_全部节失败才是_failed():
    p = FakePersister()
    out = run_research(research_id="r1", venue_name="镇山村", city="贵阳", anchor={"name": "镇山村"},
                       search_fn=_fake_search(ok=False), agent_fn=_fake_agent({}),
                       persist_fn=p.save_research)
    assert out["status"] == "failed"
    assert p.calls[-1]["status"] == "failed"
    assert p.calls[-1]["error"]                       # 终态必须带一句人话原因


def test_run_research_终态回写在持久层抛错时也不吞异常_交给调用方():
    """终态写不上 ⇒ 那行会永远 running（靠看门狗放行重跑）。**不许假装成功**。"""
    class Boom(FakePersister):
        def save_research(self, research_id, **fields):
            if fields.get("status") in ("ready", "partial", "failed"):
                raise RuntimeError("终态回写失败")
            return super().save_research(research_id, **fields)
    try:
        run_research(research_id="r1", venue_name="镇山村", city="贵阳", anchor={},
                     search_fn=_fake_search(), agent_fn=_fake_agent({}), persist_fn=Boom().save_research)
        assert False, "应当抛出"
    except RuntimeError:
        pass


def test_run_research_截断的节其条目进待核实_并记进search_log():
    """检索被 10 秒预算截断 ⇒ 该节条目**同时**留在正文与待核实里，且 search_log 记 True。

    🔴 本条的来历（判别力）：`SearchCultureInfo._run` 原先**根本不返回** `truncated`
    这个键 ⇒ `search_log[].truncated` 恒 false、报告分类 ③ 是**死代码**，而当时
    所有测试照样全绿 —— 因为夹具喂的键名是对的，值却永远是 `None`。
    所以本条的假 search **必须真的带 `truncated: True`**，否则它测不出任何东西。
    """
    p = FakePersister()
    items = {"history": [{"title": "半份资料", "content": "c", "sources": [1, 2]}]}
    out = run_research(research_id="r1", venue_name="镇山村", city="贵阳", anchor={},
                       search_fn=_fake_search(truncated=True), agent_fn=_fake_agent(items),
                       persist_fn=p.save_research)
    # ① 截断 ≠ 失败：条目**仍在正文里**，不整节作废
    assert out["report"]["history"]["items"][0]["title"] == "半份资料"
    # ② 同一条也进 verify，并写明是**被截断**（≠「无来源」「单一来源」）
    notes = [i["note"] for i in out["report"]["verify"]["items"] if i["title"] == "半份资料"]
    assert any("截断" in n for n in notes), notes
    # ③ search_log 如实记录 —— 这正是设计文档要求的那一列（§2 决策 9）
    assert all(e["truncated"] for e in p.calls[-1]["search_log"])


def test_assemble_report_无来源条目进_verify_带推断标注():
    section_reports = {
        # ⚠️ 这条**必须挂两个来源**（本节的来源列表也确实是两条）：只挂 1 条的话它自己也会
        # 进 verify（类别②「单一来源」），于是「verify 里只有无来源那条」这个断言会因为
        # **另一个正确的**分类而失败 —— 夹具没隔离被测因，测到的就不是名字说的那件事。
        "history": {"items": [{"title": "有来源", "content": "c", "sources": [1, 2]}],
                    "sources": [{"title": "t1", "site_name": "s1", "url": "https://a"},
                                {"title": "t2", "site_name": "s2", "url": "https://b"}],
                    "note": "", "not_found": False},
        "points": {"items": [{"title": "推断的点", "content": "c", "sources": [], "inferred": True}],
                   "sources": [], "note": "", "not_found": False},
    }
    rep, verify_items = assemble_report(section_reports)
    assert rep["history"]["items"][0]["title"] == "有来源"
    assert [i["title"] for i in verify_items] == ["推断的点"]
    assert verify_items[0]["note"] == "AI 推断，无来源"


def test_assemble_report_单一来源进_verify_多来源不进():
    """单一来源 ⇒ 进待核实（一个来源能立论，但不足以定论）；两个来源 ⇒ 不进。

    两个方向都断言：只测「孤立来源进了」的话，一个「把全部条目都塞进 verify」的
    实现也会绿（同族：否定观察要配独立对照）。
    """
    section_reports = {
        "history": {"items": [{"title": "孤立来源", "content": "c", "sources": [1]},
                              {"title": "双来源", "content": "c", "sources": [1, 2]}],
                    "sources": [{"title": "t1", "site_name": "s1", "url": "https://a"},
                                {"title": "t2", "site_name": "s2", "url": "https://b"}],
                    "note": "", "not_found": False},
    }
    rep, verify_items = assemble_report(section_reports)
    titles = [i["title"] for i in verify_items]
    assert "孤立来源" in titles
    assert "双来源" not in titles
    # 双来源那条**仍在正文里**（进 verify 不是「移出正文」）
    assert [i["title"] for i in rep["history"]["items"]] == ["孤立来源", "双来源"]
    singles = [i for i in verify_items if i["title"] == "孤立来源"][0]
    assert "单一来源" in singles["note"]


def test_watchdog_note_钉住跨服务的那份副本():
    """15 分钟是**跨服务的两份副本**（这里一份、pms-server 的 RESEARCH_STALE_MS 一份）。

    🔴 钉它的理由：这两份若漂开，症状是「看门狗放行了重跑，而 ai-crew 这边还在
    自检的阈值上」—— 两边都不报错，只是行为不一致，没人会想到是这里。
    改这里必须同时改 pms-server 那份（见 `decideResearchStart`）。
    """
    assert WATCHDOG_NOTE == 15 * 60


# ─────────────────────── 消歧（resolve_venue）───────────────────────


def test_resolve_venue_检索失败时返回空候选而不是抛():
    """公网查不到是**正当结果**，不是异常 —— 抛出去会让 API 层把它记成
    「搜索服务故障」，把两类完全不同的东西混成一个分类码。"""
    out = resolve_venue(venue_name="镇山村", city="贵阳",
                        search_fn=_fake_search(ok=False),
                        agent_fn=lambda *a, **k: {"candidates": [{"name": "x"}]})
    assert out["candidates"] == []
    assert out["search_log"][0]["error"]          # 失败原因必须留在日志里（否则无从排查）
    assert out["search_log"][0]["section"] == "resolve"
    assert out["reason"] == "search_failed"


def test_resolve_venue_四态分类码各归各的():
    """🔴 四个分类码**必须分开**（`""` / `search_failed` / `agent_failed` / `no_candidate`）。

    把 `agent_failed` 混进 `no_candidate`，界面就会对业务人员说「公网查不到这个场地」——
    那是一句**我们没有依据的断言**：检索明明成功了，是模型没能产出候选。
    这两件事的处置完全不同（前者换地名，后者重试），混成一个码就再也分不开了。
    """
    def boom(*a, **k):
        raise RuntimeError("坏 JSON")

    agent_failed = resolve_venue(venue_name="镇山村", search_fn=_fake_search(), agent_fn=boom)
    assert agent_failed["reason"] == "agent_failed"
    assert agent_failed["search_log"][0]["error"] == ""   # 检索是成功的，别记成检索失败

    no_cand = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                            agent_fn=lambda *a, **k: {"candidates": []})
    assert no_cand["reason"] == "no_candidate"

    ok = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                       agent_fn=lambda *a, **k: {"candidates": [{"name": "x"}]})
    assert ok["reason"] == ""


def test_resolve_venue_置信度非法值归一为_low():
    """模型给别的词（"很高"/"HIGH"/漏写）时落成 low —— 宁可让界面提示「不确定」，
    也不要让非法枚举值流到前端（前端按枚举渲染时会把非法值显示成空白）。"""
    out = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                        agent_fn=lambda *a, **k: {"candidates": [{"name": "x", "confidence": "很高"}]})
    assert out["candidates"][0]["confidence"] == "low"


def test_resolve_venue_漏写置信度也归一为_low():
    """`ResearchCandidate.confidence` 默认空串 ⇒ 归一这一步**对漏写也生效**。
    这条与上一条分开写，因为两者的来源不同：一个是模型给了怪值，一个是没给。"""
    out = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                        agent_fn=lambda *a, **k: {"candidates": [{"name": "x"}]})
    assert out["candidates"][0]["confidence"] == "low"


def test_resolve_venue_成文抛错时返回空候选而不是抛():
    """消歧这一步的失败面比检索多一个（LLM 坏 JSON 重试后仍失败 ⇒ `_run_agent` 抛
    StageFailedError）。它同样必须落成空候选 + reason，不能冒到 API 层。"""
    def boom(*a, **k):
        raise RuntimeError("JSON 校验重试后仍失败")

    out = resolve_venue(venue_name="镇山村", search_fn=_fake_search(), agent_fn=boom)
    assert out["candidates"] == []
    assert out["search_log"][0]["error"] == ""    # 检索本身是成功的，日志别记成检索失败


def test_resolve_venue_非对象候选被剔除():
    """模型把 candidates 写成 `["镇山村"]` 这种字符串数组时，别让字符串流到
    前端（前端读 `c.name` 得到 undefined，渲染成空白行，谁也不报错）。"""
    out = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                        agent_fn=lambda *a, **k: {"candidates": ["镇山村", {"name": "真候选"}]})
    assert [c["name"] for c in out["candidates"]] == ["真候选"]


def test_resolve_venue_只留字符串类型的_source_urls():
    """同族：`source_urls` 里混进 None/数字时，前端 `href` 会渲染成 "null"。"""
    out = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                        agent_fn=lambda *a, **k: {"candidates": [
                            {"name": "x", "source_urls": ["https://a", None, 42, "https://b"]}]})
    assert out["candidates"][0]["source_urls"] == ["https://a", "https://b"]


def test_resolve_venue_手填地名取代场地名():
    """「都不是」那条逃生口：hint 非空时用它检索，**不**再用 venue_name 组词。
    两者的取舍与 `build_section_query` 同一口径（用户比我们知道得更准）。"""
    seen = {}
    resolve_venue(venue_name="石桥村", city="贵阳", hint="花溪区石板镇镇山村",
                  search_fn=lambda q: (seen.update(q=q) or _fake_search()(q)),
                  agent_fn=lambda *a, **k: {"candidates": []})
    assert "花溪区石板镇镇山村" in seen["q"]
    assert "石桥村" not in seen["q"]          # 认错对象是这一步唯一要防的事


def test_resolve_venue_题面带编号与真实_URL():
    """🔴 题面**必须带 URL**。消歧的输出契约是 `source_urls`（真实链接），而共享的
    `number_sources` 只产出「编号 标题（站点）」—— 没有 URL 时模型只剩两条路：
    瞎编一个（违反它自己的铁律 3「不许自己拼 URL」）或给空数组。
    这条用例是执行时补的：原计划让这一步直接复用 `number_sources`，那条路径下
    `source_urls` 永远是空的，而**没有任何测试会发现**。"""
    seen = {}
    resolve_venue(venue_name="镇山村", search_fn=_fake_search(answer="资料正文"),
                  agent_fn=lambda q, desc, **k: (seen.update(desc=desc) or {"candidates": []}))
    assert "1." in seen["desc"]
    assert "https://a" in seen["desc"] and "https://b" in seen["desc"]
    assert "资料正文" in seen["desc"]         # 正文必须进题面，否则模型无据可依


def test_resolve_venue_编造的_source_url_被剔除():
    """题面把 URL 给了模型，而转抄长 URL 是会错的（少一个字符就是一个不存在的页面，
    而它在界面上长得跟真的一样）。按本次检索结果**取交集** ⇒ 编 URL 结构上不可能。"""
    out = resolve_venue(venue_name="镇山村", search_fn=_fake_search(),
                        agent_fn=lambda *a, **k: {"candidates": [
                            {"name": "x", "source_urls": ["https://a", "https://编的.example"]}]})
    assert out["candidates"][0]["source_urls"] == ["https://a"]
