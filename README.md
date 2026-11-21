# 宿智 Agent · PMS 多智能体协作平台

面向酒店 PMS 业务场景的多智能体协作平台：业务系统提供数据与工具，智能体负责编排、执行与人工审批。

## 模块

| 模块 | 技术栈 | 职责 |
| --- | --- | --- |
| `pms-server` | TypeScript 5 / Hono 4 / Drizzle ORM / PostgreSQL 16 | 唯一业务数据入口与 BFF，负责鉴权、租户隔离和内部工具端点 |
| `pms-web` | Next.js 16 / React 19 / Tailwind CSS 4 | 商家管理后台，含智能体协作台入口 |
| `pms-mobile` | uni-app（Vue 3）/ Pinia | 移动端与微信小程序 |
| `pms-agent` | Python 3.12 / FastAPI / LangGraph | 多智能体编排与工具调用服务（骨架，编排能力建设中） |

## 启动

```bash
# 1. 准备环境变量
cp deploy/.env.example .env

# 2. 启动服务
docker compose up -d

# 3. 访问管理后台
# http://localhost:3000
```

> `docker-compose.yml` 与 `deploy/.env.example` 将在后续部署任务中补齐。

## 文档

- 设计规格：`docs/superpowers/specs`
- 实施计划：`docs/plans`
- 访谈纪要：`docs/interview`
