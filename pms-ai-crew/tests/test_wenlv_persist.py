"""落库客户端测试：映射逻辑（mock HTTP，不真实调 pms-server）。"""
import httpx
import pytest

from src.services.wenlv_persist import (
    WenlvPersister, build_wenlv_condition, invert_wenlv_condition,
    build_level_from_product_full, build_visual_from_product_full,
    resolve_venue_point_id,
)


def test_build_condition_single_ref():
    cond = build_wenlv_condition(collected=["CLUE_1"], completed=[])
    assert cond == {"type": "all", "conditions": [
        {"type": "ref", "ref": {"kind": "collected", "id": "CLUE_1"}},
    ]}


def test_build_condition_multiple_refs():
    cond = build_wenlv_condition(collected=["CLUE_1", "CLUE_2"], completed=["NODE_1"])
    assert len(cond["conditions"]) == 3


def test_build_condition_empty_is_null():
    assert build_wenlv_condition([], []) is None


def _fake_client(calls):
    class FakeResp:
        def __init__(self, data): self._d = data
        def json(self): return self._d
        def raise_for_status(self): pass

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def post(self, url, params=None, json=None):
            calls.append((url, json))
            return FakeResp({"success": True, "data": {"id": (json or {}).get("id", "uuid")}})
        def patch(self, url, json=None):
            # 与 post 同一台账形状 `(url, json)`，既有断言 `calls[0][1]` 的读法不变
            calls.append((url, json))
            return FakeResp({"success": True, "data": dict(json or {}, id="r1")})
    return FakeClient


def test_create_node_sends_location(monkeypatch):
    """节点线下点位（location）必须落库 —— 它是「虚实结合」唯一可靠的数据来源。

    2026-09-12 实测：AI 产出 11/11 节点都带真实点位名（如「舞阳河渡口·青灯码头」），
    但 create_node 原先不发该字段，这批产出全丢；注释里声称的兜底路径
    products.config.location_map 实际从未写入。

    另一个候选来源 location_mapping.mappings 不可用：其 chapter_id 实测填的是 END_*
    （结局 id）而非节点 id，与 node.id 对不上。故 node.location 是唯一来源。
    """
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_node("P1", {
        "id": "NODE_OPENING_LAMP", "title": "青灯码头",
        "location": "舞阳河渡口·青灯码头",
    })
    assert calls[0][1]["location"] == "舞阳河渡口·青灯码头"


def test_create_node_location_absent_is_none(monkeypatch):
    """AI 没给 location 时显式发 null（而非缺键），语义与「无条件」一致、便于排查。"""
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_node("P1", {"id": "NODE_2", "title": "无点位节点"})
    assert calls[0][1]["location"] is None


def test_create_ending_sends_priority(monkeypatch):
    """结局 priority 必须落库 —— 引擎侧已改为按 priority 解析（大者胜）。

    缺这一跳，AI 产出的 priority 恒定落成 0，解析退化成 id 字典序，阶梯形同虚设。
    """
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_ending("P1", {
        "id": "END_1", "title": "真相大白", "text": "…",
        "collected_ids": ["CLUE_1"], "reward_id": "REWARD_1", "priority": 5,
    })
    assert calls[0][1]["priority"] == 5


def test_create_ending_priority_absent_is_zero(monkeypatch):
    """AI 没给 priority 时落 0（缺省档），不落 None —— 引擎按 int 比较，None 会炸。"""
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_ending("P1", {"id": "END_2", "title": "平淡收场"})
    assert calls[0][1]["priority"] == 0


def test_persister_payload_uses_semantic_id(monkeypatch):
    """落库时用预生成的语义 id（幂等），不依赖 pms-server 生成 uuid。"""
    calls = []

    class FakeResp:
        def __init__(self, data): self._d = data
        def json(self): return self._d
        def raise_for_status(self): pass

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): pass
        def post(self, url, params=None, json=None):
            calls.append((url, json))
            return FakeResp({"success": True, "data": {"id": (json or {}).get("id", "uuid")}})

    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", FakeClient)
    p = WenlvPersister()
    p.create_product("P1", "测试", mode="narrative")
    assert calls[0][1]["id"] == "P1"


# =====================================================================================
# T11：读回方向 —— invert_wenlv_condition / build_*_from_product_full / get_product_full
# =====================================================================================

