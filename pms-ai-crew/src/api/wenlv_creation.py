# src/api/wenlv_creation.py
"""文旅 AI 创作接口：一键草稿（异步 + SSE 进度）+ 分步精修 + 状态查询。"""
import json
import time
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator
from src.config import _get_redis
from src.services.wenlv_material_assist import optimize_material
from src.services.wenlv_image import get_image_provider

router = APIRouter(prefix="/wenlv-creation", tags=["wenlv-creation"])

# SSE 心跳间隔（秒）。状态全程只变 3 次（CREATED→DRAFTING→DRAFT_READY/FAILED），
# 而 5 阶段流水线要跑 2.5~20 分钟 —— 不发字节的话中间层空闲断连、
# 前端读超时看门狗都会把「正在跑」误判成「卡死」。
_HEARTBEAT_SECONDS = 15


class DraftRequest(BaseModel):
    theme: str                      # 主题一句话
    mode: str = "narrative"         # narrative / rally
    style_tag: str = "guochao"      # 风格标签
    locations: list[str] = []       # 线下地点清单（虚实映射，可选）
    # S2：结构化场地素材（BFF 组装后附带）。None = 未选场地，走纯主题老路径。
    # 形状见 pms-server src/db/schema/wenlv.ts 的 WenlvSiteMaterial，
    # 以及 pms-platform-server src/services/wenlv-site-material.ts 的 buildSiteMaterial。
    site_material: Optional[dict] = None


class RefineRequest(BaseModel):
    project_id: str
    stage: str                      # world/storyline/characters/chapters/endings/location/level/visual
    instruction: str                # 精修指令


class GenerateImageRequest(BaseModel):
    prompt: str                     # 文生图 prompt（必填）
    asset_type: str = "avatar"      # 资产类型（默认 avatar）


def _get_orchestrator():
    redis = _get_redis()
    if not redis:
        raise RuntimeError("Redis 不可用，文旅创作任务无法持久化状态")
    return WenlvCreationOrchestrator(redis)


@router.post("/draft")
async def create_draft(req: DraftRequest):
    """一键草稿：异步跑 5 阶段流水线，立即返回 project_id（进度经 /stream 订阅）。"""
    orch = _get_orchestrator()
    project_id = f"WENLV_{int(time.time())}"
    # CrewAI kickoff 同步阻塞，用线程池执行；run_draft 内部已切状态为 DRAFTING
    asyncio.create_task(asyncio.to_thread(
        orch.run_draft, project_id, req.theme, req.mode, req.style_tag, req.locations, req.site_material
    ))
    return {"status": "STARTED", "project_id": project_id}


@router.post("/refine")
async def refine(req: RefineRequest):
    orch = _get_orchestrator()
    result = await asyncio.to_thread(orch.run_refine, req.project_id, req.stage, req.instruction)
    return result


class ApplyRequest(BaseModel):
    project_id: str


@router.post("/draft/apply")
async def apply_draft(req: ApplyRequest):
    """P3：应用草稿 —— 把 Redis 里的 DRAFT_READY 草稿事务落库 + 自动入队素材。"""
    orch = _get_orchestrator()
    result = await asyncio.to_thread(orch.apply_draft, req.project_id)
    return result


@router.get("/{project_id}/draft")
async def get_draft(project_id: str):
    """P3：预览草稿 —— 返回当前 Redis 状态（含完整草稿内容）。"""
    orch = _get_orchestrator()
    return orch._get_state(project_id)


@router.delete("/{project_id}/draft")
async def discard_draft(project_id: str):
    """P3：丢弃草稿 —— 清空 Redis 状态。"""
    orch = _get_orchestrator()
    return orch.discard_draft(project_id)


class MaterialOptimizeRequest(BaseModel):
    """文化素材 AI 补充的入参。

    字段名与 ops-app 的 optimizeMaterial()、BFF 的透传体三处必须逐字一致。
    全字段可缺省：表单里场地/城市/点位都可能没有。
    """
    venue_name: str = ""
    city: str = ""
    point_name: str = ""
    material_type: str = ""
    title: str = ""
    content: str = ""
    # 🔴 仅用于**限次计数**的归属键。本服务无鉴权、靠网络隔离，所以这个字段可伪造；
    #    能连上本服务的只有 BFF（同网络），判定为可接受 —— 不为此引入签名。
    #    BFF 从已验签的 JWT 现场构造该值，前端送什么都不作数（见 wenlv-studio.ts 的
    #    /ai/material-optimize）。
    user_id: str = ""


@router.post("/material-optimize")
async def material_optimize(req: MaterialOptimizeRequest):
    """文化素材 AI 补充：联网检索 + 组装，同步返回。

    ⚠️ 与 /draft 不同：本端点**不落 Redis 状态、不发 SSE** —— 它没有长流水线，
    一次检索 + 一次组装（实测 15~25 秒），前端一个 await 就够。
    错误一律以**返回值**表达（found=false + reason 分类码 + 中文 note），不抛 5xx：
    对采集员来说「没查到」和「查不动了」都是正常结果，不是系统故障。
    """
    result = await asyncio.to_thread(
        optimize_material, req.model_dump(), redis=_get_redis()
    )
    return result


@router.post("/generate-image")
async def generate_image(req: GenerateImageRequest):
    """素材生成：根据 prompt + asset_type 调用 provider 生成图片 URL。

    Body:
        prompt: 文生图 prompt（必填）
        asset_type: 资产类型（默认 avatar，可选 background/cover/stamp/collectible 等）

    Returns:
        {data: {url, asset_type, prompt, meta}}
    """
    prompt = (req.prompt or "").strip()
    asset_type = req.asset_type or "avatar"
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt 不可为空")
    provider = get_image_provider()
    try:
        result = await provider.generate(prompt, asset_type)
        return {"data": result}
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=f"provider 未实现: {e}")
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=f"provider 调用失败: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成失败: {e}")


@router.get("/{project_id}")
async def get_status(project_id: str):
    orch = _get_orchestrator()
    return orch._get_state(project_id)


@router.get("/{project_id}/stream")
async def stream(project_id: str, request: Request):
    """SSE 流式：轮询状态变化推送进度（复用 video_script 事件语义）。"""
    orch = _get_orchestrator()

    async def gen():
        last_status = None
        last_yield = time.monotonic()
        for _ in range(1200):  # 最多 30 分钟（1200 × 1.5s；5 阶段流水线耗时较长）
            state = orch._get_state(project_id)
            status = state.get("status")
            if status != last_status:
                last_status = status
                last_yield = time.monotonic()
                yield f"event: status\ndata: {json.dumps({'status': status, 'output': state.get('output', {})}, ensure_ascii=False)}\n\n"
                if status == "DRAFT_READY":
                    yield f"event: done\ndata: {json.dumps({'product_id': state.get('output', {}).get('product_id')}, ensure_ascii=False)}\n\n"
                    break
                if status == "FAILED":
                    yield f"event: error\ndata: {json.dumps({'error': state.get('output', {}).get('error', 'FAILED')}, ensure_ascii=False)}\n\n"
                    break
            if await request.is_disconnected():
                break
            # 静默超时则发 SSE 注释心跳保活（注释无 data: 行，客户端解析器会忽略）
            if time.monotonic() - last_yield >= _HEARTBEAT_SECONDS:
                last_yield = time.monotonic()
                yield ": ping\n\n"
            await asyncio.sleep(1.5)

    return StreamingResponse(gen(), media_type="text/event-stream")
