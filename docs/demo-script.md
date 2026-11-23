# 5 分钟演示脚本

> 目标：让评审在 5 分钟内看到「Agent 读真实数据 → 提建议 → 人审批 → 真的改价 → 可回放 → 可评测」。
> 默认回放模式，无需 LLM key。若已重启过服务，先执行文末「演示前检查」。

## 0:00–0:30 业务底稿

1. 登录 `http://localhost:3000`（13800000000 / Demo123456）。
2. 打开「定价中心」，指出青岩店明天各房型价格与入住率。
3. 一句话交代：这些是种子数据，不是写死的静态页面。

## 0:30–1:00 发起协作

1. 进入 `/agent-console`。
2. 在目标框输入：「明天青岩店要不要涨价？」
3. 点击运行，观察状态 `queued → running`。

## 1:00–2:00 看协作过程

1. 中栏事件时间轴依次出现：Supervisor 分派 → revenue_collect → revenue_analyze → revenue_propose。
2. 展开工具卡片，指出每次调用的参数、耗时与返回摘要（价格日历、房态、竞对价、渠道表现）。
3. 强调：Supervisor 本身没有业务工具，工具白名单在子图里。

## 2:00–3:00 审批与执行

1. 右栏出现 L2 调价提案：当前价 → 建议价、理由、证据引用。
2. 先展示驳回路径（可选）：填理由驳回，确认价格未变、事件流记为 rejected。
3. 重新运行并批准提案。
4. 观察 `revenue_execute` 调用 `/price-adjust`，返回前后快照；状态变为 `succeeded`。

## 3:00–3:30 回到业务验证

1. 打开「定价中心」，刷新目标日期，确认价格已变。
2. 指出审批单与价格变更双向可对照，执行层还做了 ±30% 与租户校验。

## 3:30–4:30 广度与其他子图

1. **经营晨报**：输入「给我一份今天的经营晨报」，展示四路体检与 P0/P1 排序。
2. **住中客服**：输入「客人咨询退房时间和延迟退房政策」，展示知识库原文回答；再输入一个知识库没有的问题，展示「暂无相关信息，已转人工」。
3. **渠道体检**：输入「帮我做一次渠道体检，看看价差和超时风险」，展示价差、售罄、超时、同步状态四条结论与建议动作。
4. 强调后两个子图只读，报告末尾固定写「未执行任何写操作」。

## 4:30–5:00 可回放与可评测

1. 打开任一条历史运行详情，用逐条步进「倒带」讲解。
2. 展示 `eval/baselines/` 与最近一次报告；说明 30 条用例、八项指标、退出码门禁。
3. 收尾：默认回放不依赖 key；配置 key 后切 live 可产出真实链路与 LangSmith 轨迹。

## 演示前检查

```powershell
# 1. 五个服务健康
powershell -File deploy\healthcheck.ps1

# 2. 种子幂等（重复执行结果一致）
$env:PG_HOST="127.0.0.1"; $env:PG_PORT="15433"; $env:PG_DATABASE="pms_ai"; $env:PG_USER="pms"; $env:PG_PASSWORD="pms_local_dev"
pnpm --dir pms-server exec tsx ../deploy/seed/demo-seed.ts

# 3. 评测退出码为 0
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite revenue
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite ops
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite guest
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite ota
```

## 常见问题

- **协作台一直 running**：检查 `pms-agent` 日志与 `AGENT_DATABASE_URL` 是否指向同一个库。
- **guest 总是转人工**：确认种子已灌入 `kb_guide`（共 24 条），且 `pms-server` 镜像包含 `/kb-search` 端点。
- **审批后价格没变**：看 `revenue_execute` 事件；`guard_rejected` 表示重校验未通过（价格超 ±30% 或资源已变）。
- **需要真实模型**：`LLM_PROVIDER=live` 并配置 `LLM_API_KEY`；首次运行用 `--live --record` 录制夹具。