# 判据 1（最硬的一条）：对 build_wenlv_condition 的**全部**输出形状做往返自证。
# 这一条同时钉住两个函数：任一侧被改而另一侧没跟上，往返立刻不等。
# 四例覆盖：两列表都非空 / 只有 collected / 只有 completed / 两者都空（build 返回 None）。
@pytest.mark.parametrize("collected,completed", [
    (["CLUE_1"], ["NODE_1"]),          # 两列表都非空
    (["CLUE_1", "CLUE_2"], []),        # 只有 collected
    ([], ["NODE_1"]),                  # 只有 completed
    ([], []),                          # 两者都空 → build 返回 None
])
def test_invert_roundtrip_of_build_output(collected, completed):
    cond = build_wenlv_condition(collected, completed)
    assert invert_wenlv_condition(cond) == (collected, completed)


def test_invert_roundtrip_preserves_order():
    """顺序必须与输入一致（collected 在前、completed 在后），往返才有意义。"""
    assert invert_wenlv_condition(build_wenlv_condition(["C2", "C1"], ["N2", "N1"])) == (
        ["C2", "C1"], ["N2", "N1"])


def test_invert_none_condition_is_two_empty_lists():
    assert invert_wenlv_condition(None) == ([], [])


# 判据 6 的单元层：编辑器造得出来、但 build_wenlv_condition 产不出来的形状，
# 一律返回 None（回落）而不是抛 —— 抛会让 run_refine 在用户自己配过逻辑的节点上 500。
@pytest.mark.parametrize("cond,why", [
    ({"type": "any", "conditions": [{"type": "ref", "ref": {"kind": "collected", "id": "C1"}}]},
     "编辑器「任一满足 OR」"),
    ({"type": "nofM", "n": 1, "of": [{"type": "ref", "ref": {"kind": "collected", "id": "C1"}}]},
     "编辑器「至少 N 个满足」（子项键是 of）"),
    ({"type": "ref", "ref": {"kind": "collected", "id": "C1"}}, "裸 ref，无 all 包裹"),
    ({"type": "all", "conditions": [{"type": "ref", "ref": {"kind": "visited", "id": "N1"}}]},
     "第三种 kind visited"),
    ({"type": "all", "conditions": [{"type": "ref", "ref": {"kind": "whatever", "id": "X"}}]},
     "未知 kind"),
    ({"type": "all", "conditions": [{"type": "all", "conditions": []}]}, "嵌套子条件"),
    ({"type": "nope", "conditions": []}, "未知 type"),
    ({"type": "all"}, "缺 conditions 键"),
    ("不是 dict", "形状根本不是条件树"),
])
def test_invert_returns_none_for_shapes_build_cannot_produce(cond, why):
    assert invert_wenlv_condition(cond) is None, why


# -------------------------------------------------------------------------------------
# /full（扁平 camelCase 库行）→ AI 产出形状（嵌套 snake_case）
# -------------------------------------------------------------------------------------

def _full_node(nid="NODE_1", **over):
    n = {
        "id": nid, "nodeType": "scene", "title": "青灯码头", "storyText": "夜色里灯影摇晃",
        "triggerType": "qrcode", "triggerCredential": "TK-1",
        "location": "舞阳河渡口·青灯码头", "displayLocation": "青灯码头（点位名）",
        "unlockCondition": {"type": "all", "conditions": [
            {"type": "ref", "ref": {"kind": "collected", "id": "CLUE_1"}},
        ]},
        "effects": {"grant": ["CLUE_2"], "complete": [nid]},
        "interactions": [{"type": "judge", "question": "?", "answer": "true"}],
    }
    n.update(over)
    return n


def _full_data(**over):
    d = {"id": "P1", "name": "测试产品", "theme": {}, "nodes": [], "collectibles": [],
         "endings": [], "rewards": [], "tiers": []}
    d.update(over)
    return d


