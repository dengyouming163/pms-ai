"""pms-agent FastAPI 入口。

- lifespan 启动时调 init_db()：建 agent schema + 业务表 + checkpointer 表（幂等）。
- 路由挂在根路径，不加 /api（与 pms-server→agent 的遗留转发约定区分）。
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.runs import router as runs_router
from app.config import settings
from app.persistence.db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动期初始化 DB（失败致命，便于尽早发现配置/连通问题；IF NOT EXISTS 保证重启幂等）
    await init_db()
    yield


app = FastAPI(title="pms-agent", version="0.1.0", lifespan=lifespan)

# 本地 web (pms-web :3000) 直连 SSE/REST 时需要跨域；来源由 CORS_ORIGINS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "pms-agent"}


# 运行相关端点（POST /runs、GET /runs/{id}、GET /runs/{id}/events），根路径不加 /api
app.include_router(runs_router)
