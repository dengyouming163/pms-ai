import type { Context } from 'hono';

/**
 * 业务错误基类：带 HTTP 语义的 status 与**可以给用户看**的 message。
 * 各模块的错误类（PayOrderError / RefundError / WenlvRefundError / PayError…）继承它，
 * 从而能被 serverError 统一识别。
 *
 * ⚠️ 禁止让**外部接口**的错误类继承它：WxpayApiError.status 是微信 API 的状态码、
 *    DyPayApiError.errNo 是抖音的错误码，都不是 HTTP 状态码，当成 HTTP 状态回给客户端是错的。
 * ⚠️ 判别一律用 `instanceof`（见 isHttpError），**不要鸭子类型判 `.status`** —— 上面两个类也有 status。
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const isHttpError = (e: unknown): e is HttpError => e instanceof HttpError;

/**
 * `serverError` 兜底状态码的**允许集合**（唯一真源）。
 *
 * 写成运行时数组 + 由它派生类型，是为了让「哪些状态码是合法的」只有一个出处：
 * 类型检查（serverError 第 4 参）与单测（lib/__tests__/http-error.test.ts 断言各业务错误
 * 子类实例的 status 落在集合内）读的是同一份取值，不再各自抄一遍数字
 * —— 抄一遍就多一处会静默漂移的常量。
 *
 * 值是 Hono `c.json` 能接受的状态码；改动前先确认 5 个 HttpError 子类
 * （PayError ×2 / PayOrderError / RefundError / WenlvRefundError）的取值都还在集合内。
 */
export const HTTP_ERROR_STATUSES = [400, 401, 403, 404, 409, 500, 502, 503] as const;
export type HttpErrorStatus = (typeof HTTP_ERROR_STATUSES)[number];

/**
 * 路由统一错误出口。
 * - 业务错误（HttpError 子类）：原样回文案与状态码（**忽略 status 参数**）；
 * - 其余一律：日志记**完整错误对象**（含堆栈），响应只回 fallback 与 status。
 *
 * ⚠️ `console.error(msg, e)` 必须传**对象**而非 `e.message` —— 传 message 会丢掉堆栈，
 *    等于没记。drizzle 的错误 message 里带完整 SQL 与参数，正是不能回给客户端的东西。
 *
 * `status` 是**给非业务错误用的兜底状态码**，默认 500。
 * 存在的意义：迁移前有 8 处内联 catch 原本返回非 500（routes/voice.ts 的 400；
 * kf-staff/oauth.ts、mini/auth.ts、mini/pay.ts、mini/pay-product.ts、mini/pay-h5.ts 的 502），
 * 若这里写死 500，迁移会把它们静默改判成 500 造成行为回归。
 * 参数带默认值且排在最后，其余调用点无需改动。
 */
export function serverError(
  c: Context,
  e: unknown,
  fallback: string,
  status: HttpErrorStatus = 500,
) {
  if (isHttpError(e)) return c.json({ success: false, error: e.message }, e.status as 400);
  console.error('[pms-server] 未预期错误:', e);
  return c.json({ success: false, error: fallback }, status);
}

/** drizzle 查询错误的 message 前缀。用途见下。 */
const DRIZZLE_QUERY_PREFIX = 'Failed query:';

/**
 * 把异常压成一行**可以落库、因而可以被回显给用户**的诊断文本。
 *
 * 为什么不能用裸 `String(e?.message || e)`：drizzle 的 `DrizzleQueryError.message` 形如
 * `Failed query: <完整 SQL>\nparams: <参数>`。`services/wenlv-asset-gen-scheduler.ts` 的
 * `markFailed` 会把它落进 `pms_bui_wenlv_asset_jobs.error_message`，而创作台轮询进度用的
 * `GET /admin/wenlv-asset-gen/batch/:batchId` **原样**把该列回给浏览器 ——
 * 等于把 SQL 与参数（可能含手机号、主键）透给客户端。
 *
 * `serverError` 只管**响应**这一路；**落库**这一路此前无人管，本函数补的就是这条缝。
 *（对照既有先例：`routes/mini/wenlv.ts` 与 `routes/admin/wenlv-asset-gen.ts` 的 /style-bible
 *  各写了一遍「不许把 Failed query 回给客户端」，那两处都是响应侧。）
 *
 * ⚠️ 不能一刀切成「服务器错误」：`error_message` 是运维诊断的**唯一**线索，大量既有断言
 *    依赖它的可辨识内容（「超时未返回」「非 JSON」「502 Bad Gateway」「该任务没有风格基线」…）。
 *    所以策略是**只摘掉 SQL 与参数，其余原样保留**。
 *
 * ⚠️ SQLSTATE 在 **cause** 上而不在 `e.code`：drizzle 把 pg 原始错误包了一层，
 *    `e.code` 恒 undefined，必须 `(e?.cause ?? e)?.code`。
 */
export function diagnosableErrorText(e: unknown, maxLen = 2000): string {
  const raw = String((e as any)?.message || e);
  // 非 drizzle 查询错误：原样保留（截断长度与改动前一致，行为不变）。
  if (!raw.startsWith(DRIZZLE_QUERY_PREFIX)) return raw.slice(0, maxLen);
  // 走到这里说明整段 message 都不可外泄 —— SQL 与参数都在里面。
  // 只留下 where 得清的诊断位：SQLSTATE 与约束名（调用方据此分辨唯一冲突/超长/外键）。
  const cause = (e as any)?.cause ?? e;
  const bits = ['数据库查询失败'];
  if (cause?.code) bits.push(`SQLSTATE ${cause.code}`);
  if (cause?.constraint) bits.push(`约束 ${cause.constraint}`);
  return bits.join('，').slice(0, maxLen);
}
