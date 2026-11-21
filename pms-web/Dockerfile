# ====== 生产环境 Dockerfile（容器内多阶段构建）======
# 无需本地预构建，docker compose build 即可产出可运行镜像
# 开发环境仍直接用 pnpm dev，不使用 Docker

# ---- 构建阶段 ----
FROM node:22-alpine AS builder
WORKDIR /app

# rewrites 在 next build 时写入 routes-manifest，需在此阶段确定后端地址
ARG PMS_SERVER_URL=http://pms-server:9090
ENV PMS_SERVER_URL=${PMS_SERVER_URL}

# build.sh / start.sh 依赖 bash；libc6-compat 供 Next.js 的原生依赖使用
RUN apk add --no-cache bash libc6-compat && \
    npm config set registry https://registry.npmmirror.com && \
    npm install -g pnpm@9 && \
    pnpm config set registry https://registry.npmmirror.com

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production
ENV PORT=5000

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 5000
CMD ["npx", "next", "start", "--port", "5000"]
