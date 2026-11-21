import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // constants.ts 顶层会立即校验这两个环境变量，测试环境注入桩值避免 import 即崩溃
    env: {
      JWT_SECRET: 'test-jwt-secret',
      INTERNAL_SERVICE_TOKEN: 'test-internal-token',
      // pay-order.ts 顶层 import db（db/index.ts 构造惰性 pg Pool，仅校验 env 存在不连接），
      // 注入桩值避免测试 import pay-order/pay-h5 时崩溃
      PG_HOST: '132.232.166.40',
      PG_PORT: '15432',
      PG_DATABASE: 'aipms',
      PG_USER: 'aipms',
      PG_PASSWORD: 'dengyouming2tll',
    },
  },
});
