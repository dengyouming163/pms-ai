# src/api/venue_research.py
"""场地网络调研接口：消歧（立即返回 + 轮询）+ 发起（立即返回）+ 诊断态查询。

## 数据属主（两件事，属主不同 —— 别混）

🔴 **报告**（五节正文）的唯一属主是 **pms-server**：本服务的状态键只作诊断，
App 一律轮询 pms-server。
🔴 **候选**（消歧产出）在「建行之前」没有库表归属 —— pms-server 的 `candidates`
列要等 `POST /venues/:id/research` 建行才存在，而那一步发生在**用户选中候选之后**。
所以候选暂存在本服务的 Redis，键 `...:resolve:{resolve_id}`，**TTL 30 分钟**，
由 App 轮询 `GET /resolve/{resolve_id}` 取。它**不是**长期数据源，会话丢了重查一次即可
（一次消歧约 36s，实测）。
两条通道合起来仍然只有「报告走 pms-server、候选走 redis」两个源，没有第三个。

## 为什么全是「立即返回 + 后台线程」而不是长连接

三道超时闸都在场：ops-app 单请求 **20s**、BFF **30s**、nginx `/api/` 继承默认 **60s**。
实测（计划 Task 8 记录）：一场调研 5 节串行远超它们；**消歧一步也比它们长** ——
热调用 36.3s、冷调用 91.3s（含 crewai 冷导入 53.7s）。
消歧**原本是同步的**，就是这一步的实测把设计改成了轮询。
范式与 `/wenlv-creation/draft` 同款（`src/api/wenlv_creation.py:53`）。

⚠️ **本模块的重依赖一律留在函数内**（见 `src/services/venue_research.py` 的
`_default_disambiguate` / `_default_section_agent`）。`src/api/wenlv_creation.py:11`
在模块级 import crewai，实测让那个模块的进口耗时变成 **44.49s**；本模块 2.05s。
测试要在 `src.main` 的 app 与本路由的子 app 之间选时，这也是个理由。
"""
import asyncio
import json
import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.config import _get_redis
from src.services.venue_research import resolve_venue, run_research
from src.services.wenlv_persist import WenlvPersister

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/venue-research", tags=["venue-research"])

# Redis 诊断键。**前缀与 `wenlv_creation:state` 区分**（同前缀会让 `redis-cli keys`
# 与排查把两个流程的态读串 —— 本键存在的唯一理由就是「那个任务跑起来了没有」）。
# TTL 30 天与它一致：诊断数据不值得永久留。
_STATE_PREFIX = "wenlv_venue_research:state"
_STATE_TTL = 30 * 86400
# 消歧结果的键与 TTL。**30 分钟**（不是 30 天）：这是「建行之前」的临时结果，
# 一次消歧 36s、业务人员选完候选就作废；留 30 天只会让 redis 里堆满一次性候选。
# 它不是长期数据源 —— 丢了重查一次即可（见模块头注「数据属主」）。
_RESOLVE_PREFIX = "wenlv_venue_research:resolve"
_RESOLVE_TTL = 30 * 60


class ResolveRequest(BaseModel):
    # 客户端生成的消歧任务 id（App 侧 `newDraftId()`）。结果按它暂存在 redis 里供轮询。
    # 与 research_id 分开：消歧发生在**建行之前**，那时还没有 research 行。
    resolve_id: str = ""
    venue_name: str = ""
    city: str = ""
    address: str = ""
    # 「都不是」那条逃生口的输入：业务人员手填的更精确地名。非空时**取代** venue_name 去检索。
    hint: str = ""
    user_id: str = ""


class StartRequest(BaseModel):
    research_id: str = ""
    venue_name: str = ""
    city: str = ""
    anchor: dict = {}
    hint: str = ""
    user_id: str = ""


def _set_state(research_id: str, status: str, **extra):
    """写诊断态。**写不上不影响业务** —— 报告在 pms-server，这里只是排查线索。"""
    r = _get_redis()
    if not r:
        return
    key = f"{_STATE_PREFIX}:{research_id}"
    try:
        r.set(key, json.dumps({"status": status, **extra}, ensure_ascii=False))
        r.expire(key, _STATE_TTL)
    except Exception as e:
        logger.warning("调研诊断态写入失败 research_id=%s: %s", research_id, e)


def _run_in_thread(research_id: str, req: StartRequest):
    """后台线程主体。**终态的写回由 `run_research` 负责**（它一定调 `persist_fn`）；
    这里只负责诊断态与异常兜底。"""
    persister = WenlvPersister()
    try:
        out = run_research(
            research_id=research_id, venue_name=req.venue_name, city=req.city,
            anchor=req.anchor or {}, hint=req.hint, research_user_id=req.user_id,
            persist_fn=persister.save_research,
        )
        _set_state(research_id, out.get("status") or "ready")
    except Exception as e:
        logger.exception("场地调研流水线异常 research_id=%s", research_id)
        _set_state(research_id, "failed", error=str(e)[:200])
        # 进程内异常 ⇒ pms-server 那行会停在 running（看门狗 15 分钟后放行重跑）。
        # 尽力补一次 failed 回写，**失败也不抛**：线程里抛没人接，只会多一条 traceback。
        try:
            persister.save_research(research_id, status="failed",
                                   error="调研服务内部错误，请稍后重试", finished_at=True)
        except Exception as e2:
            logger.error("补写 failed 终态也失败 research_id=%s: %s", research_id, e2)


