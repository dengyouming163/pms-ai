# 酒店PMS系统 - 宝塔面板部署方案

## 架构总览

```
                    ┌──────────────┐
                    │   Nginx      │
                    │  (宝塔管理)  │
                    │  443/80      │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌──▼───────┐ ┌──▼───────┐
       │  pms-web    │ │pms-server│ │  pms-ai  │
       │  Next.js    │ │  Hono    │ │  Hono    │
       │  :5000      │ │  :8080   │ │  :8081   │
       └──────┬──────┘ └────┬─────┘ └────┬─────┘
              │              │            │
              │         ┌────▼────────────▼────┐
              │         │    PostgreSQL        │
              │         │    (宝塔管理)        │
              │         │    :5432             │
              │         └──────────────────────┘
              │
     所有服务通过 宝塔PM2管理器 守护运行
```

| 组件 | 管理方式 | 说明 |
|------|----------|------|
| Nginx | 宝塔「网站」 | 反向代理 + SSL |
| PostgreSQL | 宝塔「数据库」 | 可视化建库建用户 |
| Node.js | 宝塔「Node项目」或PM2管理器 | 运行三个服务 |
| PM2 | 宝塔「PM2管理器」插件 | 进程守护 + 日志 |

---

## 一、宝塔面板安装

如果服务器尚未安装宝塔：

```bash
# Ubuntu/Debian
wget -O install.sh https://download.bt.cn/install/install-ubuntu_6.0.sh && sudo bash install.sh ed8484bec

# CentOS
yum install -y wget && wget -O install.sh https://download.bt.cn/install/install_6.0.sh && sh install.sh ed8484bec
```

安装完成后会输出面板访问地址、用户名和密码，登录宝塔面板。

---

## 二、宝塔安装运行环境

### 2.1 安装 Nginx

宝塔面板 → **软件商店** → 搜索 **Nginx** → 安装（推荐 1.24+）

### 2.2 安装 PostgreSQL

宝塔面板 → **软件商店** → 搜索 **PostgreSQL** → 安装（推荐 15+）

> 如果软件商店没有 PostgreSQL，可通过终端安装：
> ```bash
> sudo apt install -y postgresql postgresql-contrib
> sudo systemctl enable postgresql
> ```

### 2.3 安装 Node.js 版本管理器

宝塔面板 → **软件商店** → 搜索 **Node.js版本管理器** → 安装

安装后进入 Node.js 版本管理器 → 安装 **Node.js 24.x**

### 2.4 安装 PM2 管理器

宝塔面板 → **软件商店** → 搜索 **PM2管理器** → 安装

安装后通过终端确认：

```bash
pnpm -v 2>/dev/null || sudo npm install -g pnpm
pm2 -v
```

---

## 三、创建数据库

### 方式一：宝塔面板操作（推荐）

1. 宝塔面板 → **数据库** → 选择 **PostgreSQL**
2. 点击 **添加数据库**
   - 数据库名：`pms_hotel`
   - 用户名：`pms_admin`
   - 密码：自动生成或自定义强密码
   - 访问权限：**本地服务器**（安全起见不要选所有人）
3. 点击 **提交**

### 方式二：终端操作

```bash
sudo -u postgres psql

CREATE USER pms_admin WITH PASSWORD '你的强密码';
CREATE DATABASE pms_hotel OWNER pms_admin ENCODING 'UTF8';
GRANT ALL PRIVILEGES ON DATABASE pms_hotel TO pms_admin;
\q
```

---

## 四、上传项目代码

### 方式一：宝塔文件管理器上传

1. 宝塔面板 → **文件** → 进入 `/opt/pms`（如不存在则新建）
2. 在开发机上打包项目（排除 node_modules）：

```bash
# 开发机上执行
cd /workspace/projects

# 打包前端（Tailwind CSS 4 无需 tailwind.config.ts）
tar czf pms-web.tar.gz \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=dist \
  src/ public/ scripts/ \
  package.json pnpm-lock.yaml \
  next.config.ts tsconfig.json next-env.d.ts \
  postcss.config.mjs components.json eslint.config.mjs \
  .coze

# 打包后端
tar czf pms-server.tar.gz \
  --exclude=node_modules \
  pms-server/

# 打包AI服务
tar czf pms-ai.tar.gz \
  --exclude=node_modules \
  pms-ai/
```

3. 通过宝塔文件管理器上传三个压缩包到 `/opt/pms/`
4. 在宝塔终端解压：

