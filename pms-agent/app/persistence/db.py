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


# TODO(M2): 引入 psycopg_pool 连接池或用 asyncio.to_thread 包装同步调用，避免同步 DB
# 阻塞事件循环。M1 低并发下每请求建/关一条连接可接受，但演示压测时需优化。
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


def fail_stale_runs(conn) -> int:
    """启动对账：把上次进程退出时仍停在 running 的运行标记为 failed。

    running 只由进程内后台任务推进；进程重启后这些任务已不存在，
    若不对账，run 会永久停在 running，前端轮询/SSE 也无法终结。
    awaiting_approval 是合法的人审挂起态，必须保留。
    注意：仅适用于单实例部署（本地演示）；多实例需改为心跳/看门狗。
    """
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE agent_runs SET status = 'failed', ended_at = now()"
            " WHERE status = 'running'"
        )
        return cur.rowcount


async def init_db() -> None:
    """启动初始化：先建业务表并清理重启遗留的 running，再建检查点表。

    任一步失败都向上抛（启动期致命，便于发现问题）。
    """
    with get_conn() as conn:
        init_schema(conn)
        stale = fail_stale_runs(conn)
        if stale:
            logger.warning("启动对账：%d 个上次未完成的 run 已标记 failed", stale)
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


__all__ = [
    "fail_stale_runs", "get_conn", "init_db", "init_db_sync",
    "get_checkpointer", "init_schema", "setup_checkpointer",
]
