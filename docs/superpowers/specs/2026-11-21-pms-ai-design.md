# 宿智 Agent · PMS 多智能体协作平台 设计规格

- 日期：2026-11-21
- 状态：已评审，待实施
- 仓库：`pms-ai`（由 `wwwpms` 裁剪迁移而来）
- 目标读者：面试评审、后续维护者、未来的自己

---

## 1. 背景与目标

现有 `wwwpms` 是一套可运行的民宿 PMS：商家后台（Next.js）、员工移动端（UniApp）、业务 API（Hono + Drizzle + PostgreSQL）、AI 服务（FastAPI + CrewAI）。业务能力真实，但 AI 部分停留在「Prompt 套 HTTP 工具」的阶段：八个 Crew 各自为战、Agent 内部不可观测、没有评测、没有回放、写操作缺少审批闭环。它能演示，但不能称之为生产级 AI 系统。

本项目把这份资产重做成一个**可公开演示、可复现、可评测**的多智能体协作平台，服务于 AI 应用 / Agent 开发岗位的作品集。

**目标**

1. 用 LangGraph 重构 AI 服务，形成 Supervisor + 领域子图的可控协作拓扑。
2. 让「协作」看得见：每一次运行都有完整事件时间轴，可实时观看、可事后回放。
3. 让「可靠」可量化：锁定基线的评测集，覆盖路由、工具选择、成功率、越权拦截与延迟。
4. 让「生产级」有证据：写操作人审批 + 执行层硬校验 + 全链路审计；建议采纳与收益归因闭环。
5. 让「可复现」不依赖 key：默认回放模式，克隆后一条命令跑通完整演示；配置 key 后切换真实模型，产出真实链路。

**成功标准（面试视角）**

- 陌生人 clone 后 5 分钟内看到 Agent 在改真实房价。
- 能被追问「怎么保证它不乱改价」并且有代码与审批记录作答。
- 能被追问「你怎么知道它效果好」并且有基线报告与回归门禁作答。

---

## 2. 非目标

- 不做通用 Agent 框架，不对外提供平台能力。本项目只解决民宿/酒店这一垂直场景。
- 不重写业务 CRUD。`pms-server` 的表结构与业务路由保持不变，只做增量扩展。
- 不改造移动端。`pms-mobile` 保留可编译状态，不接 AI 入口。
- 不接真实 OTA / 支付 / 短信。演示数据与 Stub 端点足够表达业务语义。
- 不做多租户商业化。租户作用域用于安全隔离，不做计费与套餐。
- 不追求全场景覆盖。四个领域子图中，`revenue` 是深度主线，其余三个是广度补充。

---

## 3. 定位与差异化

已有的两份作品集资产：

- `rag-knowledge-base`：知识底座，解决「找得到、答得准、敢拒答」。
- `enterprise-agent-platform`：通用 Agent 运行时，解决「工具调用、人审、计量、轨迹评测」。

本项目不与它们重叠，定位是**垂直业务纵深**：

> 当 Agent 拿到一家真实民宿的房态、订单、竞对价和渠道佣金，它能否像一个合格的收益经理那样思考、取证、提出可执行的调价建议，并在人的授权下真正改掉价格，最后证明自己赚到了钱。

差异化体现在三件事：真实业务数据、真实写操作、真实收益归因。这是纯框架 Demo 做不到的。

---

## 4. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ pms-web (Next.js, :3000)                                     │
│  业务后台（保留）  +  /agent-console 协作台（新增）           │
└───────────┬──────────────────────────────┬───────────────────┘
            │ ① 业务 REST                  │ ② runs / SSE / approvals
            ▼                              ▼
┌───────────────────────┐      ┌────────────────────────────────┐
│ pms-server (Hono:9090)│◄─────┤ pms-agent (FastAPI+LangGraph)  │
│  业务 API + 工具端点   │ ③工具 │  Supervisor + 四领域子图        │
└───────────┬───────────┘      └───────────────┬────────────────┘
            │ Drizzle                          │ checkpointer / events
            ▼                                  ▼
        ┌───────────────────────────────────────────┐
        │ PostgreSQL                                │
        │  schema public : 业务表（不改）            │
        │  schema agent  : 运行/事件/审批/记忆/评测   │
        └───────────────────────────────────────────┘
