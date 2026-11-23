# 文档索引

本目录存放 pms-ai 的设计、部署、评测与决策记录。README 面向第一次接触项目的读者，这里面向要动手修改或部署的人。

## 入门

| 文档 | 内容 |
| --- | --- |
| [架构说明](ARCHITECTURE.md) | 服务边界、运行与审批链路、Agent 图、内部工具端点、数据模型、扩展方式 |
| [部署手册](DEPLOYMENT.md) | 本地编排、环境变量、回放/在线/LangSmith 模式、故障排查、生产清单 |
| [评测说明](EVALUATION.md) | 指标定义与门槛、用例结构、退出码、基线维护、CI 门禁 |
| [演示脚本](demo-script.md) | 5 分钟从提问到调价落库的完整走查与演示前检查 |

## 设计与决策

| 文档 | 内容 |
| --- | --- |
| [架构规格](design/architecture-spec.md) | 原始设计规格：目标、边界、数据契约与里程碑验收 |
| [实施计划](plans/implementation-plan.md) | M1–M3 任务拆分、依赖与验收记录 |
| [ADR 0001](adr/0001-use-langgraph-over-crewai.md) | 为什么选择 LangGraph 而不是 CrewAI |
| [ADR 0002](adr/0002-approval-then-hard-guard.md) | 审批通过后为什么仍要在执行层做硬校验 |
| [ADR 0003](adr/0003-replay-miss-is-failure.md) | 回放夹具未命中必须失败，禁止回落真实模型 |

## 参考

| 文档 | 内容 |
| --- | --- |
| [测试基线](baseline/test-baseline.md) | 各子项目测试入口与基线记录 |
| [面试手册](interview/pms-ai-interview-guide.md) | 围绕本项目的知识问答与讲法 |

## 约定

- 文档默认中文，命令以仓库根目录为起点。
- 截图与图片放 `docs/assets/`，引用使用相对路径。
- 新增架构级取舍时补一篇 ADR；修改接口或流程时同步更新 [ARCHITECTURE.md](ARCHITECTURE.md)。
