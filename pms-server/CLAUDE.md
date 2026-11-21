# pms-server — 主业务 API 服务

端口 `9090`，Hono 4 + TypeScript 5 + Drizzle ORM。

## 目录结构

```
pms-server/src/
├── server.ts              # 入口（serve on port 9090）
├── index.ts                # Hono app 组装（路由挂载 + 中间件）
├── routes/                 # 路由处理器（每个文件一个业务域）
│   ├── auth.ts             # 登录/登出/改密/短信/角色切换
│   ├── dashboard.ts        # 仪表盘 KPI 聚合
│   ├── stores.ts           # 门店管理
│   ├── rooms.ts            # 房态管理
│   ├── orders.ts           # 订单管理
│   ├── pricing.ts          # 定价/促销/价格日历
│   ├── channels.ts         # 渠道管理
│   ├── finance.ts          # 财务管理
│   ├── customers.ts        # 客户管理
│   ├── staff.ts            # 员工/角色管理
│   ├── brands.ts           # 品牌管理
│   ├── settings.ts         # 系统设置
│   └── data-center.ts      # 数据中心
├── db/
│   ├── index.ts            # Drizzle + pg Pool 连接（默认 localhost:15432）
│   ├── schema/             # 按业务域拆分
│   └── seed.ts             # 种子数据
├── middleware/
│   └── op-log.ts           # 操作日志中间件（自动记录所有 POST）
└── schemas/                # Zod 请求/响应校验（按业务域拆分）
```

## 关键约定

- 所有路由挂载在 `/api/<domain>` 下（auth → `/api/auth`，dashboard → `/api/dashboard`...）
- 操作日志通过 op-log 中间件自动记录 POST 请求，**注意 JWT 密钥与 auth.ts 保持一致**
- 认证通过 JWT Bearer Token，在路由 handler 中手动校验
- 参考根目录 `CLAUDE.md` 和 `.claude/constitution.md` 的通用约束
