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

```powershell
# 1. 准备环境变量
Copy-Item deploy\.env.example .env

# 2. 预构建前端（pms-web/Dockerfile 复用本地 .next 产物）
cd pms-web; pnpm install; pnpm build; cd ..

# 3. 启动服务
docker compose up -d

# 4. 访问管理后台
# http://localhost:20001
```

> 当前 Dockerfile 复用本地构建产物；M1 Task 3 会改为容器内多阶段构建。

> `pms-agent/` 当前为空骨架，将在 M1 后续任务实现。

## 文档

- 设计规格：`docs/superpowers/specs`
- 实施计划：`docs/plans`
- 访谈纪要：`docs/interview`
