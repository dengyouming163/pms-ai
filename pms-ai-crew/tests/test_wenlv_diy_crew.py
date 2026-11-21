"""wenlv_diy 六 Agent × 七步编排测试（不真调 LLM：FakeOrch/FakeCrew + 假 httpx）。

覆盖 Task 12：
  TR-12.1 七步→(agent, schema) 调度正确且职责唯一（总监不写内容、谜题不改剧情、骨架不产场景）；
           schema 形状隔离（剧情编排师产不出 puzzle/atoms，谜题师改不到 title/content）；
  TR-12.2 JSON 非法/截断触发「1 首发 + 2 重跑」后熔断 StageFailedError；
           Task 11 会话客户端 URL/封套/404-409 语义正确。
"""
import pytest
from pydantic import ValidationError
from types import SimpleNamespace

import src.crews.wenlv_diy_crew as crew_mod
from src.crews.wenlv_diy_crew import (
    WenlvDiyOrchestrator, StageFailedError, STAGE_ORDER, STAGE_SPECS, NEXT_STAGE,
)
from src.agents.wenlv_diy import (
    director_agent, world_builder_agent, character_designer_agent,
    story_planner_agent, puzzle_designer_agent, qa_inspector_agent,
)
from src.schemas.wenlv_diy import (
    DiyIntent, DiyWorldview, DiyCharacters, DiySkeleton, DiyScenes, DiyPuzzles, QaReport,
    DiyCondition,
)


# =====================================================================================
# TR-12.1 七步状态机调度
# =====================================================================================

class _RecordingOrch(WenlvDiyOrchestrator):
    """记录每次 _run_agent 的 (agent, schema)，返回固定 dict（不跑 schema、不调 LLM）。"""

    def __init__(self):
        super().__init__(session_client=object())  # 不发 HTTP：本批用例不需要 client
        self.calls = []

    def _run_agent(self, agent, task_desc, expected, schema_cls, retries=2):
        self.calls.append({"agent": agent, "schema": schema_cls, "desc": task_desc})
        return {"_stage": expected}


def test_stage_order_matches_ai_sessions_enum():
    assert STAGE_ORDER == ["intent", "worldview", "characters", "skeleton",
                          "scenes", "puzzles", "publish"]
    assert [NEXT_STAGE[s] for s in STAGE_ORDER[:-1]] == STAGE_ORDER[1:]
    assert NEXT_STAGE["publish"] is None


def test_each_stage_dispatches_to_its_unique_agent_and_schema():
    orch = _RecordingOrch()
    for stage in STAGE_ORDER:
        orch.generate_draft(stage, {"product_num": "7"})

    got = [(c["agent"], c["schema"]) for c in orch.calls]
    assert got == [
        (director_agent, DiyIntent),
        (world_builder_agent, DiyWorldview),
        (character_designer_agent, DiyCharacters),
        (world_builder_agent, DiySkeleton),       # 骨架也归世界观构建师（同一 agent 两步）
        (story_planner_agent, DiyScenes),
        (puzzle_designer_agent, DiyPuzzles),
        (qa_inspector_agent, QaReport),
    ]
    # STAGE_SPECS 与实际调度一一对应（共 7 步）
    assert set(STAGE_SPECS) == set(STAGE_ORDER)


def test_director_only_runs_intent_and_never_writes_content():
    """编剧总监只在步①出现；五个内容步 + 质检都不是他。"""
    orch = _RecordingOrch()
    for stage in STAGE_ORDER:
        orch.generate_draft(stage, {})
    director_stages = [i for i, c in enumerate(orch.calls) if c["agent"] is director_agent]
    assert director_stages == [0]  # 只有 intent
    # intent 的 prompt 明确「不写剧本内容」
    assert "不写任何剧本内容" in orch.calls[0]["desc"]


def test_qa_only_runs_publish_and_reports_not_edits():
    orch = _RecordingOrch()
    orch.qa_review({"scenes": []})
    assert orch.calls[0]["agent"] is qa_inspector_agent
    assert orch.calls[0]["schema"] is QaReport
    assert "只报告，不修改任何内容" in orch.calls[0]["desc"]


