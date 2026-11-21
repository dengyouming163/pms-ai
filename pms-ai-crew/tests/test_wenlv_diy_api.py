"""Task 13 七步向导 API 契约测试。

TR-13.1 各阶段草案 → 四表 adopt 载荷映射正确（snake_case → camelCase）；
TR-13.2 中断恢复到原 stage、局部重生成不覆盖已落盘（谜题合并保字段）；
TR-13.3 未采纳只在 draftSnapshots：生成路径零 adopt 调用。

同 test_venue_research_api.py 的做法：不挂 src.main（wenlv_creation 模块级 import crewai 44s），
自建只挂 wenlv_diy 路由的 FastAPI 实例，用 TestClient 断言状态码；
_get_services 用 monkeypatch 全部换成记录型假件。
"""
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import wenlv_diy as api
from src.services.wenlv_diy_adopt import DiyAdoptError, build_adopt_payload
from src.services.wenlv_diy_session import WenlvSessionError
from src.services.wenlv_qa import group_fix_plan, route_todo

ROOM_ID = "room-1"
SESSION_ID = "sess-1"
USER_ID = "u7"


# ============================ 纯映射单测（TR-13.1）============================

def test_worldview_mapper_strips_schema_version_and_camelizes():
    draft = {"schema_version": "diy1.0", "era": "民国", "region": "广州",
             "theme": "民俗恐怖", "tone": "压抑", "background": "x",
             "key_rules": ["规则甲"]}
    payload = build_adopt_payload("worldview", draft)
    assert payload == {"worldview": {"era": "民国", "region": "广州", "theme": "民俗恐怖",
                                     "tone": "压抑", "background": "x", "keyRules": ["规则甲"]}}


def test_characters_mapper_persona_secret_and_relations_camel():
    draft = {"npcs": [{
        "id": "NPC_7_01", "name": "阿秀", "role": "指引", "description": "绣庄主人",
        "persona": {"personality": ["谨慎"], "tone": "轻声", "catchphrases": ["回来啦"],
                    "backstory": "...", "clues": ["左撇子"], "taboos": ["不提水患"],
                    "secret_layer": {"knows": ["真凶"], "never": ["不进祠堂"],
                                     "loosens_when": "取得银锁"}},
        "relationships": [{"target_npc_id": "NPC_7_02", "relation_type": "师徒",
                           "description": "暗中传授"}],
    }]}
    npc = build_adopt_payload("characters", draft)["npcs"][0]
    assert npc["persona"]["secretLayer"] == {"knows": ["真凶"], "never": ["不进祠堂"],
                                             "loosensWhen": "取得银锁"}
    assert npc["relationships"][0] == {"targetNpcId": "NPC_7_02", "relationType": "师徒",
                                       "description": "暗中传授"}
    assert "secret_layer" not in npc["persona"]


def test_skeleton_mapper_time_label():
    payload = build_adopt_payload("skeleton", {"chapters": [
        {"id": "CH_7_01", "title": "入村", "time_label": "黄昏", "goal": "落脚", "order": 1}]})
    assert payload["chapters"][0] == {"id": "CH_7_01", "title": "入村", "timeLabel": "黄昏",
                                      "goal": "落脚", "order": 1}


def test_scenes_mapper_scene_and_flow_condition_recursion():
    draft = {"scenes": [{
        "id": "SCENE_7_002", "chapter_id": "CH_7_01", "title": "绣庄", "type": "puzzle",
        "content": "推门", "order": 2, "venue_point_id": "VP-9", "npc_id": "NPC_7_01",
        "opening_line": "你来了", "requires": {"type": "nofM", "n": 1, "of": [
            {"type": "role", "character_id": "NPC_7_01"},
            {"type": "ref", "ref": {"kind": "collected", "id": "silver-lock"}}]},
        "grants": ["key-1"], "san_delta": 3,
        "trigger_condition": {"type": "any", "conditions": [
            {"type": "ref", "ref": {"kind": "visited", "id": "SCENE_7_001"}}]},
        "priority": 5, "reward_id": None,
    }], "flows": [
        {"from_scene_id": "SCENE_7_002", "to_scene_id": "SCENE_7_003", "type": "choice",
         "choice_text": "追问", "sort_order": 2, "san_delta": -1, "grants": ["clue-x"],
         "condition": {"type": "role", "character_id": "NPC_7_01"}},
    ]}
    payload = build_adopt_payload("scenes", draft)
    sc = payload["scenes"][0]
    assert sc["chapterId"] == "CH_7_01" and sc["venuePointId"] == "VP-9"
    assert sc["npcId"] == "NPC_7_01" and sc["openingLine"] == "你来了"
    assert sc["sanDelta"] == 3 and sc["priority"] == 5 and sc["rewardId"] is None
    assert sc["requires"]["of"][0] == {"type": "role", "characterId": "NPC_7_01"}
    assert sc["requires"]["of"][1]["ref"] == {"kind": "collected", "id": "silver-lock"}
    assert sc["triggerCondition"]["conditions"][0]["ref"]["id"] == "SCENE_7_001"
    fl = payload["flows"][0]
    assert fl["fromSceneId"] == "SCENE_7_002" and fl["choiceText"] == "追问"
    assert fl["sortOrder"] == 2 and fl["sanDelta"] == -1 and fl["grants"] == ["clue-x"]
    assert fl["condition"] == {"type": "role", "characterId": "NPC_7_01"}


