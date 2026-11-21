import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockImageProvider, ArkImageProvider, getImageProvider, TIMEOUT_MS } from '../image-provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
  // 4 个 env 一律清 —— 漏一个就会让同文件后续用例随机红/绿
  //（如 WENLV_IMAGE_MODEL 残留导致 `expected 'some-other-model' to be '<默认>'`，
  //  ARK_BASE_URL 残留则把后续用例指向错误 host）。
  delete process.env.WENLV_IMAGE_PROVIDER;
  delete process.env.ARK_API_KEY;
  delete process.env.WENLV_IMAGE_MODEL;
  delete process.env.ARK_BASE_URL;
});

/** 造一个可控的 fetch 应答。`raw` 原样作为 body 文本返回。 */
function stubReply(init: { ok: boolean; status: number; raw: string }) {
  const calls: { url: string; init: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, i: any) => {
    calls.push({ url, init: i });
    return { ok: init.ok, status: init.status, text: async () => init.raw } as any;
  });
  return calls;
}

/** 拿到抛出的错误对象（用于比较两条失败消息是否可区分）。 */
async function caught(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('预期抛错，但没有');
}

describe('provider 选择', () => {
  it('未配置时默认 mock', () => {
    delete process.env.WENLV_IMAGE_PROVIDER;
    expect(getImageProvider().name).toBe('mock');
  });
  it('配了 ark 走字节 Seedream', () => {
    process.env.WENLV_IMAGE_PROVIDER = 'ark';
    expect(getImageProvider().name).toBe('seedream');
  });
  it('大小写归一：ARK / Seedream 都能命中，且不告警', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: any) => { warns.push(String(m)); };
    try {
      process.env.WENLV_IMAGE_PROVIDER = 'ARK';
      expect(getImageProvider().name).toBe('seedream');
      process.env.WENLV_IMAGE_PROVIDER = 'Seedream';
      expect(getImageProvider().name).toBe('seedream');
      // 显式的 mock 与纯空白（= 未配置）都是合法配置，绝不能进「未识别」告警分支：
      // 误报会把运维训练成无视这条告警，而它必须一直有意义。
      process.env.WENLV_IMAGE_PROVIDER = 'mock';
      expect(getImageProvider().name).toBe('mock');
      process.env.WENLV_IMAGE_PROVIDER = '   ';
      expect(getImageProvider().name).toBe('mock');
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(0);
  });
  it('WENLV_IMAGE_PROVIDER 拼错时回落 mock 并出声告警', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: any) => { warns.push(String(m)); };
    try {
      for (const bad of ['ARK1', 'seedream4', 'volc', 'doubao']) {
        process.env.WENLV_IMAGE_PROVIDER = bad;
        expect(getImageProvider().name).toBe('mock');
      }
    } finally {
      console.warn = orig;
    }
    // 4 个未识别值，每个都必须告警（静默用 mock = 以为出了真图、实际占位图且没花钱）
    expect(warns.length).toBe(4);
    expect(warns[0]).toContain('未识别');
    expect(warns[0]).toContain('ARK1');
  });
});

describe('MockImageProvider', () => {
  it('产出占位图 URL，域名一眼可辨', async () => {
    const r = await new MockImageProvider().generate('一只猫', { assetType: 'background' });
    expect(r.urls[0]).toContain('placeholder.local');
    expect(r.provider).toBe('mock');
  });
  it('不返回真实上游 URL（防止有人误以为真出图了）', async () => {
    const r = await new MockImageProvider().generate('x', { assetType: 'stamp' });
    // 正向性质：host 必须恰好是 placeholder.local（而非「不含某几个域名」这种弱断言）
    expect(new URL(r.urls[0]).host).toBe('placeholder.local');
  });
  it('纯空白参考图与「无参考图」等价 —— 与真实 provider 同一规则', async () => {
    const p = new MockImageProvider();
    // 真实 provider 会 trim 后丢弃空白串；mock 若不丢，基于 mock 的人工判据就会
    // 报出一个真实 provider 永远不会发的参考图标记。
    const blank = await p.generate('x', { assetType: 'background', referenceUrls: ['   '] });
    expect(blank.urls[0]).not.toContain('ref=1');
  });
  it('带参考图时 URL 上有标记（便于人工判据分辨锚定是否生效）', async () => {
    const p = new MockImageProvider();
    const withRef = await p.generate('x', { assetType: 'background', referenceUrls: ['https://oss.example.com/a.png'] });
    const noRef = await p.generate('x', { assetType: 'background' });
    expect(withRef.urls[0]).toContain('ref=1');
    expect(noRef.urls[0]).not.toContain('ref=1');
  });
  it('assetType 做 URL 编码，不让 # / <> 逃出路径段', async () => {
    const r = await new MockImageProvider().generate('x', { assetType: 'stamp#frag<svg>' });
    expect(r.urls[0]).toContain(encodeURIComponent('stamp#frag<svg>'));
    expect(new URL(r.urls[0]).pathname).toContain('%23');
  });
});

