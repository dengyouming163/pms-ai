import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../lib/http-error.js';
import { PayOrderError } from '../services/pay-order.js';
import { RefundError } from '../services/product-refund.js';
import { WenlvRefundError } from '../services/wenlv-refund.js';
import { PayError as WenlvPayError } from '../services/wenlv-pay.js';
import { PayError as MiniPayProductError } from '../routes/mini/pay-product.js';
import { AtomVerifyUnsupportedError } from '../services/wenlv/atoms/verify.js';
import { AiSessionError } from '../services/wenlv/ai-session.js';

/** 递归收集 src 下所有 .ts（排除测试目录） */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      collect(p, out);
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 豁免①：lib/http-error.ts 是 serverError 的实现本身，
 * 它内部的 `c.json({ error: e.message })` 已被 isHttpError 守住 —— 全仓库唯一该这么写的地方。
 * 用 isHttpError 而非 instanceof 是有意的（要认子类）。除它之外任何文件都不许有。
 */
const SANCTIONED = join('lib', 'http-error.ts');

/**
 * 内置 Error 家族。`e instanceof Error ? e.message : '兜底'` **不是**有效豁免 ——
 * drizzle 的 DrizzleQueryError 就是 Error 实例，该式子同样把
 * `Failed query: <完整SQL> params: <参数>` 透给客户端。
 * 只有 `instanceof <业务错误类>`（PayOrderError / RefundError / WenlvRefundError / PayError…）
 * 才是「业务文案本该给用户看」的正确写法，予以豁免（豁免②）。
 */
const BUILTIN_ERROR = /instanceof\s+(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError)\b/;

/**
 * 豁免②的**登记表**：被 `instanceof` 的类名 → 该名字对应的全部类。
 *
 * 为什么需要它：豁免②原来的判定是「行内含 instanceof 且不是内置 Error 家族」，
 * 这**不校验被 instanceof 的类到底是什么**。于是
 *   `if (e instanceof Object) return c.json({ error: e.message }, 500);`
 * 这种写法照样被豁免 —— 等于把最该拦的泄漏用任意类洗白。
 * 下面这条登记表 + 用例把「被豁免的类必须 extends HttpError」钉死；
 * 想豁免一个新类，就必须回这里登记，登记时会被强制核对它真是 HttpError 子类。
 *
 * ⚠️ PayError 是**同名不同文件的两个私有类**（services/wenlv-pay.ts 与
 *    routes/mini/pay-product.ts）。行上只有名字、分辨不出是哪一个，所以名字映射到
 *    「同名类的全部」—— 断言的是**每一个**都必须是 HttpError 子类。
 */
const SANCTIONED_SUBCLASSES: Record<string, readonly (new (...args: any[]) => HttpError)[]> = {
  PayError: [WenlvPayError, MiniPayProductError],
  PayOrderError: [PayOrderError],
  RefundError: [RefundError],
  WenlvRefundError: [WenlvRefundError],
  AtomVerifyUnsupportedError: [AtomVerifyUnsupportedError],
  AiSessionError: [AiSessionError],
};

/**
 * 判断一行是否蹭到豁免②，并返回该行被 `instanceof` 的**全部**类名。
 * 不是豁免②（无 instanceof，或命中内置 Error 家族）返回 null。
 * 与主用例共用本函数，保证「扫出来的行」和「被核验的类」是同一批，不会各判各的。
 */
