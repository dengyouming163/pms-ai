"""持久化层：DB 连接、schema 初始化、检查点工厂。

- get_conn：同步 psycopg 连接（DSN 带 search_path=agent，row_factory=dict_row），
  供运行/事件读写。连接只在调用时建立，模块导入不连库 → from app.main import app 安全。
- init_db：启动时执行 schema.sql（IF NOT EXISTS 幂等）+ 建 langgraph 检查点表。
- get_checkpointer：异步上下文管理器，产出 AsyncPostgresSaver（供 ainvoke 使用）。

检查点表由 AsyncPostgresSaver.setup() 自建（checkpoints / checkpoint_blobs /
checkpoint_writes / checkpoint_migrations），不手写，避免与其迁移冲突。
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from app.config import settings

logger = logging.getLogger(__name__)

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


@contextmanager
def get_conn():
    """获取一条同步 psycopg 连接，退出时自动提交/回滚并关闭。"""
    conn = psycopg.connect(settings.agent_database_url, row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_schema(conn) -> None:
    """执行 schema.sql 建 agent schema 与 M1 四表（IF NOT EXISTS 幂等）。"""
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    logger.info("schema.sql 执行完成（agent schema + 4 表，幂等）")


async def setup_checkpointer() -> None:
    """建 langgraph-checkpoint-postgres 的检查点表（幂等，版本化迁移）。"""
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    async with AsyncPostgresSaver.from_conn_string(settings.agent_database_url) as saver:
        await saver.setup()
    logger.info("checkpointer 表 setup 完成（幂等）")


async def init_db() -> None:
    """启动初始化：先建业务表，再建检查点表。任一步失败都向上抛（启动期致命，便于发现问题）。"""
    with get_conn() as conn:
        init_schema(conn)
    await setup_checkpointer()


def init_db_sync() -> None:
    """init_db 的同步包装，供 Dockerfile CMD / 手工脚本在无事件循环时调用。"""
    asyncio.run(init_db())


@asynccontextmanager
async def get_checkpointer():
    """异步上下文：产出一条 AsyncPostgresSaver（单连接 autocommit），供 graph.ainvoke。"""
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    async with AsyncPostgresSaver.from_conn_string(settings.agent_database_url) as saver:
        yield saver


__all__ = ["get_conn", "init_db", "init_db_sync", "get_checkpointer", "init_schema", "setup_checkpointer"]