def test_scene_focused_regeneration_routes_to_story_planner():
    """逐场景细调 / 全章一键：都只走剧情编排师，且 prompt 标注作用域（FR-10）。"""
    orch = _RecordingOrch()
    orch.refine_scene("SCENE_7_003", "改成雨夜对峙", {"skeleton": {}, "characters": {}})
    orch.generate_chapter_scenes("CH_7_02", {"skeleton": {}})
    assert all(c["agent"] is story_planner_agent for c in orch.calls)
    assert "SCENE_7_003" in orch.calls[0]["desc"] and "逐场景细调" in orch.calls[0]["desc"]
    assert "CH_7_02" in orch.calls[1]["desc"] and "全章一键生成" in orch.calls[1]["desc"]
    # 谜题师不参与剧情重生成
    assert all(c["agent"] is not puzzle_designer_agent for c in orch.calls)


def test_generate_draft_rejects_unknown_stage():
    with pytest.raises(ValueError, match="未知向导阶段"):
        _RecordingOrch().generate_draft("not_a_stage")


def test_prompts_embed_anchor_and_id_rule():
    """步②与步⑤ prompt 必须带真实点位锚定与 id 铁律（防虚构的两道提示词闸）。"""
    orch = _RecordingOrch()
    anchor = {
        "venue": {"id": "v1", "name": "老街"},
        "venueProfile": {"supportActions": {"frontDesk": True}, "deployableAtoms": ["qrcode_scan"]},
        "merchants": [{"id": "m1", "name": "茶馆", "cipherDish": "雨前龙井"}],
        "venuePoints": [{"id": "p1", "name": "门口石狮"}],
    }
    orch.generate_draft("worldview", {"intent": {"theme": "悬疑"}, "anchor": anchor, "product_num": "7"})
    orch.generate_draft("scenes", {"anchor": anchor, "product_num": "7",
                                   "skeleton": {"chapters": []}, "characters": {"npcs": []}})
    wv_desc, sc_desc = orch.calls[0]["desc"], orch.calls[1]["desc"]
    assert "[p1] 门口石狮" in wv_desc and "[p1] 门口石狮" in sc_desc
    assert "NPC_7_01" in wv_desc and "SCENE_7_001" in sc_desc
    assert "deployableAtoms" in sc_desc + wv_desc


# =====================================================================================
# 职责唯一：schema 形状隔离（提示词之外的硬边界）
# =====================================================================================

def test_story_planner_schema_drops_puzzle_and_atoms_and_rejects_puzzle_edges():
    """剧情编排师即使越权输出 puzzle/atoms，也会被 schema 丢弃；成败边直接校验失败。"""
    raw = {
        "scenes": [{
            "id": "SCENE_1", "chapter_id": "CH_1", "title": "占位谜题场", "type": "narrative",
            "puzzle": {"type": "input", "question": "暗号？", "answer": "月"},   # 必须被丢
            "atoms": [{"id": "a1", "type": "qrcode_scan", "config": {}}],        # 必须被丢
            "content": "剧情正文",
        }],
        "flows": [],
    }
    scene = DiyScenes(**raw).model_dump()["scenes"][0]
    assert "puzzle" not in scene and "atoms" not in scene
    assert scene["content"] == "剧情正文"

    # puzzle_pass/fail 边不属于剧情编排师的 schema（Literal 校验失败，非静默）
    with pytest.raises(ValidationError):
        DiyScenes(scenes=[], flows=[{"from_scene_id": "A", "to_scene_id": "B",
                                    "type": "puzzle_pass"}])
    # 场景五型里剧情编排师只许 narrative/npc/ending
    with pytest.raises(ValidationError):
        DiyScenes(scenes=[{"id": "X", "chapter_id": "C", "title": "t", "type": "puzzle"}], flows=[])