function exemptedClassNames(line: string): string[] | null {
  if (!line.includes('instanceof') || BUILTIN_ERROR.test(line)) return null;
  return [...line.matchAll(/instanceof\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

/**
 * 开发态门控（豁免③）：仅当**显式** NODE_ENV=development 时透出原文，默认（含未设）一律回通用文案。
 * 失败方向安全 —— 与「无条件透出 e.message」不同。
 * 只认精确的 `=== 'development'`；`!== 'production'` 是失败方向**不安全**的写法（未设时即透出），
 * 恰恰是本次要根治的那类 bug，**不予豁免**。
 *
 * 收紧（见 devGated）：豁免成立当且仅当**其一** ——
 *   1. 可疑行**本行**就带门控（门控与透出写在同一行）；
 *   2. 可疑行**用到了**同块内先前声明的门控变量（形如 `const dev = process.env.NODE_ENV === 'development'`，
 *      且 `dev` 作为标识符出现在可疑行上，词边界匹配）。
 * 仅仅「块内出现过门控」**不算**豁免：那会让同块内另一处**无关的**泄露蹭到门控被静默放过，例如
 *   `app.get('/x', async (c) => {`
 *   `  const dev = process.env.NODE_ENV === 'development';   // 同块内的门控`
 *   `  try { ... } catch (e) {`
 *   `    return c.json({ success: false, error: e.message }, 500);   // ← 蹭到门控，被静默放过`
 *   `  }`
 *   `});`
 * 上一版豁免②就因判定太宽（`!line.includes('instanceof')`）遮蔽过 4 处真泄露，同类错误不犯第二次。
 */
const DEV_GATED = /process\.env\.NODE_ENV === 'development'/;

/** 块内门控变量声明，捕获变量名（如 `const dev = process.env.NODE_ENV === 'development'`） */
const DEV_GATE_DECL = /const\s+(\w+)\s*=\s*process\.env\.NODE_ENV === 'development'/;

/**
 * 豁免③判定：本行自身带门控，或本行**用到了**同块内先前声明的门控变量。
 * 只「块内出现过门控」是不够的 —— 见上方反例（蹭门控）。
 */
function devGated(lines: string[], depths: number[], i: number): boolean {
  const line = lines[i];
  if (DEV_GATED.test(line)) return true;
  const block = lines.slice(blockStart(depths, i), i + 1);
  return block.some((l) => {
    const m = DEV_GATE_DECL.exec(l);
    // 词边界：别让 `dev` 命中 `device`；`\w+` 抓到的名字本身即安全，无需再转义
    return !!m && new RegExp(`\\b${m[1]}\\b`).test(line);
  });
}

/**
 * 禁止异常对象的 message/stack 直接进 HTTP 响应。
 * `c.json({ error: e.message })` 与 `` c.json({ error: `失败: ${err.message}` }) ``
 * 都会把 drizzle 的 `Failed query: <SQL> params: <参数>` 原文透给客户端。
 * 业务错误请走 serverError（它只在 isHttpError 时回 e.message）。
 *
 * 正则说明（两种反例都已验过，改动前请重新验）：
 * - `\b(?:e|err|error)\??\.(?:message|stack)` 同时覆盖 `e.message` / `err?.message` /
 *   模板字符串插值 `${e.message}` / 字符串拼接 —— 首版只匹配 `error: e.message` 形式，
 *   漏掉了模板字符串，导致 video-promo.ts(12) 等整批文件不进清单。
 * - 天然**不匹配** `parsed.error.issues[0].message`（`error` 后面跟的是 `.issues`），
 *   即 zod 校验提示不会被误判 —— 那是本来就该返回给调用方的，不能动。
 * - `.stack` 一并禁止：`routes/ota/client.ts:225` 曾把堆栈也回给客户端。
 *
 * 豁免共三类（判定见下方 SANCTIONED / BUILTIN_ERROR / DEV_GATED）：
 * ① `lib/http-error.ts` 自身 —— serverError 的实现，已被 isHttpError 守住；
 * ② 窄类 `instanceof <业务错误类>` —— 业务文案本该给用户看；含 `instanceof` 一律放过是错的：
 *    `e instanceof Error ? e.message : '兜底'` 也含 `instanceof`，但对最该拦的 drizzle
 *    错误照样泄露原文，故内置 Error 家族仍进 offenders；
 * ③ 显式 development 门控 —— 失败方向安全，仅当显式 NODE_ENV=development 才透出原文。
 * 除这三类外，任何把异常 message/stack 直返客户端的写法都进 offenders。
 */
const FORBIDDEN = /c\.json\(.*\b(?:e|err|error)\??\.(?:message|stack)/;

/**
 * 逐行记录「进入该行前」的 `{}` 深度（含字符串/注释里的花括号，属朴素计数，够本守卫用）。
 * 只为把豁免③限定在**同处一个块**内 —— 否则文件里随便一处门控会给全文件泄露开后门。
 */
function braceDepths(lines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const line of lines) {
    depths.push(depth);
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    depth += opens - closes;
  }
  return depths;
}

/** 该行所在 `{}` 块的起始行下标（块起始行本身也算在内） */
function blockStart(depths: number[], idx: number): number {
  for (let i = idx - 1; i >= 0; i--) {
    if (depths[i] < depths[idx]) return i;
  }
  return 0;
}

describe('错误响应不泄露原始 message', () => {
  it('src 下无裸 e.message 直返', () => {
    const root = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const f of collect(root)) {
      if (f.endsWith(SANCTIONED)) continue;   // 豁免①见上
      const lines = readFileSync(f, 'utf8').split('\n');
      const depths = braceDepths(lines);
      lines.forEach((line, i) => {
        if (!FORBIDDEN.test(line)) return;
        // 豁免②：带 instanceof 分支的行，仅当目标是非内置的业务错误类时才豁免；
        // `instanceof Error` 这类内置基类不算豁免，仍进清单（见 BUILTIN_ERROR）。
        // ⚠️ 这里只看「行内有没有 instanceof」，**不校验类本身**；类是不是真的
        //    HttpError 子类由下面「豁免②只放行 HttpError 子类」用例逐个核验。
        if (exemptedClassNames(line)) return;
        // 豁免③：门控常写在上一行（`const dev = ...` 与用它的 `return c.json(...)` 分属两行）。
        // 但必须**本行自带门控**或**本行真的用到了**同块内的门控变量，光「块内出现过门控」不算 —— 见 devGated。
        if (devGated(lines, depths, i)) return;
        offenders.push(`${f}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 豁免②的**收紧**：光「行内有 instanceof」不够 —— 被 instanceof 的类必须真是
   * HttpError 子类。否则 `instanceof Object` / 任意自造类都能把泄漏洗白。
   * 类名取自**同一批**被豁免的行（`exemptedClassNames`，与主用例共用），
   * 不在登记表里的新名字会让用例红，逼人回来登记并核对。
   */
  it('豁免②只放行 HttpError 子类：被 instanceof 的类必须 extends HttpError', () => {
    const root = join(process.cwd(), 'src');
    const unregistered: string[] = [];
    const notSubclass: string[] = [];
    let exemptedLines = 0;

    for (const f of collect(root)) {
      if (f.endsWith(SANCTIONED)) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!FORBIDDEN.test(line)) return;
        const names = exemptedClassNames(line);
        if (!names) return;
        exemptedLines++;
        for (const name of names) {
          const classes = SANCTIONED_SUBCLASSES[name];
          if (!classes) {
            unregistered.push(`${f}:${i + 1}  instanceof ${name}（未登记，无法核验是否为 HttpError 子类）`);
            continue;
          }
          for (const cls of classes) {
            // 原型链上必须出现 HttpError.prototype。用 instanceof 而非鸭子类型 `.status`：
            // WxpayApiError/DyPayApiError 也有 status 字段，但它们不是 HttpError（见 http-error.ts 注释）。
            if (!(cls.prototype instanceof HttpError)) {
              notSubclass.push(`${f}:${i + 1}  instanceof ${name} —— ${cls.name} 不是 HttpError 子类`);
            }
          }
        }
      });
    }

    // 判据自身的活性：一条都没扫到，说明豁免②/ FORBIDDEN 已经漂移到扫不出东西，
    // 此时「0 条违规 ⇒ 绿」是无信号的全绿。必须让它红。
    expect(exemptedLines).toBeGreaterThan(0);
    expect(unregistered).toEqual([]);
    expect(notSubclass).toEqual([]);
  });
});
