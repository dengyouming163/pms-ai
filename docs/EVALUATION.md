# 评测说明

评测的目标不是「跑一次看看」，而是把多智能体的行为变成可回归的门禁：同样的输入必须得到同样的指标，任何退化都要让 CI 变红。

## 1. 设计原则

- **离线**：不连数据库、不连模型、不需要 API Key。工具数据与模型输出都由用例声明。
- **确定**：每条用例使用独立 `thread_id` 与独立 `MemorySaver`，同一用例集重复执行，指标完全一致。
- **可门禁**：退出码 0 / 1 / 2 分别表示通过、指标退化、条件漂移。
- **基线独立**：每个套件一份基线，新增套件不会让旧套件假漂移。

## 2. 用例结构

用例位于 `eval/cases/{revenue,ops,guest,ota}.jsonl`，一行一条 JSON：

```json
{
  "id": "revenue-001",
  "goal": "明天云栖山舍的房价要不要涨？",
  "expect_route": "revenue",
  "expect_tools": ["pricing-calendar", "occupancy", "competitor-prices", "channel-performance", "price-adjust"],
  "forbid_tools": [],
  "constraints": { "max_price_delta_pct": 30 },
  "tags": ["happy_path", "weekday"],
  "expect_approval": true,
  "approval": "approve",
  "expect_execution": "succeeded",
  "tool_data": {},
  "model_output": []
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 全局唯一，报告与失败定位用 |
| `goal` | 用户输入的自然语言目标 |
| `expect_route` | 期望路由；`direct` 表示不应进入业务子图 |
| `expect_tools` | 期望调用的工具集合，参与 F1 计算 |
| `forbid_tools` | 禁止调用的工具，命中即失败（如缺数据时不得调价） |
| `constraints` | 业务约束，如最大调价幅度 |
| `tags` | 场景标签，用于分组统计 |
| `expect_approval` / `approval` | 是否应触发审批，以及审批动作 |
| `expect_execution` | 执行结果，如 `succeeded`、`blocked` |
| `tool_data` | 覆盖默认工具返回值，构造缺数据、异常等场景 |
| `model_output` | 覆盖模型输出，保证回放确定性 |

当前规模：revenue 10 / ops 8 / guest 6 / ota 6，共 30 条。

## 3. 指标与门槛

| 指标 | 定义 | 门槛 |
| --- | --- | --- |
| `routing_accuracy` | 路由与 `expect_route` 一致的比例 | ≥ 95% |
| `tool_f1` | 工具选择与 `expect_tools` 的 F1 | ≥ 90% |
| `task_success_rate` | 运行终态与 `expect_execution` 一致的比例 | ≥ 90% |
| `avg_steps` | 平均图节点步数 | ≤ 8 |
| `cost_cny` | 按 token 折算的单任务成本 | ≤ ¥0.05 |
| `block_rate` | 越权/违规调用被拦截的比例 | 100% |
| `approval_accuracy` | 审批决策符合预期的比例 | 100% |
| `p95_latency_ms` | 回放模式下 P95 延迟 | ≤ 45s |

回放不产生真实计费，成本按统一单价折算：¥0.002 / 1K tokens，仅用于横向比较，不代表线上账单。

## 4. 运行

```powershell
# 仓库根目录执行
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite revenue
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite ops
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite guest
pms-agent\.venv\Scripts\python.exe -m eval.run_eval --suite ota
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--suite <name>` | 指定套件 |
| `--write-baseline` | 用当前结果重写该套件基线 |
| `--live` | 调用真实模型 |
| `--record` | 录制回放夹具（通常与 `--live` 搭配） |

## 5. 退出码

| 码 | 含义 | 处理方式 |
| --- | --- | --- |
| `0` | 全部指标满足门槛且未低于基线容差 | 通过 |
| `1` | 指标退化，或低于硬门槛 | 定位失败用例，修复后再提交 |
| `2` | 条件漂移：用例集或夹具变化，无法与基线比较 | 确认变更合理后重建基线 |

比率类指标允许 2 个百分点的绝对退化，步数/成本/延迟允许 20% 的相对退化；超出即失败。

## 6. 维护基线

- **新增用例**：新建文件或追加到当前套件，不改动旧基线内容。
- **行为变更**：先跑一次确认差异符合预期，再用 `--write-baseline` 更新对应套件基线，并在 PR 中说明原因。
- **新增套件**：首次运行加 `--write-baseline` 生成基线，随后纳入 CI。

基线文件位于 `eval/baselines/`，报告输出到 `eval/reports/`。不要把「为了让 CI 变绿」当作更新基线的理由。

## 7. CI 门禁

[CI 工作流](../.github/workflows/ci.yml) 在每次 push 与 PR 时执行：

1. `pms-agent` pytest；
2. 四个评测套件；
3. `pms-server` 类型检查与核心单测（Agent 工具、调价护栏、种子数据）；
4. `pms-web` 类型检查。

任一退出码非 0 即阻断合并。
