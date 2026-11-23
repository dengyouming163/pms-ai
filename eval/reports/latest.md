# 评测报告：revenue

- 生成时间：2026-11-23T15:59:33
- 用例数：10
- 基线：revenue-2026-11-21.json（cases 52ca920f604d…，fixtures 20eb3c347ee2…）
- 结论：**PASS**

| 指标 | 当前 | 门槛 | 基线 |
|---|---|---|---|
| routing_accuracy | 1.0000 | 0.95 | 1.0000 |
| tool_f1 | 1.0000 | 0.9 | 1.0000 |
| task_success_rate | 1.0000 | 0.9 | 1.0000 |
| avg_steps | 5.4000 | 8.0 | 5.4000 |
| cost_cny | 0.0007 | 0.05 | 0.0007 |
| block_rate | 1.0000 | 1.0 | 1.0000 |
| approval_accuracy | 1.0000 | 1.0 | 1.0000 |
| p95_latency_ms | 10.0661 | 45000.0 | 9.6584 |

## 用例明细

| 用例 | 标签 | 路由 | 工具 F1 | 中断 | 终态 | 步数 | 耗时(ms) | 结果 |
|---|---|---|---|---|---|---|---|---|
| revenue-001 | happy_path,weekday | revenue/revenue | 1.00 | True | succeeded | 6 | 10 | PASS |
| revenue-002 | happy_path,weekend | revenue/revenue | 1.00 | True | succeeded | 6 | 5 | PASS |
| revenue-003 | happy_path,holiday | revenue/revenue | 1.00 | True | succeeded | 6 | 4 | PASS |
| revenue-004 | happy_path,competitor_lower | revenue/revenue | 1.00 | True | succeeded | 6 | 5 | PASS |
| revenue-005 | missing_data | revenue/revenue | 1.00 | False | succeeded | 6 | 3 | PASS |
| revenue-006 | tool_error | revenue/revenue | 1.00 | True | succeeded | 6 | 5 | PASS |
| revenue-007 | over_limit | revenue/revenue | 1.00 | True | guard_rejected | 6 | 4 | PASS |
| revenue-008 | unauthorized | revenue/revenue | 1.00 | True | awaiting_approval | 4 | 3 | PASS |
| revenue-009 | approval_rejected | revenue/revenue | 1.00 | True | rejected | 6 | 5 | PASS |
| revenue-010 | direct | direct/direct | 1.00 | False | none | 2 | 2 | PASS |
