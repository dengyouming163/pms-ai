# 项目概览

酒店PMS商家管理后台 - 基于Next.js 16 App Router的前后端分离架构，支持品牌与门店、房态管理、房价管理、渠道管理、财务对账、数据AI分析、员工权限和系统设置等核心业务。

## 三仓架构

本项目采用前后端分仓部署：

| 仓库 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| pms-web | Next.js 16 (App Router) | 5000 | 前端项目（当前仓库） |
| pms-server | Hono + Node.js | 8080 | 后端API服务 |
| pms-ai | Hono + Node.js | 8081 | AI助手服务（LLM流式对话） |

- **前端**: 所有页面组件通过 `lib/api/client.ts` 中的API客户端与后端通信
- **代理**: Next.js rewrites 将 `/api/*` 代理到 pms-server，`/api/data-center*` 代理到 pms-ai
- **AI流式**: AI对话通过 `src/app/api/data-center/route.ts` SSE代理转发，避免Next.js rewrites缓冲
- **迁移友好**: 后端可独立替换（如PHP），前端无需修改，只需调整代理目标

## 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **Charts**: Recharts
- **Icons**: Lucide React
- **AI**: coze-coding-dev-sdk (doubao-seed-2-0-lite)

## 目录结构

```
├── src/
│   ├── app/
│   │   ├── dashboard/        # 工作台页面（KPI、待办、趋势）
│   │   ├── login/            # 登录页面（手机号+密码）
│   │   ├── brands/           # 品牌管理（重定向到/stores）
│   │   ├── stores/           # 门店管理（门店管理、房型管理、品牌管理）
│   │   ├── rooms/            # 房态管理（日房态、月房态）
│   │   ├── orders/           # 订单管理（全部订单、渠道待处理、新建订单）
│   │   ├── pricing/          # 价格管理（价格日历、基础房价、限时特价）
│   │   ├── channels/         # 渠道管理（渠道直连、评价管理）
│   │   ├── finance/          # 收支明细（收支总览、收支流水、对账提醒）
│   │   ├── data-center/      # AI助手（AI智能助手、AI收益助手、AI对话助手）
│   │   ├── api/data-center/  # SSE流式代理（转发pms-ai的SSE响应）
│   │   ├── customers/        # 客户管理（客户列表、客户标签、客户关怀）
│   │   ├── staff/            # 团队管理（员工管理、角色管理、操作日志）
│   │   └── settings/         # 系统设置（基础信息、业务参数、订阅管理、安全设置）
│   ├── components/
│   │   ├── layout/           # 布局组件（sidebar, header, app-layout）
│   │   ├── ui/               # shadcn/ui 组件库
│   │   ├── ai/chat-panel.tsx # AI对话面板组件
│   │   ├── stat-card.tsx     # KPI统计卡片
│   │   ├── tab-bar.tsx       # 页面标签栏
│   │   ├── status-badge.tsx  # 状态徽章
│   │   └── page-header.tsx   # 页面标题栏
│   └── lib/
│       ├── api/
│       │   ├── client.ts     # API客户端（前后端分离封装，Bearer token）
│       │   └── types.ts      # 全局类型定义
│       ├── auth/
│       │   ├── auth-context.tsx  # AuthProvider（login/logout/token持久化）
│       │   └── auth-guard.tsx    # AuthGuard（未登录重定向/login）
│       ├── ai/
│       │   ├── chat-client.ts    # AI流式对话客户端（streamChat）
│       │   └── types.ts          # AI类型定义
│       ├── hooks/
│       │   └── use-data.ts       # 通用数据加载hook
│       ├── utils/
│       │   ├── utils.ts          # 工具函数 (cn)
│       │   ├── validation.ts     # 表单校验工具
│       │   └── export.ts         # CSV导出工具
│       └── ...
```

## 构建和测试命令

```bash
# 安装依赖
pnpm install

# 开发环境启动（需先启动 pms-server 和 pms-ai）
coze dev

# 类型检查
pnpm ts-check

# 代码规范检查
pnpm lint:build

# 构建
coze build

# 生产环境启动
coze start
```

### 三服务启动

```bash
# 后端API服务
cd /workspace/projects/pms-server && nohup npx tsx src/server.ts > /app/work/logs/bypass/app.log 2>&1 &

# AI助手服务
cd /workspace/projects/pms-ai && nohup npx tsx src/server.ts > /app/work/logs/bypass/ai.log 2>&1 &

# 前端（依赖上面两个服务）
cd /workspace/projects && nohup coze dev > /app/work/logs/bypass/dev.log 2>&1 &
```

## 前后端分离架构

- **前端**: 所有页面组件通过 `lib/api/client.ts` 中的API客户端与后端通信
- **代理**: Next.js `rewrites` 将 `/api/:path*` 代理到 pms-server（默认 `http://localhost:8080`），`/api/data-center*` 代理到 pms-ai（默认 `http://localhost:8081`）
- **后端独立部署**: pms-server 运行在独立端口8080，pms-ai 运行在8081
- **操作日志**: pms-server 的 `opLogMiddleware` 自动记录所有 POST 写操作到 `pms_bui_op_logs` 表
- **登录鉴权**: JWT Bearer token，AuthContext + AuthGuard，演示账号 13800000001/admin123

### API接口清单

| 路径 | 方法 | 说明 | 查询参数 |
|------|------|------|----------|
| /api/auth/login | POST | 登录 | phone, password |
| /api/auth/me | GET | 当前用户 | - |
| /api/dashboard | GET | 工作台数据 | - |
| /api/brands | GET/POST/PUT/DELETE | 品牌管理 | - |
| /api/stores | GET/POST | 门店/房型/房间/设备 | type=roomTypes/rooms/devices/storeDetail&storeId= |
| /api/rooms | GET/POST/PUT | 日房态/月房态/预订 | type=daily/monthly/bookings&date=&year=&month= |
| /api/orders | GET/POST/PUT/DELETE | 订单管理 | type=list/stats/channel-pending/detail&id=&channel=&status=&keyword= |
| /api/pricing | GET/POST | 价格管理 | type=calendar/rules/channel-pricing/promotions/ai |
| /api/channels | GET/POST | 渠道/评价 | type=mappings/sync/inventory/reviews |
| /api/finance | GET | 收支/对账 | type=transactions/reconciliation/report |
| /api/data-center | GET/POST | AI助手 | type=dashboard/revenue/diagnosis（由pms-ai服务处理） |
| /api/customers | GET/POST | 客户/标签 | type=list/tags/stats/detail/care/auto-rules&id=&keyword=&tag=&level= |
| /api/staff | GET/POST/PUT/DELETE | 员工/角色 | type=roles/logs&module=&operator= |
| /api/settings | GET/POST | 系统设置 | type=subscription/basic/business/security |

## 编码规范

- TypeScript strict模式，禁止隐式any
- 函数参数和返回值必须标注类型
- 使用shadcn/ui组件和Tailwind CSS类名
- 前端通过API客户端获取数据，禁止直接操作数据源
- 使用 'use client' + useEffect/useState 处理客户端动态内容
- AI对话必须使用SSE流式输出（streamChat客户端 + API Route代理）
- 后端写操作自动通过opLogMiddleware记录操作日志
- 演示账号: phone=13800000001, password=admin123

## UI设计风格

- 主色调：翡翠绿 (emerald)
- 侧边栏：深色背景 + 白色文字
- 卡片布局为主，圆角阴影
- 状态徽章：绿色=正常、橙色=待处理、红色=异常、灰色=关闭
