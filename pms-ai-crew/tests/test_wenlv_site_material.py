"""S2：site_material 注入三处提示词（项目定位 / 剧本第 6 步 location / 关卡设计）。

用 _run_agent 替身捕获每次调用的 task_desc 字符串来断言注入内容 ——
不调真 LLM，与 test_wenlv_creation_crew.py 同款替身模式。
"""
from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator, SCRIPT_STEPS

SITE_MATERIAL = {
    "venue": {
        "id": "v1",
        "name": "龙门古镇",
        "address": "贵州省黔南州龙门镇",
        "city": "黔南",
        "culture": [
            {"type": "legend", "title": "槐树传说", "content": "树下埋着旧时的信物。", "source": "村民口述"},
        ],
    },
    "points": [
        {"id": "p1", "name": "村口老槐树", "address": "村东", "remark": "树下有石碑",
         "geo": {"lat": 26.1, "lng": 107.2}, "photos": ["https://x/1.jpg"]},
        {"id": "p2", "name": "古井", "address": None, "remark": None, "geo": None, "photos": None},
    ],
}


class _CapturingOrch(WenlvCreationOrchestrator):
    """记录每次 _run_agent 的 task_desc + expected，返回能过校验的最小产出。"""

    def __init__(self):
        super().__init__(redis=None)
        self.calls = []
        # P3：用内存 dict 模拟 Redis 状态（redis=None 时 _set_state 是 no-op）。
        self._state: dict = {}
        # 不打真 HTTP：默认的 WenlvPersister 会向 PMS_SERVER_URL（默认 localhost:9090）POST，
        # 本机无服务时抛 httpx.ConnectError 被 run_draft 宽 except 吞成 FAILED。
        # 后果有三：① 日志刷整屏 traceback；② 若本机恰有 pms-server 监听 9090，
        # 这些测试会**真写入产品数据**；③ 更要紧的：测试实际走的是**异常路径**，
        # 而 B5 要断言 res["output"]["nodes_unbound"] —— 那只有成功路径才有。
        self.persister = _RecordingPersister()

    def _run_agent(self, agent, task_desc, expected, schema_cls, retries=1):
        self.calls.append({"expected": expected, "desc": task_desc})
        if expected == "level_design JSON":
            return {"nodes": [], "collectibles": [], "endings": [], "tiers": [], "rewards": []}
        if expected == "project_positioning JSON":
            return {"mode": "narrative", "world_tone": "武侠", "style_tag": "guochao"}
        if expected == "location JSON":
            return {"mappings": [{"chapter_id": "NODE_1", "location": "村口老槐树"}]}
        return {}

    def _validate(self, draft):
        return []

    # P3：内存状态替身，让 apply_draft 能读到 run_draft 存的草稿
    def _set_state(self, project_id, status, output):
        self._state[project_id] = {"status": status, "output": output}

    def _get_state(self, project_id):
        return self._state.get(project_id, {"status": "CREATED", "output": {}})


def _desc_for(orch, expected):
    return [c["desc"] for c in orch.calls if c["expected"] == expected]


def test_site_material_injected_into_positioning():
    orch = _CapturingOrch()
    orch.run_draft("P1", "古镇寻印", site_material=SITE_MATERIAL)
    descs = _desc_for(orch, "project_positioning JSON")
    assert descs, "定位 agent 应被调用"
    d = descs[0]
    assert "龙门古镇" in d
    assert "贵州省黔南州龙门镇" in d
    assert "槐树传说" in d
    assert "树下埋着旧时的信物。" in d


def test_site_material_injected_into_location_step_not_other_script_steps():
    orch = _CapturingOrch()
    orch.run_draft("P2", "古镇寻印", site_material=SITE_MATERIAL)
    # location 步骤必须收到全部点位名
    loc = _desc_for(orch, "location JSON")
    assert loc, "location 步骤应被调用"
    assert "村口老槐树" in loc[0]
    assert "古井" in loc[0]
    assert "树下有石碑" in loc[0]

    # 其余 5 个剧本步骤不得被塞入素材。
    # ⚠️ 注入点共三处：① 项目定位 ② 剧本第 6 步 location ③ 关卡设计（B2 起）。
    #    本循环只遍历 SCRIPT_STEPS（6 个剧本步骤），**不含关卡设计** —— 关卡设计的注入
    #    由 test_points_brief_injected_into_level_design 单独钉住。
    for step_name, _schema in SCRIPT_STEPS:
        if step_name in ("location",):
            continue
        for d in _desc_for(orch, f"{step_name} JSON"):
            assert "村口老槐树" not in d, f"{step_name} 步骤不该收到点位清单"
            assert "槐树传说" not in d, f"{step_name} 步骤不该收到文化素材"