```bash
cd /opt/pms
tar xzf pms-web.tar.gz
tar xzf pms-server.tar.gz
tar xzf pms-ai.tar.gz
```

### 方式二：Git 拉取

1. 宝塔终端中执行：

```bash
mkdir -p /opt/pms
cd /opt/pms

# 替换为你的实际仓库地址
git clone https://your-git-repo/pms-web.git
git clone https://your-git-repo/pms-server.git
git clone https://your-git-repo/pms-ai.git
```

> 如果仓库需要认证，宝塔终端会提示输入用户名密码。

---

## 五、安装依赖与初始化

### 5.1 安装依赖

宝塔终端执行：

```bash
cd /opt/pms/pms-web && pnpm install --frozen-lockfile
cd /opt/pms/pms-server && pnpm install --frozen-lockfile
cd /opt/pms/pms-ai && pnpm install --frozen-lockfile
```

### 5.2 数据库迁移

```bash
cd /opt/pms/pms-server

# 设置连接串
export DATABASE_URL="postgresql://pms_admin:你的数据库密码@127.0.0.1:5432/pms_hotel?sslmode=disable"

# 推送 schema 到数据库（自动创建25张表）
npx drizzle-kit push
```

### 5.3 填充种子数据

```bash
cd /opt/pms/pms-server

export PG_HOST=127.0.0.1
export PG_PORT=5432
export PG_DATABASE=pms_hotel
export PG_USER=pms_admin
export PG_PASSWORD=你的数据库密码

npx tsx src/db/seed.ts

# 确认表已创建（应该有25张 pms_bui_* 表）
psql -h 127.0.0.1 -U pms_admin -d pms_hotel -c "\dt pms_bui_*"
```

---

## 六、构建项目

### 6.1 构建前端（必须）

pms-web 基于 Next.js，必须预构建页面和 API Route：

```bash
cd /opt/pms/pms-web

# 构建 Next.js
pnpm next build

# 打包自定义 server.ts
pnpm tsup src/server.ts \
  --format cjs \
  --platform node \
  --target node20 \
  --outDir dist \
  --no-splitting \
  --no-minify

# 确认产物
ls -la dist/server.js .next/
```

### 6.2 构建后端（必须）

PM2 不能直接执行 `node_modules/.bin/tsx` 或 `npx`（它们是 shell 脚本，PM2 会报 SyntaxError），
必须先用 tsup 打包为 JS：

```bash
# pms-server 打包
cd /opt/pms/pms-server
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting

# pms-ai 打包
cd /opt/pms/pms-ai
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting

# 确认产物
ls -la /opt/pms/pms-server/dist/server.js
ls -la /opt/pms/pms-ai/dist/server.js
```

打包后 PM2 启动文件为 `dist/server.js`，无需 tsx 运行时依赖，冷启动也更快。

---

## 七、配置环境变量

### 7.1 pms-server

```bash
cat > /opt/pms/pms-server/.env << 'EOF'
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=pms_hotel
PG_USER=pms_admin
PG_PASSWORD=你的数据库密码

JWT_SECRET=你的JWT密钥
EOF
```

### 7.2 pms-ai

```bash
cat > /opt/pms/pms-ai/.env << 'EOF'
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=pms_hotel
PG_USER=pms_admin
PG_PASSWORD=你的数据库密码

PMS_AI_PORT=8081

# 豆包大模型 API 配置（必填，否则 AI 对话功能不可用）
COZE_WORKLOAD_IDENTITY_API_KEY=你的API密钥
COZE_INTEGRATION_BASE_URL=https://api.coze.com
COZE_INTEGRATION_MODEL_BASE_URL=https://model.coze.com
# 中国大陆服务器建议使用 .cn 域名加速：
# COZE_INTEGRATION_BASE_URL=https://api.coze.cn
# COZE_INTEGRATION_MODEL_BASE_URL=https://model.coze.cn
EOF
```

### 7.3 pms-web

```bash
cat > /opt/pms/pms-web/.env << 'EOF'
COZE_PROJECT_ENV=PROD
PORT=5000
PMS_SERVER_URL=http://127.0.0.1:8080
PMS_AI_URL=http://127.0.0.1:8081
EOF
```

