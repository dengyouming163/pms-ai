"""Orchestrator 测试：校验重试熔断 + 状态机（mock agent 产出，不真实调 LLM）。"""
import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator, StageFailedError


def test_integrity_fail_retries_then_fails():
    """校验不过 → 重试 2 次 → 仍失败抛 StageFailedError（不静默入库）。"""
    class FakeOrch(WenlvCreationOrchestrator):
        def _run_agent(self, agent, task_desc, expected, schema_cls, retries=1):
            # 关卡 agent 恒产出缺失引用（校验必不过）
            return {"nodes": [{"id": "NODE_1", "node_type": "scene", "title": "x",
                               "grant_collectibles": ["CLUE_MISSING"]}],
                    "collectibles": [], "endings": [], "tiers": [], "rewards": []}
        def _validate(self, draft):
            return ["effects.grant 引用不存在的线索 CLUE_MISSING"]

    orch = FakeOrch()
    try:
        orch._run_level_design_with_retry("P1", {})
        assert False, "应抛 StageFailedError"
    except StageFailedError:
        pass


class _FakeRedis:
    """最小 redis 替身：只为断言状态机，不连真库。"""

    def __init__(self):
        self.store = {}

    def get(self, k):
        return self.store.get(k)

    def set(self, k, v):
        self.store[k] = v

    def expire(self, k, ttl):
        pass


def test_run_draft_unexpected_exception_marks_failed():
    """非 StageFailedError（LLM 网络异常等）也必须置 FAILED。

    修复前：异常直接冒泡穿越 run_draft，经 asyncio.to_thread 到 create_task 后被
    静默丢弃 —— 状态永停 DRAFTING，前端只能靠看门狗超时，且不留任何错误信息。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())

    def boom(*a, **k):
        raise RuntimeError("模型调用超时")

    orch._run_agent = boom
    res = orch.run_draft("P1", "武侠主题")

    assert res["status"] == "FAILED"
    assert "模型调用超时" in res["error"]
    assert orch._get_state("P1")["status"] == "FAILED"


def test_run_draft_persist_failure_marks_failed():
    """P3：落库失败现在发生在 apply_draft（run_draft 不再直接落库）。

    apply_draft 调 persist_draft 失败时必须返回 FAILED，不能静默成功。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())

    class _BoomPersister:
        def persist_draft(self, *a, **k):
            raise RuntimeError("pms-server 502 Bad Gateway")
        def bootstrap_style_bible(self, *a, **k):
            return {}
        def enqueue_assets(self, *a, **k):
            return {}

    orch.persister = _BoomPersister()
    # 预置一份 DRAFT_READY 草稿到 state
    orch._set_state("P2", "DRAFT_READY", {
        "positioning": {"mode": "narrative"}, "level": {}, "visual": {},
        "script": {}, "npcs": {}, "theme": "武侠主题", "site_material": None,
    })
    res = orch.apply_draft("P2")

    assert res["status"] == "FAILED"
    assert "502" in res["error"]


