"""文化素材 AI 补充的服务层用例（不真实调 LLM / 不真实联网）。"""
import logging

from src.services.wenlv_material_assist import (
    MATERIAL_TYPE_CN,
    NO_SOURCE_NO_CONTENT_NOTE,
    ORGANIZED_NOTE,
    build_search_query,
    decide_found,
    normalize_sources,
    numbered_sources,
    pick_used_sources,
)


# ---------- build_search_query ----------

def test_query_empty_when_no_title_and_no_content():
    """标题与内容都空 ⇒ 返回空串（调用方据此拒绝，**不要硬查**）。"""
    assert build_search_query(title="", content="", material_type="legend") == ""
    assert build_search_query(title="  ", content="  ") == ""


def test_query_includes_type_cn_and_place_and_title():
    q = build_search_query(
        venue_name="龙门古镇", city="黔南", point_name="古井",
        material_type="legend", title="锁井传说", content="王大爷说这井是明朝的",
    )
    assert "民间传说" in q
    assert "黔南/龙门古镇/古井" in q
    assert "锁井传说" in q
    assert "王大爷说这井是明朝的" in q


def test_query_without_place_falls_back_to_title_only():
    """场地/城市/点位都缺（新建场地时的常见态）也必须能拼出一句可检索的话。"""
    q = build_search_query(material_type="craft", title="竹编", content="")
    assert "非遗技艺" in q
    assert "「竹编」" in q
    assert "/" not in q.split("\n")[0]


def test_query_content_is_capped():
    """内容只截前 300 字进检索词 —— 一次检索的输入实测已 4.5k~5.8k tokens，
    不设上限的话长素材会把输入token推得更高（钱与延迟都涨）。"""
    q = build_search_query(title="x", content="字" * 500)
    assert q.count("字") == 300


def test_query_marks_content_as_first_hand():
    """内容要标明是采集员现场记录，避免模型把与之矛盾的说法写进答案。"""
    q = build_search_query(title="x", content="现场记录")
    assert "现场记录" in q
    assert "已知信息" in q


def test_material_type_cn_covers_all_six():
    """与服务端 WENLV_MATERIAL_TYPES 同集（改一边要改另一边）。"""
    assert set(MATERIAL_TYPE_CN) == {
        "history", "legend", "craft", "festival", "dialect", "other",
    }


# ---------- decide_found ----------

def test_found_requires_both_content_and_source():
    src = [{"title": "t", "site_name": "s", "url": "https://x/1"}]
    assert decide_found(content="有内容", sources=src) is True
    # 无来源 ⇒ 不算查到（这正是「不许无来源地说查到了」的落点）
    assert decide_found(content="有内容", sources=[]) is False
    # 无内容 ⇒ 不算查到
    assert decide_found(content="", sources=src) is False
    assert decide_found(content="   ", sources=src) is False


def test_organized_note_is_pinned_verbatim():
    """整理态那句绿字由**代码**拥有（不由模型写）—— 钉住全量相等，防被顺手改软。"""
    assert ORGANIZED_NOTE == "公网未查到你这条素材的独立来源；这段只整理了你的记录，没有新增内容。"


def test_no_source_no_content_note_is_pinned_verbatim():
    """「公网没查到 + 采集员自己也没写记录」那句同样**由代码拥有** —— 钉住全量相等。

    ⚠️ 它在 ops-app 的 `reasonMessage()` 里有一份**逐字副本**（跨服务两份，同 `ORGANIZED_NOTE`
    的惯例）。本条只钉本服务这一份；跨仓对拍要读另一个仓的文件，**不做成常驻用例**
    （会把两个服务的目录布局耦进来，也与本仓「测试不位置无关」的既有坑同族）。
    """
    assert NO_SOURCE_NO_CONTENT_NOTE == (
        "公网没查到这条素材的资料，你也还没写现场记录 —— 没有可以整理的内容。"
        "补几句现场看到、听到的，或把标题写得更具体，再试一次。"
    )


# ---------- normalize_sources ----------

def test_normalize_drops_items_without_url_and_dedups():
    raw = [
        {"title": "A", "site_name": "百度百科", "url": "https://x/1"},
        {"title": "B", "site_name": "某站", "url": "https://x/1"},   # 重复 url
        {"title": "C", "site_name": "无址"},                        # 无 url ⇒ 丢
        {"title": "D", "site_name": "空址", "url": ""},              # 空 url ⇒ 丢
        "不是字典",                                                  # 脏数据 ⇒ 丢
        {"title": "E", "site_name": "地方志", "url": "https://y/2"},
    ]
    out = normalize_sources(raw)
    assert [s["url"] for s in out] == ["https://x/1", "https://y/2"]
    assert out[0]["site_name"] == "百度百科"


def test_normalize_accepts_non_list():
    assert normalize_sources(None) == []
    assert normalize_sources({"url": "https://x/1"}) == []


def test_normalize_trims_and_fills_missing_title():
    out = normalize_sources([{"url": "  https://x/1  ", "site_name": " 某站 "}])
    assert out[0]["url"] == "https://x/1"
    assert out[0]["title"] == ""
    assert out[0]["site_name"] == "某站"


# ---------- 序号匹配：编号渲染 ↔ 编号解析 ----------