### 7.4 生成 JWT 密钥

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# 复制输出替换上面的 "你的JWT密钥"
```

### 7.5 限制文件权限

```bash
chmod 600 /opt/pms/pms-server/.env
chmod 600 /opt/pms/pms-ai/.env
chmod 600 /opt/pms/pms-web/.env
```

---

## 八、启动服务（PM2）

### 方式一：宝塔 PM2 管理器（图形界面）

1. 宝塔面板 → **软件商店** → **PM2管理器** → **设置**
2. 点击 **添加项目**，分别添加三个服务：

**项目1：pms-web**
| 配置项 | 值 |
|--------|-----|
| 项目名称 | pms-web |
| 启动文件 | /opt/pms/pms-web/dist/server.js |
| 运行目录 | /opt/pms/pms-web |
| 环境变量 | 见下方 |

环境变量（每行一个，格式 `KEY=VALUE`）：
```
COZE_PROJECT_ENV=PROD
PORT=5000
PMS_SERVER_URL=http://127.0.0.1:8080
PMS_AI_URL=http://127.0.0.1:8081
```

**项目2：pms-server**
| 配置项 | 值 |
|--------|-----|
| 项目名称 | pms-server |
| 启动文件 | /opt/pms/pms-server/dist/server.js |
| 运行目录 | /opt/pms/pms-server |
| 环境变量 | 见下方 |

> **注意**：pms-server 需要先构建，见下方"后端构建"说明。

环境变量：
```
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=pms_hotel
PG_USER=pms_admin
PG_PASSWORD=你的数据库密码
JWT_SECRET=你的JWT密钥
```

**项目3：pms-ai**
| 配置项 | 值 |
|--------|-----|
| 项目名称 | pms-ai |
| 启动文件 | /opt/pms/pms-ai/dist/server.js |
| 运行目录 | /opt/pms/pms-ai |
| 环境变量 | 见下方 |

环境变量：
```
PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=pms_hotel
PG_USER=pms_admin
PG_PASSWORD=你的数据库密码
PMS_AI_PORT=8081

# 豆包大模型 API 配置（必填，否则 AI 对话功能不可用）
COZE_WORKLOAD_IDENTITY_API_KEY=你的API密钥
COZE_INTEGRATION_BASE_URL=https://api.coze.com
COZE_INTEGRATION_MODEL_BASE_URL=https://model.coze.com
```

3. 依次启动三个项目，确认状态均为 **online**

### 方式二：终端 PM2 命令（更灵活）

```bash
# 先构建后端（PM2 不能直接执行 .bin/tsx shell脚本，需先打包为 JS）
cd /opt/pms/pms-server && npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting
cd /opt/pms/pms-ai && npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting

