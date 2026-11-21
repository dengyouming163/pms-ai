"""七步向导草案 → pms-server adopt 载荷（AdoptPayload）的唯一映射处。

落盘表映射（spec FR-10 / TR-13.1）：
  worldview  → {worldview: {...}}            merge 进 script_rooms.config.worldview
  characters → {npcs: [...]}                 npcs 表（productId 由 pms-server 按 room.contentId 落）
  skeleton   → {chapters: [...]}             chapters 表
  scenes     → {scenes, flows}               scenes/flows 表
  puzzles    → {scenes(合并), flows}          填 scenes.puzzle/atoms + flows.grants/成败边

AI 草案是 snake_case（schemas/wenlv_diy.py），pms-server 列名是 camelCase —— 转换只在此处，
agent/crew 不感知列名。条件树 character_id → characterId 递归映射。

谜题步的关键约束：pms-server adopt 的 scene upsert 是**全列替换**，
故谜题回填必须基于读回的权威场景行合并（只覆盖 puzzle/atoms/grants），
否则会把剧情编排师已落盘的 title/content/chapterId 等全部抹成默认值。
"""
from typing import Optional

# pms-server adopt 场景白名单列（src/services/wenlv/ai-session.ts AdoptSceneDraft）
_SCENE_COLUMNS = [
    "id", "chapterId", "title", "type", "content", "npcId", "atoms", "puzzle", "order",
    "venuePointId", "requires", "geo", "mapX", "mapY", "image", "narrationUrl", "grants",
    "npcLineIds", "openingLine", "chapterGoal", "perspectiveCharacterId", "sanDelta",
    "arAssetUrl", "arAssetUrls", "arDialogue", "triggerCondition", "priority", "rewardId",
]
_FLOW_COLUMNS = ["id", "fromSceneId", "toSceneId", "type", "choiceText", "condition",
                 "grants", "sanDelta", "sortOrder"]


class DiyAdoptError(Exception):
    """映射/合并阶段的业务错误（如谜题回填引用了不存在的场景）。"""


def map_condition(cond: Optional[dict]) -> Optional[dict]:
    """AI 条件树（character_id/snake）→ pms-server WenlvCondition（characterId/camel）。"""
    if not isinstance(cond, dict):
        return None
    t = cond.get("type")
    out: dict = {"type": t}
    if t == "ref":
        ref = cond.get("ref") or {}
        out["ref"] = {"kind": ref.get("kind"), "id": ref.get("id")}
    elif t == "role":
        out["characterId"] = cond.get("character_id") or cond.get("characterId")
    elif t in ("all", "any"):
        out["conditions"] = [map_condition(c) for c in (cond.get("conditions") or [])]
    elif t == "nofM":
        out["n"] = cond.get("n")
        out["of"] = [map_condition(c) for c in (cond.get("of") or [])]
    return out


def _map_persona(persona: Optional[dict]) -> dict:
    persona = persona or {}
    secret = persona.get("secret_layer") or persona.get("secretLayer")
    out = {
        "personality": persona.get("personality") or [],
        "tone": persona.get("tone") or "",
        "catchphrases": persona.get("catchphrases") or [],
        "backstory": persona.get("backstory") or "",
        "clues": persona.get("clues") or [],
        "taboos": persona.get("taboos") or [],
    }
    if secret:
        out["secretLayer"] = {
            "knows": secret.get("knows") or [],
            "never": secret.get("never") or [],
            "loosensWhen": secret.get("loosens_when") or secret.get("loosensWhen"),
        }
    return out


def _worldview_payload(draft: dict) -> dict:
    keep = ("era", "region", "theme", "tone", "background", "key_rules", "keyRules")
    wv = {k: v for k, v in draft.items() if k in keep}
    if "key_rules" in wv:
        wv["keyRules"] = wv.pop("key_rules")
    return {"worldview": wv}


def _characters_payload(draft: dict) -> dict:
    npcs = []
    for n in draft.get("npcs") or []:
        npcs.append({
            "id": n.get("id"),
            "name": n.get("name"),
            "role": n.get("role"),
            "description": n.get("description"),
            "persona": _map_persona(n.get("persona")),
            "relationships": [
                {"targetNpcId": r.get("target_npc_id") or r.get("targetNpcId"),
                 "relationType": r.get("relation_type") or r.get("relationType"),
                 "description": r.get("description") or ""}
                for r in (n.get("relationships") or [])
            ],
        })
    return {"npcs": npcs}


def _skeleton_payload(draft: dict) -> dict:
    chapters = [{
        "id": ch.get("id"),
        "title": ch.get("title"),
        "timeLabel": ch.get("time_label"),
        "goal": ch.get("goal"),
        "order": ch.get("order", 0),
    } for ch in (draft.get("chapters") or [])]
    return {"chapters": chapters}


def _map_story_scene(sc: dict) -> dict:
    return {
        "id": sc.get("id"),
        "chapterId": sc.get("chapter_id") or sc.get("chapterId"),
        "title": sc.get("title"),
        "type": sc.get("type", "narrative"),
        "content": sc.get("content") or "",
        "order": sc.get("order", 0),
        "venuePointId": sc.get("venue_point_id"),
        "npcId": sc.get("npc_id"),
        "openingLine": sc.get("opening_line"),
        "requires": map_condition(sc.get("requires")),
        "grants": sc.get("grants") or [],
        "sanDelta": sc.get("san_delta") if sc.get("san_delta") is not None else 0,
        "triggerCondition": map_condition(sc.get("trigger_condition")),
        "priority": sc.get("priority") or 0,
        "rewardId": sc.get("reward_id"),
    }


