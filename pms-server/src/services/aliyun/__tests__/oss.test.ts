import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `uploadToOSS` 的**超时封顶**（账本条目 PL-asset-library-04 的 oss 半）。
 *
 * ⚠️ 范围：只钉「OSS 转存这一跳」。**不是**「全链路无超时」—— 图片生成侧本来就有超时
 * （`services/wenlv/asset-gen/image-provider.ts` 的 `TIMEOUT_MS`，多图还会线性放宽），
 * 本文件不涉及那一跳。
 *
 * ⚠️ 为什么前置条件是**顶层写 env + 动态 import**：`oss.ts` 的 `ACCESS_KEY` / `SECRET` 是
 * **模块顶层**读 env 的常量（`const ACCESS_KEY = process.env.ALIYUN_ACCESS_KEY_ID || ''`），
 * 而缺凭据时 `getOSSConfig()` 会在上传路径上抛错 ⇒ 桩值必须在**动态 import 之前**落地。
 * 静态 `import` 会被提升到这两行赋值之上，故一律用动态 `import()`。
 * 写在本文件而不是 vitest 配置里：这是本文件自己的前置条件，不该让整包测试都背上
 * 「OSS 凭据已配置」这个语义（`routes/upload.ts` 的 `USE_OSS` 就是读这两个变量的）。
 */
process.env.ALIYUN_ACCESS_KEY_ID = 'test-oss-ak';
process.env.ALIYUN_ACCESS_KEY_SECRET = 'test-oss-sk';

const OSS_MODULE = '../oss.js';

/**
 * 超时用例的**自身上限**。实现若漏了超时，这个计时器先到 —— 于是失败信息写「没超时」，
 * 而不是整包永久挂起（挂起不是「红」，是没有信号）。
 */
const GUARD_MS = 2000;

/**
 * 注入的极小超时。取 25 而非 10：让「错误消息里应该出现的毫秒数」在断言里不易与别的数字混淆。
 */
const INJECTED_TIMEOUT_MS = 25;

type SettleOutcome =
  | { kind: 'resolved'; url: string }
  | { kind: 'rejected'; err: unknown }
  | { kind: 'guard' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadToOSS 超时封顶', () => {
  it('默认路径把真实超时 AbortSignal 传给 fetch（不是 undefined、不是普通对象）', async () => {
    const { uploadToOSS } = await import(OSS_MODULE);
    const inits: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: any, init: any) => {
        inits.push(init);
        return new Response('', { status: 200 });
      }),
    );

    await uploadToOSS(Buffer.from('hello'), 'pms/aliyun-test/a.png', 'image/png');

    expect(inits.length).toBe(1);
    const signal = inits[0].signal;
    // 「配置对象里有 signal 这个键」不算 —— 必须真的是 AbortSignal 实例，
    // 且此刻未中止。**这一条单独不足以**证明超时生效：它只证明传了东西，
    // 下面那条才是「超时会真的发生」。
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('超时真的会触发：fetch 永不 settle 时抛错，而不是静默挂起', async () => {
    const { uploadToOSS } = await import(OSS_MODULE);
    const seen: { signal?: AbortSignal } = {};
    // 桩模拟**真实 fetch 的契约**：自己永不 settle，`init.signal` 中止时才 reject。
    // ⚠️ 这里必须让桩尊重 signal —— 一个「拿到 signal 就当没看见」的桩会让**正确实现**
    // 也永远不 reject（`AbortSignal.timeout` 只负责把 signal 标成 aborted，不会去 reject
    // 别人手里的 promise；真实 undici 是靠监听 signal 才 reject 的）。那样写出来的用例
    // 测的是桩，不是实现。
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: any, init: any) => {
        seen.signal = init?.signal;
        return new Promise<never>((_resolve, reject) => {
          seen.signal!.addEventListener('abort', () => reject(seen.signal!.reason), { once: true });
        });
      }),
    );

    let guard: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let outcome: SettleOutcome = { kind: 'guard' };
    try {
      outcome = await Promise.race([
        uploadToOSS(Buffer.from('x'), 'pms/aliyun-test/b.png', 'image/png', INJECTED_TIMEOUT_MS).then(
          (url: string) => ({ kind: 'resolved' as const, url }),
          (err: unknown) => ({ kind: 'rejected' as const, err }),
        ),
        new Promise<{ kind: 'guard' }>((resolve) => {
          guard = setTimeout(() => resolve({ kind: 'guard' }), GUARD_MS);
        }),
      ]);
    } finally {
      if (guard) clearTimeout(guard);
    }
    const elapsed = Date.now() - started;

    // 两种坏形态分开报：这里「实现漏了超时」与「超时了但没抛错」会给出同一片红，
    // 措辞拉开，红的时候能直接看出是哪一种。
    if (outcome.kind === 'guard') {
      throw new Error(
        `护栏计时器（${GUARD_MS}ms）先到：fetch 永不 settle 时实现没有中断 —— 这是「没超时」。`,
      );
    }
    if (outcome.kind === 'resolved') {
      throw new Error(`fetch 永不 settle 却拿到了 URL（${outcome.url}）：这是「超时了但没抛错」。`);
    }

    // signal 确实是按注入值中止的（名字与实现里 isTimeoutAbort 认的两个名字对齐）。
    expect(seen.signal?.aborted).toBe(true);
    expect(String((seen.signal?.reason as { name?: string } | undefined)?.name)).toMatch(
      /TimeoutError|AbortError/,
    );
    // 只排除「同步立刻失败」这种假命中；真正的证据是上面的 signal 与下面的消息。
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(GUARD_MS);

    // 抛出来了，且一眼能看出是超时、含毫秒数；原错保留在 cause 里（没被吞）。
    expect(outcome.err).toBeInstanceOf(Error);
    const msg = String((outcome.err as Error).message);
    expect(msg).toMatch(/超时/);
    expect(msg).toContain(String(INJECTED_TIMEOUT_MS));
    expect((outcome.err as { cause?: unknown }).cause).toBeTruthy();
  });

  it('对照：正常返回路径未被破坏 —— fetch resolve 时仍返回拼好的 OSS URL', async () => {
    const { uploadToOSS, getOSSUrl } = await import(OSS_MODULE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 200 })),
    );

    const url = await uploadToOSS(Buffer.from('abc'), 'pms/aliyun-test/c.png', 'image/png');

    // 与同模块 `getOSSUrl` 对齐（两者读同一份 OSS_BUCKET / OSS_REGION 常量），
    // 免得把 bucket 名写死在测试里、env 一变就假红。
    expect(url).toBe(getOSSUrl('pms/aliyun-test/c.png'));
    expect(url).toMatch(/^https:\/\//);
  });

  it('对照：!res.ok 仍抛既有行为 `OSS上传失败: <status>`', async () => {
    const { uploadToOSS } = await import(OSS_MODULE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('AccessDenied', { status: 403, statusText: 'Forbidden' })),
    );

    await expect(
      uploadToOSS(Buffer.from('abc'), 'pms/aliyun-test/d.png', 'image/png'),
    ).rejects.toThrow('OSS上传失败: 403');
  });
});
