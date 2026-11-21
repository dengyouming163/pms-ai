# src/api/video_script.py
"""视频脚本生产接口：REST 状态机 + SSE 流式"""
import json
import time
import asyncio
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from src.crews.video_script_crew import VideoScriptOrchestrator
from src.config import _get_redis

router = APIRouter(prefix="/video-script", tags=["video-script"])


class StartRequest(BaseModel):
    store_id: str
    highlights: list[str] = []
    goal: str = "引流订房"          # 引流订房 / 涨粉种草 / 卖套餐
    note: str = ""                  # 一句卖点
    industry: str = "旅游住宿"
    platform: str = "通用"


class ConfirmRequest(BaseModel):
    project_id: str
    node_id: str                    # confirm_1 / confirm_2 / confirm_3
    choice: str                     # 选项 id


def _get_orchestrator():
    redis = _get_redis()
    if not redis:
        raise RuntimeError("Redis 不可用，视频脚本任务无法持久化状态")
    return VideoScriptOrchestrator(redis)


def _scope(request: Request) -> str:
    """真实门店归属键：pms-server 透传的 X-Store-Id；本地直连/dev/sanity 无头时回落 local"""
    return request.headers.get("X-Store-Id") or "local"


def _owner(state: dict) -> str:
    """state 归属：meta.store_id 存在则用之，遗留态（无 meta）视作 local（生产门店下不可见）"""
    meta = state.get("meta") or {}
    return meta.get("store_id") or "local"


@router.post("/start")
async def start(req: StartRequest, request: Request):
    """创建任务，跑阶段①，返回 confirm_1"""
    orch = _get_orchestrator()
    project_id = f"VIDEO_{int(time.time())}"
    brief = {
        "product_name": req.store_id,   # 由前端传门店名/店名（文案素材，非租户键）
        "selling_points": req.highlights,
        "usage": req.goal,
        "target_market": "",
    }
    context = {"note": req.note, "industry": req.industry, "platform": req.platform}
    # 先落归属（meta），stage1 首个 _set_state 会携带式保留；缺头回落 local 兼容本地 dev
    orch._set_state(project_id, "CREATED", {}, {
        "store_id": _scope(request),
        "merchant_id": request.headers.get("X-Merchant-Id") or "",
    })
    # CrewAI 的 crew.kickoff() 是同步阻塞方法，不能在 async 事件循环内直接调用，
    # 否则抛 RuntimeError("...running event loop")；用线程池执行。
    result = await asyncio.to_thread(orch.run_stage1, project_id, brief, context)
    result["project_id"] = project_id
    return result


@router.post("/confirm")
async def confirm(req: ConfirmRequest, request: Request):
    """提交确认选择，触发下一阶段（先校验 project 归属当前门店）"""
    orch = _get_orchestrator()
    if _owner(orch._get_state(req.project_id)) != _scope(request):
        return {"status": "ERROR", "error": "无权访问该项目"}
    if req.node_id == "confirm_1":
        return await asyncio.to_thread(orch.run_stage2, req.project_id, req.choice)
    if req.node_id == "confirm_2":
        # 阶段③（合规锁定）与阶段④（资产包+分镜）之间无确认断点，连续执行
        stage3 = await asyncio.to_thread(orch.run_stage3, req.project_id, req.choice)
        if stage3.get("status") in ("FAILED", "ERROR"):
            return stage3
        return await asyncio.to_thread(orch.run_stage4, req.project_id)
    if req.node_id == "confirm_3":
        return await asyncio.to_thread(orch.finalize, req.project_id, req.choice)
    return {"status": "ERROR", "error": f"未知确认节点 {req.node_id}"}


@router.get("/{project_id}")
async def get_status(project_id: str, request: Request):
    orch = _get_orchestrator()
    state = orch._get_state(project_id)
    if _owner(state) != _scope(request):
        return {"status": "ERROR", "error": "无权访问该项目"}
    return state


@router.get("/{project_id}/stream")
async def stream(project_id: str, request: Request):
    """SSE 流式：轮询状态变化并推送事件（简化版，复用 chat.py 事件语义）"""
    orch = _get_orchestrator()

    async def gen():
        # 越权校验与 confirm/get_status 一致：只允许归属当前门店（X-Store-Id）者订阅
        if _owner(orch._get_state(project_id)) != _scope(request):
            yield f"event: error\ndata: {json.dumps({'error': '无权访问该项目'}, ensure_ascii=False)}\n\n"
            return
        last_status = None
        for _ in range(600):  # 最多 10 分钟
            state = orch._get_state(project_id)
            status = state.get("status")
            if status != last_status:
                last_status = status
                yield f"event: stage_result\ndata: {json.dumps({'status': status, 'output': state.get('output', {})}, ensure_ascii=False)}\n\n"
                if status in ("CONFIRM1_WAIT", "CONFIRM2_WAIT", "CONFIRM3_WAIT"):
                    yield f"event: confirm_required\ndata: {json.dumps({'status': status}, ensure_ascii=False)}\n\n"
                if status == "COMPLETED":
                    yield f"event: done\ndata: {json.dumps({'final_package': state.get('output', {}).get('final_package', {})}, ensure_ascii=False)}\n\n"
                    break
                if status == "FAILED":
                    yield f"event: error\ndata: {json.dumps({'error': state.get('output', {}).get('error', 'FAILED')}, ensure_ascii=False)}\n\n"
                    break
            if await request.is_disconnected():
                break
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/history/list")
async def history(request: Request):
    """历史列表：仅返回归属当前门店（X-Store-Id）的状态"""
    orch = _get_orchestrator()
    redis = _get_redis()
    keys = redis.keys("video_script:state:*") if redis else []
    scope = _scope(request)
    items = []
    for k in keys:
        pid = k.decode().split(":")[-1]
        state = orch._get_state(pid)
        if _owner(state) == scope:
            items.append(state)
    return {"items": items}
