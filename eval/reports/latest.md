# 评测报告：guest

- 生成时间：2026-11-23T16:13:04
- 用例数：6
- 基线：guest-2026-11-21.json（cases 6831b6070ad8…，fixtures 20eb3c347ee2…）
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
| p95_latency_ms | 8.1106 | 45000.0 | 7.4279 |

## 用例明细

| 用例 | 标签 | 路由 | 工具 F1 | 中断 | 终态 | 步数 | 耗时(ms) | 结果 |
|---|---|---|---|---|---|---|---|---|
| guest-001 | happy_path,faq_wifi | guest/guest | 1.00 | False | none | 3 | 8 | PASS |
| guest-002 | happy_path,faq_breakfast | guest/guest | 1.00 | False | none | 3 | 3 | PASS |
| guest-003 | happy_path,faq_checkout | guest/guest | 1.00 | False | none | 3 | 4 | PASS |
| guest-004 | happy_path,faq_pet | guest/guest | 1.00 | False | none | 3 | 3 | PASS |
| guest-005 | transfer,kb_miss | guest/guest | 1.00 | False | none | 3 | 3 | PASS |
| guest-006 | transfer,tool_error | guest/guest | 1.00 | False | none | 3 | 3 | PASS |