def test_build_level_from_full_is_ai_shaped():
    """判据 2：建出的 level 与 AI 产出同构（snake_case），解锁条件从 unlockCondition 还原。"""
    level = build_level_from_product_full(_full_data(
        nodes=[_full_node()],
        collectibles=[{"id": "CLUE_1", "name": "灯芯", "type": "clue", "rarity": "rare",
                       "description": "半截灯芯", "image": "http://img", "stampMeta": {}}],
        endings=[{"id": "END_1", "title": "真相", "text": "……", "rewardId": "REWARD_1",
                  "priority": 5, "image": "http://img",
                  "triggerCondition": {"type": "all", "conditions": [
                      {"type": "ref", "ref": {"kind": "collected", "id": "CLUE_1"}}]}}],
        tiers=[{"id": "TIER_1", "name": "集齐", "description": "d", "rewardId": "REWARD_1",
                "icon": "i", "condition": {"type": "all", "conditions": [
                    {"type": "ref", "ref": {"kind": "collected", "id": "CLUE_1"}}]}}],
        rewards=[{"id": "REWARD_1", "name": "船票", "type": "coupon", "value": "8折",
                  "merchantId": "M1", "storeId": "S1", "description": "d"}],
    ))
    assert set(level) == {"nodes", "collectibles", "endings", "tiers", "rewards"}
    n = level["nodes"][0]
    assert set(n) == {"id", "node_type", "title", "story_text", "trigger_type",
                      "trigger_credential", "location", "unlock_collected", "unlock_completed",
                      "grant_collectibles", "complete_nodes", "interactions"}
    assert n["node_type"] == "scene" and n["story_text"] == "夜色里灯影摇晃"
    assert n["trigger_type"] == "qrcode" and n["trigger_credential"] == "TK-1"
    assert n["unlock_collected"] == ["CLUE_1"] and n["unlock_completed"] == []
    assert n["grant_collectibles"] == ["CLUE_2"] and n["complete_nodes"] == ["NODE_1"]
    assert n["interactions"] == [{"type": "judge", "question": "?", "answer": "true"}]
    assert level["collectibles"][0] == {"id": "CLUE_1", "name": "灯芯", "type": "clue",
                                       "rarity": "rare", "description": "半截灯芯"}
    assert level["endings"][0] == {"id": "END_1", "title": "真相", "text": "……",
                                   "collected_ids": ["CLUE_1"], "reward_id": "REWARD_1",
                                   "priority": 5}
    assert level["tiers"][0] == {"id": "TIER_1", "name": "集齐", "description": "d",
                                 "collected_ids": ["CLUE_1"], "reward_id": "REWARD_1"}
    assert level["rewards"][0] == {"id": "REWARD_1", "name": "船票", "type": "coupon",
                                   "value": "8折"}


def test_build_level_location_comes_from_raw_column_not_display_location():
    """location 必须取**原始文本列**，不是 displayLocation（只读展示投影）。

    拿 displayLocation 当基线 ⇒ 点位名被灌进文本列；节点日后解绑点位、展示回退到文本列时
    就印错地名（admin/wenlv.ts:861-870 记的 2026-09-19 真实回归）。
    本用例把两列设成不同的值，谁被取走动一眼可见。
    """
    level = build_level_from_product_full(_full_data(nodes=[_full_node()]))
    assert level["nodes"][0]["location"] == "舞阳河渡口·青灯码头"
    assert "displayLocation" not in level["nodes"][0]


def test_build_level_unlock_completed_restored_from_condition():
    cond = build_wenlv_condition(["CLUE_1"], ["NODE_X"])
    level = build_level_from_product_full(_full_data(nodes=[_full_node(unlockCondition=cond)]))
    assert level["nodes"][0]["unlock_collected"] == ["CLUE_1"]
    assert level["nodes"][0]["unlock_completed"] == ["NODE_X"]


def test_build_level_returns_none_when_all_five_arrays_empty():
    """五张表全空 = 库里该 stage 无内容 ⇒ None（回落 state），不能伪装成「有基线」。"""
    assert build_level_from_product_full(_full_data()) is None


@pytest.mark.parametrize("bad_cond", [
    {"type": "any", "conditions": [{"type": "ref", "ref": {"kind": "collected", "id": "C1"}}]},
    {"type": "nofM", "n": 1, "of": [{"type": "ref", "ref": {"kind": "collected", "id": "C1"}}]},
    {"type": "ref", "ref": {"kind": "collected", "id": "C1"}},
    {"type": "all", "conditions": [{"type": "ref", "ref": {"kind": "visited", "id": "N1"}}]},
])
def test_build_level_falls_back_on_editor_made_condition(bad_cond):
    """库里有内容、但某节点的解锁条件形状认不出 ⇒ **整份**返回 None（不许只丢那一条）。"""
    assert build_level_from_product_full(_full_data(nodes=[_full_node(unlockCondition=bad_cond)])) is None