def test_run_refine_refuses_when_base_missing():
    """精修基线**两处都**缺失时必须拒绝，绝不能基于空草稿凭空重生成。

    T11 起 level/visual 的基线是「库优先、state 兜底」；本用例把**两个来源都显式桩成空**
    —— 库里没有（404）+ Redis 状态为空 —— 而不是靠「真的去连 localhost:9090 连不上」这种偶然。
    基线为空时 agent 会「从零生成」，而前端 applyLevel 是「删光旧子资源再按精修结果重建」，
    于是用户点一次「应用精修」就静默丢掉全部内容。宁可报错也不能静默替换。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())  # 空状态 → output={}
    orch.persister = _StubPersister(full=None)            # 库里也没有（404）

    def _must_not_run(*a, **k):
        raise AssertionError("基线缺失时不应调用 LLM")

    orch._run_agent = _must_not_run
    res = orch.run_refine("P1", "level", "把第一个场景改成夜景")

    assert res["status"] == "ERROR"
    assert "基线" in res["error"]


# =====================================================================================
# T11：run_refine 改取 DB 权威基线（判据 2/3/4/6）
# =====================================================================================

class _StubPersister:
    """精修基线读库替身：返回固定 /full 响应或抛异常，**绝不真连网**。"""

    def __init__(self, full=None, exc=None):
        self.full = full
        self.exc = exc
        self.calls = []

    def get_product_full(self, product_id):
        self.calls.append(product_id)
        if self.exc is not None:
            raise self.exc
        return self.full


def _db_node(nid="NODE_DB_1", unlock=None):
    return {
        "id": nid, "nodeType": "scene", "title": "库里的节点", "storyText": "库里的剧情",
        "triggerType": "manual", "triggerCredential": None,
        "location": "库里的地名", "displayLocation": "展示投影地名",
        "unlockCondition": unlock,
        "effects": {"grant": ["CLUE_DB_1"], "complete": [nid]}, "interactions": [],
    }


def _full(*, nodes=None, theme=None, config=None, characters=None):
    return {"id": "P1", "name": "测试产品", "theme": theme or {}, "nodes": nodes or [],
            "config": config or {}, "characters": characters or [],
            "collectibles": [], "endings": [], "rewards": [], "tiers": []}


def _capture_agent(seen, ret=None):
    """替换 _run_agent：记录喂给 agent 的 task_desc（基线就在里面），返回固定精修结果。"""
    def _run(agent, task_desc, expected, schema_cls, retries=2):
        seen["desc"] = task_desc
        return ret if ret is not None else {"nodes": [], "collectibles": [], "endings": [],
                                            "tiers": [], "rewards": []}
    return _run


def test_run_refine_uses_db_baseline_when_state_expired():
    """判据 3 的主要收益路径：**库里有而 state 已过期 ⇒ 用 DB 建基线，精修成功**。

    这正是本 Task 要关掉的那个洞 —— 状态 30d TTL 过期后，老路只会回「基线缺失」拒答，
    而库里明明有内容。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())   # 空 state = 模拟 TTL 过期
    orch.persister = _StubPersister(full=_full(nodes=[_db_node()]))
    seen = {}
    orch._run_agent = _capture_agent(seen)

    res = orch.run_refine("P1", "level", "把第一个场景改成夜景")

    assert res["status"] == "DRAFT_READY"
    assert "NODE_DB_1" in seen["desc"]          # 基线来自库
    assert "unlock_collected" in seen["desc"]   # 且是 AI 产出形状（snake_case）
    assert orch.persister.calls == ["P1"]


def test_run_refine_uses_state_when_db_has_no_product():
    """判据 3 的另一叉：**state 有草稿但库里没有（404）⇒ 用 state，不报错**。"""
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"level": {"nodes": [{"id": "NODE_STATE_ONLY", "node_type": "scene"}]}})
    orch.persister = _StubPersister(full=None)
    seen = {}
    orch._run_agent = _capture_agent(seen)

    res = orch.run_refine("P1", "level", "改成夜景")

    assert res["status"] == "DRAFT_READY"
    assert "NODE_STATE_ONLY" in seen["desc"]
    assert "NODE_DB_1" not in seen["desc"]


def test_run_refine_refuses_when_db_and_state_both_missing():
    """判据 3 的第三态：库与 state **都**取不到 ⇒ 仍返回 ERROR（守卫语义不变）。"""
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch.persister = _StubPersister(full=_full())   # 产品在库中，但五个子资源全空
    orch._run_agent = _capture_agent({})

    res = orch.run_refine("P1", "level", "改成夜景")

    assert res["status"] == "ERROR"
    assert "基线" in res["error"]


def test_run_refine_visual_baseline_from_db_theme():
    """判据 4：visual 薄基线含 colors.primary 与 template_id，取值来自 theme。"""
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())   # state 过期
    orch.persister = _StubPersister(full=_full(
        theme={"primaryColor": "#C8102E", "templateId": "tpl-guochao", "logo": "x"}))
    seen = {}
    orch._run_agent = _capture_agent(seen, ret={"colors": {"primary": "#C8102E"}, "template_id": "tpl-guochao"})

    res = orch.run_refine("P1", "visual", "主色调成青绿")

    assert res["status"] == "DRAFT_READY"
    assert '"primary": "#C8102E"' in seen["desc"]
    assert '"template_id": "tpl-guochao"' in seen["desc"]


def test_run_refine_db_read_failure_falls_back_to_state(caplog):
    """读库失败（网络/5xx）⇒ 回落 state，且与「库里没有」在**日志上可区分**。"""
    import logging
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY", {"level": {"nodes": [{"id": "NODE_STATE_ONLY"}]}})
    orch.persister = _StubPersister(exc=RuntimeError("pms-server 502 Bad Gateway"))
    seen = {}
    orch._run_agent = _capture_agent(seen)

    with caplog.at_level(logging.WARNING, logger="src.crews.wenlv_creation_crew"):
        res = orch.run_refine("P1", "level", "改成夜景")

    assert res["status"] == "DRAFT_READY"
    assert "NODE_STATE_ONLY" in seen["desc"]           # 回落到 state
    assert any("读库失败" in r.message for r in caplog.records)