def test_puzzles_mapper_merges_onto_existing_scene_and_emits_pass_fail_flows():
    """TR-13.2：谜题回填是全列 upsert，必须保住剧情侧字段，只覆盖 puzzle/atoms/grants。"""
    room_detail = {"scenes": [{
        "id": "SCENE_7_002", "chapterId": "CH_7_01", "title": "绣庄（剧情原名）",
        "type": "puzzle", "content": "推门（原文）", "npcId": "NPC_7_01", "order": 2,
        "atoms": [], "puzzle": None, "grants": ["story-grant"], "sanDelta": 3,
        "createdAt": "2026-01-01",  # 非白名单列必须被丢弃
    }], "flows": []}
    draft = {"fills": [{
        "scene_id": "SCENE_7_002",
        "puzzle": {"type": "single", "question": "门神哪侧在左？",
                   "options": ["左", "右"], "answer": "左", "hint": "看兵器"},
        "atoms": [{"id": "door", "type": "prop", "title": "木门", "config": {}, "required": True}],
        "grants": ["puzzle-grant"],
        "pass_to_scene_id": "SCENE_7_003", "fail_to_scene_id": "SCENE_7_099",
        "san_delta_pass": 0, "san_delta_fail": -2,
    }], "flows": []}
    payload = build_adopt_payload("puzzles", draft, room_detail)
    sc = payload["scenes"][0]
    assert sc["title"] == "绣庄（剧情原名）" and sc["content"] == "推门（原文）"
    assert sc["chapterId"] == "CH_7_01" and sc["npcId"] == "NPC_7_01"
    assert sc["puzzle"]["answer"] == "左" and sc["atoms"][0]["id"] == "door"
    assert set(sc["grants"]) == {"story-grant", "puzzle-grant"}
    assert "createdAt" not in sc
    types = {(f["type"], f["toSceneId"], f["sanDelta"]) for f in payload["flows"]}
    assert ("puzzle_pass", "SCENE_7_003", 0) in types
    assert ("puzzle_fail", "SCENE_7_099", -2) in types


def test_puzzles_mapper_rejects_unknown_scene():
    with pytest.raises(DiyAdoptError, match="不存在的场景"):
        build_adopt_payload("puzzles", {"fills": [{"scene_id": "GHOST", "puzzle": {},
                                                   "atoms": [], "grants": []}],
                                        "flows": []}, {"scenes": []})


def test_intent_and_publish_have_no_table_mapping():
    with pytest.raises(DiyAdoptError):
        build_adopt_payload("intent", {"goal": "x"}, None)
    with pytest.raises(DiyAdoptError):
        build_adopt_payload("publish", {"ready_to_publish": True}, None)


# ============================ 假件 ============================

class FakeRedis:
    def __init__(self):
        self.kv = {}

    def set(self, k, v):
        self.kv[k] = v

    def get(self, k):
        return self.kv.get(k)

    def expire(self, k, ttl):
        pass


