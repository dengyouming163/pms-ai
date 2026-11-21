import { describe, it, expect, afterEach, vi } from 'vitest';
import { isAssetGenPaused, setAssetGenPaused } from '../../../wenlv-asset-gen-scheduler.js';

describe('资产生成总闸（env + 内存开关，任一为真即暂停）', () => {
  afterEach(() => {
    // ⚠️ 别把这段说成「跨文件守卫」——**vitest 每个测试文件独立进程，env 天然不跨文件**
    //    （2026-09-18 探针实证：造一对文件，A 在**模块作用域**写 WENLV_ASSET_GEN_PAUSED=1
    //     并自测读得到（证明不是空写），B 断言自己读到 undefined —— 自然序 + 5 个
    //     --sequence.shuffle 种子下 B 全绿；**对照组**把 B 的期望改成 '1' 后 B 立刻变红
    //     （expected undefined to be '1'），证明 B 这条断言是活的、不是恒真）。
    //    `vi.stubEnv` 的植入同样只在**本进程**内有效。
    //
    // 保留这两行的真实理由是**同文件内**的卫生，别夸大它的区分力：
    //   · `setAssetGenPaused(false)`：模块级 `pausedByAdmin` 在同文件内确实共享。当前声明序下
    //     每条用例收尾时它恰好都是 false，所以删掉这两行实测仍是 5 passed（零区分力）——
    //     但只要某条用例在「置 true 之后、复位之前」失败退出，或将来调整/打乱用例顺序，
    //     它立刻变成真守卫。属「现在不承重、改一下就承重」的那类，故留着。
    //   · `vi.unstubAllEnvs()`：同理。本文件最后一条用例植的是 env='1'，后面没有用例了，
    //     所以声明序下也不承重。
    // 想让它有咬合力，只能再加一条「顺序无关」的用例（如把 env 断言放到最后），本 Task 不做。
    vi.unstubAllEnvs();
    setAssetGenPaused(false);
  });

  it('env 未设 → 不暂停', () => {
    expect(isAssetGenPaused()).toBe(false);
  });

  it('env = 1 → 暂停', () => {
    vi.stubEnv('WENLV_ASSET_GEN_PAUSED', '1');
    expect(isAssetGenPaused()).toBe(true);
  });

  it('env = 0 / 空串 / 空白 → 不暂停（不是「设了就算」）', () => {
    for (const v of ['0', '', '   ']) {
      vi.stubEnv('WENLV_ASSET_GEN_PAUSED', v);
      expect(isAssetGenPaused()).toBe(false);
    }
  });

  it('内存开关 → 暂停；关掉 → 恢复', () => {
    setAssetGenPaused(true);
    expect(isAssetGenPaused()).toBe(true);
    setAssetGenPaused(false);
    expect(isAssetGenPaused()).toBe(false);
  });

  it('env 与内存开关是「或」：env=1 + 内存关 → 仍暂停', () => {
    vi.stubEnv('WENLV_ASSET_GEN_PAUSED', '1');
    setAssetGenPaused(false);
    expect(isAssetGenPaused()).toBe(true);
  });
});