def _map_flow(fl: dict) -> dict:
    out = {
        "id": fl.get("id") or None,
        "fromSceneId": fl.get("from_scene_id") or fl.get("fromSceneId"),
        "toSceneId": fl.get("to_scene_id") or fl.get("toSceneId"),
        "type": fl.get("type", "auto"),
        "choiceText": fl.get("choice_text"),
        "condition": map_condition(fl.get("condition")),
        "grants": fl.get("grants") or [],
        "sanDelta": fl.get("san_delta") if fl.get("san_delta") is not None else 0,
        "sortOrder": fl.get("sort_order") if fl.get("sort_order") is not None else 0,
    }
    return out


def _scenes_payload(draft: dict) -> dict:
    return {
        "scenes": [_map_story_scene(s) for s in (draft.get("scenes") or [])],
        "flows": [_map_flow(f) for f in (draft.get("flows") or [])],
    }


def _project_scene_row(row: dict) -> dict:
    """读回的库行 → adopt 白名单列（丢弃 createdAt 等非写入列）。"""
    return {k: row.get(k) for k in _SCENE_COLUMNS if k in row}


def _puzzles_payload(draft: dict, room_detail: Optional[dict]) -> dict:
    """谜题回填合并：以读回的场景全行为底，只覆盖 puzzle/atoms/grants。

    成败边：fills 里的 pass_to/fail_to 展开为 puzzle_pass/puzzle_fail flows；
    draft.flows 里显式给出的成败边原样映射（去 None id，由 pms-server 生成）。
    """
    existing = {}
    for row in (room_detail or {}).get("scenes") or []:
        if row.get("id"):
            existing[row["id"]] = _project_scene_row(row)

    merged_scenes = []
    missing = []
    new_flows = []
    for fill in draft.get("fills") or []:
        sid = fill.get("scene_id")
        base = existing.get(sid)
        if base is None:
            missing.append(sid)
            continue
        base = dict(base)
        base["puzzle"] = fill.get("puzzle")
        base["atoms"] = fill.get("atoms") or []
        # 已发放证物与谜题解开新增的证物取并集（只增不删，避免把剧情编排师的 grants 抹掉）
        grants = set(base.get("grants") or [])
        grants.update(fill.get("grants") or [])
        base["grants"] = sorted(grants)
        merged_scenes.append(base)

        if fill.get("pass_to_scene_id"):
            new_flows.append({"fromSceneId": sid, "toSceneId": fill["pass_to_scene_id"],
                              "type": "puzzle_pass", "grants": [],
                              "sanDelta": fill.get("san_delta_pass") or 0, "sortOrder": 10})
        if fill.get("fail_to_scene_id"):
            new_flows.append({"fromSceneId": sid, "toSceneId": fill["fail_to_scene_id"],
                              "type": "puzzle_fail", "grants": [],
                              "sanDelta": fill.get("san_delta_fail") or 0, "sortOrder": 11})
    if missing:
        raise DiyAdoptError(f"谜题回填引用了不存在的场景：{missing}（谜题师不得新建剧情场景）")

    for fl in draft.get("flows") or []:
        mapped = _map_flow(fl)
        if mapped.get("id") is None:
            mapped.pop("id", None)
        new_flows.append(mapped)
    return {"scenes": merged_scenes, "flows": new_flows}


_MAPPERS = {
    "worldview": _worldview_payload,
    "characters": _characters_payload,
    "skeleton": _skeleton_payload,
    "scenes": _scenes_payload,
}


def build_adopt_payload(stage: str, draft: dict, room_detail: Optional[dict] = None) -> dict:
    """按采纳阶段把 AI 草案映射成 pms-server adopt body（不含 scriptRoomId/advanceTo）。"""
    if stage == "puzzles":
        return _puzzles_payload(draft, room_detail)
    mapper = _MAPPERS.get(stage)
    if mapper is None:
        raise DiyAdoptError(f"阶段 {stage} 没有可落盘的四表映射（intent 存会话、publish 只出报告）")
    return mapper(draft)


# ===== 生成上下文组装（权威基线读库；未采纳阶段回落 draftSnapshots）=====

def build_generation_context(session: dict, room_detail: Optional[dict],
                             anchor: Optional[dict]) -> dict:
    """给 crew 的各步 prompt 组上下文：已采纳内容以**库**为准，草案以 draftSnapshots 补未生成阶段。"""
    room_detail = room_detail or {}
    room = room_detail.get("room") or {}
    config = room.get("config") or {}
    drafts = session.get("draftSnapshots") or session.get("draft_snapshots") or {}

    def _draft(stage):
        return drafts.get(stage)

    ctx = {
        "intent": session.get("intent") or _draft("intent"),
        "anchor": anchor,
        # 库优先：已采纳即权威；库里没有才用本阶段草案（预览换版时重生下一步的情形）
        "worldview": config.get("worldview") or _draft("worldview"),
        "characters": {"npcs": room_detail.get("npcs") or []} if room_detail.get("npcs")
        else _draft("characters") or {"npcs": []},
        "skeleton": {"chapters": room_detail.get("chapters") or []}
        if room_detail.get("chapters") else _draft("skeleton") or {"chapters": []},
        "scenes": {"scenes": room_detail.get("scenes") or [], "flows": room_detail.get("flows") or []},
    }
    return ctx


def product_num_from_room(room_detail: Optional[dict]) -> str:
    """从 room.contentId 抠产品编号喂 id 铁律（如 p7 → 7；抠不到回 'X'）。"""
    import re
    content_id = (room_detail or {}).get("room", {}).get("contentId") or ""
    m = re.search(r"(\d+)", str(content_id))
    return m.group(1) if m else "X"