describe('ArkImageProvider（stub fetch）', () => {
  const OK = JSON.stringify({ data: [{ url: 'https://ark.example.com/a.png' }] });

  it('把参考图放进请求体 —— 这是防漂移的落点，丢了它锚图就白做了', async () => {
    process.env.ARK_API_KEY = 'test-key';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    const r = await new ArkImageProvider().generate('画一只猫', {
      assetType: 'background', referenceUrls: ['https://oss.example.com/anchor.png'],
    });
    expect(JSON.parse(calls[0].init.body).image).toBe('https://oss.example.com/anchor.png');
    // 整个设计前提是「组装好的风格圣经 prompt 就是载荷」：静默丢掉 prompt，
    // 出图就不受任何约束而套件全绿。故请求体逐字段钉死。
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      model: 'doubao-seedream-4-0-250828',
      prompt: '画一只猫',
      size: '2K',
      // 代码读的是 data[].url（逐张）—— 翻成 b64_json 会返回一张用不了的图
      response_format: 'url',
      watermark: false,
    });
    // 丢了 Content-Type，方舟会 400，而套件此前察觉不到
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    // 标签有账务后果：pricing.ts 对 'mock' 记 ¥0，真出图错报成 mock 即「凭空造钱」
    expect(r.provider).toBe('seedream');
  });

  it('不带参考图时请求体里没有 image 字段（锚图自身就是这样生成的）', async () => {
    process.env.ARK_API_KEY = 'test-key';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    await new ArkImageProvider().generate('画一只猫', { assetType: 'background' });
    // 不写 toBeUndefined() —— toBe(undefined) 语义等价；该 matcher 确实仍不在桩内。
    // ⚠️ 2026-09-19 更正：原注释括号里的「（同 toThrow）」已不成立 —— toThrow 自
    //    d5a65359 起已在桩内。是否可用以 src/types/vitest.d.ts 为准。
    expect(JSON.parse(calls[0].init.body).image).toBe(undefined);
  });

  it('参考图为纯空白串时当作「没有参考图」，不把空格传给上游', async () => {
    process.env.ARK_API_KEY = 'test-key';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    await new ArkImageProvider().generate('x', { assetType: 'stamp', referenceUrls: ['   '] });
    expect(JSON.parse(calls[0].init.body).image).toBe(undefined);
  });

  it('关掉平台水印 —— 素材要能用', async () => {
    process.env.ARK_API_KEY = 'test-key';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    await new ArkImageProvider().generate('x', { assetType: 'stamp' });
    expect(JSON.parse(calls[0].init.body).watermark).toBe(false);
  });

  it('endpoint / Authorization / 超时 signal 都真的用上了', async () => {
    process.env.ARK_API_KEY = 'test-key';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    await new ArkImageProvider().generate('x', { assetType: 'stamp' });
    expect(calls[0].url.endsWith('/images/generations')).toBe(true);
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    // 不用 toBeInstanceOf —— 类型桩没声明它
    expect(calls[0].init.signal instanceof AbortSignal).toBe(true);
  });

  it('ARK_API_KEY 两侧空白被 trim —— 否则 Authorization 带尾空格直接 401', async () => {
    process.env.ARK_API_KEY = ' test-key ';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    await new ArkImageProvider().generate('x', { assetType: 'stamp' });
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
  });

  it('超时阈值是「给足时间」的量级，不是几十毫秒', () => {
    // 调成 50ms 会让几乎每一次真实请求都在拿到图之前超时
    expect(TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it('超时被标成「超时」，不与普通网络失败坍缩成同一种诊断', async () => {
    process.env.ARK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', async () => {
      // 忠实复刻 AbortSignal.timeout 的拒绝：name/code 有，cause 没有（故走 e 自身）
      const e: any = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      e.code = 23;
      throw e;
    });
    const err = await caught(() => new ArkImageProvider().generate('x', { assetType: 'stamp' }));
    expect(err.message).toContain('超时');
  });

  it('WENLV_IMAGE_MODEL / ARK_BASE_URL 纯空白时回落默认值', async () => {
    process.env.ARK_API_KEY = 'test-key';
    process.env.WENLV_IMAGE_MODEL = '   ';
    process.env.ARK_BASE_URL = '   ';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    const r = await new ArkImageProvider().generate('x', { assetType: 'stamp' });
    expect(JSON.parse(calls[0].init.body).model).toBe('doubao-seedream-4-0-250828');
    // 不能是相对路径（相对路径会让真 fetch 抛 `Failed to parse URL`，且消息里没有环境变量名）
    expect(calls[0].url.startsWith('https://ark.cn-beijing.volces.com/api/v3/')).toBe(true);
    expect(r.model).toBe('doubao-seedream-4-0-250828');
  });

  it('ARK_BASE_URL 末尾斜杠被去掉，不拼出 //images/generations', async () => {
    process.env.ARK_API_KEY = 'test-key';
    process.env.ARK_BASE_URL = 'https://ark.example.com/api/v3/';
    const calls = stubReply({ ok: true, status: 200, raw: OK });
    await new ArkImageProvider().generate('x', { assetType: 'stamp' });
    expect(calls[0].url).toBe('https://ark.example.com/api/v3/images/generations');
  });

  it('非 2xx 时把上游错误信息带进消息', async () => {
    process.env.ARK_API_KEY = 'test-key';
    stubReply({ ok: false, status: 400, raw: JSON.stringify({ error: { message: 'Invalid model id' } }) });
    await expect(new ArkImageProvider().generate('x', { assetType: 'stamp' }))
      .rejects.toThrow(/Invalid model id/);
    stubReply({ ok: false, status: 400, raw: JSON.stringify({ error: { message: 'Invalid model id' } }) });
    const err = await caught(() => new ArkImageProvider().generate('x', { assetType: 'stamp' }));
    expect(err.message).toContain('400');
  });

  it('非 2xx 且 body 无错误字段时至少报出状态码', async () => {
    process.env.ARK_API_KEY = 'test-key';
    stubReply({ ok: false, status: 500, raw: '{}' });
    await expect(new ArkImageProvider().generate('x', { assetType: 'stamp' }))
      .rejects.toThrow(/HTTP 500/);
  });

  it('2xx 但 body 不是 JSON 时能与「data 为空」区分开', async () => {
    process.env.ARK_API_KEY = 'test-key';
    stubReply({ ok: true, status: 200, raw: '<html>502 Bad Gateway</html>' });
    const htmlErr = await caught(() => new ArkImageProvider().generate('x', { assetType: 'stamp' }));
    expect(htmlErr.message).toContain('非 JSON');

    stubReply({ ok: true, status: 200, raw: JSON.stringify({ data: [] }) });
    const emptyErr = await caught(() => new ArkImageProvider().generate('x', { assetType: 'stamp' }));
    // 两者必须可区分 —— 这正是旧实现坍缩掉的诊断信息
    expect(htmlErr.message === emptyErr.message).toBe(false);
  });

  it('非 2xx 即使 body 里带了 url 也算失败（状态码优先于形态）', async () => {
    process.env.ARK_API_KEY = 'test-key';
    stubReply({
      ok: false,
      status: 403,
      raw: JSON.stringify({ data: [{ url: 'https://ark.example.com/x.png' }], error: { message: 'rate limited' } }),
    });
    await expect(new ArkImageProvider().generate('x', { assetType: 'stamp' }))
      .rejects.toThrow(/HTTP 403/);
  });

  it('2xx 但 data 为空数组时抛错，不返回 undefined URL', async () => {
    process.env.ARK_API_KEY = 'test-key';
    stubReply({ ok: true, status: 200, raw: JSON.stringify({ data: [] }) });
    await expect(new ArkImageProvider().generate('x', { assetType: 'stamp' }))
      .rejects.toThrow(/HTTP 200/);
  });

  it('上游把 url 返回成字符串 "null" 时算失败，不落一个假成功', async () => {
    process.env.ARK_API_KEY = 'test-key';
    stubReply({ ok: true, status: 200, raw: JSON.stringify({ data: [{ url: 'null' }] }) });
    await expect(new ArkImageProvider().generate('x', { assetType: 'stamp' }))
      .rejects.toThrow(/HTTP 200/);
  });

  it('部分 URL 非法时抛错，但错误对象带上「上游实际产出的张数」（判别力：不带则为 undefined 而红）', async () => {
    // 为什么必须挂在错误对象上：调度器的 catch（`wenlv-asset-gen-scheduler.ts`）只能看到
    // 错误消息，而消息里那句「（N 张 URL 形态非法）」的 N 是**被拒收**的张数，
    // 不是**实际产出**的张数 —— 拿它计费会把「少算」变成「按错的数少算」。
    // 本用例的夹具刻意让两者不等（产出 3 / 拒收 1），否则断言不出「挂的是哪个数」。
    process.env.ARK_API_KEY = 'test-key';
    stubReply({
      ok: true, status: 200,
      raw: JSON.stringify({
        data: [
          { url: 'https://ark.example.com/a.png' },
          { url: 'https://ark.example.com/b.png' },
          { url: 'null' },                        // 形态非法 → 被我们拒收
        ],
      }),
    });
    const err = await new ArkImageProvider()
      .generate('p', { assetType: 'scene', referenceUrls: [], candidates: 3 })
      .then(() => null).catch((e) => e);
    expect(err).toBeTruthy();
    expect((err as any).producedCount).toBe(3);   // 上游真的产出了 3 张、真的计了 3 张的钱
    expect((err as any).rejectedCount).toBe(1);   // 我们只拒收了 1 张
  });

  it('非 2xx 时不认「已产出」：响应体里带着的 URL 不算上游产出（判别力：一律按原始长度记则此条红）', async () => {
    // 状态码优先于形态（见 image-provider.ts 的 ①）。403 是错误信封，里面的 data
    // 不是产物、不该计费 —— 否则一次被拒的请求会被记成「上游出了 1 张」，凭空造钱，
    // 还会顺带吃掉批次熔断的额度。张数与 rejectedCount 同时为 0。
    process.env.ARK_API_KEY = 'test-key';
    stubReply({
      ok: false, status: 403,
      raw: JSON.stringify({ data: [{ url: 'https://ark.example.com/x.png' }], error: { message: 'rate limited' } }),
    });
    const err = await new ArkImageProvider()
      .generate('p', { assetType: 'scene', referenceUrls: [] })
      .then(() => null).catch((e) => e);
    expect(err).toBeTruthy();
    expect((err as any).producedCount).toBe(0);
    expect((err as any).rejectedCount).toBe(0);
  });

  it('网络层失败时把 URL 与 cause 上的诊断码带出来', async () => {
    process.env.ARK_API_KEY = 'test-key';
    vi.stubGlobal('fetch', async () => {
      const e: any = new TypeError('fetch failed');
      e.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND ark.example.com' };
      throw e;
    });
    const err = await caught(() => new ArkImageProvider().generate('x', { assetType: 'stamp' }));
    expect(err.message).toContain('ENOTFOUND');
    expect(err.message).toContain('/images/generations');
  });

  it('未配 key 时抛错，不静默降级', async () => {
    delete process.env.ARK_API_KEY;
    await expect(new ArkImageProvider().generate('x', { assetType: 'stamp' }))
      .rejects.toThrow('ARK_API_KEY');
  });
});
