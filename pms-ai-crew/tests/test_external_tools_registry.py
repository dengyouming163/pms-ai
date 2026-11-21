"""SearchCultureInfo 的行为 + **「不得进 ToolRegistry」回归闸**。"""
import pytest
import logging

import src.tools.external_tools as ext
from src.tools.registry import ToolRegistry


# ---------- 回归闸：不注册 ----------

def test_search_culture_info_is_not_registered():
    """🔴 本闸防的是一次**看起来很自然**的改动：给新工具补一句
    `ToolRegistry.register(SearchCultureInfo())`。

    为什么那是事故：`src/agents/store_manager.py:14` 用的是
    `ToolRegistry.list_all()` ⇒ 店长 agent（面向商家的前台对话）会**必然**拿到一个
    **付费联网检索**工具 —— 不是概率事件：`src/tools/__init__.py:2` 无条件 import 本模块，
    而 `list_all()` 又在**导入期**求值（`store_manager.py:5` 的模块级 `Agent(...)`），
    连运行时收窄的机会都没有。
    """
    names = {t.name for t in ToolRegistry.list_all()}
    assert "search_culture_info" not in names


def test_registry_negative_control():
    """阳性对照：既有两个外部工具**在**表里。

    没有这条，上面那条断言在「extrenal_tools 整个没被 import」时也会绿 ——
    而那种情况下它什么也没证明（同族前科：否定观察必须配独立对照）。
    """
    names = {t.name for t in ToolRegistry.list_all()}
    assert {"get_weather_forecast", "get_local_events"} <= names


# ---------- 密钥缺失 ----------