def test_numbering_shown_to_the_model_round_trips():
    """🔴 渲染给模型的编号与解析回来的编号必须是**同一套口径**。

    两处各写一份（比如渲染 0 起、解析按 1 起）的后果：模型照 A 报号、代码按 B 取源
    ⇒ 挂出去的是**别的**来源，而两边**都报成功**（跨跳丢参同族）。所以这条用例
    **两个方向都断言**：渲染行以 `i.` 开头，且 `pick_used_sources(..., [i])` 正好取回第 i 条。
    少了任何一半，「口径一致」这件事都只被验了一半。
    """
    lines = numbered_sources(SRC3).split("\n")
    assert len(lines) == len(SRC3)
    for i, s in enumerate(SRC3, start=1):
        assert lines[i - 1].startswith(f"{i}. "), f"第 {i} 行的编号不是 {i}"
        assert s["url"] in lines[i - 1], "行里必须能看见 url，模型才核得动"
        assert pick_used_sources(SRC3, [i]) == [s]


def test_numbered_sources_says_so_when_there_are_none():
    assert numbered_sources([]) == "（本次没有来源）"


def test_pick_used_sources_is_one_based_and_keeps_model_order():
    assert pick_used_sources(SRC3, [1]) == [SRC3[0]]
    assert pick_used_sources(SRC3, [3]) == [SRC3[2]]
    # 模型给的顺序即展示顺序（它按引用主次排的），不重排成来源列表的原序
    assert pick_used_sources(SRC3, [3, 1]) == [SRC3[2], SRC3[0]]


def test_pick_used_sources_drops_dups_and_out_of_range():
    assert pick_used_sources(SRC3, [2, 2]) == [SRC3[1]]                    # 去重
    assert pick_used_sources(SRC3, [0, 4, -1, 99]) == []                   # 编号从 1 起，越界丢
    assert pick_used_sources(SRC3, [2, 99, 1]) == [SRC3[1], SRC3[0]]       # 混合：合法的照收


def test_pick_used_sources_rejects_bool():
    """🔴 `True` 不许被当成 1 号来源。

    `bool` 是 `int` 的子类、`int(True) == 1` ⇒ 不显式挡的话，模型把格式写错成
    `[true, false]` 会被读成「引用了第 1 条」——一个**静默**的错误挂载。
    """
    assert pick_used_sources(SRC3, [True, False]) == []


def test_pick_used_sources_is_fail_closed_when_used_is_not_a_list():
    """模型没点名 ⇒ 没有凭证 ⇒ 空。

    ⚠️ 这一组是**整体收窄的兜底**：若哪天有人给契约加上默认值，缺省就会走到这里。
    写成「不是数组就当全用了」会把缺陷原样放回来（那正是「有来源」由检索结果的
    存在本身满足的形态）。元组也一并挡掉 —— 它是最像数组的非数组。
    """
    for bad in (None, 2, "2", {"1": True}, (1, 2)):
        assert pick_used_sources(SRC3, bad) == [], f"{bad!r} 不该被读成「引用了」"


def test_pick_used_sources_drops_entries_that_are_not_numbers():
    assert pick_used_sources(SRC3, [None, "x", {}, 2]) == [SRC3[1]]
    # 数字字符串照收（JSON 里 1 与 "1" 都可能出现），但**仍然要过范围检查**
    assert pick_used_sources(SRC3, ["2"]) == [SRC3[1]]
    assert pick_used_sources(SRC3, ["9"]) == []


# ---------- 每日配额 ----------

from src.services.wenlv_material_assist import (  # noqa: E402
    incr_and_check_quota, quota_key, release_quota,
)


class _FakeRedis:
    """最小 redis 替身：只实现配额用到的三个命令。"""

    def __init__(self):
        self.store = {}
        self.expires = {}

    def incr(self, k):
        self.store[k] = int(self.store.get(k, 0)) + 1
        return self.store[k]

    def decr(self, k):
        self.store[k] = int(self.store.get(k, 0)) - 1
        return self.store[k]

    def expire(self, k, ttl):
        self.expires[k] = ttl
        return True


def test_quota_key_shape():
    assert quota_key("u1", "20260923") == "wenlv:material-optimize:u1:20260923"


def test_quota_allows_up_to_limit():
    r = _FakeRedis()
    for i in range(1, 4):
        out = incr_and_check_quota(r, "u1", limit=3, day="20260923")
        assert out["allowed"] is True
        assert out["used"] == i
    assert r.store[quota_key("u1", "20260923")] == 3


def test_quota_rejects_over_limit():
    r = _FakeRedis()
    for _ in range(3):
        incr_and_check_quota(r, "u1", limit=3, day="20260923")
    out = incr_and_check_quota(r, "u1", limit=3, day="20260923")
    assert out["allowed"] is False
    assert out["used"] == 3
    assert out["limit"] == 3
    assert out["reason"] == "quota_exceeded"


