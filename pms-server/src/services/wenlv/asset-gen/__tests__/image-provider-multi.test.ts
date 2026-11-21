import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArkImageProvider, MockImageProvider } from '../image-provider.js';

// ⛔ **`ArkImageProvider` 的构造函数不接参数** —— 已核实：类上没有显式 constructor，
//    apiKey 是**读时**从 env 取的（`image-provider.ts` 的 `private apiKey()`；
//    用 `grep -n "private apiKey"` 定位 —— 别记行号，文件一改它就过期）。
//    写成 `new ArkImageProvider('k')` 会同时踩两个坑：
//      ① **ts-check 报 TS2554**（Expected 0 arguments, but got 1）—— Step 6 会跑 ts-check，
//         这是硬红；
//      ② 就算跳过类型检查，运行时 key 仍为空 ⇒ 在 `fetch` 之前就抛
//         「未配置 ARK_API_KEY，无法调用 Seedream」，**七条用例全红，且红的理由与
//         「契约没改」无关** —— 那是测试自己不成立，不是代码不成立，最容易误判的一类。
//    既有 `__tests__/image-provider.test.ts` 的写法就是「每条用例先设 env、再 `new` 无参」，
//    照抄它，别自创。
beforeEach(() => { process.env.ARK_API_KEY = 'test-key'; });
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARK_API_KEY;
});

const mkRes = (urls: string[]) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ data: urls.map(u => ({ url: u })) }),
});

function stubFetch() {
  const calls: any[] = [];
  const fn = vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    return mkRes(['https://oss/1.jpg', 'https://oss/2.jpg', 'https://oss/3.jpg']) as never;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** 造一个 body 完全可控的 2xx 应答（`raw` 原样作为 body 文本）。 */
function stubRaw(raw: string) {
  vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => raw }) as never);
}

/** 拿到抛出的错误对象（用于核对消息形态，而不只是「抛了就行」）。 */
async function caught(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('预期抛错，但没有');
}

