# PMS AI Crew — 智宿管家 AI Agent 服务

基于 CrewAI 多智能体框架的酒店 PMS AI 引擎，提供智能定价、客户管理、房务调度、OTA 桥接、经营分析等能力。

## 快速启动

### 环境要求
- Python >= 3.12
- PDM 包管理器
- LLM API Key (DeepSeek / 通义千问)

### 安装
```bash
cd pms-ai-crew
cp .env.example .env          # 编辑 .env 填入 LLM_API_KEY
pdm install                    # 安装依赖
```

### 运行
```bash
pdm run uvicorn src.main:app --host 0.0.0.0 --port 9091 --reload
```

### 健康检查
```bash
curl http://localhost:9091/health
# {"status":"ok","service":"pms-ai-crew"}
```

## Agent 团队

| Agent | 职责 | 触发方式 |
|-------|------|---------|
| 🧠 经营参谋长 | 对话查询·周报月报·异常预警 | 对话 / Cron |
| 💰 收益管理师 | 智能定价·±30%硬边界·ROI量化 | 对话 / 每天8:03 |
| 👤 客户管家 | 自动标签·VIP升级·72h关怀 | 退房触发 / 每天9:03 |
| 🔧 房务管家 | 脏房调度·维修跟进 | 每小时 |
| 📡 OTA桥接员 | 超时预警·评价回复草稿 | 每30分钟 |
| 📱 移动助手 | 语音指令·快捷操作 | 对话关键词触发 |

## 项目结构
```
src/
├── main.py              # FastAPI 入口
├── config.py            # 环境配置
├── api/chat.py          # SSE 流式对话端点
├── agents/              # Agent 定义 (7个)
├── crews/               # Crew 编排 (8个)
├── tools/               # Tool HTTP 适配层 (10个)
├── memory/store.py      # Memory 持久化
├── scheduler/cron.py    # 定时任务调度
└── schemas/             # Pydantic 输出校验
```

## wenlv_creation 模块（文旅 AI 创作）

一键草稿 → 分步精修的 AI 内容流水线（spec 2026-09-10-wenlv-ai-creation §5）：

- `src/schemas/wenlv_creation.py` — 5 阶段输出契约（Pydantic + LenientModel 容错）
- `src/services/wenlv_integrity.py` — 确定性完整性校验（对齐 pms-server wenlv-integrity.ts）
- `src/services/wenlv_persist.py` — 落库客户端（HTTP 内部 token → pms-server /api/admin/wenlv）
- `src/services/wenlv_image.py` — 文生图 provider 抽象（mock 占位，真实 provider key 后配）
- `src/agents/wenlv_creation/` — 9 个 LLM agent（项目定位 + 剧本 6 步 + 关卡 + 视觉）
- `src/crews/wenlv_creation_crew.py` — Orchestrator（5 阶段流水线 + 校验重试熔断 + 分步精修）
- `src/api/wenlv_creation.py` — `POST /api/wenlv-creation/draft`（异步）/ `refine` / `GET {id}` / `{id}/stream`（SSE）

## 依赖服务
- pms-server (Tool Hub API) — 数据来源
- PostgreSQL + Redis