def test_rejected_call_does_not_consume_quota():
    """🔴 判据是**两次读数的差**，不是终态：被拒的那次必须回退，
    否则采集员连点几下就把当天配额烧光（终态读数「残留 = 3」在两版实现下都一样，
    对这条规则恒绿 —— 零判别力）。"""
    r = _FakeRedis()
    for _ in range(3):
        incr_and_check_quota(r, "u1", limit=3, day="20260923")
    before = r.store[quota_key("u1", "20260923")]
    for _ in range(5):
        incr_and_check_quota(r, "u1", limit=3, day="20260923")
    after = r.store[quota_key("u1", "20260923")]
    assert before == 3 and after == 3


def test_quota_ttl_is_until_local_midnight():
    """TTL **到当天结束**（设计文档 §4.6）。

    ⚠️ 这条断言的两个界都是判据的一部分：上界 86400 抓「TTL 被写成多天」，
    下界 60 抓「午夜前算出 0 秒 ⇒ expire 当场删 key」。
    """
    r = _FakeRedis()
    incr_and_check_quota(r, "u1", limit=3, day="20260923")
    ttl = r.expires[quota_key("u1", "20260923")]
    assert 60 <= ttl <= 86400


def test_seconds_until_midnight_has_a_floor():
    """午夜前 1 秒也必须 >= 60。"""
    from datetime import datetime
    from src.services.wenlv_material_assist import _seconds_until_local_midnight
    assert _seconds_until_local_midnight(datetime(2026, 9, 23, 23, 59, 59)) == 60
    # 刚过午夜 ⇒ 差不多一整天
    assert _seconds_until_local_midnight(datetime(2026, 9, 23, 0, 0, 1)) > 86390


def test_release_quota_gives_exactly_one_back():
    """退还的判据是**增量**（前后读数之差），不是终态 —— 终态在两种实现下可能相同。"""
    r = _FakeRedis()
    incr_and_check_quota(r, "u1", limit=3, day="20260923")
    incr_and_check_quota(r, "u1", limit=3, day="20260923")
    before = r.store[quota_key("u1", "20260923")]
    release_quota(r, "u1", "20260923")
    after = r.store[quota_key("u1", "20260923")]
    assert (before, after) == (2, 1)


def test_release_quota_without_redis_is_a_noop(caplog):
    """None 入参必须**安静地**安全返回，且真替身时**确实会退还一次**。

    ⚠️ 为什么**原来那版恒真**：原写法只有一句 `release_quota(None, ...)`，判据是
    「不抛异常」。可即便把 `if redis is None: return` 删掉，`None.decr(...)` 抛的
    `AttributeError` 也会被**本函数自己的** `except Exception` 吞掉 ⇒ 仍然不抛异常
    ⇒ 该断言永不可能失败（返回值层面该守卫与 except 等价冗余）。

    这里改用**日志**把这条路径变成可观测的：
    - None 是**正常态**（没配 Redis），快路径必须**不留 warning**；删掉
      `if redis is None: return` 后会掉进 except ⇒ 多出一条 warning ⇒ 本用例变红；
    - 阳性对照 ③：decr 抛异常时**必须**留下一条 warning —— 否则 ① 的「没有 warning」
      对「except 里根本没有日志」也恒真。
    """
    # ① None 入参：安全返回，且**不留 warning**（删掉 None 守卫即这行变红）
    with caplog.at_level(logging.WARNING):
        release_quota(None, "u1", "20260923")
    assert [r for r in caplog.records if "配额退还失败" in r.getMessage()] == []

    # ② 阳性对照：真替身时真的退了一次（store 从空被 decr 成 -1）
    ok = _FakeRedis()
    release_quota(ok, "u1", "20260923")
    assert ok.store[quota_key("u1", "20260923")] == -1

    # ③ decr 抛异常 ⇒ 被吞掉、但留下一条 warning（让 ① 的「无 warning」有意义）
    caplog.clear()
    boom = _DecrBoomRedis()
    with caplog.at_level(logging.WARNING):
        release_quota(boom, "u1", "20260923")
    assert boom.decr_calls == 1
    assert any("配额退还失败" in r.getMessage() for r in caplog.records)


def test_quota_is_per_user_and_per_day():
    r = _FakeRedis()
    for _ in range(3):
        incr_and_check_quota(r, "u1", limit=3, day="20260923")
    assert incr_and_check_quota(r, "u1", limit=3, day="20260923")["allowed"] is False
    assert incr_and_check_quota(r, "u2", limit=3, day="20260923")["allowed"] is True
    assert incr_and_check_quota(r, "u1", limit=3, day="20260924")["allowed"] is True


def test_quota_without_redis_is_fail_closed():
    """Redis 不可用时**拒绝**（fail-closed），不是放行。

    理由：这是一个**付费**端点，配额是它唯一的闸；放行等于把闸拆了。
    代价明确写在返回值里（reason='quota_unavailable'），前端能如实告诉采集员
    「暂时不可用」，而不是默默花钱。"""
    out = incr_and_check_quota(None, "u1", limit=3, day="20260923")
    assert out["allowed"] is False
    assert out["reason"] == "quota_unavailable"


# ---------- 每日配额：错误路径 ----------

class _IncrBoomRedis(_FakeRedis):
    """incr 直接抛（Redis 打不通 / 命令报错）。"""

    def incr(self, k):
        raise RuntimeError("incr boom")


