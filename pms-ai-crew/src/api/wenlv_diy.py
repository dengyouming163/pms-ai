"""文旅自制向导（DIY）七步 BFF 接口 —— AI 提案、用户决策。

流水线（每步：生成草案 → 用户确认/微调 → 采纳落盘）：
  intent → worldview → characters → skeleton → scenes → puzzles → publish(质检 Task 14)

铁律（spec FR-9 / TR-13.3）：草案只写 ai_sessions.draftSnapshots；
**仅 adopt 事务**落 script_rooms/npcs/chapters/scenes/flows 四表。
本模块所有「生成/细调/全章重生成」路径只调 save_draft，绝不调 adopt。

落盘映射全部集中在 src/services/wenlv_diy_adopt.py（TR-13.1）。
中断恢复：会话与 stage/草案持久在 pms-server，本服务重启不丢（TR-13.2）；
局部重生成按 scene/flow id upsert，不触碰未重生成的行。
"""
import asyncio
import json
import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.crews.wenlv_diy_crew import (
    NEXT_STAGE,
    STAGE_ORDER,
    StageFailedError,
    WenlvDiyOrchestrator,
)
from src.services.wenlv_diy_adopt import (
    DiyAdoptError,
    build_adopt_payload,
    build_generation_context,
    product_num_from_room,
)
from src.services.wenlv_diy_session import WenlvDiySessionClient, WenlvSessionError
from src.services.wenlv_qa import (
    CHARACTERS_REGEN,
    PUZZLES_REGEN,
    SCENES_REGEN,
    SCENE_REFINE,
    group_fix_plan,
    merge_scene_drafts,
    route_todo,
)

router = APIRouter(prefix="/wenlv-diy", tags=["wenlv-diy"])
logger = logging.getLogger(__name__)

_HEARTBEAT_SECONDS = 15
_STAGE_LABELS = {
    "intent": "编剧总监需求",
    "worldview": "世界观",
    "characters": "角色卡",
    "skeleton": "章节骨架",
    "scenes": "分场剧情",
    "puzzles": "谜题回填",
    "publish": "质检发布",
}


def _get_services():
    """真实依赖：内部 HTTP client + Redis 运行态 + orchestrator。测试用 monkeypatch 替换本函数。"""
    from src.config import _get_redis
    redis = _get_redis()
    client = WenlvDiySessionClient()
    orch = WenlvDiyOrchestrator(session_client=client, redis=redis)
    return client, redis, orch


# ===== 请求模型（宽松：业务校验在 crew schema 与 pms-server 双重把关）=====

class CreateSessionBody(BaseModel):
    scriptRoomId: str = Field(min_length=1)
    userId: str = Field(min_length=1)
    intent: Optional[dict] = None


class GenerateBody(BaseModel):
    stage: str
    rawText: Optional[str] = None          # intent 步的自然语言
    context: Optional[dict] = None         # 前端补充上下文（可选，合并进 crew ctx）
    focusSceneId: Optional[str] = None     # 逐场景细调（stage 固定落 scenes 草案）
    instruction: Optional[str] = None      # 细调指令 / 换版要求
    focusChapterId: Optional[str] = None   # 全章一键重生成


class AdoptBody(BaseModel):
    scriptRoomId: str = Field(min_length=1)
    stage: Optional[str] = None            # 缺省取会话当前 stage
    draft: Optional[dict] = None           # 允许前端直接提交修改后的草案（不读快照）


class RollbackBody(BaseModel):
    toStage: Optional[str] = None          # 缺省回退一步


class TranscriptBody(BaseModel):
    entries: list[dict]


class ScriptRoomBody(BaseModel):
    scriptRoomId: str = Field(min_length=1)


class QaFixBody(ScriptRoomBody):
    codes: Optional[list[str]] = None        # 缺省修全部 AI 可修项；可只选部分 code


# ===== 同步核心（bg task / 测试共用）=====

