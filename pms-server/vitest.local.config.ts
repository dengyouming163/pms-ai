import { defineConfig } from 'vitest/config';

/**
 * 本地开发库专用 vitest 配置 —— 让 `describe.skipIf(!process.env.RUN_DB)` 的 DB 用例真正跑起来。
 *
 * 用法（仅限本机）：
 *   cd pms-server && pnpm exec vitest run --config vitest.local.config.ts <测试文件>
 *
 * ## 为什么需要这个文件
 * `vitest.config.ts` 的 PG 桩值是 `localhost`/`test`/`test`/`test` —— 变量存在但不指向任何真实库，
 * 于是所有 DB 用例在本地恒被 skip，本地等于**没有一条真跑的端点回归**。
 * `vitest.db.config.ts` 能连上库，但它**硬编码了生产库凭据**（132.232.166.40），明令禁用。
 *
 * 这个文件填的正是中间那块空白：连**本机 Docker 容器**（库 `aipms` / 用户 `gate`，
 * 见 `scripts/dev-start.sh`，127.0.0.1:5432）。
 *
 * ## 安全闸
 * `assertLoopback` 是硬闸：非回环地址会在**加载配置时**直接抛错。
 * 也就是说，即使有人把 PG_HOST 改成生产地址，也只会报错跑不起来，
 * 而不是静默地把测试打到生产库上。改这个文件之前请先想清楚这一点。
 */

const PG_HOST = process.env.LOCAL_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.LOCAL_PG_PORT ?? '5432';
const PG_DATABASE = process.env.LOCAL_PG_DATABASE ?? 'aipms';
const PG_USER = process.env.LOCAL_PG_USER ?? 'gate';
const PG_PASSWORD = process.env.LOCAL_PG_PASSWORD ?? 'gate2024';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACK.has(PG_HOST)) {
  throw new Error(
    `vitest.local.config.ts 拒绝连接非回环地址 PG_HOST=${PG_HOST}。` +
      '这个配置只服务于本机开发库；要验证生产请另走部署流程，不要放开这道闸。',
  );
}

export default defineConfig({
  test: {
    // ⚠️ DB 用例必须**串行**。本仓库的 *.db.test.ts 共用同一个物理库，
    // 而 claimNextJobs / reclaimStale 的语义就是「全库领取 / 全库收口」——
    // 两个测试文件并行跑时：
    //   · claim.db 的 `claimNextJobs(50)` 会把 run-once 刚种下的 pending 行领走
    //     （run-once 随后断言 styleAnchorUrl 有值 → 红）
    //   · run-once 的 `reclaimStale(15)` 会把 claim.db 准备用来验超时的那行先收口掉
    //     （claim.db 的 `expect(n).toBeGreaterThan(0)` 变成 0 → 红）
    // 表现是「随机红灯、重跑就绿」，极难定位。vitest 默认 fileParallelism: true，
    // 必须显式关掉。
    fileParallelism: false,
    env: {
      JWT_SECRET: 'test-jwt-secret',
      INTERNAL_SERVICE_TOKEN: 'test-internal-token',
      PG_HOST,
      PG_PORT,
      PG_DATABASE,
      PG_USER,
      PG_PASSWORD,
      // 本配置存在的唯一目的就是让 DB 用例跑起来，所以直接打开开关
      RUN_DB: '1',
    },
  },
});
