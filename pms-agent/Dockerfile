# pms-agent 服务镜像：FastAPI + LangGraph，回放/在线 LLM。
# build context 为 ./pms-agent（见 docker-compose.yml 的 build: ./pms-agent）。
FROM python:3.12-slim

# 避免 .pyc 与缓冲输出，便于日志实时查看
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 先装依赖（利用层缓存：requirements 不变则不重装）
COPY requirements.lock pyproject.toml ./
RUN pip install -r requirements.lock

# 应用代码与回放夹具（config 默认 fixtures_dir 解析为 /app/eval/fixtures）
COPY app/ ./app/
COPY eval/ ./eval/

EXPOSE 8000

# 启动前先初始化 DB（建 agent schema + 业务表 + checkpointer 表，幂等），
# 失败则容器退出（fail-fast，便于发现 DB 连通/配置问题）；再启动 uvicorn。
# lifespan 里还会再 init_db 一次，IF NOT EXISTS 保证幂等安全。
CMD ["sh", "-c", "python -c \"from app.persistence.db import init_db_sync; init_db_sync()\" && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
