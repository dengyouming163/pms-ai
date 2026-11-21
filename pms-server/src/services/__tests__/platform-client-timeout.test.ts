// platformFetch 的超时可配置：默认仍是 10000（不动既有调用方），显式传入时生效。
// ⚠️ 为什么值得一条测试：AbortSignal.timeout 的实参写成常量 10000 时，
//    「传了 timeoutMs 却没接上」不会有任何编译期或运行期报错 —— 只表现为
//    /unified 在平台慢时超客户端闸（10s），而单测全绿。
// ⚠️ 本仓两条硬约束决定了判据只能这么写（2026-09-27 实测）：
//    ① `vi.useFakeTimers()` **推不动** Node 原生的 `AbortSignal.timeout` —— 它是内部
//       timer，不走 `globalThis.setTimeout`；toFake 里再加 'AbortSignal' 也一样推不动，
//       且会把全局 AbortSignal 弄成 undefined 污染后续用例。
//    ② 本仓 it 的类型桩只有 2 个形参（传不了第 3 个 timeout），而 vitest 默认 5s 会超时
//       ⇒ 「真等 10 秒到点」这条路本仓走不通。
//    所以判据**直接读实参**：spy 住 `AbortSignal.timeout`，断言它收到的是哪个数。
//    这既更强（钉住常量的值，而不只是「没提前 abort」），也是毫秒级。
// ⚠️ 还原一律用 `spy.mockRestore()`：本仓 tsc 下 `vi.restoreAllMocks` 不存在
//    （可用面以 `src/types/vitest.d.ts` 为准）。
// 🔴 阳性对照（第二个用例里）：spy 之后另起一个真的 150ms signal，证明 spy 是**透传**的 ——
//    否则「断言 spy 收到了 6000」等于在测 spy 自己。
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('platformFetch 的可选超时', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('不传 timeoutMs 时仍是 10000（既有调用方语义不变）', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_url: any, opt: any) => {
      seen = opt?.signal;                 // 顺手核一件：signal 真的挂到了 fetch 上
      return new Promise(() => {});       // 永不 settle：本用例只关心传参
    }) as any;
    const { listProductOrders } = await import('../platform-client.js');
    listProductOrders('u-1');
    expect(spy, '默认必须是 10000（写成别的数 ⇒ 既有具名读口的超时语义被改了）').toHaveBeenCalledWith(10000);
    expect(seen, 'signal 必须真的挂到 fetch 上，否则那个 abort 永远不会触发').toBeInstanceOf(AbortSignal);
    spy.mockRestore();
  });

  it('传 timeoutMs=6000 时该值真的落到了 signal 上', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    globalThis.fetch = (() => new Promise(() => {})) as any; // 永不 settle：本用例只关心传参
    const { platformFetchForTest } = await import('../platform-client.js');
    platformFetchForTest('/api/x', { timeoutMs: 6000 });
    expect(spy, 'timeoutMs 必须真的传进 AbortSignal.timeout（写死常量 10000 时这条会红）').toHaveBeenCalledWith(6000);
    // 阳性对照：spy 必须是**透传**的，不是把调用吃掉 —— 否则上面那条断言等于在测 spy 自己
    let fired = false;
    AbortSignal.timeout(150).addEventListener('abort', () => { fired = true; });
    await new Promise((r) => setTimeout(r, 350));
    expect(fired, 'spy 把 AbortSignal.timeout 吃掉了 ⇒ 上面那条断言等于在测 spy 自己').toBe(true);
    spy.mockRestore();
  });
});
