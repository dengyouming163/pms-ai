# 酒店PMS系统 - 自有服务器部署方案

## 架构总览

```
                    ┌──────────────┐
                    │   Nginx      │
                    │  (443/80)    │
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
              │         │    :5432             │
              │         └──────────────────────┘
              │
     API /api/* → proxy to :8080
     API /api/data-center* → proxy to :8081
     (SSE流式通过API Route逐块转发)
```

| 服务 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| pms-web | Next.js 16 (App Router) | 5000 | 前端 + API代理 |
| pms-server | Hono + Node.js | 8080 | 业务API服务 |
| pms-ai | Hono + Node.js + coze-coding-dev-sdk | 8081 | AI对话服务 |
| PostgreSQL | 15+ | 5432 | 数据库(25张表) |
| Nginx | 1.24+ | 80/443 | 反向代理 + SSL |

---

## 一、服务器环境要求

### 最低配置

| 项目 | 要求 |
|------|------|
| CPU | 2核 |
| 内存 | 4GB |
| 磁盘 | 40GB SSD |
| 带宽 | 5Mbps |
| 操作系统 | Ubuntu 22.04 / CentOS 8+ / Debian 12 |

### 推荐配置（生产环境）

| 项目 | 要求 |
|------|------|
| CPU | 4核 |
| 内存 | 8GB |
| 磁盘 | 100GB SSD |
| 带宽 | 10Mbps |

---

## 二、基础环境安装

### 2.1 系统更新

```bash
# Ubuntu/Debian
sudo apt update && sudo apt upgrade -y

# CentOS
sudo yum update -y
```

### 2.2 安装 Node.js 24

```bash
# 使用 nvm 安装（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
nvm use 24
node -v  # 确认 v24.x

# 或使用 NodeSource APT 源
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2.3 安装 pnpm

```bash
sudo npm install -g pnpm
pnpm -v  # 确认 9.x+
```

### 2.4 安装 PostgreSQL

```bash
# Ubuntu/Debian
sudo apt install -y postgresql postgresql-contrib

# CentOS
sudo yum install -y postgresql-server postgresql-contrib
sudo postgresql-setup initdb

# 启动并设置开机自启
sudo systemctl enable postgresql
sudo systemctl start postgresql
```

### 2.5 安装 Nginx

```bash
# Ubuntu/Debian
sudo apt install -y nginx

# CentOS
sudo yum install -y nginx

# 启动并设置开机自启
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 2.6 安装 PM2

```bash
sudo npm install -g pm2
pm2 -v
```

---

## 三、数据库配置

### 3.1 创建数据库和用户

```bash
# 切换到 postgres 用户
sudo -u postgres psql

# 在 psql 中执行：
CREATE USER pms_admin WITH PASSWORD '你的强密码_替换此处';
CREATE DATABASE pms_hotel OWNER pms_admin ENCODING 'UTF8';
GRANT ALL PRIVILEGES ON DATABASE pms_hotel TO pms_admin;

# 退出
\q
```

### 3.2 配置 PostgreSQL 远程访问（如数据库与应用不在同一台服务器）

```bash
# 编辑 pg_hba.conf
sudo vim /etc/postgresql/15/main/pg_hba.conf

# 添加（替换为应用服务器IP）：
# host  pms_hotel  pms_admin  应用服务器IP/32  md5

# 编辑 postgresql.conf
sudo vim /etc/postgresql/15/main/postgresql.conf

# 修改监听地址：
# listen_addresses = 'localhost,应用服务器内网IP'

# 重启
sudo systemctl restart postgresql
```

### 3.3 防火墙放行（仅数据库独立部署时需要）

```bash
# Ubuntu UFW
sudo ufw allow 5432/tcp

# CentOS firewalld
sudo firewall-cmd --permanent --add-port=5432/tcp
sudo firewall-cmd --reload
```

---

## 四、项目代码部署

### 4.1 创建部署目录

```bash
sudo mkdir -p /opt/pms
sudo chown $USER:$USER /opt/pms
```

