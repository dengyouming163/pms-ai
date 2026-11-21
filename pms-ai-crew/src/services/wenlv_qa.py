"""发布闸待办 → DIY 修复路由（Task 14 TR-14.2：质检师只校验/路由，不产出内容）。

pms-server 发布闸（buildPublishTodos）给每条待办打了 fixBy=ai|manual + aiAction.type；
本模块把 ai 动作映射到七步管线里**唯一有权改该内容**的 agent：

  PUZZLE_*（node_refine 的谜题子类）→ puzzle_designer（puzzles 阶段整表回填）
  node_refine / GRAPH_R7 / ending_optimize（有场景目标）→ story_planner 逐场景细调
  ending_optimize（无目标，缺结局）/ skeleton_generate / flow_repair / GRAPH_R9 等
      → story_planner 全图 scenes 重生成（按 id upsert，未涉及的已落盘行不动）
  single_optimize / character_optimize / batch_generate
      → character_designer 重生成角色卡（复用已采纳 id）
  fixBy=manual / 未识别动作 → 不路由（人工处理；AI 不猜业务意图）

修复产物仍是**草案**（写 draftSnapshots），用户逐阶段采纳后重新查闸 —— 铁律不破。
"""
from typing import Optional

# 整阶段重生成 / 逐场景细调 两类计划键
SCENE_REFINE = "scene_refine"
SCENES_REGEN = "scenes_regen"
PUZZLES_REGEN = "puzzles_regen"
CHARACTERS_REGEN = "characters_regen"

# aiAction.type → 重生成类（无具体场景目标的产品级动作）
_REGEN_BY_ACTION = {
    "skeleton_generate": ("scenes", SCENES_REGEN),
    "flow_repair": ("scenes", SCENES_REGEN),
    "ending_optimize": ("scenes", SCENES_REGEN),
    "batch_generate": ("characters", CHARACTERS_REGEN),
    "character_optimize": ("characters", CHARACTERS_REGEN),
    "single_optimize": ("characters", CHARACTERS_REGEN),
}


def route_todo(todo: dict) -> Optional[dict]:
    """单条待办 → 修复路由；manual / 未识别返回 None。"""
    if todo.get("fixBy") != "ai":
        return None
    action = todo.get("aiAction") or {}
    action_type = action.get("type")
    code = todo.get("code") or ""
    target = todo.get("target") or {}
    target_id = action.get("targetId") or target.get("id")
    hint = action.get("hint") or todo.get("message") or ""
    base = {"codes": [code] if code else [], "instructions": [hint]}

    # 谜题类错误码虽然服务端也归 node_refine，但内容归谜题师，必须先判 code。
    if code.startswith("PUZZLE_"):
        return {"stage": "puzzles", "kind": PUZZLES_REGEN, **base}

    if action_type == "node_refine" or code == "GRAPH_R7":
        if target_id:
            return {"stage": "scenes", "kind": SCENE_REFINE, "targetId": target_id, **base}
        return {"stage": "scenes", "kind": SCENES_REGEN, **base}

    if action_type == "ending_optimize":
        if target_id:
            return {"stage": "scenes", "kind": SCENE_REFINE, "targetId": target_id, **base}
        return {"stage": "scenes", "kind": SCENES_REGEN, **base}

    mapped = _REGEN_BY_ACTION.get(action_type)
    if mapped:
        return {"stage": mapped[0], "kind": mapped[1], **base}
    return None


def _plan_key(route: dict) -> tuple:
    if route["kind"] == SCENE_REFINE:
        return ("scenes", SCENE_REFINE, route["targetId"])
    return (route["stage"], route["kind"], "*")


def group_fix_plan(todos: list, only_codes: Optional[set] = None) -> list:
    """把待办合并成去重后的修复计划（同场景多条问题一次细调；同类产品级问题一次重生成）。"""
    merged: dict = {}
    order = []
    for todo in todos:
        code = todo.get("code")
        if only_codes is not None and code not in only_codes:
            continue
        route = route_todo(todo)
        if route is None:
            continue
        key = _plan_key(route)
        if key not in merged:
            merged[key] = dict(route)
            merged[key]["codes"] = list(route["codes"])
            merged[key]["instructions"] = list(route["instructions"])
            order.append(key)
        else:
            item = merged[key]
            if code and code not in item["codes"]:
                item["codes"].append(code)
            for ins in route["instructions"]:
                if ins and ins not in item["instructions"]:
                    item["instructions"].append(ins)
    return [merged[k] for k in order]


def merge_scene_drafts(drafts: list) -> dict:
    """多份 DiyScenes 细调结果合并成一份草案：场景按 id 后者覆盖、flows 按 id 去重。"""
    scenes_by_id = {}
    scene_order = []
    anon_scenes = []
    flows_by_id = {}
    flow_order = []
    anon_flows = []
    for d in drafts:
        for sc in d.get("scenes") or []:
            sid = sc.get("id")
            if sid:
                if sid not in scenes_by_id:
                    scene_order.append(sid)
                scenes_by_id[sid] = sc
            else:
                anon_scenes.append(sc)
        for fl in d.get("flows") or []:
            fid = fl.get("id")
            if fid:
                if fid not in flows_by_id:
                    flow_order.append(fid)
                flows_by_id[fid] = fl
            else:
                anon_flows.append(fl)
    scenes = [scenes_by_id[k] for k in scene_order] + anon_scenes
    flows = [flows_by_id[k] for k in flow_order] + anon_flows
    return {"scenes": scenes, "flows": flows}
