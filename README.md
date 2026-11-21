# 宿智 Agent · PMS 多智能体协作平台

面向酒店 PMS 业务场景的多智能体协作平台：业务系统提供数据与工具，智能体负责编排、执行与人工审批。

## 模块

| 模块 | 技术栈 | 职责 |
| --- | --- | --- |
| `pms-server` | TypeScript 5 / Hono 4 / Drizzle ORM / PostgreSQL 16 | 唯一业务数据入口与 BFF，负责鉴权、租户隔离和内部工具端点 |
| `pms-web` | Next.js 16 / React 19 / Tailwind CSS 4 | 商家后台（AI 协作台为规划中功能） |
| `pms-mobile` | uni-app（Vue 3）/ Pinia | 移动端与微信小程序 |
| `pms-agent` | Python 3.12 / FastAPI / LangGraph | 多智能体编排与工具调用服务（骨架，编排能力建设中） |

## 启动

当前阶段（`pms-agent` 尚未实现）使用业务三件套一键启动：

```powershell
# 1. 准备环境变量
Copy-Item deploy\.env.example .env

# 2. 启动数据库/缓存/后端/前端（均容器内构建）
docker compose up -d postgres redis pms-server pms-web

# 3. 访问管理后台
# http://localhost:3000
```

> 若 3000 被占用，可用 `WEB_PORT` 覆盖：`$env:WEB_PORT=13000; docker compose up -d pms-web`，然后访问 `http://localhost:13000`。

健康检查（可选）：

```bash
bash deploy/healthcheck.sh
```

> `pms-agent` 将在 M1 后续任务实现，届时加入一键启动；当前请按上面的命令只启动业务三件套，不要直接 `docker compose up -d`（会因缺少 pms-agent/Dockerfile 失败）。

## 文档

- 设计规格：`docs/superpowers/specs`
- 实施计划：`docs/plans`
- 访谈纪要：`docs/interview`
