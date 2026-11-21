# pms-mobile — 员工移动端

UniApp 3.0 + Vue 3.4 + Pinia + TDesign Mobile，目标平台 H5 + 微信小程序。

## 目录结构

```
pms-mobile/src/
├── pages/                  # 页面（UniApp 约定式路由）
│   ├── index/              # 首页仪表盘（统计卡片 + 快捷操作 + 房态概览 + 最近订单）
│   ├── rooms/              # 房态管理
│   ├── orders/             # 订单管理
│   ├── ai/                 # AI 对话助手
│   └── user/               # 个人中心
├── components/             # 业务组件
│   ├── StatCard.vue        # 统计卡片
│   ├── OrderCard.vue       # 订单卡片
│   ├── RoomCard.vue        # 房间卡片
│   ├── PriceCard.vue       # 价格卡片
│   ├── AIChat.vue          # AI 聊天
│   └── VoiceInput.vue      # 语音输入
├── api/
│   ├── request.ts          # 请求封装（自动注入 token + storeId）
│   └── modules/            # 按业务域拆分（auth/orders/rooms/ai/dashboard）
├── stores/                 # Pinia stores（auth 等）
├── composables/            # 组合式函数（useOCR 等）
├── config/                 # 环境配置（BASE_URL / PMS_SERVER_URL / PMS_AI_URL）
└── types/                  # TypeScript 类型定义
```

## 关键约定

- 所有 .vue 文件使用 `<script setup lang="ts">`，状态管理走 Pinia
- API 请求**必须**通过 `@/api/request.ts` 封装的 `get`/`post`/`put`/`del` 方法
- 认证：`uni.getStorageSync('token')` 获取 JWT，请求时自动注入 `Authorization` header
- storeId 自动注入（GET → query params，POST/PUT → body）
- 组件库用 TDesign Mobile（`@tdesign/uniapp`），easycom 自动导入 `t-*` 组件，**不要**引入 Vant 或 NutUI
- H5 开发：`npm run dev:h5`，微信小程序：`npm run dev:mp-weixin`
- 参考根目录 `CLAUDE.md` 和 `.claude/constitution.md` 的通用约束