def run_generation(client: WenlvDiySessionClient, orch: WenlvDiyOrchestrator, *,
                   session_id: str, body: GenerateBody) -> dict:
    """跑一个阶段的草案生成（线程内同步），结果只进 draftSnapshots。不落四表。"""
    stage = body.stage
    if stage not in STAGE_ORDER:
        raise ValueError(f"非法阶段：{stage}（合法：{STAGE_ORDER}）")

    session = client.get_session(session_id)
    if session is None:
        raise LookupError(f"AI 会话不存在：{session_id}")
    room_id = session.get("scriptRoomId")

    detail = client.get_room_detail(room_id) if room_id else None
    if detail is None and room_id:
        # 会话指向的房不存在属数据异常（404 透传给调用方）
        raise LookupError(f"剧本房不存在：{room_id}")
    anchor = client.anchor_context(room_id) if room_id else {}
    num = product_num_from_room(detail)

    ctx = build_generation_context(session, detail, anchor)
    ctx["product_num"] = num
    if body.context:
        ctx.update(body.context)

    if stage == "intent":
        if not (body.rawText and body.rawText.strip()):
            raise ValueError("intent 阶段必须提供 rawText")
        draft = orch.generate_intent(body.rawText, anchor, num)
        save_stage = "intent"
    elif body.focusSceneId:
        if not (body.instruction and body.instruction.strip()):
            raise ValueError("逐场景细调必须提供 instruction")
        draft = orch.refine_scene(body.focusSceneId, body.instruction, ctx)
        save_stage = "scenes"
    elif body.focusChapterId:
        draft = orch.generate_chapter_scenes(body.focusChapterId, ctx)
        save_stage = "scenes"
    else:
        draft = orch.generate_draft(stage, ctx)
        save_stage = stage

    client.save_draft(session_id, save_stage, draft)
    try:
        client.append_transcript(session_id, [{
            "role": "assistant",
            "content": f"{_STAGE_LABELS.get(save_stage, save_stage)}草案已生成，等待用户确认采纳",
            "stage": save_stage,
        }])
    except WenlvSessionError:
        logger.warning("草案已保存但 transcript 追加失败 session=%s", session_id, exc_info=True)
    return {"stage": save_stage, "draft": draft}


# ===== 会话 / 恢复 / 锚定（薄代理 pms-server 内部端点）=====

@router.post("/sessions")
def create_session(body: CreateSessionBody):
    client, _, _ = _get_services()
    try:
        data = client.create_or_resume(
            body.scriptRoomId, body.userId, intent=body.intent)
        return {"success": True, "data": data}
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.get("/sessions/{session_id}")
def get_session(session_id: str):
    client, _, _ = _get_services()
    try:
        session = client.get_session(session_id)
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    if session is None:
        raise HTTPException(status_code=404, detail="AI 会话不存在")
    return {"success": True, "data": {"session": session}}


@router.get("/rooms/{room_id}/active-session")
def get_active_session(room_id: str, userId: str):
    client, _, _ = _get_services()
    try:
        session = client.get_active(room_id, userId)
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    if session is None:
        raise HTTPException(status_code=404, detail="无活跃 AI 会话")
    return {"success": True, "data": {"session": session}}


@router.get("/rooms/{room_id}")
def get_room(room_id: str):
    """中断恢复：权威图（含 npcs）一次取全，前端据此区分「已采纳锁定」与「草案待确认」。"""
    client, _, _ = _get_services()
    try:
        detail = client.get_room_detail(room_id)
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)
    if detail is None:
        raise HTTPException(status_code=404, detail="剧本房不存在")
    return {"success": True, "data": detail}


@router.get("/rooms/{room_id}/anchor")
def get_anchor(room_id: str):
    client, _, _ = _get_services()
    try:
        return {"success": True, "data": client.anchor_context(room_id)}
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


@router.post("/sessions/{session_id}/transcript")
def append_transcript(session_id: str, body: TranscriptBody):
    client, _, _ = _get_services()
    try:
        length = client.append_transcript(session_id, body.entries)
        return {"success": True, "data": {"transcriptLength": length}}
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


# ===== 生成（异步 + SSE）=====

@router.post("/sessions/{session_id}/generate")
async def generate(session_id: str, body: GenerateBody):
    """启动后台草案生成；进度通过 GET .../stream 订阅。草案只入 draftSnapshots。"""
    client, redis, orch = _get_services()
    if redis is None:
        raise HTTPException(status_code=503, detail="草案生成依赖 Redis 运行态，当前未配置")
    if body.stage not in STAGE_ORDER:
        raise HTTPException(status_code=400, detail=f"非法阶段：{body.stage}")

    await asyncio.to_thread(orch._set_run, session_id, "DRAFTING", body.stage)

    def _job():
        try:
            result = run_generation(client, orch, session_id=session_id, body=body)
            orch._set_run(session_id, "DRAFT_READY", result["stage"],
                          {"draft": result["draft"], "finishedAt": time.time()})
        except (StageFailedError, ValueError, LookupError, WenlvSessionError) as e:
            logger.warning("DIY 草案生成失败 session=%s: %s", session_id, e)
            orch._set_run(session_id, "FAILED", body.stage,
                          {"draft": None, "error": str(e), "finishedAt": time.time()})
        except Exception:
            logger.exception("DIY 草案生成异常 session=%s", session_id)
            orch._set_run(session_id, "FAILED", body.stage,
                          {"draft": None, "error": "内部错误，请重试", "finishedAt": time.time()})

    asyncio.create_task(asyncio.to_thread(_job))
    return {"success": True, "data": {"started": True, "stage": body.stage}}