class _ExpireBoomRedis(_FakeRedis):
    """incr 正常；expire **只在第一次**（n == 1 那次）抛异常。

    用「只第一次抛」而不是「每次都抛」，是为了能观测到「失败后有没有重试补 TTL」：
    若实现改成每次自增都设 expire，`expire_calls` 会 > 1，钉住现状的用例即变红。
    """

    def __init__(self):
        super().__init__()
        self.expire_calls = 0

    def expire(self, k, ttl):
        self.expire_calls += 1
        if self.expire_calls == 1:
            raise RuntimeError("expire boom")
        self.expires[k] = ttl
        return True


class _DecrBoomRedis(_FakeRedis):
    """decr 抛异常（连接抖动）。记录 decr 被调用过几次。"""

    def __init__(self):
        super().__init__()
        self.decr_calls = 0

    def decr(self, k):
        self.decr_calls += 1
        raise RuntimeError("decr boom")


def test_quota_fails_closed_when_incr_raises():
    """incr 抛异常 ⇒ fail-closed（与「无 Redis」同一处理）。

    这是**付费**端点：计数本身出错时若放行，配额这道唯一的闸就形同虚设。
    断言落在「拒答」那一支的具体取值上 —— 既不许把异常抛给调用方，也不许默默放行。
    """
    out = incr_and_check_quota(_IncrBoomRedis(), "u1", limit=3, day="20260923")
    assert out["allowed"] is False
    assert out["reason"] == "quota_unavailable"
    assert out["used"] == 0
    assert out["limit"] == 3


def test_expire_failure_is_swallowed_but_leaves_the_key_without_ttl():
    """⚠️ 刻画现状（**不是修复**）：incr 成功但 expire 失败时的真实行为与它留下的窟窿。

    实测（2026-09-23）：incr 已把计数 +1，随后 expire 抛异常 → 异常落到
    `except Exception` → 返回 fail-closed（allowed=False / used=0 / reason='quota_unavailable'）。
    也就是说这一次「被拒」其实已经吃掉了一个名额（计数侧泄漏，见下面的 store 断言）。

    🔴 窟窿：TTL 只在 `n == 1` 那一次设。第一次 incr 的 expire 一失败，该 key 的 `n`
    就再也不会等于 1 ⇒ **expire 永不重试 ⇒ TTL 永远补不上 ⇒ key 永久残留**
    （见下面的 expire_calls / expires 断言）。
    后果有界：key 里带日期，跨天后换新 key，旧 key 不再被读 ⇒ 配额按天仍正确；
    代价只是无 TTL 的僵尸 key 在 Redis 里堆积。

    修复另行处理 —— 修好之后**本用例会按预期变红，届时应一并更新**（它钉的就是现状）。
    """
    r = _ExpireBoomRedis()
    out = incr_and_check_quota(r, "u1", limit=3, day="20260923")

    # ① 异常没抛出，且返回具体落在 fail-closed 那一支
    assert out["allowed"] is False
    assert out["used"] == 0
    assert out["limit"] == 3
    assert out["reason"] == "quota_unavailable"
    # ② 计数已被 +1（这次「被拒」实际吃了一个名额）—— 侧面泄漏
    assert r.store[quota_key("u1", "20260923")] == 1

    # ③ 第二次起 n >= 2 ⇒ expire 一次都不再被调用，TTL 始终没设上
    incr_and_check_quota(r, "u1", limit=3, day="20260923")
    assert r.expire_calls == 1
    assert quota_key("u1", "20260923") not in r.expires


def test_release_quota_swallows_decr_errors():
    """decr 抛异常时 release_quota 必须吞掉（退还失败不能影响主流程）。

    断言的不是弱形式「不抛异常」，而是**具体可观测事实**：确实走到并尝试了 decr
    （`decr_calls == 1`）—— 否则对「函数什么都没做」也恒真。
    """
    r = _DecrBoomRedis()
    release_quota(r, "u1", "20260923")
    assert r.decr_calls == 1


# ---------- 编排 ----------

from src.services.wenlv_material_assist import optimize_material  # noqa: E402


def _calls_recorder(result):
    calls = []

    def fn(*a, **k):
        calls.append((a, k))
        return result
    return calls, fn


SRC = [{"title": "浙东水井", "site_name": "百度百科", "url": "https://baike.example/1"}]

# 三条来源：用来验「按编号取」与「照原样全给」**答案不同**（一条来源时两者相同 ⇒ 零判别力）。
SRC3 = [
    {"title": "浙东水井", "site_name": "百度百科", "url": "https://baike.example/1"},
    {"title": "古井名录", "site_name": "某县地方志", "url": "https://dfz.example/2"},
    {"title": "明代水井形制", "site_name": "某学报", "url": "https://journal.example/3"},
]


def test_optimize_rejects_when_input_insufficient():
    calls, search = _calls_recorder({"ok": True, "answer": "x", "sources": SRC})
    out = optimize_material(
        {"title": "", "content": ""}, redis=_FakeRedis(), search_fn=search,
        assemble_fn=lambda *a, **k: {"content": "不该被调到", "note": ""}, day="20260923",
    )
    assert out["found"] is False
    assert out["reason"] == "insufficient_input"
    assert calls == []          # 前置不足时**一次检索都不发**（省钱）
    assert out["content"] == ""


