# ADR 0001：用 LangGraph Supervisor 替代 CrewAI 多 Crew

- 日期：2026-11-21
- 状态：已采纳

## 背景

旧实现 `pms-ai-crew` 有八个彼此独立的 Crew，各自维护提示词与工具调用。它能在演示中跑通，但存在三个硬伤：路由不可见（无法判断一次请求该由谁处理）、过程不可观测（没有统一事件流）、结果不可评测（同一输入两次运行结果不同，无法锁定基线）。要把它做成可公开演示的作品集，首先需要一条**确定、可回放、可评测**的编排骨架。

## 选项

1. **保留 CrewAI 多 Crew**：改动最小，但路由与工具边界仍分散，评测只能停留在端到端黑盒。
2. **Plan-and-Execute**：跨领域能力强，但 Planner 一次失败整条链路作废，调试与现场演示风险高。
3. **Swarm**：路径不可预测、终止条件难保证，无法支撑基线评测。
4. **LangGraph Supervisor + 领域子图**：Supervisor 单点路由，子图内部工具循环固定，checkpoint 天然支持中断/恢复。

## 决定

采用方案 4：

- `supervisor` 只做意图识别与分派，**不持有任何业务工具**；
- `revenue / ops / guest / ota` 四个子图各自持有工具白名单；
- 状态 `AgentState` 字段固定（tenant / route / evidence / proposals / approvals / final），节点只读写这些字段；
- 用 Postgres checkpointer 支持人审 `interrupt` 与 `resume`。

## 后果

- 路由准确率、工具 F1、审批正确率都成为可单独断言的指标（见 `eval/`）。
- 新增领域只需加子图与条件边，不必改动其它子图。
- 代价是要自己维护事件流、checkpoint 与跨节点状态约定；子图间不共享隐式状态，所有中间结果必须落到 `evidence` 或 `proposals`。
- Supervisor 的规则路由需要持续扩充关键词；误路由会直接体现在评测的路由准确率上，而不是被"模型自由发挥"掩盖。