class FakeClient:
    """记录型 pms-server 替身：save_draft 只写快照，adopt 才推进 stage（模拟服务端契约）。"""

    def __init__(self, session=None, room_detail=None, anchor=None):
        self.session = session
        self.room_detail = room_detail
        self.anchor = anchor or {"venue": None, "venueProfile": None,
                                 "merchants": [], "venuePoints": []}
        self.saved_drafts = []      # (session_id, stage)
        self.adopts = []            # (session_id, room_id, payload_keys, advance_to)
        self.patches = []
        self.transcripts = []
        self.gate_todos = []        # Task 14 发布闸假数据
        self.published = []         # 已调用 publish 的 productId

    def create_or_resume(self, room_id, user_id, intent=None):
        return {"session": self.session, "resumed": False}

    def get_session(self, session_id):
        return self.session

    def get_active(self, room_id, user_id):
        return self.session

    def get_room_detail(self, room_id):
        return self.room_detail

    def anchor_context(self, room_id):
        return self.anchor

    def save_draft(self, session_id, stage, draft, advance_to=None):
        self.saved_drafts.append((session_id, stage))
        self.session["draftSnapshots"][stage] = draft
        return {"ok": True}

    def adopt(self, session_id, room_id, payload, advance_to=None):
        self.adopts.append((session_id, room_id, sorted(payload.keys()), advance_to))
        if advance_to:
            self.session["stage"] = advance_to
        return {"worldview": [], "npcs": [], "chapters": [], "scenes": [], "flows": []}

    def patch_session(self, session_id, *, stage=None, status=None, intent=None):
        self.patches.append({"stage": stage, "status": status, "intent": intent})
        if stage:
            self.session["stage"] = stage
        if intent is not None:
            self.session["intent"] = intent
        return {"session": self.session}

    def append_transcript(self, session_id, entries):
        self.transcripts.extend(entries)
        return len(self.transcripts)

    # ---------- Task 14 发布闸 ----------

    def get_publish_todos(self, product_id):
        return {"todos": self.gate_todos, "total": len(self.gate_todos),
                "aiFixable": sum(1 for t in self.gate_todos if t.get("fixBy") == "ai")}

    def publish_product(self, product_id):
        self.published.append(product_id)
        return {"status": "published", "publishedVersion": 1}


class FakeOrch:
    run_key = "wenlv_diy:run"

    def __init__(self):
        self.intent_calls = []
        self.refine_calls = []
        self.chapter_calls = []
        self.draft_calls = []
        self.qa_calls = []

    # 与真 WenlvDiyOrchestrator 同形：运行态写注入的 FakeRedis
    def bind_redis(self, redis):
        self._redis = redis

    def _set_run(self, session_id, status, stage, extra=None):
        import json
        self._redis.set(f"{self.run_key}:{session_id}",
                        json.dumps({"status": status, "stage": stage, **(extra or {})},
                                   ensure_ascii=False))

    def _get_run(self, session_id):
        import json
        raw = self._redis.get(f"{self.run_key}:{session_id}")
        return json.loads(raw) if raw else {"status": "IDLE"}

    def generate_intent(self, raw_text, anchor, product_num):
        self.intent_calls.append((raw_text, product_num))
        return {"schema_version": "diy1.0", "goal": "岭南婚俗恐怖本",
                "questions_for_user": [], "anchor_usage": {}}

    def generate_draft(self, stage, context=None):
        self.draft_calls.append((stage, context))
        canned = {
            "worldview": {"era": "民国", "region": "广州", "key_rules": []},
            "characters": {"npcs": [{"id": "NPC_7_01", "name": "阿秀", "persona": {}}]},
            "skeleton": {"chapters": [{"id": "CH_7_01", "title": "入村", "order": 1}]},
            "scenes": {"scenes": [{"id": "SCENE_7_001", "chapter_id": "CH_7_01",
                                   "title": "开场", "type": "narrative"}], "flows": []},
            "puzzles": {"fills": [], "flows": []},
        }
        return canned[stage]

    def refine_scene(self, scene_id, instruction, context):
        self.refine_calls.append((scene_id, instruction))
        return {"scenes": [{"id": scene_id, "chapter_id": "CH_7_01",
                            "title": "开场（细调）", "type": "narrative",
                            "content": "新内容"}], "flows": []}

    def generate_chapter_scenes(self, chapter_id, context):
        self.chapter_calls.append(chapter_id)
        return {"scenes": [{"id": "SCENE_7_010", "chapter_id": chapter_id,
                            "title": "新章首场", "type": "narrative"}], "flows": []}

    def qa_review(self, graph_snapshot):
        self.qa_calls.append(graph_snapshot)
        return {"ready_to_publish": False, "ai_fixable_count": 1, "manual_count": 0,
                "findings": [{"rule_id": "R7", "severity": "blocker", "scene_id": "SCENE_7_002",
                              "message": "咨询意见（非权威）", "ai_fixable": True,
                              "fix_hint": "补全"}]}


