# ====== 生产环境 Dockerfile ======
# 本地 pnpm build 后，docker compose up 即可
# 开发环境直接用 pnpm dev，不使用 Docker

FROM node:22-alpine
WORKDIR /app

# 仅安装生产依赖
COPY package.json pnpm-lock.yaml ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pnpm@9 && \
    pnpm config set registry https://registry.npmmirror.com && \
    pnpm install --frozen-lockfile --prod

# 本地构建产物
COPY .next/ ./.next/
COPY public/ ./public/
COPY next.config.ts ./

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

CMD ["npx", "next", "start", "--port", "5000"]
