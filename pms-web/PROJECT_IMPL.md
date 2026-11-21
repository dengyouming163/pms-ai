# 民宿·AIPMS 项目实现

## 一、整体架构与设计思路

项目采用**三仓独立部署**的微服务架构，前端、后端、AI服务分离运行，通过API代理实现统一入口：

| 仓库名 | 技术栈 | 端口 | 职责 |
|--------|--------|------|------|
| pms-web | Next.js 16 + React 19 + TypeScript 5 + Tailwind CSS 4 + shadcn/ui | 5000 | 前端渲染、API代理、SSE流式转发 |
| pms-server | Hono + Node.js + Drizzle ORM + PostgreSQL | 8080 | 业务API、JWT鉴权、操作日志中间件 |
| pms-ai | Hono + coze-coding-dev-sdk + LangChain | 8081 | AI对话流式输出、AI定价建议、经营诊断 |

**设计思路**：前后端分离，Next.js 通过 rewrites 代理后端请求，AI流式对话通过专用 SSE API Route 转发（绕过 Next.js rewrites 的缓冲机制）。后端可独立替换为 PHP/Java 等，前端无需修改，只需调整代理目标地址。

**数据库**：PostgreSQL 共享实例，25张业务表（pms_bui_前缀），Drizzle ORM 管理 Schema 与 Migration。

**鉴权体系**：JWT Bearer Token，bcryptjs 密码加密，前端 AuthContext + AuthGuard 全局拦截。

## 二、我负责的模块与成果

我独立负责三个仓库的全栈开发，主要成果如下：

**前端（pms-web）**：完成 12 个业务页面，包括工作台、房态管理（日/月视图）、订单管理、价格日历、渠道管理、财务对账、AI助手、客户管理、员工权限等；实现移动端响应式适配（侧边栏滑入/汉堡菜单）；封装通用组件（StatCard、StatusBadge、PageHeader、ChatPanel 等）。

**后端（pms-server）**：实现 12 组 RESTful API 共 40+ 端点；开发操作日志中间件（opLogMiddleware），自动拦截所有 POST 写操作并记录操作人、模块、操作类型到数据库；实现房态写操作 7 个端点（入住/退房/预订/取消/锁定/解锁/清洁标记）。

**AI服务（pms-ai）**：基于豆包大模型实现 SSE 流式对话，支持三种会话模式（通用助手/收益分析/经营诊断）；实现 AI 智能定价建议，支持采纳（同步更新基础房价）和忽略操作，数据持久化到 pms_bui_ai_suggestions 表。

**量化成果**：25张数据库表、40+ API端点、12个完整页面、3大AI功能、1个通用操作日志中间件、7个房态操作端点、AI定价采纳/忽略闭环。

## 三、遇到的难点与解决方案

**难点1：React 19 Hydration 白屏**。Next.js 16 升级 React 19 后，`performance.measure()` 在 SSR→客户端 Hydration 时计算负时长抛出 TypeError，导致整个页面白屏。尝试了 inline script、next/script、instrumentation 等多种方案，最终通过 Next.js 官方的 `instrumentation-client.ts` 机制在 Hydration 前注入 polyfill 捕获异常，配合根路由从 React `redirect()` 改为 `next.config.ts` 的 `redirects` 配置彻底解决。

**难点2：AI 流式输出被缓冲**。Next.js rewrites 会缓冲代理响应，导致 SSE 流式数据到前端变成一次性返回，无法实现打字机效果。解决方案是新建 `src/app/api/data-center/route.ts` 作为专用 SSE 代理，手动 fetch 后端 ReadableStream 并逐块转发，绕过 rewrites 缓冲。

**难点3：财务页 NaN 渲染崩溃**。后端返回 null/undefined 数据时，`.toLocaleString()` 直接产生 NaN，React 报 `Received NaN for children` 警告。封装 `fmtNum()` 和 `fmtPct()` 工具函数，统一处理空值、除零、Infinity 等边界情况，全页 18 处调用替换。

**难点4：PM2 启动后端失败**。`node_modules/.bin/tsx` 是 shell 脚本，PM2 把它当 JS 执行报 SyntaxError。改为先用 tsup 将 TypeScript 编译为 CJS 产物（dist/server.cjs），PM2 直接执行 JS 文件。