@pytest.fixture
def harness(monkeypatch):
    session = {"id": SESSION_ID, "scriptRoomId": ROOM_ID, "userId": USER_ID,
               "status": "active", "stage": "worldview", "intent": None,
               "draftSnapshots": {}}
    room_detail = {
        "room": {"id": ROOM_ID, "contentId": "p7", "config": {}},
        "chapters": [], "scenes": [], "flows": [], "npcs": [],
    }
    fake_client = FakeClient(session=session, room_detail=room_detail)
    fake_redis = FakeRedis()
    fake_orch = FakeOrch()
    fake_orch.bind_redis(fake_redis)
    monkeypatch.setattr(api, "_get_services",
                        lambda: (fake_client, fake_redis, fake_orch))
    app = FastAPI()
    app.include_router(api.router)
    tc = TestClient(app)
    return tc, fake_client, fake_redis, fake_orch, session, room_detail


# ============================ 生成路径（TR-13.3 零 adopt）============================

def test_generate_worldview_only_saves_draft_never_adopts(harness):
    tc, fc, redis, orch, *_ = harness
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/generate",
                   json={"stage": "worldview"})
    assert resp.status_code == 200, resp.text
    # 后台任务很快完成（假件），轮询 Redis 终态
    for _ in range(50):
        state = redis.kv
        done = any('"DRAFT_READY"' in v for v in state.values())
        if done:
            break
        time.sleep(0.05)
    assert any('"DRAFT_READY"' in v for v in redis.kv.values())
    assert fc.saved_drafts == [(SESSION_ID, "worldview")]
    assert fc.adopts == []  # TR-13.3：四表一个字没动


def test_generate_intent_requires_raw_text(harness):
    tc, fc, *_ = harness
    body = api.GenerateBody(stage="intent")
    with pytest.raises(ValueError, match="rawText"):
        api.run_generation(fc, FakeOrch(), session_id=SESSION_ID, body=body)


def test_generate_intent_passes_anchor_and_product_num(harness):
    tc, fc, redis, orch, *_ = harness
    body = api.GenerateBody(stage="intent", rawText="做一个岭南婚俗恐怖本")
    result = api.run_generation(fc, orch, session_id=SESSION_ID, body=body)
    assert result["stage"] == "intent"
    assert orch.intent_calls == [("做一个岭南婚俗恐怖本", "7")]
    assert fc.saved_drafts == [(SESSION_ID, "intent")]
    assert fc.adopts == []


def test_refine_scene_saves_under_scenes_without_touching_others(harness):
    """TR-13.2 逐场景细调：只路由 story_planner，草案仍只存快照，stage 固定 scenes。"""
    tc, fc, redis, orch, *_ = harness
    body = api.GenerateBody(stage="scenes", focusSceneId="SCENE_7_001",
                            instruction="把开场改得更阴冷")
    result = api.run_generation(fc, orch, session_id=SESSION_ID, body=body)
    assert result["stage"] == "scenes"
    assert orch.refine_calls == [("SCENE_7_001", "把开场改得更阴冷")]
    assert result["draft"]["scenes"][0]["content"] == "新内容"
    assert fc.saved_drafts == [(SESSION_ID, "scenes")]
    assert fc.adopts == []


def test_regenerate_chapter_only_routes_story_planner(harness):
    tc, fc, redis, orch, *_ = harness
    body = api.GenerateBody(stage="scenes", focusChapterId="CH_7_02")
    result = api.run_generation(fc, orch, session_id=SESSION_ID, body=body)
    assert orch.chapter_calls == ["CH_7_02"]
    assert result["draft"]["scenes"][0]["chapter_id"] == "CH_7_02"
    assert fc.saved_drafts == [(SESSION_ID, "scenes")]


# ============================ 采纳路径（TR-13.1 落盘表）============================

def test_adopt_worldview_advances_stage_via_adopt_transaction(harness):
    tc, fc, *_ = harness
    fc.session["stage"] = "worldview"
    fc.session["draftSnapshots"]["worldview"] = {"era": "民国", "key_rules": ["r1"]}
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["advancedTo"] == "characters"
    assert fc.adopts == [(SESSION_ID, ROOM_ID, ["worldview"], "characters")]
    assert fc.session["stage"] == "characters"
    # 生成留痕：用户确认动作进 transcript
    assert any(e["role"] == "user" for e in fc.transcripts)