def test_no_site_material_keeps_prompt_unchanged():
    """不传 site_material 时提示词与今天完全一致（向后兼容）。"""
    orch = _CapturingOrch()
    orch.run_draft("P3", "纯主题故事")
    d = _desc_for(orch, "project_positioning JSON")[0]
    assert "龙门古镇" not in d
    assert "site_material" not in d
    loc = _desc_for(orch, "location JSON")[0]
    assert "村口老槐树" not in loc


def test_site_material_point_without_geo_does_not_crash():
    """点位缺 geo / photos 时不能抛异常（BFF 一律补 null，但直接调用方可能省略键）。"""
    orch = _CapturingOrch()
    sm = {"venue": {"id": "v2", "name": "空场地", "culture": []},
          "points": [{"id": "p9", "name": "无名点位"}]}
    orch.run_draft("P4", "主题", site_material=sm)
    assert "无名点位" in _desc_for(orch, "location JSON")[0]


# ===== 落库透传 =====

class _RecordingPersister:
    """记录 persist_draft 收到的参数，不发 HTTP。

    ⚠️ 只覆盖 `persist_draft`。编排器另调 `get_product_full`（精修基线，
    `_refine_baseline_from_db`）—— 若拿本替身去测精修路径，`AttributeError` 会被
    `_refine_baseline` 的宽 `except Exception` 吞掉并**静默回落 state**（只留一条
    WARNING），测试会绿着测错分支。精修测试请照 `tests/test_wenlv_creation_crew.py:110`
    的 `_StubPersister` 补上 `get_product_full`。
    """

    def __init__(self):
        self.calls = []

    def persist_draft(self, product_id, name, mode, positioning, level, visual, config,
                      site_material=None, npcs=None):
        self.calls.append({
            "product_id": product_id, "name": name, "mode": mode,
            "config": config, "site_material": site_material, "npcs": npcs,
        })
        return {"product_id": product_id, "status": "draft", "nodes_unbound": []}

    # P3：apply_draft 会调这两个，给空实现避免 AttributeError
    def bootstrap_style_bible(self, product_id):
        return {"styleBible": {}, "reused": False}

    def enqueue_assets(self, product_id, types=None):
        return {"batchId": f"batch-{product_id}"}


def test_run_draft_passes_site_material_to_persister():
    """P3：run_draft 不再直接落库，site_material 存入草稿区（state output）。"""
    orch = _CapturingOrch()
    rec = _RecordingPersister()
    orch.persister = rec
    res = orch.run_draft("P5", "古镇寻印", site_material=SITE_MATERIAL)
    # run_draft 不直接调 persist_draft
    assert len(rec.calls) == 0
    # site_material 存入草稿区 output
    assert res["status"] == "DRAFT_READY"
    assert res["output"]["site_material"] == SITE_MATERIAL
    # apply_draft 才把 site_material 透传给 persist_draft
    orch.apply_draft("P5")
    assert len(rec.calls) == 1
    assert rec.calls[0]["site_material"] == SITE_MATERIAL


def test_run_draft_without_site_material_passes_none():
    orch = _CapturingOrch()
    rec = _RecordingPersister()
    orch.persister = rec
    res = orch.run_draft("P6", "纯主题故事")
    assert res["status"] == "DRAFT_READY"
    assert res["output"]["site_material"] is None
    orch.apply_draft("P6")
    assert rec.calls[0]["site_material"] is None