def test_build_level_endings_and_tiers_with_completed_ref_fall_back():
    """结局/档位的 AI 形状只有 collected_ids；completed 引用无处安放 ⇒ 回落，不静默丢。"""
    cond = build_wenlv_condition([], ["NODE_X"])
    assert build_level_from_product_full(_full_data(
        endings=[{"id": "END_1", "title": "t", "triggerCondition": cond}])) is None
    assert build_level_from_product_full(_full_data(
        tiers=[{"id": "TIER_1", "name": "t", "condition": cond}])) is None


def test_build_level_fallback_is_not_silent(caplog):
    """「回落」必须有日志说明为什么 —— 静默回落等于没人能事后回答「为什么没走库」。"""
    import logging
    with caplog.at_level(logging.INFO, logger="src.services.wenlv_persist"):
        build_level_from_product_full(_full_data(nodes=[_full_node(
            unlockCondition={"type": "any", "conditions": []})]))
    assert any("形状" in r.message for r in caplog.records)


# 判据 4：visual 薄基线 —— 只含消费面那两个字段，取值来自 theme。
def test_build_visual_from_full_thin_baseline():
    assert build_visual_from_product_full(
        _full_data(theme={"primaryColor": "#C8102E", "templateId": "tpl-guochao",
                          "logo": "x", "bgImage": "y"})) == {
        "colors": {"primary": "#C8102E"}, "template_id": "tpl-guochao"}


def test_build_visual_from_full_none_when_theme_empty():
    assert build_visual_from_product_full(_full_data(theme={})) is None
    assert build_visual_from_product_full(_full_data(theme={"logo": "x"})) is None
    assert build_visual_from_product_full(_full_data(theme=None)) is None


# -------------------------------------------------------------------------------------
# 判据 5：404（库里没有）必须与网络失败/5xx（读失败）可区分
# -------------------------------------------------------------------------------------

def _fake_get_client(handler, calls=None):
    """GET 版 httpx.Client 替身（与 _fake_client 同款结构）：

    只负责把 get() 转给 handler，响应对象由 handler 用 `_resp()` 造 ——
    状态码与「raise_for_status 真的会抛」这两件事必须由用例自己控制，
    因为 `_get` 的「404 与其他非 2xx 分道」全靠它。
    """
    class FakeClient:
        def __init__(self, *a, **k):
            if calls is not None:
                calls.append(("client", k))

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, **k):
            if calls is not None:
                calls.append((url, k))
            return handler(url)

        def post(self, *a, **k):
            raise AssertionError("读回路径不应走 POST")

    return FakeClient


def _install_get(monkeypatch, handler, calls=None):
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client",
                        _fake_get_client(handler, calls))


def _resp(status_code, payload, raises=False):
    """raises=True 的响应会像 httpx 一样在 raise_for_status() 处抛。

    刻意用显式布尔而不是比较状态码：本仓禁止「大于等于」形式的判据
    （数量型契约会让判据变成永真），虽然是 HTTP 语义不是数量，也不给它留误报口子。
    """
    class R:
        def __init__(self):
            self.status_code = status_code

        def json(self):
            return payload

        def raise_for_status(self):
            if raises:
                raise httpx.HTTPStatusError(
                    f"HTTP {self.status_code}",
                    request=httpx.Request("GET", "http://test"), response=self)
    return R()


def test_get_product_full_returns_data_on_success(monkeypatch):
    calls = []
    _install_get(monkeypatch,
                 lambda url: _resp(200, {"success": True, "data": {"id": "P1"}}), calls)
    assert WenlvPersister().get_product_full("P1") == {"id": "P1"}
    # 路径与鉴权头（与 _post 同款）都接上了 —— 这是「调用点」而不是「实现体」的核验
    assert calls[1][0] == "/api/admin/wenlv/products/P1/full"
    assert calls[0][1]["headers"]["X-Internal-Service-Token"] == WenlvPersister().token
    assert calls[0][1]["timeout"] == 20.0      # 与 _post 同款超时风格


def test_get_product_full_404_means_absent(monkeypatch):
    """404 ⇒ None（库里没有这个产品），不抛。"""
    _install_get(monkeypatch, lambda url: _resp(
        404, {"success": False, "error": "内容产品不存在"}, raises=True))
    assert WenlvPersister().get_product_full("P1") is None


@pytest.mark.parametrize("status", [500, 502, 403])
def test_get_product_full_other_status_raises(monkeypatch, status):
    """5xx/403 ⇒ 抛（读失败），**表现与 404 不同** —— 不许吞成「库里没有」。"""
    _install_get(monkeypatch, lambda url: _resp(
        status, {"success": False, "error": "boom"}, raises=True))
    with pytest.raises(httpx.HTTPStatusError):
        WenlvPersister().get_product_full("P1")


