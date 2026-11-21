import { describe, it, expect } from 'vitest';
import { simulateWenlv } from '../wenlv-simulate.js';
import { validateWenlvIntegrity } from '../wenlv-integrity.js';
import { fixtureLinear, fixtureBrokenChain, fixtureCycle } from '../../test-utils/wenlv-narrative-fixture.js';

describe('simulateWenlv —— 不动点迭代', () => {
  it('链式正例：三个节点全可达、结局可达', () => {
    const f = fixtureLinear('lin');
    const r = simulateWenlv(f);
    expect(r.reachableNodeIds.sort()).toEqual(['lin-n1', 'lin-n2', 'lin-n3']);
    expect(r.reachableEndingIds).toEqual(['lin-e1']);
    expect(r.unreachable).toEqual([]);
  });

  it('断链：n1 不发 key ⇒ n2/n3 都不可达，归因指向 n2 不可达', () => {
    const f = fixtureBrokenChain('brk');
    const r = simulateWenlv(f);
    expect(r.reachableNodeIds.sort()).toEqual(['brk-n1']);
    expect(r.unreachable.map((u) => u.id)).toEqual(['brk-n2', 'brk-n3']);
    expect(r.reachableEndingIds).toEqual([]);
    expect(r.unreachableEndings.map((u) => u.id)).toEqual(['brk-e1']);
    // 链式归因（E6）：n3 要的 pass 由 n2 发，但 n2 自己不可达 ⇒ 归因指向 n2。
    const n3 = r.unreachable.find((u) => u.id === 'brk-n3')!;
    expect(n3.reason).toContain('第二幕');
    expect(r.unreachableEndings[0].reason).toContain('第三幕');
  });

  it('互锁环：静态闸全绿，但模拟器报出两个都不可达（← 这就是本模块存在的理由）', () => {
    const f = fixtureCycle('cyc');
    // 前置断言：静态闸**必须**是绿的，否则这条用例证明不了增量价值。
    const staticErrs = validateWenlvIntegrity({
      product: { id: 'cyc', name: '环' },
      nodes: f.nodes, collectibles: [], endings: f.endings, rewards: [],
    });
    expect(staticErrs, `静态闸本该漏掉这个环，却报错：${staticErrs.join(' / ')}`).toEqual([]);
    // 而模拟器必须抓到。
    const r = simulateWenlv(f);
    expect(r.reachableNodeIds).toEqual([]);
    expect(r.unreachable.map((u) => u.id).sort()).toEqual(['cyc-a', 'cyc-b']);
    expect(r.reachableEndingIds).toEqual([]);
  });

  it('乐观假设必须出现在输出里（E5）', () => {
    const r = simulateWenlv(fixtureLinear('asm'));
    expect(r.assumptions.length).toBeGreaterThan(0);
  });
});