def test_puzzle_designer_schema_cannot_touch_story_fields():
    """谜题回填按 scene_id 挂载；title/content/chapter_id 等剧情字段一律被忽略。"""
    fill = DiyPuzzles(fills=[{
        "scene_id": "SCENE_2",
        "title": "想改标题（越权）", "content": "想改正文（越权）", "chapter_id": "CH_9",
        "puzzle": {"type": "judge", "question": "暗号对吗？", "answer": "true"},
        "atoms": [{"id": "a1", "type": "qrcode_scan", "config": {"code": "x"}, "required": True}],
        "grants": ["CLUE_1"],
        "pass_to_scene_id": "SCENE_3",
    }], flows=[{"from_scene_id": "SCENE_2", "to_scene_id": "SCENE_4", "type": "puzzle_fail"}])
    d = fill.model_dump()
    f0 = d["fills"][0]
    assert set(f0) == {"scene_id", "puzzle", "atoms", "grants", "pass_to_scene_id",
                       "fail_to_scene_id", "san_delta_pass", "san_delta_fail"}
    assert f0["puzzle"]["answer"] == "true"
    assert d["flows"][0]["type"] == "puzzle_fail"

    # 谜题师产不出 auto/choice 边
    with pytest.raises(ValidationError):
        DiyPuzzles(fills=[], flows=[{"from_scene_id": "A", "to_scene_id": "B", "type": "choice"}])


def test_judge_answer_must_be_true_false_string():
    with pytest.raises(ValidationError):
        DiyPuzzles(fills=[{"scene_id": "S",
                          "puzzle": {"type": "judge", "question": "q", "answer": "对"}}])


def test_recursive_condition_parses_all_nofm():
    c = DiyCondition(**{
        "type": "all",
        "conditions": [
            {"type": "ref", "ref": {"kind": "collected", "id": "CLUE_1"}},
            {"type": "nofM", "n": 1, "of": [
                {"type": "ref", "ref": {"kind": "visited", "id": "SCENE_2"}},
                {"type": "role", "character_id": "NPC_1"},
            ]},
        ],
    })
    dumped = c.model_dump()
    assert dumped["conditions"][1]["of"][0]["ref"]["id"] == "SCENE_2"
    assert dumped["conditions"][1]["of"][1]["character_id"] == "NPC_1"


def test_character_persona_six_fields_and_relationship_closure_shape():
    chars = DiyCharacters(**{"npcs": [{
        "id": "NPC_1", "name": "老周", "role": "npc", "description": "茶馆掌柜",
        "persona": {"personality": ["寡言"], "tone": "低沉", "backstory": "守着一个秘密"},
        "relationships": [{"target_npc_id": "NPC_2", "relation_type": "旧识", "description": "曾共事"}],
    }]})
    npc = chars.model_dump()["npcs"][0]
    persona = npc["persona"]
    for key in ("personality", "tone", "catchphrases", "backstory", "clues", "taboos"):
        assert key in persona                      # 六字段齐备
    assert persona["catchphrases"] == [] and persona["clues"] == []   # 缺省数组
    assert npc["relationships"][0]["target_npc_id"] == "NPC_2"


# =====================================================================================
# TR-12.2 重试与熔断
# =====================================================================================

class _FakeCrew:
    def __init__(self, **kw):
        pass

    def kickoff(self):
        return SimpleNamespace(raw=_FakeCrew.RAW)


def test_single_stage_retries_twice_then_circuit_breaks(monkeypatch):
    """非法 JSON：1 次首发 + 2 次带错误清单重跑 = 3 次 kickoff，然后 StageFailedError。"""
    calls = {"n": 0}
    _FakeCrew.RAW = "这不是 JSON"

    class _CountingCrew(_FakeCrew):
        def kickoff(self):
            calls["n"] += 1
            return super().kickoff()

    monkeypatch.setattr(crew_mod, "Crew", _CountingCrew)
    orch = WenlvDiyOrchestrator(session_client=object())
    with pytest.raises(StageFailedError):
        orch._run_agent(story_planner_agent, "desc", "scenes JSON", DiyScenes)
    assert calls["n"] == 3


def test_truncated_json_failure_is_labeled_as_truncation(monkeypatch):
    """撞 max_tokens 的截断要被识别为「截断」而非语法错（排查信号，见 test_json_truncated）。"""
    _FakeCrew.RAW = '{"scenes": [{"id": "SCENE_1", "content": "他临死前说"半截话'

    monkeypatch.setattr(crew_mod, "Crew", _FakeCrew)
    orch = WenlvDiyOrchestrator(session_client=object())
    with pytest.raises(StageFailedError) as exc:
        orch._run_agent(story_planner_agent, "desc", "scenes JSON", DiyScenes)
    assert "截断" in str(exc.value)


