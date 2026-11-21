from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from src.api.chat import router as chat_router, _process_queue
from src.api.model_config import router as model_config_router
from src.api.video_script import router as video_script_router
from src.api.wenlv_creation import router as wenlv_creation_router
from src.api.wenlv_diy import router as wenlv_diy_router
from src.api.venue_research import router as venue_research_router
from src.scheduler.cron import start_scheduler, shutdown_scheduler
import asyncio
import logging
import os

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("PMS AI Crew starting up...")
    start_scheduler()
    logger.info("AI 调度器已启动 (7个定时任务)")
    # 启动请求队列消费者
    queue_task = asyncio.create_task(_process_queue())
    logger.info("请求队列消费者已启动 (max 10)")
    yield
    queue_task.cancel()
    shutdown_scheduler()
    logger.info("PMS AI Crew shutting down...")


app = FastAPI(title="PMS AI Crew", version="0.1.0", lifespan=lifespan)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

app.include_router(chat_router, prefix="/api")
app.include_router(model_config_router, prefix="/api")
app.include_router(video_script_router, prefix="/api")
app.include_router(wenlv_creation_router, prefix="/api")
app.include_router(wenlv_diy_router, prefix="/api")
app.include_router(venue_research_router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "pms-ai-crew"}