def test_optimize_happy_path_sets_found():
    _, search = _calls_recorder({"ok": True, "answer": "据资料记载……", "sources": SRC})
    out = optimize_material(
        {"title": "锁井传说", "content": "王大爷说这井是明朝的", "material_type": "legend",
         "user_id": "u1"},
        redis=_FakeRedis(), search_fn=search,
        assemble_fn=lambda payload, answer, sources: {
            "content": "补充后的内容", "used_sources": [1], "note": "已补充"},
        day="20260923",
    )
    assert out["found"] is True
    assert out["content"] == "补充后的内容"
    assert out["sources"] == SRC
    assert out["reason"] == "ok"
    assert out["note"] == "已补充"


def test_optimize_narrows_sources_to_the_ones_the_model_cited():
    """附件列表 = 模型**点名引用**的那几条，不是检索回来的全量。

    ⚠️ 断言用 `SRC3` 的**第 2 条**（编号 2）而不是第 1 条：只给一条来源时，
    「按编号取」与「照原样全给」两个实现**答案相同** ⇒ 夹具落在分歧区之外，
    这个用例对收窄逻辑零判别力（`fixture-must-cover-implementation-disagreement`）。
    """
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": SRC3})
    out = optimize_material(
        {"title": "锁井传说", "content": "内容", "user_id": "u1"},
        redis=_FakeRedis(), search_fn=search,
        assemble_fn=lambda *a, **k: {
            "content": "只用了第二条来源", "used_sources": [2], "note": ""},
        day="20260923",
    )
    assert out["reason"] == "ok"
    assert out["sources"] == [SRC3[1]]
    assert out["found"] is True


def test_optimize_ignores_cited_sources_when_search_result_is_irrelevant():
    """🔴 **第二个线上缺陷的复现**（2026-09-23 上线冒烟实测 n=1）。

    形态：检索回了 10 条**与这条素材无关**的来源；模型没照铁律3 把 content 写空，
    而是写了一段现场记录的整理（32 字），note 写「公网未查到与这条素材相关的独立来源」。
    老实现只按 `decide_found`（有内容 且 **检索回了来源**）判 ⇒ True ⇒
    前端渲染「AI 补充」卡片 + 10 条无关链接 + 「合并」动作，本该是绿底「AI 整理」。

    修法：模型必须点名 `used_sources`；这里它给 `[]` ⇒ 收窄后来源为空 ⇒
    `decide_found` 判 False ⇒ 走整理步、`sources` 恒 `[]`、note 由代码拥有。

    ⚠️ 这一条要能红，靠的是 `pick_used_sources` 真的被调用；
    把调用点改回全量 `sources` 即变红（见 `test_optimize_happy_path_sets_found` 之外的这条）。
    """
    many = [{"title": f"无关条目{i}", "site_name": "某站", "url": f"https://irrelevant.example/{i}"}
            for i in range(1, 11)]
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "一堆无关资料", "sources": many})
    _, organize = _calls_recorder({"content": "整理后的稿子", "note": ""})
    out = optimize_material(
        {"title": "锁井传说", "content": "王大爷说这井是明朝的", "user_id": "u1"},
        redis=r, search_fn=search,
        assemble_fn=lambda *a, **k: {
            "content": "王大爷说这井是明朝的",
            "used_sources": [],
            "note": "公网未查到与这条素材相关的独立来源"},
        organize_fn=organize,
        day="20260923",
    )
    assert out["reason"] == "no_source_organized"   # 不是 ok
    assert out["found"] is False
    assert out["sources"] == []                      # 10 条无关来源一条都不许挂出去
    assert out["note"] == ORGANIZED_NOTE             # 代码拥有，不用模型给的那句
    assert r.store[quota_key("u1", "20260923")] == 1 # D7：整理态照旧算一次


def test_optimize_organizes_when_search_yields_no_source():
    """检索 200 但来源列表为空 ⇒ **走整理步**（D2）。

    ⚠️ 与改动前的老行为**正好相反**：老代码在这里直接 `return`，
    一次 LLM 都不调；现在要出一份**整理稿**。
    """
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": []})
    assemble_calls, assemble = _calls_recorder({"content": "我编的", "note": ""})
    organize_calls, organize = _calls_recorder({"content": "整理后的稿子", "note": "ignored"})
    out = optimize_material(
        {"title": "锁井传说", "content": "内容", "user_id": "u1"},
        redis=r, search_fn=search, assemble_fn=assemble, organize_fn=organize,
        day="20260923",
    )
    assert out["found"] is False                 # 公网确实没查到
    assert out["content"] == "整理后的稿子"        # 但**有产出**
    assert out["reason"] == "no_source_organized"
    assert out["sources"] == []
    assert assemble_calls == []                  # 组装步没跑（没有来源可喂）
    assert len(organize_calls) == 1              # 整理步跑了
    # 🔴 note **由代码拥有**，不是模型给的 "ignored"（与「判定权在代码里」同一原则）
    assert out["note"] == ORGANIZED_NOTE
    # D7：整理态照旧算一次配额
    assert r.store[quota_key("u1", "20260923")] == 1


