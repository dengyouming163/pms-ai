"""pms-agent 本地启动入口。

Windows 上 uvicorn 0.54 默认通过 loop_factory 创建 ProactorEventLoop，
而 psycopg 的异步连接（AsyncPostgresSaver / checkpointer）明确要求 SelectorEventLoop，
否则启动即报 "Psycopg cannot use the 'ProactorEventLoop'"。
这里显式指定 loop_factory，Linux/容器仍走默认实现。

用法：
    .venv/Scripts/python.exe run.py           # 默认 127.0.0.1:8000
    set PORT=8010 && .venv\\Scripts\\python.exe run.py
容器（Linux）直接 `uvicorn app.main:app` 即可，不受影响。
"""
import asyncio
import os
import sys

import uvicorn


def main() -> None:
    config = uvicorn.Config(
        "app.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        log_level=os.getenv("LOG_LEVEL", "info"),
    )
    server = uvicorn.Server(config)
    # Windows 必须显式用 SelectorEventLoop，才能支持 psycopg 异步连接
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(server.serve(), loop_factory=loop_factory)


if __name__ == "__main__":
    main()
