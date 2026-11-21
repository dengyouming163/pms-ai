# pms-server 业务服务测试基线

- **日期**：2026-11-21
- **仓库**：`pms-ai`（改造前快照，commit `75684e9`）
- **被测模块**：`pms-server`（TypeScript / Hono / Drizzle ORM）
- **命令**：`cd pms-server; pnpm run test`（即 `vitest run`，使用 `vitest.config.ts`）
- **完整日志**：本地文件 `docs/baseline/pms-server-test.log`（未入库，由 `.gitignore` 的 `*.log` 忽略）

## 结果

| 指标 | 数量 |
| --- | --- |
| 通过（Tests passed） | **1803** |
| 失败（Tests failed） | **4** |
| 跳过（Tests skipped） | **654** |
| 用例总数 | 2461 |
| 测试文件 | 2 failed / 188 passed / 32 skipped（共 222） |
| **退出码** | **1** |

## 运行环境

- Node **v22.11.0**、pnpm **12.8.1**、vitest **4.1.10**（win32-x64）。
- **RUN_DB 未设置**：654 个跳过中主要是 `describe.skipIf(!process.env.RUN_DB)` 门控的数据库用例，因此**本基线不覆盖 DB 用例**（未通过 `vitest.local.config.ts` 打开 `RUN_DB=1`）。
- PostgreSQL 16（pgvector 镜像）与 Redis 7 由 `docker compose` 提供，映射到本机 15433 / 16379。

## 环境准备（本机，未提交）

1. `deploy/.env.example` → 根目录 `.env`；`pms-server/.env` 写本地开发配置（PG 指向 127.0.0.1:15433 / 库 `pms_ai` / 用户 `pms`，口令取本地默认值，见 `deploy/.env.example`）。两份 `.env` 均被 `.gitignore` 忽略。
2. `docker compose up -d postgres redis`：两容器均为 `healthy`（127.0.0.1:15433 / 127.0.0.1:16379）。
3. 本地库最初为空表。注意：`pnpm run test` 不会加载 `pms-server/.env`，`vitest.config.ts` 只为 PG 注入桩值且不含 `PG_PORT`，因此必须显式导出 `PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_PASSWORD` 才能在本次运行中连上本地库。
4. 无现成迁移脚本（`package.json` 无 migrate；`drizzle/meta/_journal.json` 只登记了 0000），故用 `drizzle-kit push` 按 `src/db/schema` 建表（口令见 `deploy/.env.example`）：

```powershell
$env:DATABASE_URL='postgresql://<user>:<password>@127.0.0.1:15433/pms_ai?sslmode=disable'
pnpm exec drizzle-kit push --config drizzle.config.ts --force
```

> 未改动任何业务代码、测试文件或 compose 配置。

## 已知限制

- 数据库结构由 `drizzle-kit push` 直接按 `src/db/schema` 建立，**未固化 schema 版本**（journal 仅登记 0000，仓库也没有 migrate 脚本）。这与生产 Dockerfile CMD 逐条 `psql -f` 的迁移路径不同，不能据此推断生产库的实际结构与数据。
- 未设置 `RUN_DB`，DB 用例整体未执行；本基线只覆盖非 DB 门控用例。

## 失败用例清单

| 文件 | 用例 | 失败原因 |
| --- | --- | --- |
| `src/routes/admin/__tests__/wenlv.test.ts` | rally 合法结构（scene+collectible+tier condition/reward）publish 200 | 实际返回 409（发布完整性校验未通过），断言 200 |
| `src/routes/mini/__tests__/wenlv.test.ts` | 错凭证触发未绑点位的旧式扫码节点 → 403「触发凭证不匹配」 | 实际返回 200；当前 `nodeRequiresCredential()` 只按 `venuePointId` 判定，未绑点位的节点不再要求凭证 |
| `src/routes/mini/__tests__/wenlv.test.ts` | 未到场答题未绑点位的旧式扫码谜题 → 403「请先到场触发该节点」 | 实际返回 200；同上，旧式 `triggerType/triggerCredential` 门在 0079 统一模型中已不存在 |
| `src/routes/mini/__tests__/wenlv.test.ts` | scene 节点的现场动作（meditate / photo）仍不可提交 → 400「无此交互」 | 返回 400 但错误文案为「无此谜题」，与测试期望文案不一致 |

4 条失败在 `--no-file-parallelism` 串行单文件重跑中稳定复现，非并发抖动、非随机红灯。

## 失败摘要（关键断言差异）

```text
src/routes/admin/__tests__/wenlv.test.ts:491  期望 200，实际 409（发布完整性校验未通过）
src/routes/mini/__tests__/wenlv.test.ts:592   期望 403「触发凭证不匹配」，实际 200
src/routes/mini/__tests__/wenlv.test.ts:609   期望 403「请先到场触发该节点」，实际 200
src/routes/mini/__tests__/wenlv.test.ts:989   期望文案「无此交互」，实际「无此谜题」（状态码同为 400）
```

## 环境缺失 vs 真实代码失败

- **环境缺失（已在本次准备中消除）**：迁移前直接 `pnpm run test` 有 32 处未处理错误，全部是 `ECONNREFUSED ::1:5432`（vitest 未注入 `PG_PORT`，默认连 5432 而 compose 映射 15433）；把 `PG_*` 指向本地库后，剩余错误变为 `relation "pms_bui_wenlv_products" does not exist`（42P01），属于本地库未建表。启动 postgres/redis 并 `drizzle-kit push` 后，这两类失败全部消失。
- **真实代码/测试失败（基线内既有）**：上表 4 条。均不依赖外部 API、Redis 或网络，属于 0079 统一模型改造后遗留的测试期望与当前实现不一致（旧式节点凭证门已移除、答案错误文案已变更、rally 发布完整性校验拒绝该 fixture），需在后续任务中处理，本次仅记录。
- 未发现由外部服务（Agent API、LLM、微信/支付等）导致的失败——相关用例已被 mock 或跳过。

## 口径

**后续所有对比以此为准**（通过 1803 / 失败 4 / 跳过 654，退出码 1；不含 RUN_DB 门控的 DB 用例）。