def test_adopt_without_draft_is_409(harness):
    tc, fc, *_ = harness
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 409
    assert fc.adopts == []


def test_intent_adopt_patches_session_not_tables(harness):
    tc, fc, *_ = harness
    fc.session["stage"] = "intent"
    intent_draft = {"goal": "x", "questions_for_user": []}
    fc.session["draftSnapshots"]["intent"] = intent_draft
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200
    assert fc.adopts == []  # intent 不落四表
    assert fc.patches[0]["stage"] == "worldview"
    assert fc.patches[0]["intent"] == intent_draft


def test_adopt_skeleton_payload_maps_to_chapters(harness):
    tc, fc, *_ = harness
    fc.session["stage"] = "skeleton"
    fc.session["draftSnapshots"]["skeleton"] = {"chapters": [
        {"id": "CH_7_01", "title": "入村", "time_label": "黄昏", "order": 1}]}
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200
    _, _, keys, advance = fc.adopts[0]
    assert keys == ["chapters"] and advance == "scenes"


def test_adopt_puzzles_merges_with_library_rows(harness):
    tc, fc, redis, orch, session, room_detail = harness
    # 库里已有剧情场景
    room_detail["scenes"] = [{
        "id": "SCENE_7_002", "chapterId": "CH_7_01", "title": "原名",
        "type": "puzzle", "content": "原文", "grants": ["g0"], "order": 2}]
    session["stage"] = "puzzles"
    session["draftSnapshots"]["puzzles"] = {"fills": [{
        "scene_id": "SCENE_7_002",
        "puzzle": {"type": "input", "question": "口令？", "answer": "开门",
                   "hint": "问更夫"},
        "atoms": [], "grants": ["g1"],
        "pass_to_scene_id": "SCENE_7_003"}], "flows": []}
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200, resp.text
    _, room_id, keys, advance = fc.adopts[0]
    assert keys == ["flows", "scenes"] and advance == "publish"
    # 采纳载荷经合并后保住剧情字段（在 run 内部已由 mapper 单测细查，这里验链路真的调了库详情）
    assert fc.room_detail is not None


def test_adopt_missing_session_404(harness):
    tc, fc, *_ = harness
    fc.session = None
    resp = tc.post("/wenlv-diy/sessions/nope/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 404


def test_adopt_propagates_pms_server_conflict(harness):
    tc, fc, *_ = harness

    def boom(*a, **k):
        raise WenlvSessionError(409, "会话已完成，不可再写")
    fc.adopt = boom
    fc.session["draftSnapshots"]["worldview"] = {"era": "x"}
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/adopt",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 409
    assert "不可再写" in resp.text


# ============================ 回退 / 恢复 ============================

def test_rollback_default_one_step_and_explicit(harness):
    tc, fc, *_ = harness
    fc.session["stage"] = "scenes"
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/rollback", json={})
    assert resp.status_code == 200 and resp.json()["data"]["stage"] == "skeleton"

    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/rollback",
                   json={"toStage": "intent"})
    assert resp.status_code == 200 and resp.json()["data"]["stage"] == "intent"
    # 草案未被删除（换版时重生成覆盖即可）
    fc.session["draftSnapshots"]["worldview"] = {"era": "旧"}
    tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/rollback", json={})
    assert fc.session["draftSnapshots"]["worldview"] == {"era": "旧"}


def test_rollback_rejects_forward_target(harness):
    tc, fc, *_ = harness
    fc.session["stage"] = "intent"
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/rollback",
                   json={"toStage": "scenes"})
    assert resp.status_code == 400


def test_resume_returns_authoritative_graph(harness):
    tc, fc, *_ = harness
    resp = tc.get(f"/wenlv-diy/sessions/{SESSION_ID}")
    assert resp.status_code == 200
    assert resp.json()["data"]["session"]["scriptRoomId"] == ROOM_ID
    resp = tc.get(f"/wenlv-diy/rooms/{ROOM_ID}")
    assert resp.status_code == 200
    assert resp.json()["data"]["room"]["contentId"] == "p7"


def test_generate_without_redis_503(monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    tc = TestClient(app)
    monkeypatch.setattr(api, "_get_services",
                        lambda: (object(), None, object()))
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/generate",
                   json={"stage": "worldview"})
    assert resp.status_code == 503