```

**三条不可越过的边界**

1. `pms-agent` 不直连业务表，所有读写经 `pms-server` 的内部工具端点（`X-Internal-Service-Token`）。
2. `pms-web` 不直连 `pms-agent` 的数据库，只通过 HTTP + SSE 消费运行状态。
3. 审批与执行业务分离：审批只改 `agent_approvals`，真正的业务写入由执行节点调用 `pms-server` 完成。

**为什么这样切**：工具端点即权限边界。每个子图能碰哪些端点，在服务端按 token 与路由白名单双重限制；Agent 被提示词注入后也无法越权调用未挂载的工具。

---

## 5. 仓库结构

沿用现有扁平布局，四个子项目各自独立构建，不引入 monorepo 工具链。

```
pms-ai/
├─ pms-server/              # Hono + Drizzle，业务 API
│   └─ src/routes/agent-tools.ts   # 新增：Agent 专用工具端点
├─ pms-web/                 # Next.js 商家后台 + 协作台
│   └─ src/app/agent-console/      # 新增：协作台
├─ pms-mobile/              # UniApp，保留不改造
├─ pms-agent/               # 由 pms-ai-crew 重构
│   ├─ app/
│   │   ├─ graph/           # supervisor.py + revenue/ops/guest/ota
│   │   ├─ tools/           # LangChain Tool 适配层
│   │   ├─ runtime/         # provider（replay/live）、budget、trace
│   │   ├─ persistence/     # checkpointer、事件、审批仓储
│   │   └─ api/             # /runs、/events、/approvals
│   ├─ tests/
│   └─ pyproject.toml
├─ eval/                    # 用例、运行器、基线、报告
├─ deploy/                  # docker-compose.yml + seed + 健康检查
├─ docs/                    # 本规格、ADR、演示脚本、架构图
└─ README.md
```

**裁剪清单（从原始副本中删除）**

| 目录 | 原因 |
|---|---|
| `pms-platform/` | 运营后台与文旅模块，与本项目主线无关 |
| `pms-douyin/`、`pms-nimi/`、`www-site/` | 抖音引流、私域小程序、官网，非核心 |
| `pms-ota-client/` | Electron OTA 客户端，341 MB，含真实凭证风险 |
| `platform-server/`、`wwwskill/` | 平台服务与技能包，不参与演示 |
| 根目录散落文件 | 原型 HTML、临时 SQL、`.tar.gz`、`debug.log`、`*.png` |

**密钥策略**：任何 `.env`、证书、密钥文件都不进仓库；只保留 `.env.example`。`deploy/check-no-secrets.sh` 在 CI 与本地提交前扫描常见密钥模式。

---

## 6. 多智能体拓扑

```
START → supervisor ──┬── route=revenue → revenue 子图 ──┐
                     ├── route=ops     → ops 子图     ──┤
                     ├── route=guest   → guest 子图   ──┼→ synthesize → END
                     ├── route=ota     → ota 子图     ──┤
                     └── route=direct  → synthesize   ──┘
```

- **Supervisor**：只做意图识别、子图分派、结果汇总。不持有任何业务工具，避免它绕过子图直接调工具。
- **revenue（收益管理）**：读价格日历、房态、竞对价、渠道表现、财务汇总 → 生成逐房型调价建议 → 触发人审 → 授权后写价格日历。
- **ops（晨报与异常诊断）**：四路体检并行（营收异常、脏房积压、渠道超时、评价风险）→ 汇总成晨报 → 标注优先级与待办。
- **guest（住中客服）**：解析诉求 → 检索知识（复用 `pms-server` 的 `kb-ai`）→ 回答或转人工；只读，无写操作。
- **ota（渠道体检）**：价差扫描、库存同步状态、超时预警；默认只读，写操作走人审。

**为什么是 Supervisor 而非 Plan-and-Execute 或 Swarm**：Supervisor 的路由是单点、可评测、可回放的；子图内部的工具循环是确定的。Swarm 路径不可预测、难以保证终止，无法支撑基线评测。Plan-and-Execute 的跨领域能力更强，但 Planner 一次失败整条链路作废，调试成本与演示风险都过高。

---

## 7. 运行时契约

### 7.1 状态

`AgentState` 为 `TypedDict`，字段固定、全部可序列化：

```python
class AgentState(TypedDict):
    run_id: str
    tenant: dict          # merchant_id / store_id / user_id
    goal: str
    route: str            # revenue | ops | guest | ota | direct
    messages: list        # add_messages reducer
    budget: dict          # max_steps / max_tokens / deadline
    evidence: list        # {source, tool, summary, payload_ref}
    proposals: list       # 待审批的写操作提案
    approvals: list       # 审批结果
    final: str | None