def test_get_product_full_connect_error_raises(monkeypatch):
    def boom(url):
        raise httpx.ConnectError("connection refused")
    _install_get(monkeypatch, boom)
    with pytest.raises(httpx.ConnectError):
        WenlvPersister().get_product_full("P1")


def test_get_product_full_bad_envelope_raises(monkeypatch):
    """2xx 但不是 {success:true,data:{…}} 封套 ⇒ 抛，不冒充「库里没有」。"""
    _install_get(monkeypatch, lambda url: _resp(200, {"success": False, "error": "什么"}))
    with pytest.raises(ValueError):
        WenlvPersister().get_product_full("P1")


def test_get_product_full_success_false_with_data_still_raises(monkeypatch):
    _install_get(monkeypatch, lambda url: _resp(200, {"success": False, "data": {"id": "P1"}}))
    with pytest.raises(ValueError):
        WenlvPersister().get_product_full("P1")


# ===== B4：点位绑定的解析与兜底 =====

_POINTS = [
    {"id": "p1", "name": "村口老槐树"},
    {"id": "p2", "name": "古井"},
]


def test_resolve_prefers_ai_point_id():
    """一级：AI 给的 id 在本场地点位集里时**压过**二级的 location 文本兜底。

    ⚠️ 夹具的 id 与 location 文本必须指向**不同的点**，否则两级给出同一个答案、
    这条用例就没有观测能力（`_POINTS` 里 p1 = 村口老槐树、p2 = 古井）。
    """
    assert resolve_venue_point_id({"venue_point_id": "p2", "location": "村口老槐树"}, _POINTS) == "p2"


def test_resolve_rejects_foreign_point_id(caplog):
    """一级的丢弃路径：AI 编造/串号（id 不在本场地）→ 该 id 被丢弃、改由二级 location 兜底；本例 location 也匹配不上，故整体落成 None。

    这是本 Task 的核心：一个不存在的 venuePointId 会让 /trigger 返回
    「点位不存在或已删除」403，节点**永远点不开** —— 比不绑还糟。

    丢弃时**被丢弃的原值必须进日志**：静默丢弃等于没人能事后回答「AI 到底给了什么」。
    """
    import logging
    with caplog.at_level(logging.INFO, logger="src.services.wenlv_persist"):
        assert resolve_venue_point_id({"venue_point_id": "vp-foreign", "location": "不存在的地方"}, _POINTS) is None
    assert any("vp-foreign" in r.message for r in caplog.records)


def test_resolve_falls_back_to_exact_location_match():
    """二级：AI 漏给 id 但 location 与点位名**精确相等** → 文本兜底回填。"""
    assert resolve_venue_point_id({"location": "古井"}, _POINTS) == "p2"


def test_resolve_location_fuzzy_match_is_not_used():
    """对照：location 带修饰（非精确相等）时**不**回填 —— 精确匹配召回率低但不会绑错。"""
    assert resolve_venue_point_id({"location": "龙门古镇的古井旁边"}, _POINTS) is None


def test_resolve_no_points_returns_none():
    """对照：没有点位清单（产品未归属场地）时一律 None，且不抛。"""
    assert resolve_venue_point_id({"venue_point_id": "p1", "location": "古井"}, None) is None
    assert resolve_venue_point_id({}, []) is None


def test_create_node_sends_venue_point_id(monkeypatch):
    """create_node 必须把 venuePointId 放进 HTTP body（字段名对齐 pms-server 的 nodeSchema）。"""
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_node("P1", {
        "id": "NODE_1", "title": "古井旁", "location": "古井", "venue_point_id": "p2",
    }, points=_POINTS)
    assert calls[0][1]["venuePointId"] == "p2"


def test_create_node_venue_point_id_absent_is_none(monkeypatch):
    """未绑点位 → 显式发 null（而非缺键），语义与「无需到场」一致、便于排查。"""
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_node("P1", {"id": "NODE_2", "title": "开场"}, points=_POINTS)
    assert calls[0][1]["venuePointId"] is None


def test_create_node_rejects_foreign_id_in_body(monkeypatch):
    """端到端：串号的 id 不得出现在 body 里。"""
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().create_node("P1", {
        "id": "NODE_3", "title": "x", "venue_point_id": "vp-foreign",
    }, points=_POINTS)
    assert calls[0][1]["venuePointId"] is None


