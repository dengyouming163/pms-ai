"""三个端点的契约测试：消歧 / 发起 / 诊断态。

⚠️ **不用 `src.main` 的 app**，改为一个只挂本路由的 FastAPI 实例。两个理由都实测过：
 ① `src.main` 连带 import `src.api.wenlv_creation`，它在**模块级** import crewai
    （`src/api/wenlv_creation.py:11`）⇒ 那一个 import 实测 **44.49s**；
 ② 本模块刻意把重依赖都留在函数内（`_default_disambiguate` 的 import 全在函数体里），
    自身 import 实测只要 **2.05s**。为三条契约付 44s 不值得。
**代价**：「路由没挂进 `src.main`」这件事本文件测不到（照样全绿）—— 另有
`test_main_挂载了新路由` 扫源码兜底，加上执行时的一次性真探针（见计划完成记录）。

本仓既有的 `tests/test_wenlv_material_optimize_api.py` 走「直接调路由函数」的路子；
这里用 TestClient 是因为要断言**状态码**（400/404），而 `HTTPException` 是抛不是返回，
直接调函数断言不了它。
"""
import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import venue_research as api

SRC_DIR = Path(__file__).resolve().parents[1] / "src"


class FakeRedis:
    """**记录型**替身。不能用字符串桩：`_set_state` 把整段写入包在 try/except 里，
    桩没有 `.set` 时抛的 AttributeError 会被**静默吞掉** ⇒ 测试全绿而诊断态一个字没写。
    本文件要防的就是这类「全绿但没生效」。"""

    def __init__(self):
        self.kv = {}
        self.expires = []

    def set(self, key, value):
        self.kv[key] = value

    def expire(self, key, ttl):
        self.expires.append((key, ttl))

    def get(self, key):
        return self.kv.get(key)


class FakePersister:
    """记录 `save_research` 的调用（`_run_in_thread` 的异常兜底要验的就是这一笔）。"""

    calls = []

    def __init__(self, *a, **kw):
        pass

    def save_research(self, research_id, **fields):
        FakePersister.calls.append({"research_id": research_id, **fields})
        return {"ok": True}


@pytest.fixture
def client():
    a = FastAPI()
    a.include_router(api.router, prefix="/api")
    return TestClient(a)


@pytest.fixture
def fake_redis(monkeypatch):
    r = FakeRedis()
    monkeypatch.setattr(api, "_get_redis", lambda: r)
    return r


@pytest.fixture(autouse=True)
def _reset_calls():
    FakePersister.calls = []
    yield


def _wait_until(pred, timeout=5.0):
    """等后台线程的终态落地。

    🔴 **不能**「跑完 `asyncio.run` 就直接断言」：`asyncio.run` 收尾时对未完成任务只做
    `_cancel_all_tasks`（取消 + gather），**不等** `to_thread` 的线程跑完 ——
    `await run_in_executor` 那一刻线程已经交出去了，取消只取消「等」这件事，线程照跑。
    于是断言与线程写终态谁先谁后是**赛跑**（桩足够快时通常断言赢不了几次就输）。
    等，而不是断言那一刻恰好已经到了。
    """
    end = time.time() + timeout
    while time.time() < end and not pred():
        time.sleep(0.02)
    return pred()


def test_resolve_立即返回_STARTED_且先写_running(monkeypatch, fake_redis):
    """消歧也是「立即返回 + 轮询」。

    🔴 同步版**实测后被推翻**：热调用 36.3s、冷调用 91.3s，放不进任何一道闸。
    这条用例存在的意义之一就是别让它被改回同步 —— 若改回同步，POST 就不会回
    STARTED（而会回 `{"status": "OK", "candidates": [...]}`），这里立刻红。
    """
    seen = []
    monkeypatch.setattr(api, "_write_resolve", lambda rid, p: seen.append((rid, p["status"])))
    monkeypatch.setattr(api, "resolve_venue", lambda **kw: {"candidates": [], "reason": "no_candidate"})

    out = asyncio.run(api.resolve(api.ResolveRequest(resolve_id="q1", venue_name="镇山村")))

    assert out == {"status": "STARTED", "resolve_id": "q1"}
    assert _wait_until(lambda: len(seen) >= 2), f"后台没写终态，只看到 {seen}"
    # 第一次写入必须是 running 且发生在后台之前（任务不可能在 create_task 之前跑）
    assert seen[0] == ("q1", "running")
    assert seen[-1] == ("q1", "done")
    assert "running" not in [s for _, s in seen[1:]], "终态被写回去了"


