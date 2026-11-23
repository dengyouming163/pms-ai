# 更新日志

本文件记录项目的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- Agent 运行与审批接口接入用户级鉴权。
- 审批幂等键落唯一索引，支持跨进程去重。
- Agent 持久化切换异步连接池，补充并发压测基线。

## [0.3.0] - 2026-11-23

M3：可观测性、决策记录与开源工程化。

### 新增

- LangSmith 可选双写：`LANGCHAIN_TRACING_V2=true` 且 Key 非空时启用，默认零外部请求。
- 收益归因页 `/agent-console/insights`：采纳率、归因增益、待回填与采纳记录。
- 三篇 ADR：LangGraph 选型、审批后硬校验、回放未命中即失败。
- 开源配套：MIT 许可证、贡献指南、安全策略、行为准则、Issue/PR 模板与 CI 工作流。
- PC 与移动端界面截图（`docs/assets/screenshots/`）。

### 变更

- 设计规格迁移至 `docs/design/architecture-spec.md`，实施计划迁移至 `docs/plans/implementation-plan.md`。
- README 重写为开源项目主页，补充能力矩阵、架构图、评测表与文档索引。

## [0.2.0] - 2026-11-22

M2：场景扩展与评测扩容。

### 新增

- `ops` 经营晨报子图：并发四路体检并按 P0/P1 排序。
- `guest` 住中客服子图：知识库检索，无命中固定转人工。
- `ota` 渠道体检子图：价差、库存、超时与同步状态。
- 评测用例扩充到 30 条（revenue 10 / ops 8 / guest 6 / ota 6），四套件全部通过。
- 服务端内部端点：`/kb-search`、`/channel-status`、`/daily-revenue`。

## [0.1.0] - 2026-11-21

M1：可运行的多智能体闭环。

### 新增

- `pms-agent`：FastAPI + LangGraph，Supervisor + `revenue` 子图。
- 人工审批中断与恢复：`agent_approvals` 记录决策，执行节点二次硬校验。
- `/agent-console` 协作台：运行创建、事件时间轴、SSE 实时推送、审批抽屉。
- 回放 Provider：默认无需 API Key，四套夹具支持离线演示。
- 评测运行器与基线：路由、工具选择、成功率、步数、成本、拦截、审批、延迟八项指标。
- Docker Compose 一键编排、健康检查脚本与「云栖山舍」演示种子数据。
