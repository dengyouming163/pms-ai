"""pms-agent FastAPI 入口（M1 骨架）。

Task 7 仅提供 GET /health；runs / events / approve 端点在 Task 8/9 实现。
路由前缀为根路径，不加 /api（与 pms-server→agent 的遗留转发约定区分）。
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="pms-agent", version="0.1.0")

# 本地 web (pms-web :3000) 直连 SSE/REST 时需要跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "pms-agent"}