def test_resolve_结果写进redis_可轮询(client, fake_redis, monkeypatch):
    """TestClient 会等后台线程跑完（见 `test_start_先写_running` 的注释）⇒ 断言终态是确定的。"""
    monkeypatch.setattr(api, "resolve_venue", lambda **kw: {
        "candidates": [{"name": "镇山村", "region": "贵阳"}], "reason": "",
    })
    r = client.post("/api/venue-research/resolve",
                    json={"resolve_id": "q1", "venue_name": "镇山村", "city": "贵阳"})
    assert r.status_code == 200 and r.json()["status"] == "STARTED"

    g = client.get("/api/venue-research/resolve/q1")
    assert g.status_code == 200
    b = g.json()
    assert b["status"] == "done" and b["candidates"][0]["name"] == "镇山村"


def test_轮询只回三个字段_不透传_search_log(client, fake_redis):
    """`search_log` 是内部结构（检索词 + 失败细节）—— 只给 App 它需要的三个字段。

    🔴 这里**直接**往 redis 塞一个带额外键的载荷（而不是走 POST 那条路）：
    `search_log` 在写入侧（`_run_resolve_in_thread`）和读取侧（`get_resolve`）
    **各被剔一次**，走 POST 的话**任何一侧单独失效都测不出来**（实测：M13 变异
    「读取侧整包透传」漏网 —— 因为写入侧已经剔干净了）。分开测，两侧各钉一条。
    """
    api._write_resolve("q1", {
        "status": "done", "candidates": [], "reason": "no_candidate",
        "search_log": [{"section": "resolve", "query": "内部检索词", "error": "内部失败细节"}],
        "内部键": "内部值",
    })
    b = client.get("/api/venue-research/resolve/q1").json()
    assert set(b) == {"status", "candidates", "reason"}
    assert "内部检索词" not in json.dumps(b, ensure_ascii=False)


def test_后台不把_search_log_写进_redis(monkeypatch, fake_redis):
    """写入侧的同一件事（见上一条：为什么要分成两条）。"""
    monkeypatch.setattr(api, "resolve_venue", lambda **kw: {
        "candidates": [], "reason": "no_candidate",
        "search_log": [{"section": "resolve", "query": "内部检索词"}],
    })
    api._run_resolve_in_thread("q1", api.ResolveRequest(resolve_id="q1", venue_name="x"))
    raw = fake_redis.kv["wenlv_venue_research:resolve:q1"]
    assert "内部检索词" not in raw
    assert set(json.loads(raw)) == {"status", "candidates", "reason"}


def test_resolve_无候选时_reason_码随结果回给App(client, fake_redis, monkeypatch):
    """候选为空是**正当结果**（公网查不到这个地名），不是错误 —— 用分类码表达。"""
    monkeypatch.setattr(api, "resolve_venue", lambda **kw: {"candidates": [], "reason": "no_candidate"})
    client.post("/api/venue-research/resolve", json={"resolve_id": "q1", "venue_name": "某村"})
    assert client.get("/api/venue-research/resolve/q1").json()["reason"] == "no_candidate"


def test_resolve_成文失败的原样到达_App_不说成查不到(client, fake_redis, monkeypatch):
    """模型挂了**不能**说成「公网查不到」—— `agent_failed` 与 `no_candidate` 的处置不同
    （前者重试，后者换更精确的地名）。API 层**不做任何重解释**，服务层说什么就回什么。"""
    monkeypatch.setattr(api, "resolve_venue",
                        lambda **kw: {"candidates": [], "reason": "agent_failed"})
    client.post("/api/venue-research/resolve", json={"resolve_id": "q1", "venue_name": "镇山村"})
    b = client.get("/api/venue-research/resolve/q1").json()
    assert b["status"] == "done" and b["reason"] == "agent_failed"


def test_resolve_后台抛异常时写_failed_不留_App_空转(monkeypatch, fake_redis):
    """不写终态 ⇒ App 一直轮询到 TTL 到期。异常路径必须兜到 failed。"""
    def boom(**kw):
        raise RuntimeError("流水线炸了")

    monkeypatch.setattr(api, "resolve_venue", boom)
    api._run_resolve_in_thread("q1", api.ResolveRequest(resolve_id="q1", venue_name="x"))
    assert json.loads(fake_redis.kv["wenlv_venue_research:resolve:q1"])["status"] == "failed"


def test_resolve_id_缺失_400(client, monkeypatch):
    """没有 resolve_id 就没处放结果（App 也就无从轮询）⇒ 在起后台之前拒掉。
    桩里 `pytest.fail` 把「**碰服务层之前**就拒」这条顺序也钉住。"""
    monkeypatch.setattr(api, "resolve_venue", lambda **kw: pytest.fail("缺 resolve_id 不该起后台任务"))
    r = client.post("/api/venue-research/resolve", json={"venue_name": "镇山村"})
    assert r.status_code == 400