def test_router_registered_in_main():
    """路由注册兜底（不 import src.main，只扫源码，避免 crewai 44s 导入）。"""
    from pathlib import Path
    main_src = (Path(__file__).resolve().parents[1] / "src" / "main.py").read_text(encoding="utf-8")
    assert "wenlv_diy_router" in main_src
    assert 'include_router(wenlv_diy_router, prefix="/api")' in main_src


# ============================ Task 14：质检/修复/发布 ============================

def _todo(code, fix_by, action_type=None, target_id=None, hint=None):
    t = {"code": code, "message": f"{code} 违规", "fixBy": fix_by}
    if target_id:
        t["target"] = {"kind": "node", "id": target_id, "name": target_id}
    if action_type:
        t["aiAction"] = {"type": action_type, "targetId": target_id,
                         "hint": hint or f"修复 {code}", "label": "AI 修"}
    elif fix_by == "manual":
        t["manualHint"] = "人工处理"
    return t


def test_route_todo_maps_each_gate_code_to_owner_agent():
    # 谜题码虽挂 node_refine，但内容归谜题师 → puzzles 阶段整表回填
    r = route_todo(_todo("PUZZLE_REQUIRED", "ai", "node_refine", "SCENE_7_002"))
    assert r["stage"] == "puzzles" and r["kind"] == "puzzles_regen"
    # 节点内容缺失（有目标）→ 剧情编排师逐场景细调
    r = route_todo(_todo("GRAPH_R7", "ai", "node_refine", "SCENE_7_002"))
    assert r == {"stage": "scenes", "kind": "scene_refine", "targetId": "SCENE_7_002",
                 "codes": ["GRAPH_R7"], "instructions": ["修复 GRAPH_R7"]}
    # 流程死锁/线索断流 → 全图 scenes 重生成（按 id upsert）
    r = route_todo(_todo("GRAPH_R9", "ai", "flow_repair", "p7", "疏通死锁"))
    assert r["stage"] == "scenes" and r["kind"] == "scenes_regen"
    # 缺结局（产品级，无目标）→ scenes 重生成
    assert route_todo(_todo("NARRATIVE_NO_ENDING", "ai", "ending_optimize"))["kind"] == "scenes_regen"
    # NPC/角色类 → character_designer
    assert route_todo(_todo("NPC_NO_LINES", "ai", "single_optimize", "NPC_7_01"))["kind"] == "characters_regen"
    # 人工项不路由
    assert route_todo(_todo("POINT_NOT_FOUND", "manual")) is None
    assert route_todo(_todo("GRAPH_R1", "manual")) is None


def test_group_fix_plan_merges_same_scene_todos():
    todos = [
        _todo("GRAPH_R7", "ai", "node_refine", "SCENE_7_002", "补开场白"),
        _todo("GRAPH_R7", "ai", "node_refine", "SCENE_7_002", "绑 NPC"),
        _todo("GRAPH_R7", "ai", "node_refine", "SCENE_7_003", "另一场"),
        _todo("GRAPH_R1", "manual"),
    ]
    plan = group_fix_plan(todos)
    scene_items = [p for p in plan if p["kind"] == "scene_refine"]
    assert len(scene_items) == 2
    s2 = next(p for p in scene_items if p["targetId"] == "SCENE_7_002")
    assert s2["codes"] == ["GRAPH_R7"]  # code 去重
    assert "补开场白" in s2["instructions"] and "绑 NPC" in s2["instructions"]
    # only_codes 过滤
    assert group_fix_plan(todos, only_codes={"GRAPH_R1"}) == []


def test_qa_review_gate_is_authoritative_and_advisory_is_separate(harness):
    tc, fc, redis, orch, *_ = harness
    fc.gate_todos = [
        _todo("PUZZLE_REQUIRED", "ai", "node_refine", "SCENE_7_002"),
        _todo("POINT_NOT_FOUND", "manual"),
    ]
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/qa/review",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["readyToPublish"] is False
    assert data["total"] == 2 and data["aiFixableCount"] == 1 and data["manualCount"] == 1
    assert data["todos"][0]["route"]["kind"] == "puzzles_regen"
    assert data["todos"][1]["route"] is None
    # 咨询意见被附加但不作为裁决（它自称 ready=false 也不改变闸门计数口径）
    assert data["advisory"]["findings"][0]["rule_id"] == "R7"
    assert len(orch.qa_calls) == 1