def _write_resolve(resolve_id: str, payload: dict):
    """写消歧结果。**失败只记日志**：写不上时 App 会轮询到 404（= 再查一次），
    比让它一直转好 —— 那次消歧的结果确实已经丢了。"""
    r = _get_redis()
    if not r:
        logger.warning("无 redis，消歧结果无处可写 resolve_id=%s", resolve_id)
        return
    key = f"{_RESOLVE_PREFIX}:{resolve_id}"
    try:
        r.set(key, json.dumps(payload, ensure_ascii=False))
        r.expire(key, _RESOLVE_TTL)
    except Exception as e:
        logger.warning("消歧结果写入失败 resolve_id=%s: %s", resolve_id, e)


def _run_resolve_in_thread(resolve_id: str, req: ResolveRequest):
    """消歧的后台线程主体。**终态一定要写** —— running 是端点写的，不写终态会让
    App 一直轮询到 TTL 到期（同款兜底见 `_run_in_thread`）。"""
    try:
        out = resolve_venue(venue_name=req.venue_name, city=req.city, address=req.address,
                            hint=req.hint, user_id=req.user_id)
    except Exception as e:
        logger.exception("调研消歧异常 resolve_id=%s", resolve_id)
        _write_resolve(resolve_id,
                       {"status": "failed", "candidates": [], "reason": "search_failed"})
        return
    _write_resolve(resolve_id, {"status": "done",
                                "candidates": out.get("candidates") or [],
                                "reason": out.get("reason") or ""})


@router.post("/resolve")
async def resolve(req: ResolveRequest):
    """消歧：立即返回，后台线程跑；结果轮询 `GET /resolve/{resolve_id}`。

    🔴 **本端点原本是同步的，实测后改成异步**：热调用 36.3s、冷调用 91.3s，
    放不进 ops-app 20s / BFF 30s / nginx 60s 任何一道闸（读数见计划 Task 8 记录）。
    别因为「就一次检索 + 一次 LLM」把它改回同步 —— 那是**没量过**的直觉。

    `reason` 的分类码由服务层给（四态分开：检索失败 / 成文失败 / 公网查不到），
    在轮询结果里回给 App。**不要在 API 层用「候选为空」反推** —— 那会把
    「模型挂了」说成「公网查不到」，而两者的处置不同。

    与 `/start` 一样必须是 `async def`（同步端点由 FastAPI 丢线程池，那里没有事件循环，
    `create_task` 会 RuntimeError，而它发生在**返回之后**，接口看着是对的）。
    """
    if not (req.venue_name or "").strip() and not (req.hint or "").strip():
        raise HTTPException(status_code=400, detail="场地名不能为空")
    if not (req.resolve_id or "").strip():
        raise HTTPException(status_code=400, detail="resolve_id 不能为空")
    # running 先落再起后台 —— 与 /start 同序（顺序有单测钉住）
    _write_resolve(req.resolve_id, {"status": "running", "candidates": [], "reason": ""})
    asyncio.create_task(asyncio.to_thread(_run_resolve_in_thread, req.resolve_id, req))
    return {"status": "STARTED", "resolve_id": req.resolve_id}


@router.get("/resolve/{resolve_id}")
async def get_resolve(resolve_id: str):
    """轮询消歧结果。只回 App 需要的三个字段 —— **不透传 `search_log`**
    （内部结构，且会带上检索词与失败细节；排查看服务日志）。"""
    r = _get_redis()
    raw = r.get(f"{_RESOLVE_PREFIX}:{resolve_id}") if r else None
    if not raw:
        raise HTTPException(status_code=404, detail="没有这个消歧任务（可能已过期，请重查）")
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    d = json.loads(raw)
    return {"status": d.get("status") or "running",
            "candidates": d.get("candidates") or [],
            "reason": d.get("reason") or ""}


@router.post("/start")
async def start(req: StartRequest):
    """发起调研：立即返回，后台线程跑（同 `/wenlv-creation/draft` 的范式）。

    ⚠️ 必须是 `async def`：同步端点会被 FastAPI 丢进线程池，那里没有事件循环，
    `asyncio.create_task` 会 RuntimeError —— 而它发生在**返回之后**，接口看着是对的。
    """
    if not (req.research_id or "").strip():
        raise HTTPException(status_code=400, detail="research_id 不能为空")
    _set_state(req.research_id, "running", started_at=time.time())
    asyncio.create_task(asyncio.to_thread(_run_in_thread, req.research_id, req))
    return {"status": "STARTED", "research_id": req.research_id}


@router.get("/{research_id}")
async def get_state(research_id: str):
    """诊断态。**App 不走它**（见模块头注）。"""
    r = _get_redis()
    raw = r.get(f"{_STATE_PREFIX}:{research_id}") if r else None
    if not raw:
        raise HTTPException(status_code=404, detail="没有这个调研任务的运行记录")
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return json.loads(raw)
