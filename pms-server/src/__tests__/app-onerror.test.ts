import { describe, it, expect, afterEach, vi } from 'vitest';
import app from '../index.js';

/**
 * `src/index.ts` 的全局错误处理（`app.onError`）此前**没有任何测试驱动** ——
 * 无论它回通用文案还是把 `err.message` 原样透给客户端，全仓测试都照绿，
 * 于是「生产不泄露原始 message」这条主张只活在注释里，没有任何判据守着。
 * 本文件是它的第一条判据，一次关掉同一件事的两种表述：
 *   · SP-error-leak-14：未捕获异常必须回 500 + 通用文案；
 *   · SP-error-leak-15：除显式 NODE_ENV=development 外，一律不许透出 err.message。
 *
 * ⚠️ 探针路由只加在**本测试文件**里（`import app` 之后）。绝不要为了测试往
 *    生产的 `src/index.ts` 里加路由 —— 那会把测试用的入口带上生产。
 *
 * ⚠️ 文案取决于 `process.env.NODE_ENV` 门控（index.ts 在 `dev ? err.message : '服务器内部错误'`
 *    处读它）。**必须先钉住 NODE_ENV**，否则判据会随「跑测试那台机器的 env」而变：
 *    本机若恰好 export 了 NODE_ENV=development，这条「不泄露」的判据反而会红/绿颠倒。
 *
 * ⚠️ `index.ts` 只 `export default app`，**不监听端口**（真正 serve 的是 `src/server.ts`，
 *    package.json 的 start 是 `tsx src/server.ts`），所以 import 它不会占端口。
 *
 * 中间件顺序（已读 index.ts 确认）：`app.use('*', authMiddleware)` 对**非 `/api/` 路径**
 * 直接 `next()`（middleware/auth.ts 的 `if (!path.startsWith('/api/')) return next();`），
 * 故探针用 `/__probe_onerror`（非 /api 前缀）即可裸调，无需内部 token。
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

// 探针：抛一个带「敏感」原文的错误，形状对齐 drizzle 的 DrizzleQueryError
//（`Failed query: <完整 SQL>\nparams: <参数>`），正是绝不能回给客户端的那类 message。
app.get('/__probe_onerror', () => {
  throw new Error('Failed query: SELECT * FROM pms_bui_orders params: 13800000000');
});

describe('app.onError 全局错误处理', () => {
  it('未捕获异常 ⇒ 500 + 通用文案，且错误对象进 console.error（判别力：改成回 e.message 时红）', async () => {
    // 显式钉住生产态。若 index.ts 去掉了 dev 门控直接回 err.message，本用例立刻红。
    vi.stubEnv('NODE_ENV', 'production');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/__probe_onerror');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ success: false, error: '服务器内部错误' });
      // toEqual 已经足够，再钉一次「连子串都不许出现」—— 防止将来有人把兜底文案
      // 改成 `服务器内部错误：${err.message}` 这种「通用文案 + 原文」的混合体。
      expect(JSON.stringify(body)).not.toContain('Failed query');
      expect(JSON.stringify(body)).not.toContain('13800000000');

      expect(spy.mock.calls.length > 0).toBe(true);
      // 第二实参必须是**错误对象本身**：传 e.message 会丢堆栈，线上只剩一句话，无从排查。
      // 只断言「被调用过」不够 —— 那样改成 (e as any).message 也能全绿。
      expect(spy.mock.calls[0][1]).toBeInstanceOf(Error);
      expect((spy.mock.calls[0][1] as Error).message).toContain('Failed query');
    } finally {
      spy.mockRestore();
    }
  });

  it('仅显式 NODE_ENV=development 才透出原文（门控失败方向安全）', async () => {
    // 反向用例：它证明上一条的「通用文案」确实是**门控**的结果，而不是「文案写死」。
    // 若有人把门控删成无条件通用文案，本条红；若删成无条件透出原文，上一条红。
    vi.stubEnv('NODE_ENV', 'development');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/__probe_onerror');
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('Failed query');
    } finally {
      spy.mockRestore();
    }
  });
});