def test_run_returns_error_without_key(monkeypatch):
    """没配密钥时**返回** error，不抛异常穿透到 agent。"""
    monkeypatch.delenv("LLM_API_KEY_DASHSCOPE", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    tried = []
    monkeypatch.setattr("src.tools.external_tools.httpx.stream",
                        lambda *a, **k: tried.append(1))
    r = ext.SearchCultureInfo()._run(query="杭州西湖断桥")
    # 密闭闸：这两条用例本来只靠**闸的先后顺序**才不联网。顺序一变（比如有人删掉密钥闸），
    # 就会真的发请求到 dashscope.aliyuncs.com，而那个失败会被下面那条 `"密钥" in ...`
    # 报成「闸不存在」—— 用这个桩把「真联网」也一并钉死。
    assert not tried, "没配密钥就不该走到联网那一步"
    assert r["ok"] is False
    assert r["answer"] == ""
    assert r["sources"] == []
    # 钉住**原因**：只断言 r["error"] 为真时，一个 401（或任何传输故障）也满足，
    # 那样这条用例证明不了密钥闸存在（实测：绕过密钥闸喂 401，前面几条断言全绿）。
    assert "密钥" in r["error"]


def test_run_returns_error_on_empty_query(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY_DASHSCOPE", "sk-x")
    tried = []
    monkeypatch.setattr("src.tools.external_tools.httpx.stream",
                        lambda *a, **k: tried.append(1))
    r = ext.SearchCultureInfo()._run(query="   ")
    assert not tried, "检索词为空就不该走到联网那一步"
    assert r["ok"] is False
    # 同上钉原因：不钉的话，删掉空词闸后这条会落到真实网络调用而照样绿。
    assert "空" in r["error"]
    # 返回值形状**统一**：早退路径也带 `truncated`。缺了它，调用方在**失败路径**上
    # 直接取键就会 KeyError —— 而失败路径正是最需要取键的地方。
    assert r["truncated"] is False


# ---------- SSE 解析 ----------

class _FakeStream:
    def __init__(self, status_code, lines, raw=b""):
        self.status_code = status_code
        self._lines = lines
        self._raw = raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_lines(self):
        return iter(self._lines)

    def read(self):
        return self._raw


def _install_stream(monkeypatch, status_code, lines, raw=b""):
    monkeypatch.setenv("LLM_API_KEY_DASHSCOPE", "sk-x")
    monkeypatch.setattr(
        "src.tools.external_tools.httpx.stream",
        lambda *a, **k: _FakeStream(status_code, lines, raw),
    )


# **字段**形状照实测抄：正文在 output.choices[0].message.content，
# 来源在 output.search_info.search_results（**不是** output.text —— 那条是非流式的字段）。
# ⚠️ **行框架没有实测记录**：设计文档 §3 只记了字段路径，没记「一个 event 一行 data:」
# 还是允许跨行续行 ⇒ 本夹具「一行一个 event」是**假设**。若线上服务端改成跨行，
# 症状是「来源凭空少了」，由 test_run_counts_unparseable_chunks_instead_of_dropping_silently
# 的告警兜住。
# 🔴 **不要**为了「兼容跨行」把连续的 `data:` 行用 \n 拼起来再解析 ——
# 实测那次正是**按行解析并成功取到了 sources**，可见这些 `data:` 行是**各自独立的 chunk**；
# 拼接会把两个完整 JSON 并成一个非法 JSON，把本来能用的流全丢掉。
_SSE = [
    'data: {"output":{"choices":[{"message":{"content":"据记载，"}}]}}',
    'data: {"output":{"choices":[{"message":{"content":"该井为明代形制。"}}],'
    '"search_info":{"search_results":[{"index":1,"site_name":"百度百科",'
    '"title":"浙东水井","url":"https://baike.example/1"}]}}}',
    'data: {"output":{"choices":[{"message":{"content":""}}],"search_info":{"search_results":['
    '{"index":1,"site_name":"百度百科","title":"浙东水井","url":"https://baike.example/1"},'
    '{"index":2,"site_name":"某县地方志","title":"古井名录","url":"https://dfz.example/2"}]}}}',
    ": ping",
    'data: {"output":{"choices":[{"message":{"content":""}}]}}',
]


def test_run_parses_stream_answer_and_sources(monkeypatch):
    _install_stream(monkeypatch, 200, _SSE)
    r = ext.SearchCultureInfo()._run(query="浙东古井")
    assert r["ok"] is True
    # 正文分片按序拼接（**不是**取最后一片 —— 那样只会拿到空串）
    assert r["answer"] == "据记载，该井为明代形制。"
    # 来源按 url 去重：第 3 片把 index:1 又说了一遍
    assert [s["url"] for s in r["sources"]] == [
        "https://baike.example/1", "https://dfz.example/2",
    ]
    assert r["sources"][0]["site_name"] == "百度百科"
    assert r["sources"][1]["title"] == "古井名录"


def test_run_non_200_is_reported_not_raised(monkeypatch):
    _install_stream(monkeypatch, 400, [], raw=b'{"code":"InvalidParameter","message":"x"}')
    r = ext.SearchCultureInfo()._run(query="浙东古井")
    assert r["ok"] is False
    assert "400" in r["error"]
    assert r["sources"] == []


def test_run_200_without_any_content_is_not_ok(monkeypatch):
    """空流（既无正文也无来源）必须判失败，不能回 ok:True + 空串 ——
    否则上游「查不到」会被下游当成「查到了但内容为空」，走到组装步白花钱。"""
    _install_stream(monkeypatch, 200, [": ping"])
    r = ext.SearchCultureInfo()._run(query="浙东古井")
    assert r["ok"] is False


def test_run_counts_unparseable_chunks_instead_of_dropping_silently(monkeypatch, caplog):
    """解析不了的分片**计数并告警**，不静默丢。

    🔴 为什么值得单测：这条丢弃路径的症状（来源凭空少了 / 查到的说成查无结果）恰好
    与本函数的**正常返回**同形（`ok:True`+空 sources、`ok:False`+「检索无结果」）
    ⇒ 没有这条日志，线上「服务端改了行框架」与「真的查不到」无法区分。
    """
    _install_stream(monkeypatch, 200, [
        'data: {"output":{"choices":[{"message":{"content":"据记载，"}}]}}',
        "data: {这不是 JSON",  # 解析失败 ⇒ 计数 + 告警
        'data: {"output":{"choices":[{"message":{"content":"该井为明代形制。"}}]}}',
    ])
    with caplog.at_level(logging.WARNING, logger="src.tools.external_tools"):
        r = ext.SearchCultureInfo()._run(query="浙东古井")
    # 丢一段不该毁掉整次调用：好的分片照常拼接
    assert r["ok"] is True
    assert r["answer"] == "据记载，该井为明代形制。"
    assert "无法解析" in caplog.text


# ---------- 流式预算：到点收手，但已收到的照留 ----------

class _ClockStub:
    """假时钟：每次读都前进 `step` 秒（装上后替换 `external_tools.time` 这个名字）。

    🔴 为什么是「每次前进固定步长」，而不是「按调用次序喂一串预设值」：后者的期望值会
    绑死在「实现里 `monotonic()` 被调了几次」上，实现稍一挪动（比如判定从循环头挪到循环尾）
    就变成另一条断言 —— 而这几条用例真正要锁的是「**累计走完预算就收手**」。
    ⚠️ 桩打在 `external_tools` 的**模块级名字**上，不动 stdlib 的全局 `time`
    （免得顺手把 pytest 自己的计时也换掉）。
    """

    def __init__(self, step: float):
        self.step = step
        self.t = 0.0
        self.calls = 0

    def monotonic(self) -> float:
        v = self.t
        self.t += self.step
        self.calls += 1
        return v


def _install_clock(monkeypatch, *, step: float, budget: float):
    clock = _ClockStub(step)
    monkeypatch.setattr(ext, "time", clock)
    monkeypatch.setattr(ext.SearchCultureInfo, "STREAM_BUDGET_SECONDS", budget)
    return clock


# 正文做成**可分辨的 5 段**、来源分散在第 1 段与第 5 段 —— 这样「截断到哪」与「来源收了几条」
# 两个读数能分开断言，且不依赖截断点恰好落在哪一段（见下）。
_BUDGET_SSE = [
    'data: {"output":{"choices":[{"message":{"content":"第1段。"}}],"search_info":{"search_results":['
    '{"index":1,"site_name":"甲","title":"一","url":"https://x/1"}]}}}',
    'data: {"output":{"choices":[{"message":{"content":"第2段。"}}]}}',
    'data: {"output":{"choices":[{"message":{"content":"第3段。"}}]}}',
    'data: {"output":{"choices":[{"message":{"content":"第4段。"}}]}}',
    'data: {"output":{"choices":[{"message":{"content":"第5段。"}}],"search_info":{"search_results":['
    '{"index":2,"site_name":"乙","title":"二","url":"https://x/2"}]}}}',
]
_BUDGET_FULL = "第1段。第2段。第3段。第4段。第5段。"


def test_stream_budget_default_is_pinned_to_the_agreed_cap():
    """上限值本身钉住：**10 秒**是用户拍板的产品上限，不是随手填的常数。

    实测同一请求本地 4.6~5.7s、**生产 9~31s** ⇒ 这条线在生产里**会**经常截断，
    那是有意的取舍（截断但保留已收到的，好过让用户等半分钟）。
    放大它之前先想清楚上限链：客户端那条闸是 `pms-ops-app` 的 `REQUEST_TIMEOUT`（20s，
    已装版本）与 `AI_REQUEST_TIMEOUT`（70s，已落地待出包）。
    """
    assert ext.SearchCultureInfo.STREAM_BUDGET_SECONDS == 10.0


def test_budget_does_not_fire_when_the_stream_finishes_in_time(monkeypatch):
    """阳性对照：同一份夹具、时钟照走（每次 2 秒），预算给够 ⇒ **完整**读完。

    没有这条，下面那条 `answer != 全文` 在「夹具本身就少了段落」时也会绿 ——
    那样它证明的是夹具残缺，不是预算生效（同族：否定观察必须配独立对照）。
    """
    _install_stream(monkeypatch, 200, _BUDGET_SSE)
    _install_clock(monkeypatch, step=2.0, budget=100.0)
    r = ext.SearchCultureInfo()._run(query="浙东古井")
    assert r["answer"] == _BUDGET_FULL
    assert [s["url"] for s in r["sources"]] == ["https://x/1", "https://x/2"]
    # 阳性对照也要**否证**截断标志：只断言下面两条是 True，不能排除「恒 True」的实现。
    assert r["truncated"] is False


def test_stream_budget_stops_early_but_keeps_what_arrived(monkeypatch, caplog):
    """预算走完 ⇒ 收手，且**保留**已收到的正文与来源（不整次作废）。

    🔴 为什么值得单测：没有这个上限，`TIMEOUT_SECONDS`（60s）拦不住一个「一直吐但吐得慢」
    的流 —— 流式响应每来一个分片都重置 read 计时。生产实测同一请求 9~31s，而客户端
    （pms-ops-app）的全局闸是 20s ⇒ 客户端先超时、用户看到「报错 无返回」。
    """
    _install_stream(monkeypatch, 200, _BUDGET_SSE)
    _install_clock(monkeypatch, step=2.0, budget=5.0)  # 走 3 次即超额：只吃得下前两段
    with caplog.at_level(logging.WARNING, logger="src.tools.external_tools"):
        r = ext.SearchCultureInfo()._run(query="浙东古井")

    # ① 真的提前收手了（若无预算 ⇒ answer == 全文 ⇒ 本条红）
    assert r["answer"] != _BUDGET_FULL
    # ② 截断点是**前缀**：只锁「按序累积、没乱序、没整段作废」，
    #    **不**锁「断在第几段」—— 那取决于时钟被读了几次，是实现细节不是契约
    assert r["answer"]
    assert _BUDGET_FULL.startswith(r["answer"])
    # ③ 预算内收到的来源照留（第 1 段那条），第 5 段那条自然拿不到
    assert [s["url"] for s in r["sources"]] == ["https://x/1"]
    # ④ 仍判成功：有正文就该继续走组装步。截断 ≠ 失败，别把半份资料一起丢掉
    assert r["ok"] is True
    # ⑤ 🔴 **程序可见**的截断标志。它与 `ok` 正交：截断可能是 ok:True（收到半份）
    #    ⇒ 调用方不许从「有正文」推断「查完了」。场地调研的 search_log 就靠它。
    assert r["truncated"] is True
    # ⑥ 不静默：warning 是给人看的那个信号（与 ⑤ 是两个信号，不是一个）
    assert "截断" in caplog.text


def test_budget_expiry_with_nothing_received_says_timeout_not_no_result(monkeypatch, caplog):
    """预算在**第一个分片之前**就走完 ⇒ 如实说超时，不能说「检索无结果」。

    🔴 为什么单列一条：两者在上游（`src/services/wenlv_material_assist.py:436`）**都**走
    `search_failed`、都退还额度，看起来无差别 —— 但对人不一样：前者等于告诉运维
    「公网没有这条素材」，而真相是「我们没查完」。
    """
    _install_stream(monkeypatch, 200, _BUDGET_SSE)
    _install_clock(monkeypatch, step=6.0, budget=5.0)  # 第一次读就已超额 ⇒ 一个分片都没吃到
    with caplog.at_level(logging.WARNING, logger="src.tools.external_tools"):
        r = ext.SearchCultureInfo()._run(query="浙东古井")
    assert r["ok"] is False
    assert r["answer"] == "" and r["sources"] == []
    assert "超时" in r["error"]
    assert "无结果" not in r["error"]
    # 空手而归也是截断 —— `truncated` 与 `ok` 正交，别把它写成「成功路径才带」的字段
    assert r["truncated"] is True
    assert "截断" in caplog.text


# ---------- 请求侧：必须带 SSE 开关头 ----------

def test_request_carries_sse_header(monkeypatch):
    """发出去的请求必须带 `X-DashScope-SSE: enable`。

    🔴 本条补的是一个**真实发生过**的静默失效（2026-09-23 上线冒烟）：该端点
    **不带这个头就不分片**，整包回一个普通 JSON，而 `_run()` 只认 `data:` 前缀
    ⇒ 整包被跳过 ⇒ 恒返回「检索无结果」，**功能 100% 死掉而 HTTP 仍是 200**。

    ⚠️ 为什么本文件原有 8 条用例全绿却漏了它：那些用例都是**喂响应**（把
    `httpx.stream` 的**返回值**换成假流），**请求侧根本不在被测全集里** ——
    桩手喂了正确形状，被测的就只剩解析。生产事故的产地正是这个没被覆盖的 seam。
    另：设计文档 §3 的「照抄这一组」配方块当时**只写了 URL 与 body、没有 headers**，
    照抄必漏开关（该文档已订正）。
    """
    monkeypatch.setenv("LLM_API_KEY_DASHSCOPE", "sk-x")
    seen = {}

    def _capture(*a, **k):
        seen.update(k)
        return _FakeStream(200, _SSE)

    monkeypatch.setattr("src.tools.external_tools.httpx.stream", _capture)
    r = ext.SearchCultureInfo()._run(query="杭州西湖断桥")

    # 先证明这次调用真的走到了联网那一步。少了这条，桩没被调用时下面的断言会以
    # 「头不对」的形态报错，而真因是「压根没发请求」 —— 红得指向错对象。
    assert seen, "本用例假定走到联网那一步"
    assert r["ok"] is True
    headers = {str(x).lower(): y for x, y in (seen.get("headers") or {}).items()}
    assert headers.get("x-dashscope-sse") == "enable", (
        "缺 `X-DashScope-SSE: enable` ⇒ 该端点不分片、整包回一个普通 JSON ⇒ "
        "只认 `data:` 的解析器整包跳过（HTTP 仍 200，功能全死）"
    )