def test_create_product_sends_venue_id_and_ai_input():
    """create_product 必须把 venueId 与 aiInput 放进 HTTP body（字段名对齐 pms-server 的 productHeadSchema）。"""
    from src.services.wenlv_persist import WenlvPersister

    captured = {}

    class _P(WenlvPersister):
        def _post(self, path, body):
            captured["path"] = path
            captured["body"] = body
            return {"success": True, "data": {}}

    p = _P()
    p.create_product("P1", "名", venue_id="v1", ai_input={"venue": {"id": "v1"}})
    assert captured["path"] == "/api/admin/wenlv/products"
    assert captured["body"]["venueId"] == "v1"
    assert captured["body"]["aiInput"] == {"venue": {"id": "v1"}}


def test_create_product_omits_venue_id_when_absent():
    from src.services.wenlv_persist import WenlvPersister

    captured = {}

    class _P(WenlvPersister):
        def _post(self, path, body):
            captured["body"] = body
            return {"success": True, "data": {}}

    _P().create_product("P1", "名")
    # 不传就不出现该键：pms-server 的 venueId 无 default，出现即写库
    assert "venueId" not in captured["body"]
    assert "aiInput" not in captured["body"]


def test_persist_draft_forwards_venue_id_from_site_material():
    """persist_draft 从 site_material.venue.id 取 venueId，并把整份 site_material 作为 aiInput 落库。"""
    from src.services.wenlv_persist import WenlvPersister

    captured = {}

    class _P(WenlvPersister):
        def _post(self, path, body):
            captured["path"] = path
            captured["body"] = body
            return {"success": True, "data": {}}

    _P().persist_draft("P1", "名", "narrative", {}, {"nodes": []}, {}, {}, site_material=SITE_MATERIAL)
    assert captured["body"]["venueId"] == "v1"
    assert captured["body"]["aiInput"] == SITE_MATERIAL


def test_persist_draft_without_site_material_writes_no_venue():
    from src.services.wenlv_persist import WenlvPersister

    captured = {}

    class _P(WenlvPersister):
        def _post(self, path, body):
            captured["body"] = body
            return {"success": True, "data": {}}

    _P().persist_draft("P1", "名", "narrative", {}, {"nodes": []}, {}, {})
    assert "venueId" not in captured["body"]
    assert "aiInput" not in captured["body"]


# ===== B1：点位清单必须带 id =====

def test_points_brief_includes_point_id():
    """点位 id 必须进提示词 —— 它是「节点↔点位」绑定的权威键。

    修复前 `_points_brief` 只取 name/address/remark/geo，AI 只拿到地点**名字**，
    随后 create_node 不写 venuePointId ⇒ 生产实测已发布产品 16/17 节点未绑点位，
    配合 nodeRequiresCredential（!!venuePointId || triggerType !== 'manual'）
    退化成「免凭证可远程触发」。
    """
    from src.crews.wenlv_creation_crew import _points_brief

    brief = _points_brief(SITE_MATERIAL)
    assert "p1" in brief, "点位 id p1 必须出现在清单里"
    assert "p2" in brief, "点位 id p2 必须出现在清单里"
    assert "村口老槐树" in brief, "名字不能因为加 id 而丢"
    assert "古井" in brief


def test_points_brief_without_ids_still_lists_names():
    """对照：点位缺 id 时不得崩、名字仍要在（BFF 一律给 id，但调用方可能省略键）。"""
    from src.crews.wenlv_creation_crew import _points_brief

    brief = _points_brief({"points": [{"name": "无名点位"}]})
    assert "无名点位" in brief


def test_points_brief_empty_is_empty_string():
    """对照：无点位 → 空串（调用方靠它判断「要不要注入」）。"""
    from src.crews.wenlv_creation_crew import _points_brief

    assert _points_brief(None) == ""
    assert _points_brief({"points": []}) == ""


# ===== B2：点位清单必须注入关卡设计那一步 =====