### 4.2 上传代码

**方式一：Git 拉取（推荐）**

```bash
cd /opt/pms

# 拉取三个仓库（替换为你的实际仓库地址）
git clone https://your-git-repo/pms-web.git
git clone https://your-git-repo/pms-server.git
git clone https://your-git-repo/pms-ai.git
```

**方式二：压缩包上传**

```bash
# 在开发机上打包（排除 node_modules）
cd /workspace/projects

# 打包前端
tar czf pms-web.tar.gz \
  --exclude=node_modules --exclude=.next --exclude=dist \
  src/ public/ scripts/ \
  package.json pnpm-lock.yaml \
  next.config.ts tsconfig.json next-env.d.ts \
  postcss.config.mjs components.json eslint.config.mjs \
  .coze

# 打包后端
tar czf pms-server.tar.gz --exclude=node_modules pms-server

# 打包AI服务
tar czf pms-ai.tar.gz --exclude=node_modules pms-ai

# 上传到服务器
scp pms-*.tar.gz user@your-server:/opt/pms/

# 在服务器上解压
cd /opt/pms
tar xzf pms-web.tar.gz
tar xzf pms-server.tar.gz
tar xzf pms-ai.tar.gz
```

### 4.3 安装依赖

```bash
# pms-web
cd /opt/pms/pms-web
pnpm install --frozen-lockfile

# pms-server
cd /opt/pms/pms-server
pnpm install --frozen-lockfile

# pms-ai
cd /opt/pms/pms-ai
pnpm install --frozen-lockfile
```

---

## 五、数据库初始化

### 5.1 执行 Schema Migration

```bash
cd /opt/pms/pms-server

# 设置数据库连接环境变量
export DATABASE_URL="postgresql://pms_admin:你的强密码@localhost:5432/pms_hotel?sslmode=disable"

# 方式一：使用 drizzle-kit push（推荐，直接推送 schema 到数据库）
npx drizzle-kit push

# 方式二：使用 migration SQL 文件
# psql -h localhost -U pms_admin -d pms_hotel -f drizzle/0000_next_steel_serpent.sql
```

### 5.2 填充种子数据

```bash
cd /opt/pms/pms-server

# 设置环境变量（seed.ts 引用 db/index.ts 读取 PG_* 变量）
export PG_HOST=localhost
export PG_PORT=5432
export PG_DATABASE=pms_hotel
export PG_USER=pms_admin
export PG_PASSWORD=你的强密码

# 执行 seed
npx tsx src/db/seed.ts

# 确认数据
psql -h localhost -U pms_admin -d pms_hotel -c "\dt pms_bui_*"
```

---

## 六、环境变量配置

### 6.1 创建环境变量文件

```bash
# pms-server 环境变量
cat > /opt/pms/pms-server/.env << 'EOF'
# 数据库连接
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=pms_hotel
PG_USER=pms_admin
PG_PASSWORD=你的强密码_替换此处

# JWT密钥（务必替换为随机强密钥）
JWT_SECRET=你的JWT密钥_替换此处_建议32位以上随机字符串

# 服务端口
PORT=8080
EOF

# pms-ai 环境变量
cat > /opt/pms/pms-ai/.env << 'EOF'
# 数据库连接
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=pms_hotel
PG_USER=pms_admin
PG_PASSWORD=你的强密码_替换此处

# 服务端口
PMS_AI_PORT=8081

# 豆包大模型 API 配置（必填，否则 AI 对话功能不可用）
COZE_WORKLOAD_IDENTITY_API_KEY=你的API密钥
COZE_INTEGRATION_BASE_URL=https://api.coze.com
COZE_INTEGRATION_MODEL_BASE_URL=https://model.coze.com
# 中国大陆服务器建议使用 .cn 域名加速：
# COZE_INTEGRATION_BASE_URL=https://api.coze.cn
# COZE_INTEGRATION_MODEL_BASE_URL=https://model.coze.cn
EOF

# pms-web 环境变量
cat > /opt/pms/pms-web/.env << 'EOF'
# 生产环境标识
COZE_PROJECT_ENV=PROD

# 后端服务地址（内网通信，使用localhost即可）
PMS_SERVER_URL=http://localhost:8080
PMS_AI_URL=http://localhost:8081

# 服务端口
PORT=5000
EOF
```

