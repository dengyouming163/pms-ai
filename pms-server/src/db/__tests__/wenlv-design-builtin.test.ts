import { describe, it, expect } from 'vitest';
import { BUILTIN_WENLV_TEMPLATES, assertDesignTokensCompliant } from '../wenlv-design-builtin.js';

/**
 * 断言抛错。等价于 `expect(fn).toThrow()`。
 * ⚠️ 2026-09-19 更正：本行原称「类型桩未声明该 matcher」——已不成立，
 *    `toThrow` 自 d5a65359 起已在桩内。是否可用**以 `src/types/vitest.d.ts` 为准**，
 *    别在本注释里复述桩的成员表（会过期）。本 helper 保留是历史写法。
 */
function expectThrow(fn: () => unknown): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  expect(threw).toBe(true);
}
/** 断言不抛错：替代 not.toThrow */
function expectNoThrow(fn: () => unknown): void {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBe(null);
}
/** 捕获抛出的错误信息（没有抛出则失败） */
function catchMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('预期抛错，但没有抛出');
}

describe('内置设计模板的对比度准入', () => {
  it('三套内置模板全部通过门槛', () => {
    for (const t of BUILTIN_WENLV_TEMPLATES) {
      expectNoThrow(() => assertDesignTokensCompliant(t.id, t.tokens));
    }
  });

  it('三套模板都定义了 surface/primarySoft/accentText（本次补的三个槽位）', () => {
    for (const t of BUILTIN_WENLV_TEMPLATES) {
      expect(t.tokens.colors?.surface).toBeTruthy();
      expect(t.tokens.colors?.primarySoft).toBeTruthy();
      expect(t.tokens.colors?.accentText).toBeTruthy();
    }
  });

  it('赛博的 surface 是深色（浅色会让卡片标题不可见）', () => {
    const cyber = BUILTIN_WENLV_TEMPLATES.find((t) => t.id === 'tpl-cyber')!;
    // 深色 surface 与浅色 text 的对比度必须很高
    expect(cyber.tokens.colors?.surface).toBe('#141A2E');
  });

  it('国潮/赛博的 accent、primary 保持原亮色不变（不得为迁就白字而调深）', () => {
    const guochao = BUILTIN_WENLV_TEMPLATES.find((t) => t.id === 'tpl-guochao')!;
    const cyber = BUILTIN_WENLV_TEMPLATES.find((t) => t.id === 'tpl-cyber')!;
    expect(guochao.tokens.colors?.accent).toBe('#F5C518');
    expect(cyber.tokens.colors?.primary).toBe('#00F0FF');
  });

  it('门槛能抓到不达标组合（防门槛本身失效），错误信息含模板 id 与实测值', () => {
    // 国潮原 accent 作 price 文字时仅 1.63:1，用它当 accentText 必须被拒
    const broken = { colors: { text: '#2B2B2B', surface: '#FFFFFF', accentText: '#F5C518', background: '#FFF8F0', primary: '#C8102E', primarySoft: '#FBEAEC' } };
    expectThrow(() => assertDesignTokensCompliant('tpl-broken', broken as never));

    const msg = catchMessage(() => assertDesignTokensCompliant('tpl-broken', broken as never));
    expect(msg.includes('tpl-broken')).toBe(true);   // 说得清是哪套模板
    expect(msg.includes('accentText')).toBe(true);  // 说得清是哪一对
    expect(msg.includes('1.63')).toBe(true);        // 说得清实测多少
    expect(msg.includes('4.5')).toBe(true);         // 说得清阈值多少
  });

  it('多处不达标一次性全列出，不是首个即返回', () => {
    // text↔surface 1.11、text↔background 1.15、accent↔surface(on-color) 也是中亮度
    const broken = { colors: { text: '#E0F7FA', surface: '#FFFFFF', background: '#F7F5F0', accent: '#808080' } };
    const msg = catchMessage(() => assertDesignTokensCompliant('tpl-multi', broken as never));
    expect(msg.includes('text↔surface')).toBe(true);
    expect(msg.includes('text↔background')).toBe(true);
    expect(msg.includes('accent')).toBe(true);
  });

  it('新增 primary↔surface 规则生效：品牌绿压赛博卡片底 3.51:1 必须被拒', () => {
    // 旧 .claim-copy 用品牌绿 #3A7D5C 压赛博卡片底 #141A2E 实测仅 3.51:1，不达 AA —— 这正是本规则要拦的真实缺陷
    const broken = { colors: { primary: '#3A7D5C', surface: '#141A2E' } };
    const msg = catchMessage(() => assertDesignTokensCompliant('tpl-broken', broken as never));
    expect(msg.includes('primary↔surface')).toBe(true);   // 说得清是哪一对
    expect(msg.includes('主色文字压卡片底')).toBe(true);   // 说得清规则语义
    expect(msg.includes('3.51')).toBe(true);              // 说得清实测多少
  });

  it('缺槽位模板跳过校验，不误报', () => {
    expectNoThrow(() => assertDesignTokensCompliant('tpl-partial', { colors: { primary: '#C8102E' } } as never));
    expectNoThrow(() => assertDesignTokensCompliant('tpl-empty', {} as never));
  });

  it('不可解析为不透明 hex 的色值记为「不达标」，而不是抛未捕获异常', () => {
    // AI 精修会把 LLM 的 rgb(...) 直接写进 theme；门槛必须对任意输入是全函数 ——
    // 要么通过、要么走 failures 给出可读原因，不能以未捕获异常的形态炸掉 seed。
    const nonHex = { colors: { text: '#2B2B2B', surface: 'rgb(20,26,46)' } };
    const msg = catchMessage(() => assertDesignTokensCompliant('tpl-nonhex', nonHex as never));
    expect(msg.includes('tpl-nonhex')).toBe(true);              // 说得清是哪套模板
    expect(msg.includes('text↔surface')).toBe(true);            // 说得清是哪一对
    expect(msg.includes('无法解析为不透明 hex')).toBe(true);     // 说得清原因（走 failures，不是 parseHex 直接炸）

    // 4 位 / 8 位带 alpha 的 hex 同样记为不达标
    const alphaHex = { colors: { primary: '#F5C51880' } };
    const msg2 = catchMessage(() => assertDesignTokensCompliant('tpl-alpha', alphaHex as never));
    expect(msg2.includes('实心底 primary=#F5C51880')).toBe(true);
    expect(msg2.includes('无法解析为不透明 hex')).toBe(true);
  });
});