```

规则：节点只读写上述字段；中间数据必须落到 `evidence` 或 `proposals`；禁止使用全局单例传参。这是回放与评测成立的前提。

### 7.2 工具

- 用 LangChain `@tool` 声明，参数用 Pydantic 模型校验。
- 统一返回信封：`{"ok": bool, "data": Any, "error": str | None, "latency_ms": int}`。
- 风险分级：`read`（自动）、`write_l1`（±5% 内调价，自动但强制审计）、`write_l2`（5%~15%，需人审）、`write_l3`（>15%，需人审并双人确认）。
- 每个子图持有独立工具白名单；Supervisor 的工具集为空。

### 7.3 预算与失败处理

- 单次运行默认：最多 12 步、8 万 token、90 秒墙钟时间。
- 工具失败重试 1 次；仍失败则把错误写入 `evidence`，Agent 必须显式说明「数据不可用」。
- 禁止编造数字：最终回答中的数值必须能追溯到某条 `evidence`，否则在合成节点被剥离并标注。
- 超预算立即终止，事件流记录 `budget_exceeded`，不产出建议。

---

## 8. 人审闭环

写操作不直接执行，流程固定为五步：

1. **提案**：子图生成 `Proposal`，含 `tool_name`、`params`、`before`、`after`、`reason`、`evidence_refs`、`idempotency_key`。
2. **挂起**：节点调用 LangGraph `interrupt(payload)`，checkpointer 持久化整个状态，运行进入 `awaiting_approval`。
3. **审批**：协作台展示前后差异、理由与证据；人批准或驳回（驳回必填理由）。
4. **续跑**：`POST /runs/{id}/resume` 携带审批结论，图从断点恢复。
5. **硬校验后执行**：执行节点重新校验租户归属、价格硬边界（±30%）、幂等键未使用、目标资源仍存在。任一不通过即终止并记录 `guard_rejected`。

**为什么审批后还要硬校验**：审批界面是外部输入，不可信；执行层是最后一道闸。这层冗余是刻意的，代价只有一次查询。

**审计**：`agent_approvals` 记录审批人、时间、结论、理由、请求快照与执行结果；业务表侧同时保留变更记录，双向可对照。

---

## 9. 可观测

### 9.1 事件模型

自研 `TraceCallbackHandler` 监听 `on_chain_start/end`、`on_tool_start/end`、`on_llm_start/end` 与自定义 `approval_*` 事件，写入 `agent_events` 并同步推送 SSE。

字段：`run_id, seq, node, type, payload, started_at, ended_at, tokens_in, tokens_out, trace_id`。`seq` 单调递增，前端按序渲染。

### 9.2 链路追踪

`trace_id` 由 `pms-web` 生成，经 `pms-agent` 透传到 `pms-server` 的 `X-Trace-Id` 头。三端日志可按同一 ID 串联。

### 9.3 LangSmith（可选）

`LANGCHAIN_TRACING_V2=true` 且配置 `LANGCHAIN_API_KEY` 时启用双写；关闭时不报错、不影响功能。README 提供真实链路截图（本地运行产生）。

---

## 10. 双模运行时

`LLMProvider` 抽象两个实现：

- `ReplayProvider`：按 `(model, prompt_hash)` 从 `eval/fixtures/` 读取响应。
- `LiveProvider`：OpenAI 兼容接口，支持 DeepSeek / 通义 / 火山方舟，仅需 `base_url + model + api_key`。

**录制**：`--live --record` 模式下，每次模型调用把 `(model, prompt_hash, response, usage)` 追加到 fixture。

**回放未命中即失败**：直接抛 `FixtureMissing`，禁止回落到真实模型或让模型自由生成。评测与离线演示因此具备确定性；夹具缺失是显式缺陷，而不是被掩盖的随机性。

---

## 11. 评测体系

### 11.1 用例

`eval/cases/<subgraph>.jsonl`，每条声明：

```json
{"id": "revenue-001", "goal": "...", "expect_route": "revenue",
 "expect_tools": ["get_pricing_calendar", "get_competitor_prices"],
 "forbid_tools": ["update_price_without_approval"],
 "constraints": {"max_price_delta_pct": 30}, "tags": ["happy_path"]}