def test_points_brief_injected_into_level_design():
    """关卡设计那一步必须收到点位清单（含 id）—— 它才是产出 LevelNode.venue_point_id 的一步。

    修复前：_points_brief 只喂剧本第 6 步 location，而 LevelNode 由**关卡设计**产出，
    该步 desc 只有「剧本产出：{script_out}」⇒ AI 无从知道任何点位 id。

    ⚠️ 本测试断言的是 `[p1] 村口老槐树`（带方括号 id 的**整行形态**），而不是裸的
    `村口老槐树` —— 后者会经**测试替身**泄漏进来：_CapturingOrch 对 location JSON
    硬编码返回 `"location": "村口老槐树"`，而整个 script_out 被 json.dumps 进
    「剧本产出：…」⇒ 与有没有注入**无关**，裸名字断言恒真、零判别力。
    """
    orch = _CapturingOrch()
    orch.run_draft("P7", "古镇寻印", site_material=SITE_MATERIAL)
    descs = _desc_for(orch, "level_design JSON")
    assert descs, "关卡设计 agent 应被调用"
    d = descs[0]
    assert "p1" in d, "点位 id p1 必须进关卡设计提示词"
    assert "[p1] 村口老槐树" in d, "点位 id + 名字必须同行进关卡设计提示词"
    assert "venue_point_id" in d, "必须明确点出要填的字段名"


def test_level_design_without_site_material_keeps_prompt_unchanged():
    """对照：不传 site_material 时关卡设计提示词不追加任何点位注入（向后兼容）。

    ⚠️ 此处断言的是**注入内容本身**（清单表头 + 待填字段名），而不是「村口老槐树」——
    后者会经**替身夹具**泄漏进来：_CapturingOrch 对 location JSON 硬编码返回
    {"location": "村口老槐树"}，而整个 script_out 被 json.dumps 进「剧本产出：…」，
    与 site_material 传没传无关（实测：按计划原文写 `"村口老槐树" not in d` 是本步唯一
    该绿却红的一条，红的原因在夹具不在实现）。
    """
    orch = _CapturingOrch()
    orch.run_draft("P8", "纯主题故事")
    d = _desc_for(orch, "level_design JSON")[0]
    assert "本场地的真实点位清单" not in d, "无 site_material 时不得追加点位清单"
    assert "venue_point_id" not in d, "无 site_material 时不得追加绑定说明"


def test_points_brief_line_format_is_exact():
    """钉住 B1 的行格式契约：`- [<id>] <名字>；…`，id 在**行首方括号**里、与名字同行。

    为什么单列一条：B1 自带的 3 条断言全是**子串存在性**（`"p1" in brief`），
    对「id 落在行内哪个位置」零判别力 —— 本仓实测：把 id 挪到行尾
    （渲染成 `- 村口老槐树 p1`）后，本条变红，而 B1 那 3 条**全部照绿**
    （变异后 `-k points_brief` 为 1 failed / 6 passed）。而「行首方括号」正是
    B2/B3 提示词里「从方括号里的 id 中选取」所依赖的全部语义。
    """
    import re
    from src.crews.wenlv_creation_crew import _points_brief

    lines = _points_brief(SITE_MATERIAL).splitlines()
    # 行数断言必须放最前：清单塌成一行时先抛 IndexError，看不到这条有信息的失败
    assert len(lines) == 3, f"一个点一行、行数与点数必须单射，实为 {len(lines)} 行：{lines}"
    assert lines[0].startswith("本场地的真实点位清单"), f"首行应是表头，实为 {lines[0]!r}"
    assert re.fullmatch(r"- \[p1\] 村口老槐树(；.*)?", lines[1]), lines[1]
    assert re.fullmatch(r"- \[p2\] 古井", lines[2]), lines[2]


def test_points_brief_blank_id_falls_back_to_name_only():
    """id 为空串时要降级成老格式，**不得**渲染出 `- [] 名字`。"""
    from src.crews.wenlv_creation_crew import _points_brief

    out = _points_brief({"points": [{"id": "", "name": "无名"}]})
    assert out.endswith("- 无名"), out
    assert "[]" not in out, f"空 id 不得渲染成方括号对：{out!r}"


def test_points_brief_keeps_upstream_order():
    """顺序即上游顺序，不得重排（AI 靠「第一个点位」之类的相对位置做语义对应）。"""
    from src.crews.wenlv_creation_crew import _points_brief

    out = _points_brief({"points": [{"id": "p2", "name": "乙"}, {"id": "p1", "name": "甲"}]})
    assert out.index("p2") < out.index("p1"), out


