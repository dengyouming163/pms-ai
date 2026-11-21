# pms-web — 商家 Web 管理后台

Next.js 16 App Router + React 19 + Tailwind CSS 4 + shadcn/ui。

## 目录结构

```
pms-web/src/
├── app/                    # App Router 页面（每个文件夹一个路由）
│   ├── layout.tsx          # 根布局：AuthProvider → AuthGuard → AppLayout
│   ├── page.tsx            # 首页 → 重定向到 /dashboard
│   ├── dashboard/          # 数据看板
│   ├── stores/             # 门店管理
│   ├── rooms/              # 房态管理
│   ├── orders/             # 订单管理
│   ├── pricing/            # 智能定价
│   ├── channels/           # 渠道管理
│   ├── finance/            # 财务管理
│   ├── customers/          # 客户管理
│   ├── staff/              # 员工管理
│   ├── brands/             # 品牌管理
│   ├── marketing/          # 营销中心
│   ├── data-center/        # 数据中心（AI 核心入口）
│   ├── settings/           # 系统设置
│   └── login/              # 登录页
├── components/
│   ├── ui/                 # shadcn/ui 组件（40+ 个，由 Radix UI 驱动）
│   └── layout/             # AppLayout / Sidebar
├── lib/
│   ├── auth/               # AuthProvider + AuthGuard
│   └── ...                 # 工具函数
└── storage/
    └── database/shared/    # Drizzle ORM Schema（与 pms-server 共享表定义）
```

## 关键约定

- 使用 shadcn/ui 组件（`@/components/ui/`），**不要**引入 Ant Design 或 MUI
- 认证通过 `AuthProvider` 包裹全局，页面无需自己处理登录态
- 后端 API 统一调用 `http://localhost:9090/api/*`（pms-server）
- AI 功能调用 `http://localhost:9091/api/data-center/*`（pms-ai）
- 样式用 Tailwind CSS 4 的 utility class，组件变体用 `class-variance-authority`
- 参考根目录 `CLAUDE.md` 和 `.claude/constitution.md` 的通用约束