### 6.2 生成强密钥

```bash
# 生成 JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# 将输出复制到 .env 文件的 JWT_SECRET 值
```

### 6.3 环境变量安全

```bash
# 限制 .env 文件权限
chmod 600 /opt/pms/pms-server/.env
chmod 600 /opt/pms/pms-ai/.env
chmod 600 /opt/pms/pms-web/.env
```

> **重要**：确保 `.env` 文件已加入 `.gitignore`，不要提交到代码仓库。

---

## 七、构建与启动

### 7.1 构建 pms-web

```bash
cd /opt/pms/pms-web

# 构建 Next.js
pnpm next build

# 打包自定义 server.ts
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify
```

### 7.2 构建后端（PM2 部署必须）

PM2 不能直接执行 `node_modules/.bin/tsx` 或 `npx`（它们是 shell 脚本），必须先用 tsup 打包为 JS：

```bash
# pms-server
cd /opt/pms/pms-server
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting

# pms-ai
cd /opt/pms/pms-ai
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting
```

打包后 PM2 启动文件：pms-web/pms-server 为 `dist/server.js`，pms-ai 为 `dist/server.cjs`（因 package.json 含 `"type":"module"`）。

### 7.3 使用 PM2 管理进程

> **重要**：PM2 不能直接执行 `node_modules/.bin/tsx` 或 `npx`，因为它们是 shell 脚本而非 JS 文件。
> 后端服务必须先用 tsup 打包为 JS，再由 PM2 执行。

```bash
# 先构建后端
cd /opt/pms/pms-server && npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting
cd /opt/pms/pms-ai && npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting
```

创建 PM2 配置文件：

```bash
cat > /opt/pms/ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [
    {
      name: 'pms-web',
      cwd: '/opt/pms/pms-web',
      script: 'dist/server.js',
      env: {
        COZE_PROJECT_ENV: 'PROD',
        PORT: 5000,
        PMS_SERVER_URL: 'http://localhost:8080',
        PMS_AI_URL: 'http://localhost:8081',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      error_file: '/var/log/pms/pms-web-error.log',
      out_file: '/var/log/pms/pms-web-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'pms-server',
      cwd: '/opt/pms/pms-server',
      script: 'dist/server.js',
      env: {
        PG_HOST: 'localhost',
        PG_PORT: '5432',
        PG_DATABASE: 'pms_hotel',
        PG_USER: 'pms_admin',
        PG_PASSWORD: '你的强密码_替换此处',
        JWT_SECRET: '你的JWT密钥_替换此处',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      error_file: '/var/log/pms/pms-server-error.log',
      out_file: '/var/log/pms/pms-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'pms-ai',
      cwd: '/opt/pms/pms-ai',
      script: 'dist/server.cjs',
      env: {
        PG_HOST: 'localhost',
        PG_PORT: '5432',
        PG_DATABASE: 'pms_hotel',
        PG_USER: 'pms_admin',
        PG_PASSWORD: '你的强密码_替换此处',
        PMS_AI_PORT: '8081',
        COZE_WORKLOAD_IDENTITY_API_KEY: '你的API密钥',
        COZE_INTEGRATION_BASE_URL: 'https://api.coze.cn',
        COZE_INTEGRATION_MODEL_BASE_URL: 'https://model.coze.cn',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '256M',
      error_file: '/var/log/pms/pms-ai-error.log',
      out_file: '/var/log/pms/pms-ai-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
EOF
```

### 7.4 创建日志目录

```bash
sudo mkdir -p /var/log/pms
sudo chown $USER:$USER /var/log/pms
```

### 7.5 启动服务