def test_optimize_organizes_when_assemble_yields_nothing():
    """**来源有**，但组装步给不出内容（或只有空白）⇒ 掉到整理步（D2）。

    ⚠️ 这条与上一条走的是**不同的分支**：上一条在 `not sources` 就没进组装步。
    这条才是 `decide_found` 的**假分支** —— 少了它，「有来源但组装空」这条规则零覆盖。
    """
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": SRC})
    _, organize = _calls_recorder({"content": "只有整理的稿子", "note": ""})
    out = optimize_material(
        {"title": "锁井传说", "content": "内容", "user_id": "u1"},
        redis=r, search_fn=search,
        assemble_fn=lambda *a, **k: {
            "content": "   ", "used_sources": [1], "note": "检索到的资料与这条对不上"},
        organize_fn=organize,
        day="20260923",
    )
    # 有来源、组装步跑通了，但给不出内容 ⇒ **掉到整理步**（不是故障，见设计文档 §5 的分行）
    assert out["found"] is False
    assert out["content"] == "只有整理的稿子"
    assert out["reason"] == "no_source_organized"
    assert out["sources"] == []
    # ⚠️ **行为变更**：老代码在这里把组装步的 note 透传出去，现在**不透传** ——
    #    整理态的 note 由代码拥有（同上一条用例）。别把这当成回归。
    assert out["note"] == ORGANIZED_NOTE
    assert r.store[quota_key("u1", "20260923")] == 1   # D7：不退


def test_optimize_title_only_and_no_source_skips_organize():
    """🔴 只填标题（内容空）+ 公网查不到 ⇒ **不进整理步**，也不报假故障。

    2026-09-24 需求变更带出来的**新可达组合**：ops-app 的入口门槛由「标题**且**内容非空」
    放宽为「至少一个」，于是「只有标题、内容还空」进得来（新增素材时的常态）。

    为什么必须挡：整理步**唯一的输入就是 `content`**（`_default_organize` 里
    「只能整理它」），而 `MaterialOrganizeResult.content` 仍必填 ⇒ 模型**必须**吐点什么；
    这一态的对外文案偏偏写死「只整理了你的记录，没有新增内容」——
    模型一旦补了年代/人名，那句话就把**编造**冒充成采集员的一手材料。
    ⚠️ 也**不能**让它落到 `organize_empty_content` 那条去报「资料整理没成功」：
    什么都没坏，那是**假故障**，还会请采集员白重试一次并再扣一次配额。
    """
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": []})
    organize_calls, organize = _calls_recorder(
        {"content": "据县志，此井凿于明万历十七年", "note": ""})
    out = optimize_material(
        {"title": "村口的井", "content": "", "user_id": "u1"},
        redis=r, search_fn=search, organize_fn=organize, day="20260923",
    )
    assert organize_calls == []        # 整理步一次都没跑 ⇒ 模型没机会编
    assert out["content"] == ""
    assert out["found"] is False
    assert out["reason"] == "no_source_no_content"
    assert out["sources"] == []
    # D7 同口径：DashScope 检索真跑了（它 200 了，只是没查到相关来源）⇒ **不退**
    assert r.store[quota_key("u1", "20260923")] == 1
    # 文案必须**如实**说没东西可整理，且给一条采集员能自己走的下一步
    assert "整理" in out["note"] or "记录" in out["note"]


def test_optimize_title_only_still_gets_sourced_content():
    """只填标题 + 公网**查得到** ⇒ 照常出补充稿。**这才是这次需求变更的主用法。**

    🔴 与上一条**成对**：上一条证明「内容为空 ⇒ 不跑整理步」，
    这一条证明那个判据**只挡整理步、不挡组装步** ——
    少了它，一个「内容为空就直接 return」的写宽了的实现会全绿，
    而「让 AI 把内容一键生成出来」这个诉求**根本实现不了**。
    """
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "资料", "sources": SRC3})
    out = optimize_material(
        {"title": "村口的井", "content": "", "user_id": "u1"},
        redis=r, search_fn=search,
        assemble_fn=lambda *a, **k: {
            "content": "据《黔南州志》卷三，此井凿于明万历十七年（1589）。",
            "used_sources": [1], "note": "",
        },
        day="20260923",
    )
    assert out["reason"] == "ok"
    assert out["found"] is True
    assert "明万历十七年" in out["content"]
    assert out["sources"] == [SRC3[0]]        # 收窄到模型点名的第 1 条
    assert r.store[quota_key("u1", "20260923")] == 1


def test_optimize_treats_missing_used_sources_as_no_citation(caplog):
    """组装步产出**缺 `used_sources` 键**时：按「一条都没引用」处理，并留一条日志。

    正常路径进不来这里（契约里它是必填，缺了先由 pydantic 报错、由 `_run_agent` 重跑兜住）
    —— 这条守的是**将来有人给它加默认值**的那天：那时缺省会静默落成 `[]`，
    若这里再写成「缺了就当全用了」，缺陷就原样回来了。
    ⚠️ 断言的方向是**fail-closed**：缺键的结果必须与「明确说 []」**完全一样**，
    而不是与「说了 [1,2]」一样。
    """
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": SRC3})
    _, organize = _calls_recorder({"content": "整理后的稿子", "note": ""})
    with caplog.at_level(logging.WARNING, logger="src.services.wenlv_material_assist"):
        out = optimize_material(
            {"title": "锁井传说", "content": "内容", "user_id": "u1"},
            redis=r, search_fn=search,
            assemble_fn=lambda *a, **k: {"content": "有正文但没点名来源", "note": ""},
            organize_fn=organize,
            day="20260923",
        )
    assert out["reason"] == "no_source_organized"
    assert out["sources"] == []
    assert "used_sources" in caplog.text, "缺键必须留下可查的痕迹"


