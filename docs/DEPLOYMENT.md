# 部署手册

本文覆盖本地一键编排、环境变量、运行模式与生产落地前的检查项。

## 1. 前置条件

- Docker Desktop（Compose v2）
- Node.js 20+ 与 pnpm 9+（仅灌种子、前端本地开发需要）
- Python 3.12（仅本地跑 Agent 单测与评测需要）

## 2. 服务与端口

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| `postgres` | `127.0.0.1:15433` | pgvector/pg16，业务表在 `public`，Agent 数据在 `agent` |
| `redis` | `127.0.0.1:16379` | 缓存与限流 |
| `pms-server` | `127.0.0.1:9090` | 业务 API 与内部工具端点 |
| `pms-agent` | `127.0.0.1:8000` | FastAPI + LangGraph |
| `pms-web` | `127.0.0.1:3000` | 商家后台与 `/agent-console` |

所有端口只绑定回环地址，默认不对外暴露。

## 3. 首次启动

```powershell
Copy-Item deploy\.env.example .env
docker compose up -d --build
powershell -File deploy\healthcheck.ps1
```

健康检查会依次探测 9090、8000、3000，每个最多等待 60 秒；任一失败返回非零退出码。

## 4. 演示数据

```powershell
$env:PG_HOST="127.0.0.1"; $env:PG_PORT="15433"; $env:PG_DATABASE="pms_ai"; $env:PG_USER="pms"; $env:PG_PASSWORD="pms_local_dev"
pnpm --dir pms-server exec tsx ../deploy/seed/demo-seed.ts
```

种子包含 3 家门店、8 个房型、90 天价格日历与 24 条知识库条目，可重复执行且结果一致。

演示账号：`13800000000` / `Demo123456`（商户 `demo-yunqi`，门店 `store-yunqi-qingyan`）。

## 5. 环境变量

完整示例见 [deploy/.env.example](../deploy/.env.example)。以下为必须理解的核心变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | `pms_ai` / `pms` / `pms_local_dev` | 数据库凭据，生产必须替换 |
| `JWT_SECRET` | 本地演示值 | 商家后台 JWT 签名密钥 |
| `INTERNAL_SERVICE_TOKEN` | 本地演示值 | Agent 调用内部端点的一次性凭证 |
| `MINI_JWT_SECRET` | 本地演示值 | 小程序端 JWT 密钥 |
| `LLM_PROVIDER` | `replay` | `replay` 回放 / `live` 真实模型 |
| `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` | 空 / `deepseek-chat` | live 模式下的模型配置 |
| `AGENT_ALLOWED_MERCHANTS` | `demo-yunqi` | 允许创建运行的商户白名单 |
| `CORS_ORIGINS` | `http://localhost:3000` | 允许的前端来源，逗号分隔 |
| `LANGCHAIN_TRACING_V2` | `false` | LangSmith 双写开关 |
| `LANGCHAIN_API_KEY` | 空 | LangSmith Key，开关为 true 且非空才启用 |
| `WEB_PORT` | `3000` | 前端宿主映射端口 |

`pms-server` 没有 `env_file`，容器只认 compose 中显式列出的变量。**新增变量必须同时写入 `docker-compose.yml` 与 `.env`**，否则修改 `.env` 不会生效，而且往往表现为静默降级而非报错。

## 6. 运行模式

### 回放（默认）

- 不发起任何网络请求，不需要模型 Key。
- 按 `prompt_hash + model` 命中 `eval/fixtures/`；未命中抛 `FixtureMissingError`。
- 适合演示、CI 与回归。

### 在线

```dotenv
LLM_PROVIDER=live
LLM_API_KEY=<your-key>
LLM_MODEL=<model>
LLM_BASE_URL=<openai-compatible-endpoint>
```

切换后重启 `pms-agent`：

```powershell
docker compose up -d pms-agent
```

### LangSmith（可选）

```dotenv
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=<langsmith-key>
LANGCHAIN_PROJECT=pms-ai
```

开关关闭或 Key 为空时不会产生外部请求。

## 7. 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 协作台一直 `running` | 查看 `pms-agent` 日志；确认 `AGENT_DATABASE_URL` 与 `pms-server` 指向同一个库 |
| `guest` 总是转人工 | 确认种子已灌入 `kb_guide`，且镜像包含 `/kb-search` 端点 |
| 审批后价格没变 | 查看 `revenue_execute` 事件；`guard_rejected` 表示幅度超限或资源已变化 |
| 回放报夹具未命中 | 目标文本或工具数据与录制时不同；用 `--live --record` 重新录制，禁止回落真实模型 |
| 前端跨域失败 | 把实际来源加入 `CORS_ORIGINS`，并重启 `pms-agent` |
| 改了 `.env` 不生效 | 变量未列入 `docker-compose.yml` 的 environment 白名单 |

## 8. 生产检查清单

- [ ] 替换全部演示密钥：`DB_PASSWORD`、`JWT_SECRET`、`INTERNAL_SERVICE_TOKEN`、`MINI_JWT_SECRET`
- [ ] 移除或重置演示账号，关闭种子脚本
- [ ] `pms-agent` 与 `pms-web` 置于网关之后，限制来源，启用 HTTPS
- [ ] 确认 `CORS_ORIGINS` 只包含生产域名
- [ ] 核对容器内 `WENLV_*` / `ARK_*` / `WXPAY_*` 等变量确实有值，避免静默降级
- [ ] 为数据库配置备份与连接池；Agent 持久化替换同步 psycopg
- [ ] 打开 LangSmith 或等价追踪，保留运行与审批审计
- [ ] 在 CI 中保留四个评测套件作为合并门禁

更多安全说明见 [安全策略](../SECURITY.md)。