@router.get("/sessions/{session_id}/stream")
async def stream(session_id: str, request: Request):
    """SSE：轮询 Redis 运行态，DRAFTING 心跳保活，READY/FAILED 终态后结束。"""
    _, redis, orch = _get_services()
    if redis is None:
        raise HTTPException(status_code=503, detail="SSE 依赖 Redis 运行态，当前未配置")

    async def gen():
        last_status = None
        last_yield = time.monotonic()
        for _ in range(800):  # 最多 20 分钟（800 × 1.5s）
            state = await asyncio.to_thread(orch._get_run, session_id) or {}
            status = state.get("status")
            if status != last_status:
                last_status = status
                last_yield = time.monotonic()
                yield f"event: status\ndata: {json.dumps({'status': status, 'stage': state.get('stage')}, ensure_ascii=False)}\n\n"
                if status == "DRAFT_READY":
                    yield f"event: done\ndata: {json.dumps({'stage': state.get('stage'), 'draft': state.get('draft')}, ensure_ascii=False)}\n\n"
                    break
                if status == "FAILED":
                    yield f"event: error\ndata: {json.dumps({'error': state.get('error', 'FAILED'), 'stage': state.get('stage')}, ensure_ascii=False)}\n\n"
                    break
            if await request.is_disconnected():
                break
            if time.monotonic() - last_yield >= _HEARTBEAT_SECONDS:
                last_yield = time.monotonic()
                yield ": ping\n\n"
            await asyncio.sleep(1.5)

    return StreamingResponse(gen(), media_type="text/event-stream")


# ===== 采纳（唯一落盘路径）=====

@router.post("/sessions/{session_id}/adopt")
def adopt(session_id: str, body: AdoptBody):
    """用户确认采纳当前阶段草案：映射 → pms-server adopt 事务落四表 → stage 前进。"""
    client, _, _ = _get_services()
    try:
        session = client.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="AI 会话不存在")
        stage = body.stage or session.get("stage")
        if stage not in STAGE_ORDER:
            raise HTTPException(status_code=400, detail=f"非法阶段：{stage}")

        drafts = session.get("draftSnapshots") or session.get("draft_snapshots") or {}
        draft = body.draft if body.draft is not None else drafts.get(stage)
        if draft is None:
            raise HTTPException(status_code=409, detail=f"阶段 {stage} 尚无草案，请先生成再采纳")

        advance = NEXT_STAGE.get(stage)

        # intent 不落四表：写 ai_sessions.intent 并前进到 worldview。
        if stage == "intent":
            updated = client.patch_session(session_id, stage=advance, intent=draft)
            client.append_transcript(session_id, [{
                "role": "user", "content": "已采纳创作需求，进入世界观", "stage": "intent"}])
            return {"success": True, "data": {"stage": "intent", "advancedTo": advance,
                                              "session": updated}}

        detail = client.get_room_detail(body.scriptRoomId)
        try:
            payload = build_adopt_payload(stage, draft, detail)
        except DiyAdoptError as e:
            raise HTTPException(status_code=400, detail=str(e))

        adopted = client.adopt(session_id, body.scriptRoomId, payload, advance_to=advance)
        try:
            client.append_transcript(session_id, [{
                "role": "user",
                "content": f"已采纳{_STAGE_LABELS.get(stage, stage)}草案并落盘",
                "stage": stage,
            }])
        except WenlvSessionError:
            logger.warning("落盘成功但 transcript 追加失败 session=%s", session_id, exc_info=True)
        return {"success": True, "data": {"stage": stage, "advancedTo": advance, "adopted": adopted}}
    except WenlvSessionError as e:
        # 4xx 透传（会话不 active/章节不属于本房等），5xx 统一 502
        code = e.status_code if 400 <= e.status_code < 500 else 502
        raise HTTPException(status_code=code, detail=e.message)