```bash
cd /opt/pms

# 启动所有服务
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status

# 查看日志
pm2 logs

# 预期输出：
# ┌────┬────────────┬─────────┬─────────┐
# │ id │ name       │ status  │ port    │
# ├────┼────────────┼─────────┼─────────┤
# │ 0  │ pms-web    │ online  │ :5000   │
# │ 1  │ pms-server │ online  │ :8080   │
# │ 2  │ pms-ai     │ online  │ :8081   │
# └────┴────────────┴─────────┴─────────┘
```

### 7.6 验证服务

```bash
# 验证 pms-server
curl -s http://localhost:8080/api/auth/me | head -c 200

# 验证 pms-ai
curl -s http://localhost:8081/health
# 预期: {"status":"ok","service":"pms-ai"}

# 验证 pms-web
curl -I -s http://localhost:5000 | head -5
# 预期: HTTP/1.1 200 OK

# 验证登录
curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"13800000001","password":"admin123"}'
# 预期: {"success":true,"data":{"token":"eyJ..."}}
```

### 7.7 设置 PM2 开机自启

```bash
pm2 save
pm2 startup
# 按照输出的命令执行（通常需要 sudo）
```

---

## 八、Nginx 反向代理配置

### 8.1 创建配置文件

```bash
sudo vim /etc/nginx/sites-available/pms-hotel
```

写入以下内容：

```nginx
# HTTP → HTTPS 重定向
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名或IP
    return 301 https://$server_name$request_uri;
}

# HTTPS 主配置
server {
    listen 443 ssl http2;
    server_name your-domain.com;  # 替换为你的域名或IP

    # SSL 证书（替换为你的实际证书路径）
    ssl_certificate     /etc/nginx/ssl/pms-hotel.pem;
    ssl_certificate_key /etc/nginx/ssl/pms-hotel.key;

    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 日志
    access_log /var/log/nginx/pms-hotel-access.log;
    error_log  /var/log/nginx/pms-hotel-error.log;

    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_types
      text/plain
      text/css
      application/json
      application/javascript
      text/xml
      application/xml
      application/xml+rss
      text/javascript;

    # 客户端请求大小限制
    client_max_body_size 10M;

    # 所有请求代理到 pms-web (Next.js)
    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        # WebSocket 支持（HMR / 未来实时功能）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # AI 对话流式接口 - 需要更长的超时和禁用缓冲
    location /api/data-center {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 关键配置：禁用缓冲，确保流式输出
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        chunked_transfer_encoding on;

        # AI 响应可能较慢，延长超时
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
}
```

### 8.2 启用站点配置

```bash
# 创建软链接
sudo ln -sf /etc/nginx/sites-available/pms-hotel /etc/nginx/sites-enabled/

# 移除默认站点（可选）
sudo rm -f /etc/nginx/sites-enabled/default

# 检查配置
sudo nginx -t

# 重载
sudo systemctl reload nginx
```

### 8.3 不使用域名（纯IP访问）

如果没有域名，移除 SSL 配置，直接监听 80 端口：

```nginx
server {
    listen 80;
    server_name 你的服务器IP;

    # ... 其余配置同上，去掉 SSL 相关行 ...
}
```

---

## 九、SSL 证书配置

### 方式一：Let's Encrypt（免费，有域名推荐）

```bash
# 安装 certbot
sudo apt install -y certbot python3-certbot-nginx

# 自动获取并配置证书
sudo certbot --nginx -d your-domain.com

# 自动续期（certbot 会自动添加 cron）
sudo certbot renew --dry-run
```

### 方式二：自签名证书（测试/内网用）

```bash
sudo mkdir -p /etc/nginx/ssl

sudo openssl req -x509 -nodes -days 365 \
  -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/pms-hotel.key \
  -out /etc/nginx/ssl/pms-hotel.pem \
  -subj "/CN=pms-hotel.local"
```

---

## 十、防火墙配置

```bash
# Ubuntu UFW
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable

# CentOS firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload

# 注意：5000/8080/8081 端口不需要对外开放
# 所有外部请求通过 Nginx 80/443 进入，内部转发到各服务
```

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