@pytest.mark.parametrize("bad_cond,why", [
    ({"type": "any", "conditions": [{"type": "ref", "ref": {"kind": "collected", "id": "C1"}}]},
     "编辑器「任一」"),
    ({"type": "nofM", "n": 1, "of": [{"type": "ref", "ref": {"kind": "collected", "id": "C1"}}]},
     "编辑器「N 选 M」"),
    ({"type": "ref", "ref": {"kind": "collected", "id": "C1"}}, "裸 ref"),
    ({"type": "all", "conditions": [{"type": "ref", "ref": {"kind": "visited", "id": "N1"}}]},
     "visited"),
])
def test_run_refine_falls_back_to_state_on_unrecognized_db_condition(bad_cond, why, caplog):
    """判据 6：库里有内容、但条件形状认不出 ⇒ **不抛、不 500**，回落到 state。

    这是「新增功能不许变成老功能倒退」的唯一防线：
    今天 run_refine 只读 state，压根不碰这些形状；若改成抛，
    用户在**自己用编辑器配过「任一 / N 选 M / 到访」的节点**上会直接从「能用」变成 500。
    """
    import logging
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"level": {"nodes": [{"id": "NODE_STATE_ONLY", "node_type": "scene"}]}})
    orch.persister = _StubPersister(full=_full(nodes=[_db_node(unlock=bad_cond)]))
    seen = {}
    orch._run_agent = _capture_agent(seen)

    with caplog.at_level(logging.INFO, logger="src.services.wenlv_persist"):
        res = orch.run_refine("P1", "level", "改成夜景")   # 关键是「不抛」

    assert res["status"] == "DRAFT_READY", why
    assert "NODE_STATE_ONLY" in seen["desc"], why       # 回落**用了** state
    assert "NODE_DB_1" not in seen["desc"], why
    assert any("形状" in r.message for r in caplog.records), why   # 且不是静默回落


def test_run_refine_unrecognized_db_condition_still_refuses_when_state_empty():
    """回落不是绕过守卫：库里形状认不出 + state 也空 ⇒ 仍然 ERROR。"""
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch.persister = _StubPersister(full=_full(nodes=[_db_node(
        unlock={"type": "any", "conditions": []})]))
    orch._run_agent = _capture_agent({})

    res = orch.run_refine("P1", "level", "改成夜景")

    assert res["status"] == "ERROR"
    assert "基线" in res["error"]


@pytest.mark.parametrize("stage,key", [
    ("world", "world"), ("storyline", "storyline"),
    ("chapters", "chapters"), ("endings", "endings"), ("location", "location"),
])
def test_run_refine_script_stages_never_touch_db(stage, key):
    """§2/§5.4：界面不开放精修入口的那 5 个 stage **一行不改**，仍只从 state 取（characters 已改库优先，见下面两条用例）。"""
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY", {"script": {key: {"MARK": "STATE_SCRIPT"}}})
    persister = _StubPersister(full=_full())
    orch.persister = persister
    seen = {}
    orch._run_agent = _capture_agent(seen, ret={"MARK": "REFINED"})

    res = orch.run_refine("P1", stage, "改一改")

    assert res["status"] == "DRAFT_READY"
    assert "STATE_SCRIPT" in seen["desc"]
    assert persister.calls == []      # 一次都没读库


def test_run_refine_characters_takes_db_baseline_not_state():
    """T12：characters 是**唯一**与 level/visual 的 None 约定相反的 stage ——
    产品存在即有基线（空表 = 存量剧本的有效起始态），故**库优先、永不回落 state**。

    承重断言是 `persister.calls == ["P1"]` 与 `"STATE_SCRIPT" not in desc`：
    把 crew 里 `elif stage == "characters"` 那一支删掉、落回 `elif stage in dict(SCRIPT_STEPS)`
    （= T12 之前的旧行为）时，两条当场红。那个洞的后果不是「少一个功能」而是
    **构造上不可用**：存量剧本的 state 早已过 30 天 TTL，走 state 支必然命中
    「精修基线缺失」守卫（`if not base`）⇒「给还没有角色的剧本一键生成」永远拒答。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"script": {"characters": {"MARK": "STATE_SCRIPT"}}})   # state 里有陈旧草稿
    persister = _StubPersister(full=_full(
        config={"world_setting": {"era": "北宋"}},
        characters=[{"id": "CHAR_DB_1", "name": "库里的角色", "role": "主角",
                     "ipPrompt": "水墨风少女"}]))
    orch.persister = persister
    seen = {}
    orch._run_agent = _capture_agent(seen, ret={"characters": []})

    res = orch.run_refine("P1", "characters", "加一个反派")

    assert res["status"] == "DRAFT_READY"
    assert persister.calls == ["P1"]           # 库优先：真读了库
    assert "STATE_SCRIPT" not in seen["desc"]  # 且**没用** state 里那份陈旧草稿
    assert "CHAR_DB_1" in seen["desc"]         # 表里已有的角色进了基线
    assert '"world_setting"' in seen["desc"]   # 剧本上下文（config 快照）也在，供 LLM 判该为谁设计
    assert '"ip_prompt": "水墨风少女"' in seen["desc"]   # 已人工产出的文生图 prompt 也进基线（否则 AI 每次重跑都重画）


def test_run_refine_characters_empty_table_is_valid_baseline():
    """T12 的另一半契约：**空表就是有效基线**，不许拒答。

    与 level/visual 刻意不同：那两个库里没内容就返回 None ⇒ 回落 state ⇒ 命中 `if not base`
    守卫拒答。若本 stage 也走 None 约定，「给还没有角色的剧本一键生成」在存量剧本上
    （state 已过 TTL）永远返回 ERROR —— 而那恰是本功能的主要用途。
    注意这里的基线是**非空 dict**（含 characters + 5 个上下文键），所以它绕过守卫靠的是
    「dict 有键」而不是「表里有角色」。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())   # state 空 = 模拟 TTL 过期
    orch.persister = _StubPersister(full=_full())          # 产品在库，但表里一个角色都没有
    seen = {}
    orch._run_agent = _capture_agent(seen, ret={"characters": []})

    res = orch.run_refine("P1", "characters", "生成一套角色")

    assert res["status"] == "DRAFT_READY"        # 不拒答
    assert orch.persister.calls == ["P1"]        # 而且是读了库，不是回落 state 蹭到的
    assert '"characters": []' in seen["desc"]    # 基线就是空表