# ===== 回退（只回 stage；已落盘内容不回滚，草案保留供换版）=====

@router.post("/sessions/{session_id}/rollback")
def rollback(session_id: str, body: RollbackBody):
    client, _, _ = _get_services()
    try:
        session = client.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="AI 会话不存在")
        cur = session.get("stage")
        cur_idx = STAGE_ORDER.index(cur) if cur in STAGE_ORDER else 0
        if body.toStage is not None:
            if body.toStage not in STAGE_ORDER:
                raise HTTPException(status_code=400, detail=f"非法阶段：{body.toStage}")
            target_idx = STAGE_ORDER.index(body.toStage)
            if target_idx >= cur_idx:
                raise HTTPException(status_code=400, detail="回退目标必须早于当前阶段")
            target = body.toStage
        else:
            if cur_idx <= 0:
                raise HTTPException(status_code=400, detail="已在最初阶段，无法回退")
            target = STAGE_ORDER[cur_idx - 1]
        updated = client.patch_session(session_id, stage=target)
        return {"success": True, "data": {"stage": target, "session": updated}}
    except WenlvSessionError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message)


# ===== Task 14：质检 / 一键修复（提案）/ 发布 =====

def _gate_todos(client: WenlvDiySessionClient, detail: dict) -> tuple[str, list]:
    """取发布闸清单。productId=room.contentId（门票产品即发布主体）。"""
    room = (detail or {}).get("room") or {}
    product_id = room.get("contentId")
    if not product_id:
        raise HTTPException(status_code=400, detail="剧本房未绑定产品（contentId 为空），无法校验发布")
    gate = client.get_publish_todos(product_id)
    return product_id, gate.get("todos") or []


def run_qa_fix(client: WenlvDiySessionClient, orch: WenlvDiyOrchestrator, *,
               session_id: str, script_room_id: str,
               only_codes: Optional[set] = None) -> dict:
    """按发布闸待办分组调度内容 agent 产出修复草案。只写 draftSnapshots，不调 adopt。

    质检师本身不出现在此路径（TR-14.2）：被调度的只有 story_planner
    （refine_scene/generate_draft scenes）、puzzle_designer（puzzles）、
    character_designer（characters）。
    """
    session = client.get_session(session_id)
    if session is None:
        raise LookupError(f"AI 会话不存在：{session_id}")
    detail = client.get_room_detail(script_room_id)
    if detail is None:
        raise LookupError(f"剧本房不存在：{script_room_id}")
    _, todos = _gate_todos(client, detail)
    plan = group_fix_plan(todos, only_codes)
    if not plan:
        return {"plan": [], "proposalStages": [], "todos": todos}

    ctx = build_generation_context(session, detail, client.anchor_context(script_room_id))
    ctx["product_num"] = product_num_from_room(detail)
    ctx["qa_todos"] = [{"code": t.get("code"), "message": t.get("message"),
                        "target": t.get("target")} for t in todos]

    scene_drafts = []
    puzzles_draft = None
    characters_draft = None
    used_kinds = []
    for item in plan:
        instruction = "\n".join(i for i in item["instructions"] if i)
        if item["kind"] == SCENE_REFINE:
            scene_drafts.append(orch.refine_scene(item["targetId"], instruction, ctx))
        elif item["kind"] == SCENES_REGEN:
            scene_drafts.append(orch.generate_draft("scenes", ctx))
        elif item["kind"] == PUZZLES_REGEN:
            puzzles_draft = orch.generate_draft("puzzles", ctx)
        elif item["kind"] == CHARACTERS_REGEN:
            characters_draft = orch.generate_draft("characters", ctx)
        used_kinds.append(item["kind"])

    proposal_stages = []
    if scene_drafts:
        merged = merge_scene_drafts(scene_drafts)
        client.save_draft(session_id, "scenes", merged)
        proposal_stages.append({"stage": "scenes", "scenes": len(merged["scenes"]),
                                "flows": len(merged["flows"])})
    if puzzles_draft is not None:
        client.save_draft(session_id, "puzzles", puzzles_draft)
        proposal_stages.append({"stage": "puzzles",
                                "fills": len(puzzles_draft.get("fills") or [])})
    if characters_draft is not None:
        client.save_draft(session_id, "characters", characters_draft)
        proposal_stages.append({"stage": "characters",
                                "npcs": len(characters_draft.get("npcs") or [])})

    try:
        client.append_transcript(session_id, [{
            "role": "assistant",
            "content": f"质检修复草案已生成（{', '.join(p['stage'] for p in proposal_stages)}），"
                       f"请逐阶段确认采纳后重新校验",
            "stage": "publish",
        }])
    except WenlvSessionError:
        logger.warning("修复草案已保存但 transcript 追加失败 session=%s", session_id, exc_info=True)

    return {"plan": plan, "proposalStages": proposal_stages, "todos": todos,
            "usedKinds": used_kinds}