def test_persist_draft_gives_no_bindings_when_product_has_no_venue(monkeypatch):
    """🔴 产品无场地时**一个绑定都不能发** —— 服务端会 400，后果是**部分落库 + 中断后续**。

    `pms-server/src/routes/admin/wenlv.ts:1118`（节点 POST）：
        if (!product.venueId) return c.json({...'产品未归属场地，不能引用点位'}, 400);
    该端点是**单节点 POST**（`nodeSchema.safeParse(body)` → 单行 insert）；所谓「循环」是
    **客户端** `persist_draft` 里的 `for n in nodes`。故一次 400 抛异常只**中断循环** ——
    此前已 POST 成功的节点仍在库里，准确说法是「**部分落库 + 后续节点中断**」，
    不是「整批拒绝」。而带绑定的节点必然 400、循环死在该节点 ⇒ 已 POST 的那几行留在库里、
    其余节点（连同结局/档位）整体缺失 —— 产品是「**缺节点**」而不是「一半节点有绑定」，
    比不绑更难排查 ⇒「比不绑更糟」的结论不变，故这里必须钉住。

    ⚠️ 位置参数顺序以 `wenlv_persist.py` 里 `persist_draft` 的**实际签名**为准。
       本计划写作时**已实测**（ast 取 args + defaults）：
           REQUIRED: (product_id, name, mode, positioning, level, visual, config)
           OPTIONAL: (site_material)
       ⇒ **`config` 是必填的第 7 个位置参数**，漏传会 `TypeError`（初稿漏了，2026-09-21 订正）。
       若你实测的签名与此不符，以实际签名为准改调用，**不要**改断言。
    """
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().persist_draft(
        "P1", "主题", "narrative", {},
        {"nodes": [{"id": "NODE_1", "title": "t", "venue_point_id": "p1",
                    "location": "古井"}]},
        {},
        {},  # config —— 必填（第 7 个位置参数），不可省
        # 关键：有点位、**没有 venue**
        site_material={"points": [{"id": "p1", "name": "古井"}]},
    )
    node_bodies = [b for (url, b) in calls if url.endswith("/nodes")]
    assert node_bodies, "应有节点落库调用"
    assert all(b.get("venuePointId") is None for b in node_bodies), \
        "产品无场地时不得发任何非空 venuePointId（服务端会 400，后续节点落库中断）"


def test_persist_draft_binds_nodes_when_product_has_venue(monkeypatch):
    """🟢 承重：产品**有**场地 + 点位 ⇒ 节点必须真的带上 venuePointId 落库。

    这条是 `persist_draft` 正向跳的唯一覆盖。缺了它，把
        points = ((site_material or {}).get("points") or []) if venue_id else []
    改成恒 `points = []`（或改错 venue_id 的取法），全套用例一条都不红 ——
    而线上后果正是「16/17 个节点免凭证、可从首页远程触发」。
    """
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    WenlvPersister().persist_draft(
        "P1", "主题", "narrative", {},
        # ⚠️ 键名以 `create_node` / `resolve_venue_point_id` 实际吃进去的为准：
        #    上面那条负向用例写的是 `venue_point_id` + `location`，照它抄。
        {"nodes": [{"id": "NODE_1", "title": "t", "venue_point_id": "p1",
                    "location": "古井"}]},
        {},
        {},  # config —— 必填的第 7 个位置参数，不可省
        # 与负向用例唯一的差别：这次**有 venue**
        site_material={"venue": {"id": "v1"},
                       "points": [{"id": "p1", "name": "古井"}]},
    )
    node_bodies = [b for (url, b) in calls if url.endswith("/nodes")]
    assert node_bodies, "应有节点落库调用"
    assert node_bodies[0]["venuePointId"] == "p1", \
        "有场地 + 点位时，AI 给的 id 必须被解析并落进 venuePointId"