def test_run_refine_characters_never_falls_back_to_state_on_404():
    """T12 的第三条契约：**characters 不回落 state** —— 产品 404 时拒答，不拿 state 草稿顶。

    与 level/visual 刻意相反：那两个 404 时回落 state 继续跑（见
    test_run_refine_uses_state_when_db_has_no_product）；characters 的建库函数虽也可能拿到 None，
    但契约是「库优先、永不回落」—— 存量剧本的 state 早已过期，回落进去只是把「库里查不到」
    伪装成「有一份草稿」，然后 agent 基于陈旧内容重生成一遍。

    ⚠️ 本用例**不是** `_refine_baseline` 里那段 `if stage == "characters"` 分支的判据 ——
    经变异实测：把那段分支整块拆掉，本用例**仍通过**。原因是那条 `out.get("characters")` 兜底
    对 characters **结构上取不到东西**（剧本草稿在 `out["script"]["characters"]`，
    见 run_refine 的写回分支），故它是死代码、拆不拆都等价。本用例守的是**另一条**：
    将来任何人把 characters 接到一个**活的** state 兜底上，这里必须变红。
    真正的泄漏路径是 `elif stage in dict(SCRIPT_STEPS)` 那一支，由
    test_run_refine_script_stages_never_touch_db 守着。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"script": {"characters": {"MARK": "STATE_SCRIPT"}}})
    orch.persister = _StubPersister(full=None)          # 库里没有（404）
    seen = {}
    orch._run_agent = _capture_agent(seen, ret={"characters": []})

    res = orch.run_refine("P1", "characters", "加一个反派")

    assert res["status"] == "ERROR"          # 拒答，不是静默用 state 跑完
    assert "基线" in res["error"]
    assert seen == {}                        # agent 根本没被调用（state 草稿没进 prompt）


def test_run_refine_level_baseline_end_to_end_over_stubbed_http(monkeypatch):
    """判据 2 的端到端形态：**只桩 httpx、不桩 persister**。

    `_StubPersister` 那些用例桩掉了 persister，于是「crew ↔ persister 的接缝」
    （方法名/签名/返回语义/404 与异常的分工）全在盲区里 —— 那条接缝恰恰是本次改动新增的。
    """
    payload = {"success": True, "data": _full(nodes=[_db_node()])}

    class FakeResp:
        status_code = 200

        def json(self):
            return payload

        def raise_for_status(self):
            pass

    class FakeClient:
        def __init__(self, *a, **k):
            self.kw = k

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, **k):
            assert url == "/api/admin/wenlv/products/P1/full"
            return FakeResp()

        def post(self, *a, **k):
            raise AssertionError("精修不应写库")

    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", FakeClient)

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())   # 空 state：只有库能提供基线
    seen = {}
    orch._run_agent = _capture_agent(seen)
    res = orch.run_refine("P1", "level", "把第一个场景改成夜景")

    assert res["status"] == "DRAFT_READY"
    assert "NODE_DB_1" in seen["desc"]
    assert '"unlock_collected": ["CLUE_DB_1"]' not in seen["desc"]   # 该节点无条件，别谎报
    assert '"grant_collectibles": ["CLUE_DB_1"]' in seen["desc"]
    assert "库里的地名" in seen["desc"]
    assert "展示投影地名" not in seen["desc"]   # 只取原始列，不取 displayLocation


def test_run_refine_level_end_to_end_over_404_http(monkeypatch):
    """同上但走 404：整条链路上「库里没有」必须表现为**回落**，不是异常。"""
    import httpx as _httpx

    class FakeResp:
        status_code = 404

        def json(self):
            return {"success": False, "error": "内容产品不存在"}

        def raise_for_status(self):
            raise _httpx.HTTPStatusError("HTTP 404", request=_httpx.Request("GET", "http://t"),
                                         response=self)

    class FakeClient:
        def __init__(self, *a, **k): pass

        def __enter__(self): return self

        def __exit__(self, *a): return False

        def get(self, url, **k): return FakeResp()

    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", FakeClient)

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"level": {"nodes": [{"id": "NODE_STATE_ONLY", "node_type": "scene"}]}})
    seen = {}
    orch._run_agent = _capture_agent(seen)

    res = orch.run_refine("P1", "level", "改成夜景")

    assert res["status"] == "DRAFT_READY"
    assert "NODE_STATE_ONLY" in seen["desc"]


def test_build_draft_shape():
    """组装草稿：positioning + level + visual + config。"""
    orch = WenlvCreationOrchestrator()
    draft = orch._build_draft(
        {"mode": "narrative", "world_tone": "武侠", "style_tag": "guochao"},
        {"nodes": [], "collectibles": [], "endings": [], "tiers": [], "rewards": []},
        {"colors": {"primary": "#C8102E"}},
    )
    assert draft["product"]["mode"] == "narrative"
    assert draft["product"]["name"]  # name 从 world_tone 派生


def test_level_design_retries_exactly_twice():
    """外层「带错误清单重跑」= 1 次首发 + 2 次重跑，共 3 次。"""
    calls = {"n": 0}
    class FakeOrch(WenlvCreationOrchestrator):
        def _run_agent(self, agent, task_desc, expected, schema_cls, retries=1):
            calls["n"] += 1
            return {"nodes": [{"id": "NODE_1", "node_type": "scene", "title": "x",
                               "grant_collectibles": ["CLUE_MISSING"]}],
                    "collectibles": [], "endings": [], "tiers": [], "rewards": []}
        def _validate(self, draft):
            return ["effects.grant 引用不存在的线索 CLUE_MISSING"]

    orch = FakeOrch()
    with pytest.raises(StageFailedError):
        orch._run_level_design_with_retry("P1", {})
    assert calls["n"] == 3   # 判别力：range(2)→range(0) 时为 1，红


def test_single_stage_retries_exactly_twice(monkeypatch):
    """单阶段路径（项目定位/剧本 6 步/视觉设计/精修）也是 1 次首发 + 2 次重跑。

    修复前 `_run_agent` 只重试 1 次（2 次 kickoff），低于模块 docstring 的自述契约。
    """
    import src.crews.wenlv_creation_crew as m

    calls = {"n": 0}
    class _FakeCrew:
        def __init__(self, **kw): pass
        def kickoff(self):
            calls["n"] += 1
            return SimpleNamespace(raw="这不是 JSON")   # 恒校验失败

    monkeypatch.setattr(m, "Crew", _FakeCrew)
    orch = m.WenlvCreationOrchestrator(redis=_FakeRedis())
    with pytest.raises(m.StageFailedError):
        # 用真实 agent 实例（派给 Task 的 agent 字段要过 pydantic 校验，裸 object() 会在
        # Task 构造处 AttributeError；这里只替换 Crew，故不会真调 LLM）。
        orch._run_agent(m.level_designer_agent, "desc", "expected JSON", m.LevelDesign)

    assert calls["n"] == 3   # 修复前为 2，红


# =====================================================================================
# T24：S3 npc_voice stage（TTS 合成 + 重试 + 哈希缓存 + 并发限 5）
# 不真调火山 API：替身 TtsVolcanoAdapter 由 monkeypatch 注入。
# =====================================================================================

class _FakeTtsAdapter:
    """TTS 适配器替身：按脚本返回 (audio_bytes, duration)，记录调用次数与参数。

    · scripts: {(text, voice_id): (audio_bytes, duration)}；命中即返回，未命中返回默认。
    · fail_words: set[text] —— 对应文本每次调用恒抛 TtsError（模拟限流/密钥失效）。
    """

    def __init__(self, scripts=None, fail_words=None, default_audio=(b"\x49\x44\x33", 3)):
        self.scripts = scripts or {}
        self.fail_words = fail_words or set()
        self.default_audio = default_audio
        self.calls = []  # [(text, voice_id), ...]

    def synthesize(self, text, voice_id):
        self.calls.append((text, voice_id))
        if text in self.fail_words:
            from src.services.tts_volcano import TtsError
            raise TtsError(f"合成失败：{text}")
        return self.scripts.get((text, voice_id), self.default_audio)


def _npc_state(npc_id="NPC_1", voice_id="male_young", lines=None):
    """构造 S1 写入 Redis state 的 NPC 产出形状（snake_case，lines 无 voiceUrl）。"""
    return {"npcs": [{
        "id": npc_id, "voice_id": voice_id,
        "lines": lines or [{"id": "L1", "text": "你好"}, {"id": "L2", "text": "再见"}],
    }]}


def test_npc_voice_synthesizes_all_lines_from_state(monkeypatch):
    """S3 基线来自 state（S1 产出，无 voiceUrl）→ 全量合成，返回 audio_base64 + duration。

    判据：voiceUrl 留空（AI crew 不上传 OSS，留给 admin 路由），audio_base64 非空，
    每条 line 都调了一次 TTS（无缓存命中）。
    """
    fake = _FakeTtsAdapter(scripts={
        ("你好", "male_young"): (b"\x49\x44\x33", 2),
        ("再见", "male_young"): (b"\x49\x44\x33", 1),
    })
    monkeypatch.setattr("src.services.tts_volcano.TtsVolcanoAdapter", lambda: fake)

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY", {"npcs": _npc_state()["npcs"]})
    orch.persister = _StubPersister(full=None)   # 库里没有 → 回落 state

    res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "DRAFT_READY"
    assert len(res["npcs"]) == 1
    lines = res["npcs"][0]["lines"]
    assert len(lines) == 2
    assert lines[0]["line_id"] == "L1"
    assert lines[0]["duration"] == 2
    assert lines[0]["audio_base64"]            # 非空（base64 编码的音频字节）
    assert lines[0]["voiceUrl"] == ""           # AI crew 不上传，留给 admin 路由
    assert lines[0]["skipped"] is False
    assert lines[0]["error"] is None
    assert lines[0]["voice_hash"]              # 哈希非空
    assert len(fake.calls) == 2                # 全量合成，无缓存命中


def test_npc_voice_cache_hit_skips_synth(monkeypatch):
    """表内已有 voiceUrl ⇒ (text + voice_id) 视为未变 ⇒ 跳过合成（spec §7.5 一级缓存）。

    判据：skipped=True、voiceUrl 保留既有值、audio_base64 为空、TTS 一次都没调。
    这是「点了一次「AI 生成旁白」但所有 line 都没改过 text」的命中路径 ——
    不该重跑 TTS 白烧配额。
    """
    fake = _FakeTtsAdapter()
    monkeypatch.setattr("src.services.tts_volcano.TtsVolcanoAdapter", lambda: fake)

    full = {"id": "P1", "npcs": [{
        "id": "NPC_1", "voiceId": "male_young",
        "lines": [{"id": "L1", "text": "你好", "voiceUrl": "https://assets/old.mp3", "duration": 2}],
    }]}
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch.persister = _StubPersister(full=full)

    res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "DRAFT_READY"
    line = res["npcs"][0]["lines"][0]
    assert line["skipped"] is True
    assert line["voiceUrl"] == "https://assets/old.mp3"   # 保留既有 URL
    assert line["duration"] == 2
    assert line["audio_base64"] == ""                     # 未合成
    assert fake.calls == []                                # 一次都没调 TTS


def test_npc_voice_failure_does_not_block_other_lines(monkeypatch):
    """单句失败 → 该 line voiceUrl 留空 + error 填充；其他 line 正常合成（spec §7.6）。

    判据：失败 line 的 error 非空、voiceUrl 空；同批其他 line 的 audio_base64 非空、error None。
    这是「不阻塞其他 line」的承重断言 —— 6 NPC × 8 line 的批里一句崩了不该拖垮全批。
    """
    fake = _FakeTtsAdapter(fail_words={"崩溃句"})
    monkeypatch.setattr("src.services.tts_volcano.TtsVolcanoAdapter", lambda: fake)

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY", {"npcs": _npc_state(lines=[
        {"id": "L1", "text": "正常句"},
        {"id": "L2", "text": "崩溃句"},
        {"id": "L3", "text": "另一句"},
    ])["npcs"]})
    orch.persister = _StubPersister(full=None)

    res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "DRAFT_READY"
    lines = {l["line_id"]: l for l in res["npcs"][0]["lines"]}
    assert lines["L1"]["error"] is None
    assert lines["L1"]["audio_base64"]                # 成功
    assert lines["L2"]["error"]                       # 失败
    assert lines["L2"]["voiceUrl"] == ""
    assert lines["L2"]["audio_base64"] == ""
    assert lines["L3"]["error"] is None               # 其他 line 不受影响
    assert lines["L3"]["audio_base64"]


def test_npc_voice_retries_then_succeeds(monkeypatch):
    """重试 3 次（1s/2s/4s 退避）：前 2 次失败、第 3 次成功 → 最终返回音频。

    判据：最终 error=None、duration 正确、synthesize 被调 3 次（首发 + 2 次重试）、
    sleep 被调 2 次（第 3 次成功后不再 sleep）。退避序列 = [1, 2]（第 3 次成功，4s 不触发）。
    """
    sleep_calls = []
    monkeypatch.setattr("time.sleep", lambda s: sleep_calls.append(s))

    state = {"n": 0}

    class _RetryThenSucceed:
        def synthesize(self, text, voice_id):
            state["n"] += 1
            if state["n"] < 3:
                from src.services.tts_volcano import TtsError
                raise TtsError("偶发限流")
            return (b"audio", 5)

    monkeypatch.setattr("src.services.tts_volcano.TtsVolcanoAdapter", lambda: _RetryThenSucceed())

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"npcs": _npc_state(lines=[{"id": "L1", "text": "重试句"}])["npcs"]})
    orch.persister = _StubPersister(full=None)

    res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "DRAFT_READY"
    line = res["npcs"][0]["lines"][0]
    assert line["error"] is None
    assert line["duration"] == 5
    assert state["n"] == 3          # 首发 + 2 次重试 = 3 次调用
    assert sleep_calls == [1, 2]    # 第 3 次成功，4s 不触发


def test_npc_voice_retries_exhausted_then_fails(monkeypatch):
    """重试 3 次仍失败 → 该 line 标记 error，voiceUrl 留空（spec §7.6 仍失败）。

    判据：error 非空、synthesize 被调 4 次（首发 + 3 次重试）、sleep = [1, 2, 4]。
    """
    sleep_calls = []
    monkeypatch.setattr("time.sleep", lambda s: sleep_calls.append(s))

    class _AlwaysFail:
        def __init__(self): self.calls = 0
        def synthesize(self, text, voice_id):
            self.calls += 1
            from src.services.tts_volcano import TtsError
            raise TtsError("密钥失效")

    failer = _AlwaysFail()
    monkeypatch.setattr("src.services.tts_volcano.TtsVolcanoAdapter", lambda: failer)

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY",
                    {"npcs": _npc_state(lines=[{"id": "L1", "text": "必失败"}])["npcs"]})
    orch.persister = _StubPersister(full=None)

    res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "DRAFT_READY"   # stage 不整体失败（spec §7.6：该 line 留空）
    line = res["npcs"][0]["lines"][0]
    assert line["error"]
    assert line["voiceUrl"] == ""
    assert failer.calls == 4         # 首发 + 3 次重试 = 4 次
    assert sleep_calls == [1, 2, 4]  # 退避序列完整触发


def test_npc_voice_no_baseline_returns_error():
    """库与 state 都没 NPC → 返回 ERROR（不能凭空合成）。

    与 level/visual 的「基线缺失」守卫同款语义：宁可报错也不凭空跑。
    """
    orch = WenlvCreationOrchestrator(redis=_FakeRedis())   # 空 state
    orch.persister = _StubPersister(full=None)             # 库里也没有

    res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "ERROR"
    assert "基线" in res["error"]


def test_npc_voice_db_read_failure_falls_back_to_state(monkeypatch, caplog):
    """读库失败（5xx）⇒ 回落 state，且与「库里没有」在日志上可区分（同 _refine_baseline 语义）。"""
    import logging
    fake = _FakeTtsAdapter()
    monkeypatch.setattr("src.services.tts_volcano.TtsVolcanoAdapter", lambda: fake)

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch._set_state("P1", "DRAFT_READY", {"npcs": _npc_state()["npcs"]})
    orch.persister = _StubPersister(exc=RuntimeError("pms-server 502 Bad Gateway"))

    with caplog.at_level(logging.WARNING, logger="src.crews.wenlv_creation_crew"):
        res = orch.run_refine("P1", "npc_voice", "")

    assert res["status"] == "DRAFT_READY"
    assert len(fake.calls) == 2                       # 回落 state，全量合成
    assert any("读库失败" in r.message for r in caplog.records)


def test_run_refine_dispatch_chain_covers_every_stage():
    """dispatch 的 stage→(schema_cls, agent) 接线必须**逐 stage 完整且一一对应**。

    事故记录（2026-09-29，本仓）：一次「按行号施加」的编辑脚本在同一份文件上插了 6 行，
    推漂了它后面那处编辑的锚点，把 `elif stage == "npc_setting":` **整行换成了注释**。
    后果：npc_setting 落到 `else: 未知精修环节`（创作台「AI 生成全套 NPC」100% 失败），
    且 visual 分支的 schema/agent 被 NPC 的覆盖。**当时全套 328 passed、同文件 34 passed** ——
    测试结构性看不见它：`_capture_agent` 丢掉 agent/schema_cls，`tests/` 下 `grep npc_setting` 零命中。
    ⇒ 本用例不看行为、直接按**结构**钉住这条 elif 链（与「该 stage 在库里有没有内容」无关）。
    """
    crew_py = Path(__file__).resolve().parents[1] / "src" / "crews" / "wenlv_creation_crew.py"
    tree = ast.parse(crew_py.read_text(encoding="utf-8"))
    run_refine = next(n for n in ast.walk(tree)
                      if isinstance(n, ast.FunctionDef) and n.name == "run_refine")

    def _branch_key(node):
        """`stage == "<字面量>"` → 该字面量；其余形状（`stage in ...` / `not base`）→ None。"""
        t = node.test
        if not isinstance(t, ast.Compare):
            return None
        if not (isinstance(t.left, ast.Name) and t.left.id == "stage"):
            return None
        if len(t.comparators) != 1 or not isinstance(t.comparators[0], ast.Constant):
            return None
        return t.comparators[0].value

    def _assigned(body, target):
        """该分支体里对 target 的赋值表达式（源码形式）；没有则 None。"""
        for stmt in body:
            if (isinstance(stmt, ast.Assign) and isinstance(stmt.targets[0], ast.Name)
                    and stmt.targets[0].id == target):
                return ast.unparse(stmt.value)
        return None

    chain = {}
    for node in ast.walk(run_refine):
        if not isinstance(node, ast.If):
            continue
        key = _branch_key(node)
        if key is None:
            continue
        schema = _assigned(node.body, "schema_cls")
        if schema is None:          # 不是 dispatch 分支（如 npc_voice 那条 return）
            continue
        chain[key] = (schema, _assigned(node.body, "agent"))

    # 核心 4 个 stage 的 schema/agent 必须正确（其余 stage 亦须覆盖，不做全量等值断言以避免每次新增 stage 都改测试）
    actual = {k: v[0] for k, v in chain.items()}
    assert actual["level"] == "LevelDesign"
    assert actual["visual"] == "VisualDesign"
    assert actual["npc_setting"] == "WenlvNpcs"
    assert actual["characters"] == "Characters"
    # 新增 stage 必须出现（防回归：删了分支这里会挂）
    assert actual["skeleton_generate"] == "WenlvPlotSkeleton"
    assert chain["level"][1] == "level_designer_agent"
    assert chain["visual"][1] == "visual_designer_agent"
    assert chain["npc_setting"][1] == "npc_designer_agent"
    assert chain["characters"][1].startswith("SCRIPT_AGENTS[")


def test_run_refine_npc_setting_reaches_the_npc_agent():
    """行为面：`stage="npc_setting"` 真落到 NPC agent + `WenlvNpcs`。

    为什么结构判据不够（**实测，不是推测**）：把该分支体里的
    `base = self._refine_baseline(project_id, stage, out)` 删掉、行头/schema_cls/agent 全留，
    则 `test_run_refine_dispatch_chain_covers_every_stage` 连同整份文件**全绿**（35 passed），
    而真实调用抛 `UnboundLocalError: cannot access local variable 'base'`。
    ⇒ 本用例**真跑一次**；夹具让 `full["npcs"]` 非空，以便通过 `if not base` 守卫。
    """
    from src.agents.wenlv_creation import npc_designer_agent   # 就地导入：不动文件头，零行漂移
    from src.schemas.wenlv_creation import WenlvNpcs

    seen = {}

    def _run(agent, task_desc, expected, schema_cls, retries=2):
        seen["agent"] = agent
        seen["schema"] = schema_cls
        seen["desc"] = task_desc
        return {"npcs": []}

    orch = WenlvCreationOrchestrator(redis=_FakeRedis())
    orch.persister = _StubPersister(full={
        "id": "P1",
        "npcs": [{"id": "NPC_DB_1", "name": "库里的NPC", "role": "npc", "lines": []}],
    })
    orch._run_agent = _run

    res = orch.run_refine("P1", "npc_setting", "")

    assert res["status"] == "DRAFT_READY", res.get("error")
    assert seen["agent"] is npc_designer_agent
    assert seen["schema"] is WenlvNpcs
    assert "NPC_DB_1" in seen["desc"]      # 基线确实来自库（不是空基线、更不是回落 state）
