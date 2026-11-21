# pms-server 项目概览

酒店PMS后端API服务 - 基于Hono框架的轻量级Node.js后端，为pms-web前端提供RESTful API。

## 版本技术栈

- **Framework**: Hono 4.x
- **Runtime**: Node.js 24 (via @hono/node-server)
- **Language**: TypeScript 5 (strict mode)
- **Package Manager**: pnpm

## 目录结构

```
├── src/
│   ├── index.ts          # Hono应用入口（CORS + 路由注册）
│   ├── server.ts         # Node.js服务器启动（端口8080）
│   └── routes/
│       ├── dashboard.ts  # 工作台API
│       ├── brands.ts     # 品牌管理API
│       ├── stores.ts     # 门店/房型/房间/设备API
│       ├── rooms.ts      # 房态API（日房态/月房态/预订）
│       ├── orders.ts     # 订单API（列表/统计/渠道待处理/详情）
│       ├── pricing.ts    # 房价API（日历/规则/渠道定价/促销/AI定价）
│       ├── channels.ts   # 渠道API（映射/同步/评价/库存）
│       ├── finance.ts    # 财务API（收支/对账/报表）
│       ├── data-center.ts # AI助手API（SSE流式对话）
│       ├── customers.ts  # 客户API（列表/标签/统计/详情）
│       ├── staff.ts      # 员工API（列表/角色/日志）
│       └── settings.ts   # 设置API（基础/业务/订阅/安全）
├── package.json
├── tsconfig.json
└── .coze                 # Coze部署配置
```

## 构建和运行命令

```bash
# 安装依赖
pnpm install

# 开发环境（热更新）
pnpm dev          # tsx watch src/server.ts

# 生产环境
pnpm start        # tsx src/server.ts

# 类型检查
pnpm ts-check     # tsc --noEmit
```

## 多仓协作

- **pms-web** (Next.js/:5000): 通过 Next.js rewrites 将 `/api/*` 代理到本服务
- **pms-server** (Hono/:8080): 本项目，提供所有业务API
- **环境变量**: `PMS_SERVER_URL`（在pms-web中配置代理目标地址）

## 编码规范

- 所有路由使用 Hono 的 Router 模式：`const route = new Hono(); ... export default route;`
- 在 `index.ts` 中注册：`app.route('/api/xxx', xxxRoute);`
- 请求参数：`c.req.query('type')` 获取查询参数，`c.req.json()` 获取请求体
- 响应：`c.json(data)` 返回JSON，`stream(c, async (s) => {...})` 返回SSE流
- CORS中间件已在 `index.ts` 全局配置

## 数据说明

当前所有数据为硬编码Mock数据，存储在各路由文件中。后续将接入Supabase数据库。