cat > /opt/pms/ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [
    {
      name: 'pms-web',
      cwd: '/opt/pms/pms-web',
      script: 'dist/server.js',
      env: {
        COZE_PROJECT_ENV: 'PROD',
        PORT: '5000',
        PMS_SERVER_URL: 'http://127.0.0.1:8080',
        PMS_AI_URL: 'http://127.0.0.1:8081',
      },
      autorestart: true,
      max_memory_restart: '512M',
      error_file: '/var/log/pms/pms-web-error.log',
      out_file: '/var/log/pms/pms-web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'pms-server',
      cwd: '/opt/pms/pms-server',
      script: 'dist/server.js',
      env: {
        PG_HOST: '127.0.0.1',
        PG_PORT: '5432',
        PG_DATABASE: 'pms_hotel',
        PG_USER: 'pms_admin',
        PG_PASSWORD: '你的数据库密码',
        JWT_SECRET: '你的JWT密钥',
      },
      autorestart: true,
      max_memory_restart: '256M',
      error_file: '/var/log/pms/pms-server-error.log',
      out_file: '/var/log/pms/pms-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'pms-ai',
      cwd: '/opt/pms/pms-ai',
      script: 'dist/server.cjs',
      env: {
        PG_HOST: '127.0.0.1',
        PG_PORT: '5432',
        PG_DATABASE: 'pms_hotel',
        PG_USER: 'pms_admin',
        PG_PASSWORD: '你的数据库密码',
        PMS_AI_PORT: '8081',
        COZE_WORKLOAD_IDENTITY_API_KEY: '你的API密钥',
        COZE_INTEGRATION_BASE_URL: 'https://api.coze.com',
        COZE_INTEGRATION_MODEL_BASE_URL: 'https://model.coze.com',
      },
      autorestart: true,
      max_memory_restart: '256M',
      error_file: '/var/log/pms/pms-ai-error.log',
      out_file: '/var/log/pms/pms-ai-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
EOF

# 创建日志目录
sudo mkdir -p /var/log/pms
sudo chown $(whoami) /var/log/pms

# 启动
cd /opt/pms && pm2 start ecosystem.config.cjs

# 保存进程列表（开机自启）
pm2 save
pm2 startup
# 按照输出命令执行
```

### 验证服务

```bash
# pms-server
curl -s http://127.0.0.1:8080/api/auth/me

# pms-ai
curl -s http://127.0.0.1:8081/health
# 预期: {"status":"ok","service":"pms-ai"}

# pms-web
curl -I -s http://127.0.0.1:5000 | head -3
# 预期: HTTP/1.1 200 OK

# 登录测试
curl -s -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800000001","password":"admin123"}'
# 预期: {"success":true,"data":{"token":"eyJ..."}}
```

---

## 九、宝塔配置 Nginx 反向代理

### 9.1 添加站点

1. 宝塔面板 → **网站** → **添加站点**
   - 域名：填写你的域名（如 `pms.yourdomain.com`）或服务器IP
   - 根目录：默认即可（会被反向代理覆盖，不影响）
   - PHP版本：选 **纯静态**
   - 点击 **提交**

2. 点击刚创建的站点 → **设置**

### 9.2 配置反向代理

1. 站点设置 → **反向代理** → **添加反向代理**
   - 代理名称：`pms-web`
   - 目标URL：`http://127.0.0.1:5000`
   - 发送域名：`$host`
   - 点击 **提交**

2. 点击刚添加的反向代理的 **配置文件**，替换为以下内容：

```nginx
#PROXY-START/
location / {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket 支持
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}

# AI 对话流式接口 - 禁用缓冲确保打字机效果
location /api/data-center {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE 关键：禁用缓冲
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection '';
    chunked_transfer_encoding on;

    # AI 响应较慢，延长超时
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
}

# Next.js 静态资源 - 长缓存
location /_next/static/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    expires 365d;
    add_header Cache-Control "public, immutable";
}
#PROXY-END/
```

3. 点击 **保存**

### 9.3 配置 SSL 证书

**方式一：宝塔 Let's Encrypt（推荐，免费）**

1. 站点设置 → **SSL** → **Let's Encrypt**
2. 勾选域名 → 点击 **申请**
3. 开启 **强制HTTPS**

**方式二：宝塔其他证书**

1. 站点设置 → **SSL** → **其他证书**
2. 粘贴证书内容（key + pem）→ 点击 **保存**
3. 开启 **强制HTTPS**

**方式三：自签名（测试/内网）**

1. 站点设置 → **SSL** → **自签名证书**
2. 填写信息 → 点击 **生成**

---

## 十、宝塔防火墙配置

1. 宝塔面板 → **安全**
2. 放行端口：
   - **80** - HTTP
   - **443** - HTTPS
   - **22** - SSH（默认已放行）
3. 确认以下端口**未放行**（仅内网通信）：
   - 5000（pms-web）
   - 8080（pms-server）
   - 8081（pms-ai）
   - 5432（PostgreSQL）

---

## 十一、启用 AI 能力（重要）

AI 助手功能（智能对话、AI定价建议等）依赖豆包大模型，需要配置 API 密钥才能使用。

> **未配置时的报错**：`OpenAIError: Missing credentials. Please pass an apiKey...`
> AI 对话返回：`"抱歉，AI服务暂时不可用，请稍后重试"`

### 11.1 获取 API 密钥

1. 访问 [火山引擎控制台](https://console.volcengine.com/ark) 并注册/登录
2. 开通 **方舟 (ARK)** 服务（按量计费，豆包模型价格极低）
3. 创建 **接入点 (Endpoint)**：
   - 模型选择：`doubao-seed-2-0-lite`（与项目默认模型一致）
   - 创建后获得接入点 ID（格式如 `ep-xxxxxxxxxx-xxxxx`）
4. 获取 **API Key**：
   - 左侧菜单 → **API Key管理** → **创建新的 API Key**
   - 复制保存（仅显示一次）

### 11.2 配置环境变量

**方式一：在 ecosystem.config.cjs 中配置（推荐）**

编辑 `/opt/pms/ecosystem.config.cjs`，找到 pms-ai 部分，填入以下三个环境变量：

```javascript
{
  name: 'pms-ai',
  cwd: '/opt/pms/pms-ai',
  script: 'dist/server.js',
  env: {
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'pms_hotel',
    PG_USER: 'pms_admin',
    PG_PASSWORD: '你的数据库密码',
    PMS_AI_PORT: '8081',
    // ====== 以下三项是 AI 密钥配置（必填） ======
    COZE_WORKLOAD_IDENTITY_API_KEY: '在这里填入你的API密钥',
    COZE_INTEGRATION_BASE_URL: 'https://api.coze.cn',
    COZE_INTEGRATION_MODEL_BASE_URL: 'https://model.coze.cn',
  },
  // ... 其他配置不变
},
```

> **域名选择**：
> - 中国大陆服务器 → 用 `api.coze.cn` / `model.coze.cn`（访问更快更稳定）
> - 海外服务器 → 用 `api.coze.com` / `model.coze.com`

**方式二：在 .env 文件中配置**

如果 pms-ai 不通过 ecosystem 启动，可以编辑 `.env` 文件：

```bash
vi /www/wwwroot/pms/pms-ai/.env
```

添加以下内容：

```env
# 豆包大模型 API 配置（必填）
COZE_WORKLOAD_IDENTITY_API_KEY=你的API密钥
COZE_INTEGRATION_BASE_URL=https://api.coze.cn
COZE_INTEGRATION_MODEL_BASE_URL=https://model.coze.cn
```

### 11.3 重启 AI 服务

```bash
# 如果用 ecosystem 启动
pm2 restart pms-ai

# 如果修改了 ecosystem.config.cjs，需要重新加载配置
pm2 delete pms-ai
cd /opt/pms && pm2 start ecosystem.config.cjs --only pms-ai
pm2 save
```

### 11.4 验证 AI 功能

```bash
# 1. 查看启动日志，确认无报错
pm2 logs pms-ai --lines 5

# 2. 测试 AI 对话（需替换为有效 token）
curl -s -X POST http://127.0.0.1:8081/api/data-center \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好","sessionType":"general"}'
# 预期: 返回流式文本（SSE格式），不再是"Missing credentials"报错
```

在浏览器中访问 AI 助手页面，发送消息验证对话功能。

### 11.5 不启用 AI 的影响

如果不配置 API 密钥，以下功能将不可用：
- **AI 智能对话** — 发送消息后显示"抱歉，AI服务暂时不可用"
- **AI 收益助手** — 对话功能不可用（数据面板正常）
- **AI 定价建议** — 建议列表可正常查看，但无法生成新建议

以下功能**不受影响**，无需 AI 密钥即可使用：
- 工作台 / 门店管理 / 房态管理 / 订单管理
- 价格管理（基础房价、价格日历、限时特价）
- 渠道管理 / 收支管理 / 客户管理 / 团队管理 / 系统设置

---

## 十二、日常运维

### 查看服务状态

- 宝塔面板 → **软件商店** → **PM2管理器** → 可视化查看三个服务运行状态、CPU、内存

### 查看日志

- PM2管理器 → 点击服务名 → **日志** 实时查看
- 或宝塔面板 → **文件** → `/var/log/pms/` 目录查看日志文件

### 更新部署

```bash
# 拉取代码
cd /opt/pms/pms-web && git pull origin main
cd /opt/pms/pms-server && git pull origin main
cd /opt/pms/pms-ai && git pull origin main

# 更新依赖
cd /opt/pms/pms-web && pnpm install --frozen-lockfile
cd /opt/pms/pms-server && pnpm install --frozen-lockfile
cd /opt/pms/pms-ai && pnpm install --frozen-lockfile

# 重新构建前端
cd /opt/pms/pms-web
pnpm next build
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

# 重启（宝塔PM2管理器中点击重启，或终端执行）
pm2 restart all

# 如有数据库变更
cd /opt/pms/pms-server
export DATABASE_URL="postgresql://pms_admin:你的密码@127.0.0.1:5432/pms_hotel?sslmode=disable"
npx drizzle-kit push
```

### 数据库备份

**方式一：宝塔计划任务（推荐）**

1. 宝塔面板 → **计划任务**
2. 添加任务：
   - 任务类型：**Shell脚本**
   - 任务名称：`PMS数据库备份`
   - 执行周期：**每天** 凌晨 3:00
   - 脚本内容：

```bash
#!/bin/bash
BACKUP_DIR="/opt/pms/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

pg_dump -h 127.0.0.1 -U pms_admin -d pms_hotel \
  --format=custom \
  --file="$BACKUP_DIR/pms_hotel_$DATE.dump"

# 保留最近30天
find $BACKUP_DIR -name "*.dump" -mtime +30 -delete

echo "[$DATE] Backup completed"
```

**方式二：宝塔数据库备份**

1. 宝塔面板 → **数据库** → PostgreSQL → 点击数据库名旁的 **备份** 按钮
2. 可设置定时备份

### 数据库恢复

```bash
# 从备份恢复
pg_restore -h 127.0.0.1 -U pms_admin -d pms_hotel \
  --clean --if-exists \
  /opt/pms/backups/pms_hotel_20250101_030000.dump
```

---

## 十二、宝塔部署检查清单

### 部署前

- [ ] 宝塔面板已安装 Nginx、PostgreSQL、Node.js 24、PM2管理器
- [ ] PostgreSQL 数据库 `pms_hotel` 已创建
- [ ] 三个项目代码已上传到 `/opt/pms/`
- [ ] 依赖已安装（pnpm install）
- [ ] 数据库 schema 已推送（drizzle-kit push）
- [ ] 种子数据已填充（seed.ts）
- [ ] 前端已构建（next build + tsup）

### 安全检查

- [ ] **JWT_SECRET** 已替换为随机强密钥（勿用默认值）
- [ ] **PG_PASSWORD** 已替换为强密码
- [ ] `.env` 文件权限为 600
- [ ] `.env` 未提交到 Git
- [ ] 5000/8080/8081/5432 端口未在宝塔防火墙中放行
- [ ] SSL 证书已配置并开启强制 HTTPS
- [ ] 已修改演示账号密码

### 验证服务

- [ ] PM2 三个服务状态均为 **online**
- [ ] `curl http://127.0.0.1:8080/api/auth/me` 返回 JSON
- [ ] `curl http://127.0.0.1:8081/health` 返回 `{"status":"ok"}`
- [ ] `curl -I http://127.0.0.1:5000` 返回 200
- [ ] 浏览器访问域名/SSL 正常显示登录页
- [ ] 能正常登录（13800000001 / admin123）
- [ ] AI 助手对话有打字机效果

---

## 十三、常见问题

### Q1: PM2管理器中 pms-server/pms-ai 启动失败

**原因**：宝塔PM2管理器添加项目时，启动文件路径可能不对。

**解决**：使用终端方式启动更可靠：
```bash
cd /opt/pms && pm2 start ecosystem.config.cjs
```
启动后宝塔 PM2 管理器会自动识别并展示这些进程。

### Q2: pnpm 命令找不到

```bash
# 全局安装 pnpm
npm install -g pnpm

# 如果宝塔 Node.js 版本管理器切换了版本，需重新安装
pnpm -v || npm install -g pnpm
```

### Q3: drizzle-kit push 报连接失败

```bash
# 检查 PostgreSQL 是否运行
sudo systemctl status postgresql

# 检查连接
psql -h 127.0.0.1 -U pms_admin -d pms_hotel -c "SELECT 1;"

# 确认 DATABASE_URL 格式正确
echo $DATABASE_URL
# 应为: postgresql://pms_admin:密码@127.0.0.1:5432/pms_hotel?sslmode=disable
```

### Q4: Nginx 反向代理后页面样式错乱

确认反向代理配置中 `proxy_set_header Host $host;` 已设置，且 Nginx 没有缓存静态资源导致版本不一致。可在浏览器中 Ctrl+Shift+R 强制刷新。

### Q5: AI 对话无流式效果（一次性输出）

确认 Nginx 中 `/api/data-center` location 配置了 `proxy_buffering off;`，这是 SSE 流式输出的关键配置。修改后需重载 Nginx：

```bash
sudo nginx -t && sudo systemctl reload nginx
# 或在宝塔：软件商店 → Nginx → 重载配置
```

### Q6: 宝塔面板 Node.js 版本管理器安装的 Node 在终端找不到

宝塔的 Node 版本管理器安装的 Node 可能不在系统 PATH 中。解决方法：

```bash
# 查找宝塔安装的 node 路径
find /www/server -name "node" -type f 2>/dev/null

# 创建软链接（替换实际路径）
sudo ln -sf /www/server/nodejs/v24.x/bin/node /usr/local/bin/node
sudo ln -sf /www/server/nodejs/v24.x/bin/npm /usr/local/bin/npm
sudo ln -sf /www/server/nodejs/v24.x/bin/npx /usr/local/bin/npx

# 或直接用宝塔终端（PATH 已自动配置）
```

### Q7: PostgreSQL 宝塔未提供管理入口

部分宝塔版本不内置 PostgreSQL 管理，可使用终端操作：

```bash
# 切换 postgres 用户操作
sudo -u postgres psql

# 或直接带密码连接
psql -h 127.0.0.1 -U pms_admin -d pms_hotel
```

也可安装 **phpPgAdmin** 或使用 **DBeaver** 等远程管理工具连接。