@router.post("/sessions/{session_id}/qa/review")
def qa_review(session_id: str, body: ScriptRoomBody):
    """发布闸体检：权威结论 = pms-server publish-todos（清零才可 live）。

    qa_inspector 的 LLM 意见仅作 advisory 附加（不增删待办、不参与放行判定）。
    """
    client, _, orch = _get_services()
    try:
        session = client.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="AI 会话不存在")
        detail = client.get_room_detail(body.scriptRoomId)
        if detail is None:
            raise HTTPException(status_code=404, detail="剧本房不存在")
        product_id, todos = _gate_todos(client, detail)
    except WenlvSessionError as e:
        code = e.status_code if 400 <= e.status_code < 500 else 502
        raise HTTPException(status_code=code, detail=e.message)

    routed = []
    for t in todos:
        item = dict(t)
        item["route"] = route_todo(t)  # manual 项 route=None
        routed.append(item)
    ai_count = sum(1 for t in routed if t.get("route"))
    manual_count = len(routed) - ai_count

    advisory = None
    try:
        advisory = orch.qa_review({
            "chapters": detail.get("chapters"), "scenes": detail.get("scenes"),
            "flows": detail.get("flows"), "npcs": detail.get("npcs"), "todos": routed,
        })
    except Exception:
        logger.warning("qa_inspector 咨询意见生成失败（不影响发布闸结论）", exc_info=True)

    return {"success": True, "data": {
        "productId": product_id,
        "readyToPublish": len(routed) == 0,
        "total": len(routed), "aiFixableCount": ai_count, "manualCount": manual_count,
        "todos": routed, "advisory": advisory,
    }}


@router.post("/sessions/{session_id}/qa/fix")
def qa_fix(session_id: str, body: QaFixBody):
    """一键修复：调度对应 agent 产出修复**草案**。仍需用户逐阶段 /adopt 后再查闸。"""
    client, _, orch = _get_services()
    try:
        result = run_qa_fix(client, orch, session_id=session_id,
                            script_room_id=body.scriptRoomId,
                            only_codes=set(body.codes) if body.codes else None)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except WenlvSessionError as e:
        code = e.status_code if 400 <= e.status_code < 500 else 502
        raise HTTPException(status_code=code, detail=e.message)
    return {"success": True, "data": {
        "proposalStages": result["proposalStages"],
        "remainingManual": sum(1 for t in result["todos"] if t.get("fixBy") == "manual"),
        "note": "修复仅生成草案，请逐阶段采纳后重新调 qa/review 校验",
    }}


@router.post("/sessions/{session_id}/publish")
def publish(session_id: str, body: ScriptRoomBody):
    """清零才上架：先查发布闸，有待办一律 409（连 pms-server 都不调）；清零才 POST publish。"""
    client, _, _ = _get_services()
    try:
        session = client.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="AI 会话不存在")
        detail = client.get_room_detail(body.scriptRoomId)
        if detail is None:
            raise HTTPException(status_code=404, detail="剧本房不存在")
        product_id, todos = _gate_todos(client, detail)
        if todos:
            raise HTTPException(status_code=409, detail={
                "message": "发布闸未清零，禁止上架",
                "total": len(todos),
                "aiFixable": sum(1 for t in todos if t.get("fixBy") == "ai"),
                "todos": todos,
            })
        result = client.publish_product(product_id)
        # 向导会话随上架收尾（已发布内容是用户采纳的，不是 AI 自动发布）。
        try:
            client.patch_session(session_id, status="completed")
        except WenlvSessionError:
            logger.warning("产品已上架但会话收尾失败 session=%s", session_id, exc_info=True)
        return {"success": True, "data": {"productId": product_id, "published": result}}
    except WenlvSessionError as e:
        if e.status_code == 409:
            # 竞态：查闸后、发布前出现新问题 —— 透传服务端清单。
            raise HTTPException(status_code=409, detail={
                "message": e.message, "todos": (e.payload or {}).get("todos", [])})
        code = e.status_code if 400 <= e.status_code < 500 else 502
        raise HTTPException(status_code=code, detail=e.message)