编辑 `ecosystem.config.cjs`，找到 pms-ai 部分，确保以下三个环境变量已填入：

```javascript
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
vi /opt/pms/pms-ai/.env
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

# 2. 测试 AI 对话
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

## 十二、运维管理

### 11.1 PM2 常用命令

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs                    # 所有服务
pm2 logs pms-web            # 仅前端
pm2 logs pms-server         # 仅后端
pm2 logs pms-ai             # 仅AI

# 重启服务
pm2 restart pms-web
pm2 restart pms-server
pm2 restart pms-ai
pm2 restart all

# 停止服务
pm2 stop all

# 监控面板
pm2 monit
```

### 11.2 更新部署

```bash
# 拉取最新代码
cd /opt/pms/pms-web && git pull origin main
cd /opt/pms/pms-server && git pull origin main
cd /opt/pms/pms-ai && git pull origin main

# 更新依赖
cd /opt/pms/pms-web && pnpm install --frozen-lockfile
cd /opt/pms/pms-server && pnpm install --frozen-lockfile
cd /opt/pms/pms-ai && pnpm install --frozen-lockfile

# 重新构建前端
cd /opt/pms/pms-web && pnpm next build
cd /opt/pms/pms-web && pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

# 重启服务
pm2 restart all

# 如有数据库变更
cd /opt/pms/pms-server && npx drizzle-kit push
```

### 11.3 数据库备份

```bash
# 创建备份脚本
cat > /opt/pms/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/pms/backups"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# 全量备份
pg_dump -h localhost -U pms_admin -d pms_hotel \
  --format=custom \
  --file="$BACKUP_DIR/pms_hotel_$DATE.dump"

# 保留最近30天备份
find $BACKUP_DIR -name "*.dump" -mtime +30 -delete

echo "Backup completed: pms_hotel_$DATE.dump"
EOF

chmod +x /opt/pms/backup.sh

# 添加定时任务（每天凌晨3点备份）
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/pms/backup.sh >> /var/log/pms/backup.log 2>&1") | crontab -
```

### 11.4 数据库恢复

```bash
# 从备份恢复
pg_restore -h localhost -U pms_admin -d pms_hotel \
  --clean --if-exists \
  /opt/pms/backups/pms_hotel_20250101_030000.dump
```

---

## 十二、生产环境检查清单

### 部署前必检

- [ ] **JWT_SECRET** 已替换为随机强密钥（不要使用默认值）
- [ ] **PG_PASSWORD** 已替换为强密码
- [ ] `.env` 文件权限为 600
- [ ] `.env` 文件已加入 `.gitignore`
- [ ] 数据库仅监听内网（如与应用同机则保持 localhost）
- [ ] 5000/8080/8081 端口未对外开放
- [ ] SSL 证书已配置
- [ ] 防火墙仅开放 22/80/443

### 安全加固

```bash
# 1. 禁用 root 远程登录
sudo vim /etc/ssh/sshd_config
# PermitRootLogin no
sudo systemctl restart sshd

# 2. 安装 fail2ban 防暴力破解
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

# 3. PostgreSQL 限制连接数
# 在 postgresql.conf 中：
# max_connections = 50
```

### 性能调优

```bash
# PostgreSQL 内存优化（8GB内存服务器参考）
# 在 postgresql.conf 中：
# shared_buffers = 2GB
# effective_cache_size = 6GB
# work_mem = 32MB
# maintenance_work_mem = 512MB

# 重启 PostgreSQL
sudo systemctl restart postgresql
```

---

## 十三、架构说明

### 请求流转

```
用户浏览器
    │
    ▼
Nginx (80/443)
    │
    ▼
pms-web (Next.js :5000)
    │
    ├── 页面渲染 → SSR/CSR
    │
    ├── /api/* → Next.js rewrites → pms-server (:8080)
    │
    └── /api/data-center* (GET)  → Next.js rewrites → pms-ai (:8081)
    │
    └── /api/data-center* (POST) → API Route SSE代理 → pms-ai (:8081)
        （原因：Next.js rewrites 会缓冲 SSE，API Route 逐块转发）
```

