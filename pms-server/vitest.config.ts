import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // constants.ts 顶层会立即校验这两个环境变量，测试环境注入桩值避免 import 即崩溃。
    // 2026-10-07 改为「shell 显式传入优先」：RUN_DB=1 PG_DATABASE=aipms_test vitest run
    // 时能透传到测试进程（桩值仅在未传入时兜底），否则 DB 类测试永远连不上指定库。
    env: {
      JWT_SECRET: process.env.JWT_SECRET ?? 'test-jwt-secret',
      INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN ?? 'test-internal-token',
      // pay-order.ts 顶层 import db（db/index.ts 构造惰性 pg Pool，仅校验 env 存在不连接），
      // 注入桩值避免测试 import pay-order/pay-h5 时崩溃
      PG_HOST: process.env.PG_HOST ?? 'localhost',
      PG_DATABASE: process.env.PG_DATABASE ?? 'test',
      PG_USER: process.env.PG_USER ?? 'test',
      PG_PASSWORD: process.env.PG_PASSWORD ?? 'test',
    },
  },
});
