import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * docker-compose 白名单一致性门禁。
 *
 * 为什么需要它：pms-server 的 compose 块是**显式 environment 白名单**（没有 env_file），
 * 没列进来的变量**改了 .env 也进不了容器**。失败方向不是报错而是**静默降级** ——
 * `WENLV_IMAGE_PROVIDER` 缺失时 getImageProvider 回落 mock：整批出占位图、
 * 状态全 succeeded、账面记 ¥0，所有测试照样全绿。S3 的交付判据恰恰是「知道花了多少钱」，
 * 所以这条缝必须在**测试里**有信号（2026-09-14 终审 Important-2 的落地门）。
 *
 * 反向危害同样要挡：`WENLV_BYPASS_TICKET` 是双守卫红线，**恰恰不能**进 compose。
 * 所以本门禁不是「见 WENLV_ 就要求进白名单」，而是**两向都断言**（见下）。
 *
 * ⚠️ 诚实说明：这是**源码形状**断言，不是运行时断言。它能抓的是「代码读了 X 而 compose 没列 X」；
 *    抓不到「.env 里其实没填值」—— 那需要在部署时 `docker exec … env` 实测（部署核对项）。
 */

/**
 * 剥注释后再扫。**这一步是承重的**：`WENLV_TTS_VOICE_ID` 全仓库只出现在
 * tts-provider.ts 的一句注释里（那句注释正是在说明「它被**刻意**删掉了」），
 * 不剥注释就会把它当成「代码在读却没配」，把一个已修好的东西报成缺陷 ——
 * 写本文件第一版正是这么红的。
 */
function stripComments(t: string): string {
  return t
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释 / JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（保留 `https://` 这类）
}

/** 递归收集 src 下所有 .ts（排除测试目录），与 no-raw-error-leak 同一套写法。 */
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

/** 受管前缀：文旅 S3 素材生产的 provider / 单价 / 模型配置。 */
const MANAGED = /^(WENLV|ARK)_[A-Z0-9_]+$/;

/**
 * 红线：**必须不在** compose 白名单里。
 *
 * 这份清单是「测试旁路开关」的口子，它们**故意**不可通过 compose 配置，
 * 各自在代码里还有一道 production 守卫（双保险）。新出现任何一个这类开关，
 * 都必须先在这里表态（是「该进白名单」还是「红线」），不许默默过去。
 */
const MUST_BE_ABSENT = [
  // pms-server 守卫：`=== '1' && NODE_ENV !== 'production'`（routes/mini/wenlv.ts）。
  'WENLV_BYPASS_TICKET',
  // pms-server 守卫：`NODE_ENV === 'production'` 直接 return 真实金额（services/wenlv-pay.ts
  // 的 wenlvAmountFen）。列进来在生产也无效，不列则是第二道保险。
  'WENLV_PAY_TEST_AMOUNT_FEN',
];

const ROOT = process.cwd(); // vitest 以 pms-server 为 cwd 运行
const compose = readFileSync(join(ROOT, '..', 'docker-compose.yml'), 'utf8');

/** 切出 `pms-server:` 那个服务块（到下一个顶层服务键为止）。 */
function serviceBlock(name: string): string {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^  ${name}:\\s*$`).test(l));
  // 不带第二参消息、且用 toBeGreaterThan(-1) 而**不是** toBeGreaterThanOrEqual(0)：
  // toBeGreaterThanOrEqual 确实仍不在桩内（同 run-once.db.test.ts 里 toBeUndefined 的先例），
  // 故用等价的 (n) > -1 写法。
  // ⚠️ 2026-09-19 更正：上句原文「这两种都没声明」**不成立**。它指代的东西本身有歧义
  //    （读作「两参 expect / toBeGreaterThanOrEqual」，或「toBeGreaterThan /
  //    toBeGreaterThanOrEqual」都说得通），但两种读法下都至少有一项其实在桩内 ——
  //    桩的 `expect<T>(actual: T, message?: string)` 一直带两参，`toBeGreaterThan` 也早已声明。
  //    故这里不逐项归因。唯一为真的是 toBeGreaterThanOrEqual 不在桩内，那正是换写法的原因。
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^  [a-z0-9-]+:\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('docker-compose 与代码的 env 契约', () => {
  const block = serviceBlock('pms-server');

  it('代码里读的每个 WENLV_/ARK_ 变量都在 pms-server 的 environment 白名单里', () => {
    const files = collect(join(ROOT, 'src'));
    // 两种写法都要收：直接 `process.env.X`，以及**动态取**的
    // `envPrice('WENLV_TTS_UNIT_PRICE')`（pricing.ts 用 `process.env[name]`，
    // 只扫 process.env. 会漏掉这两个单价 —— 那正是最容易「以为门在、其实没覆盖」的地方）。
    const cand = new Set<string>();
    for (const f of files) {
      const t = stripComments(readFileSync(f, 'utf8'));
      for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) cand.add(m[1]);
      for (const m of t.matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) cand.add(m[1]);
    }
    const managed = [...cand].filter(n => MANAGED.test(n) && !MUST_BE_ABSENT.includes(n)).sort();
    // 自检：一个都没收到说明正则/目录跑偏了 —— 那样的「全绿」毫无意义
    expect(managed.length).toBeGreaterThan(0);
    // 失败时打印的就是**缺哪些**（数组元素即变量名），所以不必再挂第二参消息。
    // 含义写进用例名：这些变量被代码读取却不在白名单里 —— 生产走默认/mock 且**无告警**。
    const missing = managed.filter(n => !new RegExp(`^\\s*- ${n}=`, 'm').test(block));
    expect(missing).toEqual([]);
  });

  it('测试旁路开关（BYPASS_TICKET / PAY_TEST_AMOUNT_FEN）**不得**出现在 compose 里', () => {
    // 失败时打印的 false/true 认不出是哪个变量，所以这里把名字并进断言对象本身：
    // 断言 `{ 名字: 是否在 compose 里 }` 深等于 `{ 名字: false }`，红的时候直接看得见是谁。
    const present = Object.fromEntries(
      MUST_BE_ABSENT.map(n => [n, new RegExp(`^\\s*- ${n}=`, 'm').test(compose)]),
    );
    expect(present).toEqual(Object.fromEntries(MUST_BE_ABSENT.map(n => [n, false])));
  });

  it('白名单里的受管变量真的有人读（防空配置：列了但代码从没读）', () => {
    const files = collect(join(ROOT, 'src'));
    const text = files.map(f => readFileSync(f, 'utf8')).join('\n');
    const listed = [...block.matchAll(/^\s*- ([A-Z][A-Z0-9_]*)=/gm)]
      .map(m => m[1]).filter(n => MANAGED.test(n));
    expect(listed.length).toBeGreaterThan(0);
    const dead = listed.filter(n => !text.includes(`'${n}'`) && !text.includes(`.${n}`));
    expect(dead).toEqual([]);
  });
});
