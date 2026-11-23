# 贡献指南

感谢你愿意改进 pms-ai。本文说明本地开发、提交规范与合并门槛，目标是在保证正确性的前提下让改动尽量小。

## 目录与职责

| 目录 | 职责 | 技术栈 |
| --- | --- | --- |
| `pms-server` | 唯一业务数据入口；对外 REST 与 Agent 内部工具端点 | TypeScript / Hono / Drizzle / PostgreSQL |
| `pms-agent` | 多智能体编排、审批中断、事件流、归因 | Python 3.12 / FastAPI / LangGraph |
| `pms-web` | 商家后台与 `/agent-console` 协作台 | Next.js 16 / React 19 |
| `pms-mobile` | 移动端（H5 / 微信小程序 / App） | UniApp / Vue 3 |
| `eval` | 用例、运行器、基线、夹具与报告 | Python |
| `deploy` | 环境变量示例、健康检查、演示种子 | Compose / PowerShell / Shell |

跨层改动请先说清边界：Agent 不得直连业务表，Web 不得直连 Agent 数据库。

## 本地开发

```powershell
# 1. 环境变量与基础服务
Copy-Item deploy\.env.example .env
docker compose up -d --build

# 2. Agent（Python 3.12）
cd pms-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.lock

# 3. 服务端与前端（Node 20+ / pnpm 9+）
cd ..\pms-server; pnpm install
cd ..\pms-web;    pnpm install
cd ..\pms-mobile; pnpm install
```

默认 `LLM_PROVIDER=replay`，不需要任何模型 API Key。需要真实链路时设置 `LLM_PROVIDER=live` 与 `LLM_API_KEY`；回放未命中会直接失败，不会静默回落真实模型（见 [ADR 0003](docs/adr/0003-replay-miss-is-failure.md)）。

## 分支与提交

- 从 `master` 切出功能分支：`feat/agent-xxx`、`fix/server-xxx`、`docs/xxx`。
- 提交信息使用中文，格式 `type(scope): 描述`，`type` 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
- 一个提交只做一件事；格式化、重命名与逻辑改动分开提交。
- 不要在提交中包含 `.env`、私钥、证书、真实用户数据。

示例：

```
feat(agent): 增加渠道体检子图的超时订单扫描
fix(server): 调价接口在事务内校验租户边界
docs(readme): 补充移动端截图与贡献入口
```

## 合并门槛

提交 Pull Request 前，以下检查必须全部通过：

```powershell
# Agent 单测
cd pms-agent; .\.venv\Scripts\python.exe -m pytest -q

# 四个评测套件（退出码必须为 0）
.\.venv\Scripts\python.exe -m eval.run_eval --suite revenue
.\.venv\Scripts\python.exe -m eval.run_eval --suite ops
.\.venv\Scripts\python.exe -m eval.run_eval --suite guest
.\.venv\Scripts\python.exe -m eval.run_eval --suite ota

# 服务端类型检查与核心单测（完整套件需本地 Postgres 与种子）
cd ..\pms-server; pnpm run ts-check; pnpm vitest run src/routes/internal deploy/seed/demo-seed.test.ts

# 前端类型检查
cd ..\pms-web; pnpm run ts-check
```

改动涉及接口或行为时，请同步更新文档与评测用例：

- 新增工具端点：补充到 `docs/ARCHITECTURE.md` 的接口表，并增加越权/边界用例。
- 调整审批或执行逻辑：补充 `docs/adr/` 记录，并更新 `docs/DEPLOYMENT.md` 的运维说明。
- 新增场景：在 `eval/cases/` 新建用例文件，不要修改既有基线；用 `--write-baseline` 生成新套件基线。

## Pull Request 要求

- 描述里写清：改了什么、为什么改、如何验证、有哪些已知边界。
- 关联 Issue（如有），并在 UI 变更时附截图。
- 不引入与当前任务无关的重构；不提交调试日志与临时文件。
- 保持向后兼容，除非 PR 明确声明破坏性变更。

## 文档风格

- 文档默认中文，术语首次出现时给出英文原文。
- 命令与路径使用代码块，命令默认可在仓库根目录直接执行。
- 结论先行，少用形容词，多写可验证的事实与数字。
- 图片放在 `docs/assets/screenshots/`，使用相对路径引用。

## 问题反馈

- Bug 请使用 Bug Report 模板，附复现步骤、期望行为、日志与版本。
- 功能建议请说明使用场景与替代方案，避免只给结论。
- 安全漏洞请勿公开提交，按 [安全策略](SECURITY.md) 私下报告。