def test_persist_draft_returns_unbound_node_ids(monkeypatch):
    """🔴 生产者侧的 return 契约：未绑点位的节点 id 必须出现在**返回值**里。

    这条钉的是 B5 那条链的**上游端点** —— 消费侧
    （`wenlv_creation_crew.run_draft` 的 `out["nodes_unbound"]`）用的是
    `(persist_res or {}).get("nodes_unbound", [])`，即**键缺失时会静默变成「0 个未绑」**。
    没有这条用例，把 `unbound = [...]` 改成 `unbound = []` 就不会红，
    而后果是「AI 没绑上」与「AI 认为无需绑」在出稿结果里长得一模一样 ——
    用户会拿到一个「上线后才发现 16/17 节点免凭证」的产品。
    ⚠️ 但**「或把键名改掉，全套用例一条都不红」这句不成立**（原稿如此写，2026-09-21 实测推翻）：
    把返回字典的键名改成 `unbound_nodes`，本条的 `res["nodes_unbound"]` 与兄弟用例
    `test_persist_draft_always_returns_nodes_unbound_key` 的 `"nodes_unbound" in res`
    **两条同时变红** —— 键名有兄弟用例守着，不存在「改键名也无人发现」这条缝。
    """
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    res = WenlvPersister().persist_draft(
        "P1", "主题", "narrative", {},
        {"nodes": [
            {"id": "NODE_1", "title": "已绑", "venue_point_id": "p1"},
            # ⚠️ 「未绑」必须**既没有** venue_point_id、**也没有**能匹配上点位名的 location ——
            #    否则会走 `resolve_venue_point_id` 的二级文本兜底解出点来，这条用例就测不到未绑。
            # ⚠️ **未绑节点必须是两个、且两个都不能有 location**，别把它「简化」回一个
            #    （2026-09-21 质量审查实测）：未绑数为 1 时，`unbound` 只报前 1 个（`unbound[:1]`）
            #    与本条断言**恰好同形** ⇒ 零判别力，而「16/17 未绑被报成 1 未绑」正是本条的靶子。
            #    两个未绑节点顺带把**顺序**也钉住了（只有一个元素时顺序是空真）。
            {"id": "NODE_2", "title": "未绑甲"},
            {"id": "NODE_3", "title": "未绑乙"},
        ]},
        {},
        {},  # config —— 必填的第 7 个位置参数，不可省
        site_material={"venue": {"id": "v1"}, "points": [{"id": "p1", "name": "古井"}]},
    )
    assert res["nodes_unbound"] == ["NODE_2", "NODE_3"], \
        "未绑点位的节点 id 必须**全部、按节点顺序**随 persist_draft 的返回值一起交出来（消费侧靠它报数）"


def test_persist_draft_always_returns_nodes_unbound_key(monkeypatch):
    """🔴 不变量：**无论有没有未绑节点，这个键都必须存在**（消费侧 `.get(..., [])` 的前提）。

    `.get("nodes_unbound", [])` 的默认值**只在键缺失时生效**，而键缺失 = 把「未测」报成 0。
    故这里钉住「全绑上时该键**仍在**，且为空列表」——
    而不是允许 `persist_draft` 在无未绑时省掉这个键（省掉就等于把最坏的情形显示成最好的）。
    """
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    res = WenlvPersister().persist_draft(
        "P1", "主题", "narrative", {},
        {"nodes": [{"id": "NODE_1", "title": "已绑", "venue_point_id": "p1"}]},
        {},
        {},  # config —— 必填的第 7 个位置参数，不可省
        site_material={"venue": {"id": "v1"}, "points": [{"id": "p1", "name": "古井"}]},
    )
    assert "nodes_unbound" in res, \
        "键必须恒在 —— 消费侧的 .get(..., []) 默认值只有在键缺失时才生效，那正是把未测报成 0"
    assert res["nodes_unbound"] == []


def test_resolve_prefers_authoritative_id_over_location_text():
    """一级（AI 给的 id）必须压过二级（location 文本兜底）—— 两者的结论**必须不同**才有判别力。

    ⚠️ 这条用例的存在理由：既有的 `test_resolve_prefers_ai_point_id` 曾经把夹具写成
    `{"venue_point_id": "p2", "location": "古井"}`，两个解**指向同一个点**
    （`_POINTS` 里 p2 = 古井），于是「id 优先」与「文本兜底」不可区分 —— 删掉整个一级分支也不红。
    这里刻意让两者**指向不同的点**：id 给 p1、location 文本给 p2，只有一级生效才会绿。
    """
    node = {"id": "N1", "venue_point_id": "p1", "location": "古井"}  # 古井 → p2
    assert resolve_venue_point_id(node, _POINTS) == "p1"