def test_default_assemble_feeds_search_result_as_argument_and_retries(monkeypatch):
    """🔴 两条承重设计都锁在这里：

    ① 组装步**自己**重试（`_run_agent(retries=_ASSEMBLE_RETRIES)`），而不是靠外层
       再包一层循环 —— 所以检索不会跟着重跑；
    ② 检索结果是**参数**灌进 task 描述的，不是让 agent 自己去取。

    ⚠️ 为什么必须打**类**而不能打实例：`_default_assemble` 内部**自己新建**
    orchestrator，打实例上不生效（本仓既有替身模式见
    tests/test_wenlv_creation_crew.py 的 `orch._run_agent = ...`，那是外部先建好
    实例再打；本用例没有那个实例，只能打类）。本用例不真实调 LLM。
    """
    import src.crews.wenlv_creation_crew as crew_mod
    from src.schemas.wenlv_material_assist import MaterialOptimizeResult
    from src.services.wenlv_material_assist import _ASSEMBLE_RETRIES, _default_assemble

    seen = {}

    def fake_run_agent(self, agent, task_desc, expected, schema_cls, retries=2):
        seen.update(task_desc=task_desc, expected=expected,
                    schema_cls=schema_cls, retries=retries)
        # 形状照 `_run_agent` 的真实返回抄（`schema_cls(**…).model_dump()`）——
        # 少一个键的桩会喂出一个真实现**产不出**的形状，让下游断言失去意义。
        return {"content": "x", "used_sources": [1], "note": ""}

    monkeypatch.setattr(crew_mod.WenlvCreationOrchestrator, "_run_agent", fake_run_agent)
    out = _default_assemble(
        {"title": "锁井传说", "content": "现场记录", "material_type": "legend",
         "city": "黔南", "venue_name": "龙门古镇", "point_name": "古井"},
        "据资料记载……", SRC3,
    )
    assert out == {"content": "x", "used_sources": [1], "note": ""}
    # 组装步必须自己重试 —— 否则「检索不参与重试」在这层失去落点
    assert seen["retries"] == _ASSEMBLE_RETRIES
    assert seen["schema_cls"] is MaterialOptimizeResult
    # 检索结果是**参数**：答案与来源都要出现在喂给 agent 的描述里
    assert "据资料记载……" in seen["task_desc"]
    assert "锁井传说" in seen["task_desc"]
    # 🔴 来源必须以**带编号**的形态喂进去，且题面要点名 `used_sources` ——
    # 模型只能引用它看得见的编号；少了编号，它回的号就是猜的（而代码会照猜的号取来源）。
    for i, s in enumerate(SRC3, start=1):
        assert f"{i}. " in seen["task_desc"], f"来源 {i} 没带编号"
        assert s["url"] in seen["task_desc"]
    assert "used_sources" in seen["task_desc"]


def test_default_organize_uses_the_organize_schema(monkeypatch):
    """🔴 整理步**不许**用组装步那个类（它带必填的 `used_sources`）。

    回归形态：有人为了「省一个类」把 `MaterialOrganizeResult` 删掉、两处共用
    `MaterialOptimizeResult` ⇒ 整理步开始要求模型交代引用编号，而它**连来源都没有**
    ⇒ 模型漏写 ⇒ 校验失败 ⇒ 重试 ⇒ `assemble_failed`。而整理步是「公网查不到」时
    **必经**的兜底路径。本项目所有流程用例都用**假 `organize_fn`**，所以那种回归
    **全绿也抓不到** —— 这条用例就是那个唯一的钉子。
    """
    import src.crews.wenlv_creation_crew as crew_mod
    from src.schemas.wenlv_material_assist import MaterialOrganizeResult
    from src.services.wenlv_material_assist import _default_organize

    seen = {}

    def fake_run_agent(self, agent, task_desc, expected, schema_cls, retries=2):
        seen.update(schema_cls=schema_cls, task_desc=task_desc)
        return {"content": "整理稿", "note": ""}

    monkeypatch.setattr(crew_mod.WenlvCreationOrchestrator, "_run_agent", fake_run_agent)
    out = _default_organize({"title": "锁井传说", "content": "现场记录"})
    assert out == {"content": "整理稿", "note": ""}
    assert seen["schema_cls"] is MaterialOrganizeResult
    # 整理步的题面里不许出现引用编号那种要求
    assert "used_sources" not in seen["task_desc"]


def test_default_organize_takes_no_search_result():
    """🔴 **D3 唯一的工程保障**：整理步在**类型层**就喂不进检索结果。

    断言签名里**没有** `answer` / `sources`（或任何形如它们的参数）——
    这比断言「task 描述里没写检索结果」硬：描述是可以被顺手改回去的，
    签名不能。整理态**不标出处**，一旦喂了检索结果，模型会产出
    「看起来有出处」的内容而采集员无从分辨哪句是新的。
    """
    import inspect
    from src.services.wenlv_material_assist import _default_organize
    params = set(inspect.signature(_default_organize).parameters)
    assert params == {"payload"}, f"整理步的签名里出现了额外参数：{params}"