def test_resolve_场地名为空_400(client, monkeypatch):
    """桩里 `pytest.fail` 是**有意**的：这个闸的契约不只是「回 400」，
    还有「**在碰服务层之前**回 400」—— 否则一次空表单会真的发起联网检索 + LLM 调用
    （花钱、耗时 36s+）。让桩直接失败，把这条顺序也钉住。"""
    monkeypatch.setattr(api, "resolve_venue", lambda **kw: pytest.fail("空场地名不该调到服务层"))
    r = client.post("/api/venue-research/resolve", json={"resolve_id": "q1", "venue_name": "  ", "city": ""})
    assert r.status_code == 400


def test_resolve_场地名为空但_hint_非空_放行(client, fake_redis, monkeypatch):
    """`hint` 是「候选都不是」那条逃生口的输入 —— 只填 hint 也必须能查。"""
    seen = {}
    monkeypatch.setattr(api, "resolve_venue",
                        lambda **kw: seen.update(kw) or {"candidates": [], "reason": ""})
    r = client.post("/api/venue-research/resolve",
                    json={"resolve_id": "q1", "venue_name": "", "hint": "花溪区镇山村"})
    assert r.status_code == 200
    assert seen["hint"] == "花溪区镇山村"


def test_get_resolve_未见过_404(client, fake_redis):
    """TTL 过期 / 从未见过都是 404；App 的处置是「重查一次」，文案要说清。"""
    assert client.get("/api/venue-research/resolve/never").status_code == 404


def test_resolve_键与前缀_不与报告诊断键撞():
    """候选（临时）与报告诊断（长期）用不同前缀：同前缀会让 `keys` 与排查读串。"""
    assert api._RESOLVE_PREFIX == "wenlv_venue_research:resolve"
    assert not api._RESOLVE_PREFIX.startswith(api._STATE_PREFIX)
    assert api._RESOLVE_TTL == 30 * 60
    # 候选是「建行之前」的临时结果 ⇒ TTL 必须**短于**报告诊断键（30 天）
    assert api._RESOLVE_TTL < api._STATE_TTL


def test_start_先写_running_再起后台_顺序(monkeypatch):
    """🔴 顺序：**先**写 runnning 诊断态，**再** create_task。

    ⚠️ 这条**不能**用 TestClient 测：它的 portal 在关事件循环时会
    `shutdown_default_executor()`，即**等后台线程跑完**才把响应交回测试 ——
    于是中间态 `running` 永远观测不到（实测：桩里无论怎么卡，断言到的都是终态
    `'ready' != 'running'`）。
    改用直接 `asyncio.run(api.start(...))`：能精确看到**两次**写入的先后。
    第一条是端点自己写的 ⇒ 它在 `create_task` 之前（任务不可能在它之前跑）。
    第二条证明后台线程确实起来了、跑到了终态。
    """
    seen = []
    monkeypatch.setattr(api, "_set_state", lambda rid, st, **kw: seen.append((rid, st)))
    monkeypatch.setattr(api, "run_research", lambda **kw: {"status": "ready"})

    out = asyncio.run(api.start(api.StartRequest(research_id="r1", venue_name="镇山村")))

    assert out == {"status": "STARTED", "research_id": "r1"}
    assert _wait_until(lambda: len(seen) >= 2), f"后台没写终态，只看到 {seen}"
    assert seen == [("r1", "running"), ("r1", "ready")]


def test_start_诊断态走真_set_state_写进redis带TTL(client, fake_redis, monkeypatch):
    """TestClient 这里等后台线程跑完是**确定的**（见上一条的注释），所以断言终态安全。"""
    import json as _json
    monkeypatch.setattr(api, "run_research", lambda **kw: {"status": "ready"})
    r = client.post("/api/venue-research/start", json={"research_id": "r1", "venue_name": "镇山村"})
    assert r.status_code == 200
    assert r.json()["status"] == "STARTED"
    assert _json.loads(fake_redis.kv["wenlv_venue_research:state:r1"])["status"] == "ready"
    # 两次写入（running → ready）都要挂 TTL：只在第一次挂的话，第二次 `set` 会
    # **清掉** TTL（Redis 里 set 是覆盖整个键），诊断键就永久留下了。
    assert set(fake_redis.expires) == {("wenlv_venue_research:state:r1", api._STATE_TTL)}


def test_start_research_id_缺失_400(client, monkeypatch):
    """同上一类：必须在创建后台任务**之前**拒绝 —— 没有 research_id 的调研
    跑完也没处回写（报告的唯一属主是 pms-server）。"""
    monkeypatch.setattr(api, "run_research", lambda **kw: pytest.fail("缺 research_id 不该起后台任务"))
    r = client.post("/api/venue-research/start", json={"venue_name": "x"})
    assert r.status_code == 400


def test_get_未见过_404(client, fake_redis):
    r = client.get("/api/venue-research/never-seen-id")
    assert r.status_code == 404


