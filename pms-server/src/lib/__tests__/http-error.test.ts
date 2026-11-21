import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  HttpError, isHttpError, serverError, diagnosableErrorText,
  HTTP_ERROR_STATUSES, type HttpErrorStatus,
} from '../http-error.js';
import { PayOrderError } from '../../services/pay-order.js';
import { RefundError } from '../../services/product-refund.js';
import { WenlvRefundError } from '../../services/wenlv-refund.js';
import { PayError as WenlvPayError } from '../../services/wenlv-pay.js';
import { PayError as MiniPayProductError } from '../../routes/mini/pay-product.js';

/**
 * 注：本项目自写的 vitest.d.ts 类型桩未声明 vi.spyOn / mockRestore
 * （同 kf.test.ts、wenlv-design-load.resilience.test.ts 的约定），
 * 所以这里手动替换 console.error 捕获调用，不用 vi.spyOn。
 */
function captureConsoleError() {
  const calls: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.error = orig;
    },
  };
}

function appWith(thrown: () => never) {
  const app = new Hono();
  app.get('/boom', (c) => {
    try {
      thrown();
    } catch (e) {
      return serverError(c, e, '操作失败，请稍后重试');
    }
    return c.json({ ok: true });
  });
  return app;
}

describe('serverError', () => {
  it('未预期错误：回通用文案，不回原始 message', async () => {
    const spy = captureConsoleError();
    try {
      // 错误对象提到闭包外，便于断言 console.error 收到的是**同一个对象**
      const err = new Error('Failed query: SELECT * FROM t params: 13800000000');
      const app = appWith(() => {
        throw err;
      });
      const res = await app.request('/boom');
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe('操作失败，请稍后重试');
      expect(JSON.stringify(body)).not.toContain('Failed query');
      expect(JSON.stringify(body)).not.toContain('13800000000');
      expect(spy.calls.length > 0).toBe(true);
      // 钉住第二实参就是**错误对象本身**：serverError 必须 console.error(msg, e) 传对象，
      // 传 e.message 会丢掉堆栈，等于没记。只断言「被调用过」不够 ——
      // 那样把实参改成 (e as any).message 也能全绿，等于没钉住这份设计的核心主张。
      expect(spy.calls[0][1]).toBe(err);
    } finally {
      spy.restore();
    }
  });

  it('业务错误：保留原文案与原状态码', async () => {
    const app = appWith(() => {
      throw new HttpError(404, '订单不存在');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('订单不存在');
  });

  it('isHttpError 不认鸭子类型：带 status 字段的普通 Error 不算业务错误', () => {
    class FakeApiError extends Error {
      constructor(public status: number) {
        super('x');
      }
    }
    expect(isHttpError(new FakeApiError(400))).toBe(false);
    expect(isHttpError(new HttpError(400, 'x'))).toBe(true);
  });

  it('可覆写状态码：非业务错误也能回 502 而非 500', async () => {
    // 回归背景：routes/mini/auth.ts 等 8 处泄露点原本返回非 500（400/502），
    // 若 serverError 硬编码 500，迁移时会把它们静默改判成 500。
    const app = new Hono();
    app.get('/boom', (c) => {
      try {
        throw new Error('Failed query: SELECT 1');
      } catch (e) {
        return serverError(c, e, '免登失败', 502);
      }
      return c.json({ ok: true });
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(502); // 不是 500
    expect((await res.json()).error).toBe('免登失败'); // 仍是兜底文案，不泄露
  });
});

/**
 * `serverError` 守的是**响应**这一路；下面这些守的是**落库**这一路。
 *
 * 背景（2026-09-14 终审 Minor）：`services/wenlv-asset-gen-scheduler.ts` 的 `markFailed`
 * 把 `String(e.message)` 直接写进 `error_message`，而创作台轮询用的
 * `GET /admin/wenlv-asset-gen/batch/:batchId` 原样回显该列 —— 于是 drizzle 的
 * `Failed query: <完整SQL> params: <参数>` 会绕过 serverError 直达浏览器。
 */
describe('diagnosableErrorText（落库侧消毒）', () => {
  /** 造一个形状与 drizzle DrizzleQueryError 一致的错误：message 带 SQL，cause 才是 pg 原始错误。 */
  function drizzleErr(cause: unknown) {
    const e: any = new Error(
      'Failed query: select "id" from "pms_bui_wenlv_asset_jobs"\nparams: job-1,13800000000',
    );
    e.cause = cause;
    return e;
  }

  it('drizzle 查询错误：SQL 与参数都不落库，但保留 SQLSTATE 与约束名', () => {
    const out = diagnosableErrorText(drizzleErr({ code: '23505', constraint: 'asset_jobs_pkey' }));
    expect(out).not.toContain('Failed query');
    expect(out).not.toContain('select "id"');
    expect(out).not.toContain('pms_bui_wenlv_asset_jobs');
    expect(out).not.toContain('13800000000');
    // 保留可诊断位：调用方要能分辨唯一冲突 / 超长 / 外键
    expect(out).toContain('23505');
    expect(out).toContain('asset_jobs_pkey');
  });

  it('SQLSTATE 在 cause 上：drizzle 包的这层**没有** e.code，读 e.code 会漏掉它', () => {
    // 这条钉的是 `(e?.cause ?? e)?.code` 这个写法本身。若有人图省事写成 `e.code`，
    // 上面那条会退化成「不带任何 SQLSTATE」，本条红。
    const e = drizzleErr({ code: '22P02' });
    expect((e as any).code).toBe(undefined); // 前提：外层确实没有 code
    expect(diagnosableErrorText(e)).toContain('22P02');
  });

  it('drizzle 错误连 cause 都没有时，仍然不泄露 SQL（宁可只回一句「查询失败」）', () => {
    const e: any = new Error('Failed query: delete from "pms_bui_wenlv_asset_jobs"');
    const out = diagnosableErrorText(e);
    expect(out).not.toContain('Failed query');
    expect(out).not.toContain('delete from');
    expect(out).toContain('数据库查询失败');
  });

  it('非 drizzle 错误原样保留 —— 这是**刻意**的，不是漏网', () => {
    // error_message 是运维诊断的唯一线索，大量既有断言依赖它的可辨识内容。
    // 若有人把本函数改成「凡是 Error 一律回兜底文案」，本条红。
    //（真实依赖：run-once.db.test.ts 的「超时」「非 JSON」「502 Bad Gateway」「OSS」…）
    for (const msg of ['文生图失败（出图）：HTTP 502 Bad Gateway', '对象存储上传失败：OSS 超时']) {
      expect(diagnosableErrorText(new Error(msg))).toBe(msg);
    }
    // 非 Error 的抛出物（字符串 / 对象）也要能落库
    expect(diagnosableErrorText('裸字符串抛出')).toBe('裸字符串抛出');
  });

  it('超长文本按 maxLen 截断（落库列不是无底洞）', () => {
    const long = 'x'.repeat(3000);
    expect(diagnosableErrorText(new Error(long)).length).toBe(2000);
    expect(diagnosableErrorText(new Error(long), 50).length).toBe(50);
    // drizzle 分支同样受 maxLen 约束
    expect(diagnosableErrorText(drizzleErr({ code: '23505' }), 8).length).toBe(8);
  });
});

/**
 * `serverError` 对 HttpError 子类是**盲转**的：
 *   `c.json({ success: false, error: e.message }, e.status as 400)`
 * `as 400` 只是一句断言，不校验取值。若某个子类的 status 落在 Hono 能接受的状态码之外，
 * 类型检查只挡得住「构造参数有字面量联合类型」的那 3 个类；`RefundError` /
 * `WenlvRefundError` 的构造参数是裸 `number`，编译期完全挡不住。
 * 这里把「允许集合」在运行时钉一遍 —— 集合取自 http-error.ts 的导出常量，
 * **不重抄数字**（重抄一遍就又多一处会漂移的常量，正是本用例要防的东西）。
 */
describe('业务错误子类的 status 落在 serverError 的允许集合内', () => {
  /**
   * 5 个类一笔列全（含两个同名不同文件的 PayError，用别名区分）。
   * ⚠️ 只列 4 个 / 少列一个类，本表就废了一角 —— 所以下面断言 length=5，
   *    并断言类名互不重复，「漏登记」会当场红而不是静默少测。
   */
  const CLASSES: [string, new (status: any, message: string) => HttpError][] = [
    ['services/wenlv-pay.ts PayError', WenlvPayError],
    ['routes/mini/pay-product.ts PayError', MiniPayProductError],
    ['services/pay-order.ts PayOrderError', PayOrderError],
    ['services/product-refund.ts RefundError', RefundError],
    ['services/wenlv-refund.ts WenlvRefundError', WenlvRefundError],
  ];

  // 3 个窄类的构造签名就是 400|404|500|502；2 个宽类（status: number）枚举源码里
  // 真实用到的代表值（product-refund 还透传过平台 4xx，此处取集合内的几个）。
  const REPRESENTATIVE_STATUSES = [400, 404, 500, 502];

  it('枚举值全部命中 HTTP_ERROR_STATUSES', () => {
    expect(CLASSES.length).toBe(5);
    expect(new Set(CLASSES.map(([label]) => label)).size).toBe(5);

    for (const [label, Cls] of CLASSES) {
      for (const status of REPRESENTATIVE_STATUSES) {
        const err = new Cls(status, 'x');
        // 失败时 message 会指出是哪个类的哪个取值 —— 否则 20 个取值里挂了哪个要看半天
        expect(HTTP_ERROR_STATUSES, `${label} 构造 status=${status}`).toContain(err.status);
      }
    }
  });

  it('窄类的声明类型是允许集合的子集（越界字面量由 ts-check 当场挡下）', () => {
    // 这三行是**类型级**断言：若有人往 PayError / PayOrderError 的 `declare status`
    // 里塞一个集合外的字面量（如 418），`pnpm ts-check` 会在此处报错。
    // 运行期取值由上一条用例覆盖 —— 两条互补，缺一条都留缝。
    const narrowed: HttpErrorStatus[] = [
      new WenlvPayError(400, 'x').status,
      new MiniPayProductError(400, 'x').status,
      new PayOrderError(400, 'x').status,
    ];
    expect(narrowed.length).toBe(3);
  });
});