def test_resolve_tolerates_point_without_id():
    """点位项缺 `id` 时不得抛 —— 本函数的立论是「出稿不该因为一个坏 id 整体失败」。

    ⚠️ **改前**：`valid = {p.get("id") for p in points if ...}` 已经把无 id 的项过滤掉了，
    但二级的 name 匹配**直接遍历 `points`**、用的是 `p["id"]` —— 两者口径不一致，
    无 id 的项排在前面时必炸（而 `persist_draft` 是先算 unbound 再落库 ⇒ 一炸就是整次出稿 FAILED）。
    现二级已改用 `p.get("id")`、与 `valid` 同口径（B4c 的 I2），本用例即钉住这一改。
    """
    points = [{"name": "古井"}, {"id": "p1", "name": "古井"}]
    assert resolve_venue_point_id({"id": "N1", "location": "古井"}, points) == "p1"


def test_resolve_warning_is_logged_once_per_node(caplog, monkeypatch):
    """同一个节点的「id 被丢弃」warning 只能打一条 —— 打两条会让人怀疑「落库了两次」。

    ⚠️ 改前：`persist_draft` 先为 unbound 算一次、`create_node` 再算一次 ⇒ **2 条/节点**。
    """
    import logging
    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))
    with caplog.at_level(logging.WARNING, logger="src.services.wenlv_persist"):
        WenlvPersister().persist_draft("P1", "主题", "narrative", {}, {
            # ⚠️ 订正（2026-09-21 实测）：`title` 是 `create_node` 的**直接下标**（`node["title"]`），
            # 缺了它会先炸 `KeyError: 'title'`（`create_node` 里的 `node["title"]`），压根走不到「warning 打了几条」的断言。
            # 键集与本文件既有夹具一致（`test_persist_draft_gives_no_bindings_when_product_has_no_venue`
            # 里的 `{"id": "NODE_1", "title": "t", …}`）。此处不写行号：行号会随本文改动漂移。
            "nodes": [{"id": "N1", "title": "t", "venue_point_id": "vp-foreign", "location": "古井"}],
        }, {}, {}, site_material={"venue": {"id": "v1"}, "points": _POINTS})
    hits = [r for r in caplog.records if "vp-foreign" in r.message]
    assert len(hits) == 1, f"期望 1 条，实得 {len(hits)}"



def test_save_research_路径与_finished_at_哨兵(monkeypatch):
    """`save_research` 的**跨服务契约**：路径 + `finished_at` 的中转形状。

    钉两件「改错了不会当场报错、只会静默丢东西」的事：
      ① 路径 `/api/admin/wenlv-research/research/{id}` —— 服务端是
         `src/index.ts` 的 `app.route('/api/admin/wenlv-research', …)` 加上
         `routes/admin/wenlv-research.ts` 的 `route.patch('/research/:id')`。
         拼错了得到 **404**，而在「逐节回写」这个位置 404 等于**静默丢进度**
         （用户看到进度条不动，日志里只有一行 HTTP 错误）。
      ② `finished_at=True` 是**布尔哨兵**，由本方法换成 ISO **字符串**。直接传
         `datetime` 对象会在 json 序列化处 `TypeError`；格式不对则服务端
         （`z.coerce.date().nullable()`）400 —— 同样是**静默丢终态**，那行会停在
         running 直到看门狗 15 分钟后放行重跑。
    """
    from datetime import datetime

    calls = []
    monkeypatch.setattr("src.services.wenlv_persist.httpx.Client", _fake_client(calls))

    # ① 逐节回写：不带哨兵 ⇒ body 里连键都不该有（服务端语义是「只写提供了的键」，
    #    整体替换；多送一个 null 会把 finishedAt 清掉）
    WenlvPersister().save_research(
        "r1", status="running", progress={"history": "done"},
        search_log=[{"section": "history", "truncated": True}],
    )
    url, body = calls[0]
    assert url == "/api/admin/wenlv-research/research/r1"
    assert body["status"] == "running"
    assert body["search_log"][0]["truncated"] is True
    assert "finished_at" not in body, "没传哨兵就不该产出该键"

    # ② 终态回写：哨兵 ⇒ ISO 字符串，且**整个 body 可 json 序列化**
    calls.clear()
    WenlvPersister().save_research("r1", status="ready", report={}, error="", finished_at=True)
    _url, body = calls[0]
    import json
    json.dumps(body)                                   # datetime 对象在这一行就 TypeError
    assert isinstance(body["finished_at"], str)
    datetime.fromisoformat(body["finished_at"])        # 服务端 z.coerce.date() 的解析形状
    assert body["finished_at"] != "True", "哨兵不许原样透传成字符串 True"