def test_get_已写入_返回诊断态(client, fake_redis):
    api._set_state("r1", "ready")
    r = client.get("/api/venue-research/r1")
    assert r.status_code == 200
    assert r.json()["status"] == "ready"


def test_run_in_thread_异常时补写_failed_终态(monkeypatch, fake_redis):
    """线程里抛异常没人接 ⇒ 必须**尽力**补一笔 failed 终态；补不上也不许再抛。
    pms-server 那行停在 running 的兜底是看门狗（15 分钟），不是这里。"""
    def boom(**kw):
        raise RuntimeError("流水线炸了")

    monkeypatch.setattr(api, "run_research", boom)
    monkeypatch.setattr(api, "WenlvPersister", FakePersister)

    api._run_in_thread("r1", api.StartRequest(research_id="r1", venue_name="镇山村"))

    assert FakePersister.calls[-1]["status"] == "failed"
    assert FakePersister.calls[-1]["finished_at"] is True
    import json as _json
    state = _json.loads(fake_redis.kv["wenlv_venue_research:state:r1"])
    assert state["status"] == "failed"
    assert state["error"]


def test_run_in_thread_补写也失败时不抛(monkeypatch, fake_redis):
    """补写是**尽力而为**：这一步再抛，线程里没人接，日志里会只剩一条 traceback。"""
    class BoomPersister(FakePersister):
        def save_research(self, research_id, **fields):
            raise RuntimeError("补写也炸")

    monkeypatch.setattr(api, "run_research", lambda **kw: (_ for _ in ()).throw(RuntimeError("x")))
    monkeypatch.setattr(api, "WenlvPersister", BoomPersister)

    api._run_in_thread("r1", api.StartRequest(research_id="r1", venue_name="镇山村"))  # 不抛即为通过
    assert fake_redis.kv["wenlv_venue_research:state:r1"]


def test_run_in_thread_正常路径_状态取流水线返回值(monkeypatch, fake_redis):
    monkeypatch.setattr(api, "run_research", lambda **kw: {"status": "partial"})
    api._run_in_thread("r1", api.StartRequest(research_id="r1", venue_name="镇山村"))
    import json as _json
    assert _json.loads(fake_redis.kv["wenlv_venue_research:state:r1"])["status"] == "partial"


def test_request_model_field_names_are_snake_case():
    """字段名是 ops-app ↔ BFF ↔ ai-crew 三层的契约，改一处就**静默**变空串
    （上游按旧名发、这边按默认值收，两边都不报错）。"""
    assert set(api.ResolveRequest().model_dump()) == {
        "resolve_id", "venue_name", "city", "address", "hint", "user_id"}
    assert set(api.StartRequest().model_dump()) == {
        "research_id", "venue_name", "city", "anchor", "hint", "user_id"}
    assert api.ResolveRequest().model_dump() == {
        "resolve_id": "", "venue_name": "", "city": "", "address": "", "hint": "", "user_id": ""}


def test_main_挂载了新路由():
    """挂载是**声明式的一行**，漏了就是生产 404，而本文件其他用例照样全绿 —— 必须单测。

    不 import `src.main`（44.49s，见模块头注）。扫源码，且用**整行相等**判定：
    子串匹配会被注释里的同名文本骗过（本仓前科见 fence-parity-needs-line-anchor）。
    """
    lines = [ln.strip() for ln in (SRC_DIR / "main.py").read_text(encoding="utf-8").splitlines()]
    assert "from src.api.venue_research import router as venue_research_router" in lines
    assert 'app.include_router(venue_research_router, prefix="/api")' in lines


def test_state_prefix_与_creation_的不撞():
    """两个流程的诊断键**不能同前缀**：同前缀会让 `redis-cli keys` 与排查把两个
    任务的态读串（本模块存在的唯一理由就是「那个任务跑起来了没有」）。

    对照值从**对方源码**里取（`wenlv_creation_crew.py` 的 `state_key` 字面量），
    不 import 它 —— 那会连带 crewai（44.49s，见模块头注）。自己跟自己比
    （`assert _STATE_PREFIX == "wenlv_venue_research:state"`）是**同义反复**，
    钉不住「与对方不撞」这句话。
    """
    crew_src = (SRC_DIR / "crews" / "wenlv_creation_crew.py").read_text(encoding="utf-8")
    assert '"wenlv_creation:state"' in crew_src, "对方的键名变了 —— 本用例的对照物失效了"
    assert api._STATE_PREFIX == "wenlv_venue_research:state"
    assert api._STATE_PREFIX.split(":")[0] != "wenlv_creation"
    # /start 必须是 async：同步端点由 FastAPI 丢进线程池跑，那里没有事件循环，
    # `asyncio.create_task` 会直接 RuntimeError（而它发生在**返回之后**，接口看着是对的）。
    assert asyncio.iscoroutinefunction(api.start)