```

覆盖类型：正常路径、缺数据、工具报错、越权尝试、审批驳回、预算超限。

### 11.2 指标

| 指标 | 定义 | M2 门槛 |
|---|---|---|
| 路由准确率 | 分派到正确子图的比例 | ≥ 95% |
| 工具选择准确率 | 调用集合与期望集合的 F1 | ≥ 90% |
| 任务成功率 | 达成目标且未触发红线 | ≥ 90% |
| 平均步数 | 单次运行节点数 | ≤ 8 |
| 单任务成本 | token 折算人民币 | ≤ ¥0.05 |
| 越权拦截率 | 应拦截全部拦截 | 100% |
| 审批正确率 | 应审批/应拒绝判断正确 | 100% |
| P95 延迟 | 端到端 | ≤ 45s（回放） |

### 11.3 基线与门禁

- `eval/baselines/*.json` 锁定后不修改；新增用例另建文件。
- 运行器对比基线，退出码：`0` 通过、`1` 指标退化超阈值、`2` 条件漂移（模型/夹具/用例集变化）无法比较。
- 报告输出 `eval/reports/latest.md` 与 `latest.json`，README 直接引用表格。

---

## 12. 数据模型

新增 `agent` schema，六张表，不影响现有 `public` 业务表。

| 表 | 作用 | 关键字段 |
|---|---|---|
| `agent_runs` | 一次运行 | id, tenant, goal, route, status, started_at, ended_at, total_tokens, cost |
| `agent_events` | 事件流 | run_id, seq, node, type, payload(jsonb), started_at, ended_at |
| `agent_approvals` | 审批单 | run_id, proposal(jsonb), status, decided_by, decided_at, reason, executed_at, result |
| `agent_memories` | 长期记忆 | tenant, scope, key, value(jsonb), importance, last_used_at |
| `agent_eval_runs` | 评测记录 | id, suite, git_sha, metrics(jsonb), baseline_delta, exit_code |
| `agent_insights` | 建议与归因 | run_id, proposal_ref, adopted_at, baseline_revenue, observed_revenue, attribution_note |

`checkpointer` 使用 `langgraph-checkpoint-postgres`，同样落在 `agent` schema，表名不改，避免与业务表冲突。

---

## 13. 协作台界面（`/agent-console`）

三栏：

- **左栏**：四个场景入口 + 历史运行列表（状态、耗时、路由、是否待审批）。
- **中栏**：目标输入、运行按钮、实时事件时间轴。每个节点一张卡：Supervisor → 子图 → 工具调用（参数、返回摘要、耗时、缓存命中标识）。
- **右栏**：结论面板（逐房型建议：当前价 → 建议价、置信度、证据链接）与审批抽屉（差异对比、批准/驳回、理由）。

**运行详情** `/agent-console/[runId]`：从 `agent_events` 回放，支持逐条步进。用于面试现场「倒带讲解」。

**状态**：`queued → running → awaiting_approval → running → succeeded | failed | rejected | budget_exceeded`。前端只按状态与事件渲染，不推断内部逻辑。

---

## 14. 演示数据与脚本

**虚构品牌**：云栖山舍。3 家门店（青岩、镇远、西江），8 个房型，90 天数据。

数据构成：

- 订单与入住率：工作日 45%~65%，周末 75%~95%，含两个节假日峰值。
- 竞对价：每房型 3 个竞对，价格围绕本店 ±10%~25% 波动。
- 渠道：携程 / 美团 / 飞猪，佣金 8%~15%，含超时未确认样本。
- 评价：120 条，4.2~4.9 分，含 6 条需回复的低分。

**种子脚本**：`deploy/seed/demo-seed.ts`，固定 demo 租户 ID，先清后灌，可重复执行且结果一致。

**演示脚本** `docs/demo-script.md`，5 分钟：

1. 登录后台，看今日房价与入住率。
2. 进入协作台，输入「明天青岩店要不要涨价？」
3. 观察 Supervisor 分派到 revenue，工具调用逐张出现。
4. 收到 L2 调价提案，查看证据与差异，批准。
5. 回到价格日历，确认价格已变；打开收益归因面板。

---

## 15. 交付节奏与砍单线

| 阶段 | 内容 | Gate |
|---|---|---|
| **M1 深** | 仓库裁剪、一键 compose、Supervisor + revenue 子图、回放 provider、事件流 + SSE + trace 表、协作台、调价人审闭环、10 条用例与报告 | 无 key 一条命令跑通调价全流程 |
| **M2 广** | ops 晨报（四路并行）、guest 住中客服、ota 渠道体检、建议采纳与收益归因、用例扩至 30 条 | 30 条通过率 ≥ 90%，越权拦截 100% |
| **M3 打磨** | LangSmith 双写、README / 架构图 / 3 篇 ADR、演示录屏、可选公网部署 | 陌生人 clone 后独立跑通 |

**砍单顺序**：M3 全部可砍 → M2 的 `guest` / `ota` 降级为只读体检 → M1 不可砍。M1 完成即具备可展示的最小可信系统。

---

## 16. 验收标准

1. **离线可跑**：无任何 LLM key，`docker compose up` 后按演示脚本走通全部路径。
2. **在线可证**：配置 key 后 `--live` 跑通同一路径，产出真实 LangSmith 链路截图。
3. **评测可信**：基线报告含八项指标与阈值对比；新增用例不改变旧基线。
4. **安全可证**：越权工具调用、超边界调价、重复幂等键三类攻击全部拦截，且有审计记录。
5. **回归不退化**：`pms-agent` 单测全绿；`pms-server` 现有测试通过率不低于迁移前。
6. **文档可用**：README 五步启动；`docs/adr/` 含三篇决策记录（LangGraph 选型、审批后硬校验、回放未命中即失败）。

---

## 17. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| LangGraph API 迭代快 | 实现返工 | 锁定版本；图定义与业务节点分离，升级只改适配层 |
| 回放夹具覆盖不足 | 离线演示走不通 | M1 即录制全部演示路径；CI 跑回放评测兜底 |
| CrewAI 遗留代码干扰 | 维护混乱 | `pms-agent` 新目录重写；旧 Crew 仅作业务语义参考，不并行运行 |
| 真实业务表耦合 | 误改生产语义 | 只加不改；工具端点只读为主，写操作仅价格日历与审批记录 |
| 演示数据过于理想 | 被质疑真实性 | 种子数据刻意包含缺数据、异常、低分评价等不完美样本 |
| 仓库体积与密钥 | 无法公开 | 裁剪清单 + 密钥扫描脚本 + `.gitignore` 白名单 |

---

## 18. ADR 清单

1. `0001-use-langgraph-over-crewai.md`：为什么从 CrewAI 迁到 LangGraph。
2. `0002-approval-then-hard-guard.md`：为什么审批之后执行层还要再校验。
3. `0003-replay-miss-is-failure.md`：为什么回放未命中必须报错而不是回落真实模型。

---

## 19. 现有资产盘点（迁移依据）

| 资产 | 现状 | 本项目处置 |
|---|---|---|
| `pms-server` 业务路由 | 45+ 路由文件，覆盖房态/订单/定价/渠道/财务/客户 | 保留，新增 `agent-tools.ts` |
| `pms-server` 定价引擎 | `services/pricing-engine.ts` 六维定价，含节假日/天气 | 保留，作为 Agent 的确定性基线对照 |
| `pms-ai-crew` 工具层 | 10 个 `HttpTool`，统一内部 token | 语义保留，改写为 LangChain Tool |
| `pms-ai-crew` Crew | 8 个 Crew，含定价/晨报/房务/OTA/内容 | 业务描述复用，编排全部重写 |
| `pms-ai-crew` 分级 | 已有 L1/L2/L3 执行级别概念 | 沿用并落到审批与硬校验 |
| `pms-web` 后台 | 23 个业务页面，shadcn/ui | 保留，新增协作台路由 |
| `pms-mobile` | UniApp 员工端 | 保留可编译，不改造 |