### 环境变量汇总

| 变量 | 服务 | 说明 | 默认值 |
|------|------|------|--------|
| `PG_HOST` | pms-server, pms-ai | 数据库主机 | localhost |
| `PG_PORT` | pms-server, pms-ai | 数据库端口 | 5432 |
| `PG_DATABASE` | pms-server, pms-ai | 数据库名 | pms_hotel |
| `PG_USER` | pms-server, pms-ai | 数据库用户 | pms_admin |
| `PG_PASSWORD` | pms-server, pms-ai | 数据库密码 | - |
| `JWT_SECRET` | pms-server | JWT签名密钥 | - |
| `PMS_SERVER_URL` | pms-web | 后端API地址 | http://localhost:8080 |
| `PMS_AI_URL` | pms-web | AI服务地址 | http://localhost:8081 |
| `PORT` | pms-web | 前端服务端口 | 5000 |
| `PMS_AI_PORT` | pms-ai | AI服务端口 | 8081 |
| `COZE_PROJECT_ENV` | pms-web | 环境标识 | PROD |

### 数据库表清单（25张）

| 表名 | 说明 |
|------|------|
| pms_bui_brands | 品牌 |
| pms_bui_stores | 门店 |
| pms_bui_room_types | 房型 |
| pms_bui_rooms | 房间 |
| pms_bui_room_devices | 房间设备 |
| pms_bui_orders | 订单 |
| pms_bui_channel_orders | 渠道订单 |
| pms_bui_pricing_rules | 定价规则 |
| pms_bui_pricing_calendar | 价格日历 |
| pms_bui_promotions | 促销活动 |
| pms_bui_channels | 渠道 |
| pms_bui_reviews | 评价 |
| pms_bui_transactions | 收支流水 |
| pms_bui_reconciliation_details | 对账明细 |
| pms_bui_reconciliation_alerts | 对账预警 |
| pms_bui_customers | 客户 |
| pms_bui_tags | 标签 |
| pms_bui_auto_tag_rules | 自动标签规则 |
| pms_bui_care_reminders | 关怀提醒 |
| pms_bui_staff | 员工 |
| pms_bui_roles | 角色 |
| pms_bui_op_logs | 操作日志 |
| pms_bui_settings | 系统设置 |
| pms_bui_ai_chat_history | AI对话历史 |
| pms_bui_ai_suggestions | AI定价建议 |

---

## 十四、常见问题排查

### Q1: 前端页面空白

```bash
# 检查 pms-web 是否运行
pm2 status pms-web
pm2 logs pms-web --lines 50

# 检查构建产物是否存在
ls -la /opt/pms/pms-web/.next/
ls -la /opt/pms/pms-web/dist/server.js

# 重新构建
cd /opt/pms/pms-web && pnpm next build
pm2 restart pms-web
```

### Q2: API 返回 502

```bash
# 检查 pms-server 是否运行
pm2 status pms-server
pm2 logs pms-server --lines 50

# 检查数据库连接
psql -h localhost -U pms_admin -d pms_hotel -c "SELECT 1;"

# 直接测试 pms-server
curl -s http://localhost:8080/api/auth/me
```

### Q3: AI 对话无响应

```bash
# 检查 pms-ai 是否运行
pm2 status pms-ai
pm2 logs pms-ai --lines 50

# 检查 AI 服务健康
curl -s http://localhost:8081/health

# 检查 SSE 代理
curl -N -X POST http://localhost:5000/api/data-center \
  -H 'Content-Type: application/json' \
  -d '{"type":"chat","messages":[{"role":"user","content":"你好"}]}'
```

### Q4: 数据库连接失败

```bash
# 检查 PostgreSQL 状态
sudo systemctl status postgresql

# 检查连接参数
psql -h localhost -U pms_admin -d pms_hotel -c "SELECT 1;"

# 检查环境变量
pm2 env 1  # 查看 pms-server 的环境变量
```