def test_optimize_reports_search_failure_without_spending_assemble():
    r = _FakeRedis()
    calls, search = _calls_recorder({"ok": False, "answer": "", "sources": [], "error": "超时"})
    assemble_calls, assemble = _calls_recorder({"content": "x", "note": ""})
    out = optimize_material(
        {"title": "t", "content": "c", "user_id": "u1"},
        redis=r, search_fn=search, assemble_fn=assemble, day="20260923",
    )
    assert out["found"] is False and out["reason"] == "search_failed"
    assert out["content"] == ""
    # 🔴 检索已经失败了，不该再去跑一次要花钱的组装
    assert assemble_calls == []
    # 「没查完」⇒ 退还这一次（设计文档 §5：不扣一次配额）
    assert r.store[quota_key("u1", "20260923")] == 0


def test_optimize_reports_assemble_failure():
    r = _FakeRedis()
    calls, search = _calls_recorder({"ok": True, "answer": "答案", "sources": SRC})

    def boom(*a, **k):
        raise RuntimeError("组装炸了")

    out = optimize_material(
        {"title": "t", "content": "c", "user_id": "u1"},
        redis=r, search_fn=search, assemble_fn=boom, day="20260923",
    )
    assert out["found"] is False and out["content"] == ""
    assert out["reason"] == "assemble_failed"
    # 🔴 组装失败**不许**重发检索：每次检索都是真实计费的 DashScope 调用
    assert len(calls) == 1
    # §5 的「组装环节失败 → 同上按『没查完』处理」⇒ 也退还
    assert r.store[quota_key("u1", "20260923")] == 0


def test_optimize_organize_failure_is_assemble_failed_and_releases_quota():
    """整理步抛异常 ⇒ **不产出** + 退还配额（D4：我们自己坏了，不假装有产出）。"""
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": []})

    def boom(*a, **k):
        raise RuntimeError("llm down")

    out = optimize_material(
        {"title": "t", "content": "c", "user_id": "u1"},
        redis=r, search_fn=search, organize_fn=boom, day="20260923",
    )
    assert out["found"] is False
    assert out["content"] == ""
    assert out["reason"] == "assemble_failed"
    assert r.store[quota_key("u1", "20260923")] == 0     # 退还


def test_optimize_organize_empty_content_is_assemble_failed():
    """整理步**跑通了**但产出空白 ⇒ 同上（我们没拿回东西，不该扣钱）。"""
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": []})
    out = optimize_material(
        {"title": "t", "content": "c", "user_id": "u1"},
        redis=r, search_fn=search,
        organize_fn=lambda *a, **k: {"content": "   ", "note": ""}, day="20260923",
    )
    assert out["reason"] == "assemble_failed"
    assert out["content"] == ""
    assert r.store[quota_key("u1", "20260923")] == 0


def test_optimize_no_source_keeps_quota():
    """🔴 与上面两条**成对**的对照：检索成功但公网没资料 ⇒ **不退**。

    理由：那次 DashScope 检索是真花了钱的（它 200 了，只是没查到相关来源）。

    ⚠️ 这条不能省。少了它，「任何非成功都 release」这种写宽了的实现会全绿 ——
    上面两条只能证明「失败时退了」，证明不了「该退的才退」。

    ⚠️ 用例名里的 `no_source` 是**历史名**（分类码已改为 `no_source_organized`）：
    服务端 `release_quota` 的 docstring 按此名引用它，本次不改名。
    """
    r = _FakeRedis()
    _, search = _calls_recorder({"ok": True, "answer": "答案", "sources": []})
    out = optimize_material(
        {"title": "t", "content": "c", "user_id": "u1"},
        redis=r, search_fn=search,
        assemble_fn=lambda *a, **k: {"content": "", "note": ""},
        organize_fn=lambda *a, **k: {"content": "整理稿", "note": ""}, day="20260923",
    )
    assert out["found"] is False and out["reason"] == "no_source_organized"
    assert r.store[quota_key("u1", "20260923")] == 1


def test_optimize_reports_quota_exceeded_and_does_not_search():
    r = _FakeRedis()
    for _ in range(2):
        incr_and_check_quota(r, "u1", limit=2, day="20260923")
    calls, search = _calls_recorder({"ok": True, "answer": "答案", "sources": SRC})
    out = optimize_material(
        {"title": "t", "content": "c", "user_id": "u1"},
        redis=r, search_fn=search, assemble_fn=lambda *a, **k: {"content": "x", "note": ""},
        limit=2, day="20260923",
    )
    assert out["found"] is False and out["reason"] == "quota_exceeded"
    assert out["limit"] == 2 and out["used"] == 2
    assert calls == []


def test_optimize_default_fns_are_production_implementations():
    """默认参数必须指向生产实现 —— 否则测试全绿而线上什么也没接。"""
    import inspect
    sig = inspect.signature(optimize_material)
    assert sig.parameters["search_fn"].default is not None
    assert sig.parameters["assemble_fn"].default is not None
    assert sig.parameters["organize_fn"].default is not None