def test_points_brief_injected_into_level_design_retry():
    """重跑那一次的 desc 也必须带点位清单 —— 它只在 AI 首次产错时才走，最容易漏。

    判别力：把重跑 desc 末尾的 `{points_suffix}` 换成空串（首发那处不动），本条第 3 条
    断言（清单表头）必红，第 4/5 条因其后不再执行；那两条各自另有判别力（id 形态变异
    杀「[p1] 村口老槐树」、字段名变异杀「venue_point_id」）。
    而现行 18 条**一条都不红** —— 它们用的基类 `_CapturingOrch._validate` 恒返 `[]`
    （第 49-50 行），`errors` 为空 ⇒ 重跑循环首轮即 break，**重跑 desc 根本不会被构造**，
    注入与否在既有断言下不可观测。
    """

    class _RetryOnceOrch(_CapturingOrch):
        """首次校验失败 → 进 for 循环重跑 → 二次校验通过（替身不抛 StageFailedError）。"""

        def __init__(self):
            super().__init__()
            self.seen = 0

        def _validate(self, draft):
            self.seen += 1
            if self.seen == 1:
                return ["可达性错误：unlock_completed 引用的节点 NODE_1 无人 complete"]
            return []

    orch = _RetryOnceOrch()
    orch.run_draft("P9", "古镇寻印", site_material=SITE_MATERIAL)
    descs = _desc_for(orch, "level_design JSON")
    assert len(descs) == 2, f"应首发 1 次 + 重跑 1 次，实为 {len(descs)} 次"
    retry = descs[1]
    assert "上次关卡设计校验失败" in retry, "第二条必须是带错误清单的重跑 desc"
    # 只断言**只可能来自注入**的内容：script_out 里只有地点名，没有方括号 id
    assert "本场地的真实点位清单" in retry, f"重跑 desc 丢了点位清单：{retry[:120]}…"
    assert "[p1] 村口老槐树" in retry, "重跑 desc 必须带点位 id + 名字"
    assert "venue_point_id" in retry, "重跑 desc 必须带绑定字段说明"


# ===== B5：未绑点数必须带进出稿结果 =====

class _FakeRedis:
    """最小 redis 替身：只为断言状态机，不连真库（与 `test_wenlv_creation_crew.py` 里同款）。

    🔴 **必须有它**：`_CapturingOrch.__init__` 走的是 `super().__init__(redis=None)`，而
    `_set_state` 在 `self.redis` 为假时**直接 return、什么都不存**，`_get_state` 也只会返回
    `{"status": "CREATED", "output": {}}` ⇒ 不塞替身的话，下面那条 state 断言
    **无论实现怎么写都必然 KeyError**（恒红，且红的原因与实现无关 —— 是夹具缺件，
    不是被测对象有问题）。本仓无 `conftest.py`、`tests/` 不是包，故在本文件里就地定义，
    不要跨测试模块 import。
    """

    def __init__(self):
        self.store = {}

    def get(self, k):
        return self.store.get(k)

    def set(self, k, v):
        self.store[k] = v

    def expire(self, k, ttl):
        pass


def test_run_draft_carries_unbound_count_into_state():
    """P3：nodes_unbound 由 apply_draft 的 persist_draft 返回，透传到 apply 结果。"""
    orch = _CapturingOrch()
    orch.redis = _FakeRedis()
    rec = _RecordingPersister()
    rec.persist_draft = lambda *a, **k: {
        "product_id": "P9", "status": "draft", "nodes_unbound": ["NODE_3", "NODE_7"],
    }
    orch.persister = rec
    # run_draft 只存草稿区，不直接落库
    res = orch.run_draft("P9", "古镇寻印", site_material=SITE_MATERIAL)
    assert res["status"] == "DRAFT_READY"
    # apply_draft 才返回 nodes_unbound
    apply_res = orch.apply_draft("P9")
    assert apply_res["output"]["nodes_unbound"] == ["NODE_3", "NODE_7"]


def test_run_draft_without_unbound_key_is_empty_list():
    """对照：persist_draft 不返回 nodes_unbound 时，apply 结果用 [] 兜底。"""
    orch = _CapturingOrch()
    rec = _RecordingPersister()
    rec.persist_draft = lambda *a, **k: {"product_id": "P10", "status": "draft"}
    orch.persister = rec
    orch.run_draft("P10", "主题", site_material=SITE_MATERIAL)
    apply_res = orch.apply_draft("P10")
    assert apply_res["output"]["nodes_unbound"] == []