### Q5: Nginx 504 超时

```nginx
# 在 Nginx 配置中增大超时（特别是 AI 接口）
proxy_read_timeout 300s;
proxy_connect_timeout 300s;
```

---

## 十五、一键部署脚本（参考）

> 以下脚本仅供参考，请根据实际环境调整后再执行。

```bash
#!/bin/bash
set -euo pipefail

# ============ 配置区 ============
DB_PASSWORD="替换为强密码"
JWT_SECRET="替换为随机密钥"
DOMAIN="your-domain.com"
DEPLOY_DIR="/opt/pms"
# =================================

echo "=== PMS 系统一键部署 ==="

# 1. 安装基础依赖
echo "[1/8] 安装基础依赖..."
sudo apt update && sudo apt install -y postgresql nginx certbot python3-certbot-nginx

# 2. 安装 Node.js + pnpm
echo "[2/8] 安装 Node.js 24..."
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pnpm pm2

# 3. 配置数据库
echo "[3/8] 配置 PostgreSQL..."
sudo -u postgres psql -c "CREATE USER pms_admin WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -c "CREATE DATABASE pms_hotel OWNER pms_admin ENCODING 'UTF8';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE pms_hotel TO pms_admin;"

# 4. 部署代码（假设已上传到 $DEPLOY_DIR）
echo "[4/8] 安装依赖..."
cd ${DEPLOY_DIR}/pms-web && pnpm install --frozen-lockfile
cd ${DEPLOY_DIR}/pms-server && pnpm install --frozen-lockfile
cd ${DEPLOY_DIR}/pms-ai && pnpm install --frozen-lockfile

# 5. 数据库初始化
echo "[5/8] 初始化数据库..."
cd ${DEPLOY_DIR}/pms-server
export DATABASE_URL="postgresql://pms_admin:${DB_PASSWORD}@localhost:5432/pms_hotel"
npx drizzle-kit push
export PG_HOST=localhost PG_PORT=5432 PG_DATABASE=pms_hotel PG_USER=pms_admin PG_PASSWORD=${DB_PASSWORD}
npx tsx src/db/seed.ts

# 6. 构建所有服务
echo "[6/8] 构建服务..."
cd ${DEPLOY_DIR}/pms-web
pnpm next build
pnpm tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify

cd ${DEPLOY_DIR}/pms-server
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting

cd ${DEPLOY_DIR}/pms-ai
npx tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting

# 7. 启动服务
echo "[7/8] 启动服务..."
cd ${DEPLOY_DIR}
# （请先将 ecosystem.config.cjs 中的密码替换为实际值）
pm2 start ecosystem.config.cjs
pm2 save

# 8. 配置 Nginx
echo "[8/8] 配置 Nginx..."
# （请先将 nginx 配置中的域名替换为实际值）
sudo ln -sf ${DEPLOY_DIR}/nginx/pms-hotel /etc/nginx/sites-available/pms-hotel
sudo ln -sf /etc/nginx/sites-available/pms-hotel /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "=== 部署完成 ==="
echo "访问地址: https://${DOMAIN}"
echo "演示账号: 13800000001 / admin123"
echo ""
echo "重要：请尽快修改默认密码和 JWT_SECRET！"
```

---

## 十六、迁移友好性

本系统采用前后端分离架构，具备良好的迁移性：

| 场景 | 操作 |
|------|------|
| 替换后端语言（如 PHP/Java） | 保持 `/api/*` 接口协议不变，仅替换 pms-server 实现 |
| 替换数据库（如 MySQL） | 修改 Drizzle ORM 配置 + 重新生成 migration |
| 替换 AI 模型 | 修改 `pms-ai/src/ai/client.ts` 中的 LLM 客户端 |
| 水平扩展 | pms-server/pms-ai 可多实例 + Nginx 负载均衡 |
| 数据库独立部署 | 修改 PG_HOST 指向独立数据库服务器 |