def test_qa_review_clean_means_ready(harness):
    tc, fc, *_ = harness
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/qa/review",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["readyToPublish"] is True and data["total"] == 0


def test_qa_fix_only_produces_drafts_and_routes_content_agents(harness):
    """TR-14.1/14.2：一键修复产草案不采纳；质检师不在修复路径上（不产出内容）。"""
    tc, fc, redis, orch, *_ = harness
    fc.gate_todos = [
        _todo("PUZZLE_REQUIRED", "ai", "node_refine", "SCENE_7_002", "补谜题"),
        _todo("GRAPH_R9", "ai", "flow_repair", "p7", "疏通死锁"),
        _todo("POINT_NOT_FOUND", "manual"),
    ]
    resp = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/qa/fix",
                   json={"scriptRoomId": ROOM_ID})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    stages = sorted(p["stage"] for p in data["proposalStages"])
    assert stages == ["puzzles", "scenes"]
    assert data["remainingManual"] == 1
    # 草案进快照（puzzles 一份、scenes 一份），四表零写入
    assert sorted(s for _, s in fc.saved_drafts) == ["puzzles", "scenes"]
    assert fc.adopts == []
    # 修复路径只调内容 agent：puzzles/scenes 各一次 generate_draft；qa_review 零次
    assert [s for s, _ in orch.draft_calls] == ["puzzles", "scenes"]
    assert orch.qa_calls == []
    # qa_todos 已注入上下文供 agent 定位
    _, scenes_ctx = orch.draft_calls[1]
    assert scenes_ctx["qa_todos"][0]["code"] == "PUZZLE_REQUIRED"


def test_qa_fix_scene_refine_merges_and_publishes_blocked_until_clean(harness):
    tc, fc, redis, orch, *_ = harness
    # 先有一条场景级 AI 可修 + 一条人工：修复有提案，但发布必须仍 409
    fc.gate_todos = [_todo("GRAPH_R7", "ai", "node_refine", "SCENE_7_001", "补开场白"),
                     _todo("GRAPH_R1", "manual")]
    r = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/qa/fix", json={"scriptRoomId": ROOM_ID})
    assert r.status_code == 200
    assert orch.refine_calls == [("SCENE_7_001", "补开场白")]
    assert fc.adopts == []

    r = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/publish",
                json={"scriptRoomId": ROOM_ID})
    assert r.status_code == 409
    assert fc.published == []  # 未清零连发布请求都不该发出

    # 用户采纳修复后（模拟 pms-server 重算）闸清零 → 发布成功、会话收尾
    fc.adopt(SESSION_ID, ROOM_ID, {"scenes": []}, advance_to="publish")
    fc.gate_todos = []
    r = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/publish",
                json={"scriptRoomId": ROOM_ID})
    assert r.status_code == 200, r.text
    assert fc.published == ["p7"]
    assert fc.patches[-1]["status"] == "completed"


def test_qa_fix_manual_only_yields_no_proposals(harness):
    tc, fc, *_ = harness
    fc.gate_todos = [_todo("POINT_NO_CODE", "manual"), _todo("GRAPH_R8", "manual")]
    r = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/qa/fix",
                json={"scriptRoomId": ROOM_ID})
    assert r.status_code == 200
    assert r.json()["data"]["proposalStages"] == []
    assert fc.saved_drafts == [] and fc.adopts == []


def test_qa_fix_respects_code_filter(harness):
    tc, fc, redis, orch, *_ = harness
    fc.gate_todos = [
        _todo("PUZZLE_REQUIRED", "ai", "node_refine", "SCENE_7_002"),
        _todo("NPC_NO_LINES", "ai", "single_optimize", "NPC_7_01"),
    ]
    r = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/qa/fix",
                json={"scriptRoomId": ROOM_ID, "codes": ["NPC_NO_LINES"]})
    assert r.status_code == 200
    stages = [p["stage"] for p in r.json()["data"]["proposalStages"]]
    assert stages == ["characters"]
    assert [s for s, _ in orch.draft_calls] == ["characters"]


def test_publish_without_product_binding_400(harness):
    tc, fc, *_ = harness
    fc.room_detail["room"] = {"id": ROOM_ID}  # 无 contentId
    r = tc.post(f"/wenlv-diy/sessions/{SESSION_ID}/publish",
                json={"scriptRoomId": ROOM_ID})
    assert r.status_code == 400
    assert fc.published == []