def test_valid_json_passes_on_first_call(monkeypatch):
    _FakeCrew.RAW = '{"summary": "做悬疑本", "theme": "民国悬疑", "experience_goals": ["解谜"]}'
    monkeypatch.setattr(crew_mod, "Crew", _FakeCrew)
    orch = WenlvDiyOrchestrator(session_client=object())
    out = orch._run_agent(director_agent, "desc", "intent JSON", DiyIntent)
    assert out["theme"] == "民国悬疑"
    assert out["questions_for_user"] == []


# =====================================================================================
# Task 11 会话客户端（HTTP 接缝：URL / 头 / 封套 / 404 / 409）
# =====================================================================================

from src.services.wenlv_diy_session import WenlvDiySessionClient, WenlvSessionError


class _FakeResp:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {"success": True, "data": {}}

    @property
    def is_success(self):
        return 200 <= self.status_code < 300

    def json(self):
        return self._payload


class _FakeHttp:
    def __init__(self, resp=None, exc=None):
        self.resp = resp or _FakeResp()
        self.exc = exc
        self.calls = []

    def Client(self, *a, **k):
        self.kwargs = k
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def request(self, method, url, params=None, json=None):
        self.calls.append({"method": method, "url": url, "params": params, "json": json})
        if self.exc:
            raise self.exc
        return self.resp


def test_session_client_create_save_adopt_urls_and_envelope(monkeypatch):
    fake = _FakeHttp(resp=_FakeResp(payload={
        "success": True, "data": {"session": {"id": "s1"}, "resumed": False}}))
    monkeypatch.setattr("src.services.wenlv_diy_session.httpx.Client", fake.Client)

    client = WenlvDiySessionClient(base_url="http://pms", token="tok")
    res = client.create_or_resume("room1", "u1", intent={"theme": "悬疑"})
    assert res["resumed"] is False
    assert fake.calls[0] == {
        "method": "POST", "url": "/api/admin/wenlv-ai-sessions/sessions",
        "params": None,
        "json": {"scriptRoomId": "room1", "userId": "u1", "intent": {"theme": "悬疑"}},
    }

    fake.resp = _FakeResp(payload={"success": True, "data": {"stage": "worldview", "stages": ["worldview"]}})
    client.save_draft("s1", "worldview", {"era": "民国"}, advance_to="characters")
    assert fake.calls[1]["method"] == "PUT"
    assert fake.calls[1]["url"] == "/api/admin/wenlv-ai-sessions/sessions/s1/drafts/worldview"
    assert fake.calls[1]["json"] == {"draft": {"era": "民国"}, "advanceTo": "characters"}

    fake.resp = _FakeResp(payload={"success": True, "data": {"adopted": {"npcs": ["NPC_1"]}}})
    adopted = client.adopt("s1", "room1", {"npcs": [{"id": "NPC_1", "name": "老周"}]})
    assert adopted == {"npcs": ["NPC_1"]}
    assert fake.calls[2]["json"]["scriptRoomId"] == "room1"
    assert fake.calls[2]["json"]["npcs"][0]["name"] == "老周"

    # 内部 token 头
    assert fake.kwargs["headers"]["X-Internal-Service-Token"] == "tok"


def test_session_client_anchor_context_passes_query(monkeypatch):
    fake = _FakeHttp(resp=_FakeResp(payload={"success": True, "data": {"venue": None,
                                                                       "merchants": []}}))
    monkeypatch.setattr("src.services.wenlv_diy_session.httpx.Client", fake.Client)
    data = WenlvDiySessionClient().anchor_context("room1")
    assert data["venue"] is None
    assert fake.calls[0]["url"] == "/api/admin/wenlv-ai-sessions/rooms/room1/anchor-context"


def test_session_client_404_returns_none_but_409_raises(monkeypatch):
    fake = _FakeHttp(resp=_FakeResp(404, {"success": False, "error": "AI 会话不存在"}))
    monkeypatch.setattr("src.services.wenlv_diy_session.httpx.Client", fake.Client)
    client = WenlvDiySessionClient()
    assert client.get_session("missing") is None

    # active-session 的 404 同样归一为 None
    assert client.get_active("room1", "u1") is None

    # 409（会话已 completed）必须抛出、带状态码，调用方据此提示而不是误建新会话
    fake.resp = _FakeResp(409, {"success": False, "error": "会话已完成，不可再写"})
    with pytest.raises(WenlvSessionError) as exc:
        client.append_transcript("s1", [{"role": "user", "content": "x"}])
    assert exc.value.status_code == 409
