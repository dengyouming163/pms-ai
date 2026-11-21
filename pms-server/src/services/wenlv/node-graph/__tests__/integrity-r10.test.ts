import { describe, it, expect } from 'vitest';
import { checkFreeBypass } from '../integrity.js';
import type { WenlvAtom, WenlvAtomType } from '../../../../db/schema/wenlv.js';

// R10 是纯函数校验：夹具只需 id/title/atoms（不连库），真实场景行结构见
// db/schema/wenlv.ts 的 pmsBuiWenlvScenes（title notNull、atoms jsonb 可空）。
interface R10Node {
  id: string;
  title: string | null;
  atoms?: WenlvAtom[] | null;
}

const node = (atoms: WenlvAtom[], title: string | null = '晚饭'): R10Node => ({ id: 'n1', title, atoms });
const atom = (id: string, type: WenlvAtomType, config: Record<string, unknown> = {}): WenlvAtom =>
  ({ id, type, config });

describe('R10 免费旁路校验', () => {
  it('商业原子无 bypass ⇒ 报 R10', () => {
    const errs = checkFreeBypass([node([
      atom('a1', 'cipher-contact', { cipherPhrase: '老规矩' }),
    ])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^R10:/);
    expect(errs[0]).toContain('晚饭');
  });

  it('商业原子带 bypass.how ⇒ 通过', () => {
    const errs = checkFreeBypass([node([
      atom('a1', 'cipher-contact', { cipherPhrase: '老规矩', bypass: { how: '邻桌旁听获70%情报' } }),
    ])]);
    expect(errs).toHaveLength(0);
  });

  it('非商业原子无需 bypass；无 atoms 节点零报错（老剧本零变更）', () => {
    expect(checkFreeBypass([node([])])).toHaveLength(0);
    expect(checkFreeBypass([{ id: 'n2', title: '老节点', atoms: null }])).toHaveLength(0);
    expect(checkFreeBypass([{ id: 'n3', title: '老节点' }])).toHaveLength(0);
    expect(checkFreeBypass([node([
      atom('a2', 'human-quest', { questBrief: 'x' }),
    ])])).toHaveLength(0);
  });

  // 其余 3 类商业原子缺 bypass 同样必须被拦（商业原子恰 4 类，isCommerceAtom 全量覆盖）。
  for (const type of ['merchant-grant', 'token-redeem', 'paid-customization'] as const) {
    it(`商业原子 ${type} 无 bypass ⇒ 报 1 条 R10`, () => {
      const errs = checkFreeBypass([node([atom('a1', type)])]);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/^R10:/);
    });
  }

  it('同节点多个商业原子全缺 bypass ⇒ 错误条数=原子数，且逐条定位到原子', () => {
    const errs = checkFreeBypass([node([
      atom('a1', 'cipher-contact', { cipherPhrase: '老规矩' }),
      atom('a2', 'merchant-grant', { grantCollectibleIds: ['c1'] }),
      { id: 'a3', type: 'token-redeem', title: '信物兑换', config: { rewardId: 'r1' } },
    ])]);
    expect(errs).toHaveLength(3);
    expect(errs.every((e) => /^R10:/.test(e))).toBe(true);
    expect(errs.some((e) => e.includes('「a1」'))).toBe(true);
    expect(errs.some((e) => e.includes('「a2」'))).toBe(true);
    // 原子有 title 时消息用 title 定位，没有才回退 id。
    expect(errs.some((e) => e.includes('「信物兑换」'))).toBe(true);
  });

  it('bypass 存在但 how 为空白字符串 ⇒ 仍报 R10（trim 判定）', () => {
    for (const how of ['', '   ', '\t\n ']) {
      const errs = checkFreeBypass([node([
        atom('a1', 'cipher-contact', { cipherPhrase: '老规矩', bypass: { how } }),
      ])]);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/^R10:/);
    }
  });

  it('bypass.how 非字符串 / bypass 结构非法 ⇒ 仍报 R10', () => {
    expect(checkFreeBypass([node([
      atom('a1', 'cipher-contact', { cipherPhrase: '老规矩', bypass: { how: 123 } }),
    ])])).toHaveLength(1);
    expect(checkFreeBypass([node([
      atom('a2', 'cipher-contact', { cipherPhrase: '老规矩', bypass: 'not-an-object' }),
    ])])).toHaveLength(1);
    expect(checkFreeBypass([node([
      atom('a3', 'cipher-contact', { cipherPhrase: '老规矩', bypass: null }),
    ])])).toHaveLength(1);
  });

  it('节点标题为 null 时回退用节点 id 定位', () => {
    const errs = checkFreeBypass([node([atom('a1', 'cipher-contact')], null)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('n1');
  });
});