describe('Ark provider 多参考图 / 多产物', () => {
  it('单张参考图 → body.image 是字符串（本层自定的形态，上游解释待真跑验证）', async () => {
    const calls = stubFetch();
    await new ArkImageProvider().generate('p', { assetType: 'background', referenceUrls: ['https://a/1.jpg'] });
    expect(calls[0].image).toBe('https://a/1.jpg');
  });

  it('多张参考图 → body.image 是数组，且**顺序即入参顺序**（锚图在前）', async () => {
    const calls = stubFetch();
    await new ArkImageProvider().generate('p', {
      assetType: 'background',
      referenceUrls: ['https://a/anchor.jpg', 'https://a/ref1.jpg', 'https://a/ref2.jpg'],
    });
    expect(calls[0].image).toEqual(['https://a/anchor.jpg', 'https://a/ref1.jpg', 'https://a/ref2.jpg']);
  });

  it('参考图为空 → body 里**没有** image 键（不是空串、不是空数组）', async () => {
    const calls = stubFetch();
    await new ArkImageProvider().generate('p', { assetType: 'background', referenceUrls: [] });
    expect('image' in calls[0]).toBe(false);
  });

  it('候选数 >1 → 带 sequential_image_generation 与 max_images，且**不带 n**', async () => {
    const calls = stubFetch();
    await new ArkImageProvider().generate('p', { assetType: 'background', referenceUrls: [], candidates: 3 });
    expect(calls[0].sequential_image_generation).toBe('auto');
    expect(calls[0].sequential_image_generation_options).toEqual({ max_images: 3 });
    expect('n' in calls[0]).toBe(false);   // 方舟对 n 报 400
  });

  it('候选数 =1 → 不带 sequential 字段（保持与既有单图路径完全一致）', async () => {
    const calls = stubFetch();
    await new ArkImageProvider().generate('p', { assetType: 'background', referenceUrls: [] });
    expect('sequential_image_generation' in calls[0]).toBe(false);
  });

  it('返回 urls 数组，长度 = 上游实际返回张数（少返回时不补空）', async () => {
    stubFetch();
    const r = await new ArkImageProvider().generate('p', {
      assetType: 'background', referenceUrls: [], candidates: 4,
    });
    expect(r.urls).toEqual(['https://oss/1.jpg', 'https://oss/2.jpg', 'https://oss/3.jpg']);
  });

  it('超时随候选数放宽：1 张 120s，4 张 300s', async () => {
    expect(ArkImageProvider.timeoutFor(1)).toBe(120_000);
    expect(ArkImageProvider.timeoutFor(4)).toBe(300_000);
  });

  it('超时对非法候选数有定义：NaN / Infinity / 0 / 负数一律按 1 张（120s），不产出非法 abort delay', () => {
    // `Math.max(1, NaN)` 仍是 NaN ⇒ 旧写法会一路走到 `AbortSignal.timeout(NaN)` 抛 RangeError，
    // 被 fetch 的 catch 接住后标成「网络」失败 —— 一个错误的失败类别。
    for (const bad of [NaN, Infinity, -Infinity, 0, -3]) {
      expect(ArkImageProvider.timeoutFor(bad)).toBe(120_000);
    }
  });

  it('candidates=NaN 端到端：不抛、真发出请求、body 不带 sequential、abort delay 是基准 120s', async () => {
    // 上一条只测了静态 timeoutFor(NaN)；这条钉住整条语义。
    // 若 timeoutFor 退回 `Math.max(1, NaN)`（= NaN），`AbortSignal.timeout(NaN)` 会抛
    // RangeError，被 fetch 的 catch 标成「网络」失败 —— 本条的「不抛」就会红。
    const calls = stubFetch();
    // 不用 vi.spyOn：本仓自写的 vitest.d.ts 类型桩没声明它（用了会挂 ts-check）。
    // 按仓内既有做法直接接管 + finally 还原。
    const orig = AbortSignal.timeout;
    const delays: number[] = [];
    (AbortSignal as any).timeout = (ms: number) => { delays.push(ms); return orig.call(AbortSignal, ms); };
    try {
      // ① 不抛（RangeError 被 catch 成业务错误的话这里就炸）
      const r = await new ArkImageProvider().generate('x', { assetType: 'background', candidates: NaN });
      expect(r.urls.length).toBe(3);   // stub 返回 3 张，原样透传（未传 candidates 时上游返回几张就是几张）
    } finally {
      (AbortSignal as any).timeout = orig;
    }
    expect(calls.length).toBe(1);                                   // ② fetch 真的被调用过
    expect('sequential_image_generation' in calls[0]).toBe(false);  // ③ `NaN > 1` 为 false，不带多图字段
    expect(delays).toEqual([120_000]);                              // ④ 兜底成基准 delay，不是 NaN
  });

  it('混合数组：第一张合法、第二张非法 ⇒ 仍整条失败（专打 malformed 那一支）', async () => {
    // 这条**专打 clause ③**：`urls.length === 1`（clause ② 「一张合法 URL 都没有」不成立），
    // `res.ok === true`（clause ① 不成立）—— 只有 `malformed > 0` 能让它失败。
    // 若该分支被删掉，本用例会返回 `['https://ok.test/1.jpg']` 而**静默丢弃**坏的那张，
    // 落库张数因此少于上游实际返回数，而成本核对正是靠张数。
    stubRaw(JSON.stringify({ data: [{ url: 'https://ok.test/1.jpg' }, { url: 'null' }] }));
    await expect(new ArkImageProvider().generate('p', { assetType: 'background' }))
      .rejects.toThrow(/形态非法/);
  });

  it('data 是对象而非数组 ⇒ 抛出带 HTTP 状态的业务错误，不是逃逸的 TypeError', async () => {
    // 没有 `Array.isArray` 守卫时，`data.data.map` 抛 `TypeError: ... is not a function`，
    // 它会原样逃出 generate()，被 markFailed 写成用户可见的 error_message ——
    // 把「HTTP 状态 / detail / body 摘录」这套诊断换成一句无信息的 TypeError。
    stubRaw(JSON.stringify({ data: { url: 'x' } }));
    const err = await caught(() => new ArkImageProvider().generate('p', { assetType: 'background' }));
    expect(err.message).toContain('HTTP 200');
    expect(err.message).not.toContain('is not a function');
  });
});

describe('MockImageProvider 多候选', () => {
  it('candidates=3 ⇒ urls 长度 3，且**三个 URL 互不相同**', async () => {
    // 长度映射是 `opts.candidates` 在 mock 里**唯一**的可观察效果（Task 10 会据此落素材行数）；
    // 「互不相同」对齐真实 provider（N 个不同地址），否则按 URL 去重的逻辑在 mock 下与生产下不同。
    const r = await new MockImageProvider().generate('x', { assetType: 'background', candidates: 3 });
    expect(r.urls.length).toBe(3);
    expect(new Set(r.urls).size).toBe(3);
  });

  it('candidates=1 或不传 ⇒ urls 长度 1（单图路径不变）', async () => {
    expect((await new MockImageProvider().generate('x', { assetType: 'background', candidates: 1 })).urls.length).toBe(1);
    expect((await new MockImageProvider().generate('x', { assetType: 'background' })).urls.length).toBe(1);
  });

  it('候选下标标记不破坏既有的 q / ref 标记（人工判据仍可用）', async () => {
    const r = await new MockImageProvider().generate('x', {
      assetType: 'background', referenceUrls: ['https://oss.test/a.png'], candidates: 2,
    });
    for (const u of r.urls) {
      expect(u).toContain('placeholder.local/background');
      expect(u).toContain('&ref=1');
      expect(u).toContain('&cand=');
    }
  });
});
