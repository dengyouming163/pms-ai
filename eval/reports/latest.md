# 评测报告：ops

- 生成时间：2026-11-23T16:08:34
- 用例数：8
- 基线：ops-2026-11-21.json（cases ce63182bf6b2…，fixtures 20eb3c347ee2…）
- 结论：**PASS**

| 指标 | 当前 | 门槛 | 基线 |
|---|---|---|---|
| routing_accuracy | 1.0000 | 0.95 | 1.0000 |
| tool_f1 | 1.0000 | 0.9 | 1.0000 |
| task_success_rate | 1.0000 | 0.9 | 1.0000 |
| avg_steps | 3.0000 | 8.0 | 3.0000 |
| cost_cny | 0.0000 | 0.05 | 0.0000 |
| block_rate | 1.0000 | 1.0 | 1.0000 |
| approval_accuracy | 1.0000 | 1.0 | 1.0000 |
| p95_latency_ms | 7.2304 | 45000.0 | 7.0675 |

## 用例明细

| 用例 | 标签 | 路由 | 工具 F1 | 中断 | 终态 | 步数 | 耗时(ms) | 结果 |
|---|---|---|---|---|---|---|---|---|
| ops-001 | happy_path,morning_report | ops/ops | 1.00 | False | none | 3 | 7 | PASS |
| ops-002 | happy_path,daily_report | ops/ops | 1.00 | False | none | 3 | 3 | PASS |
| ops-003 | channel_timeout | ops/ops | 1.00 | False | none | 3 | 3 | PASS |
| ops-004 | low_rating | ops/ops | 1.00 | False | none | 3 | 3 | PASS |
| ops-005 | dirty_rooms | ops/ops | 1.00 | False | none | 3 | 3 | PASS |
| ops-006 | zero_revenue | ops/ops | 1.00 | False | none | 3 | 3 | PASS |
| ops-007 | tool_error,reviews_failed | ops/ops | 1.00 | False | none | 3 | 3 | PASS |
| ops-008 | tool_error,channel_failed | ops/ops | 1.00 | False | none | 3 | 2 | PASS |
