# 评测报告：ota

- 生成时间：2026-11-23T17:25:09
- 用例数：6
- 基线：ota-2026-11-21.json（cases 6e1177ffde34…，fixtures c80b8a51340e…）
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
| p95_latency_ms | 8.2542 | 45000.0 | 5.4605 |

## 用例明细

| 用例 | 标签 | 路由 | 工具 F1 | 中断 | 终态 | 步数 | 耗时(ms) | 结果 |
|---|---|---|---|---|---|---|---|---|
| ota-001 | happy_path | ota/ota | 1.00 | False | none | 3 | 8 | PASS |
| ota-002 | price_gap | ota/ota | 1.00 | False | none | 3 | 3 | PASS |
| ota-003 | inventory | ota/ota | 1.00 | False | none | 3 | 3 | PASS |
| ota-004 | channel_timeout | ota/ota | 1.00 | False | none | 3 | 3 | PASS |
| ota-005 | sync_overdue | ota/ota | 1.00 | False | none | 3 | 3 | PASS |
| ota-006 | tool_error | ota/ota | 1.00 | False | none | 3 | 3 | PASS |
