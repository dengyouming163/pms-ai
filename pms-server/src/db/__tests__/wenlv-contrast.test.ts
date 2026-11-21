import { describe, it, expect } from 'vitest';
import { contrastRatio, relativeLuminance } from '../wenlv-contrast.js';

/** 两位小数取整：替代 toBeCloseTo（仓库**自写**的类型桩 src/types/vitest.d.ts 未声明该 matcher，故类型解析不到；桩头部约定用时补桩） */
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 断言抛错。等价于 `expect(fn).toThrow()`。
 * ⚠️ 2026-09-19 更正：本行原称「类型桩未声明 toThrow」——已不成立，
 *    `toThrow` 自 d5a65359 起已在桩内。是否可用以 `src/types/vitest.d.ts` 为准。
 *    本 helper 保留是历史写法。
 */
function expectThrow(fn: () => unknown): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  expect(threw).toBe(true);
}

describe('contrastRatio（WCAG 2.x）', () => {
  it('黑白基准 21:1', () => {
    expect(r2(contrastRatio('#FFFFFF', '#000000'))).toBe(21);
  });
  it('同色 1:1', () => {
    expect(r2(contrastRatio('#FFFFFF', '#FFFFFF'))).toBe(1);
  });
  it('三套模板的实测值（本计划的诊断依据，钉死防漂移）', () => {
    // 国潮亮金：作角标白字底与作价格文字色都不达标
    expect(r2(contrastRatio('#F5C518', '#FFFFFF'))).toBe(1.63);
    // 赛博浅字压白卡：卡片标题不可见的根因
    expect(r2(contrastRatio('#E0F7FA', '#FFFFFF'))).toBe(1.11);
    // 赛博霓虹底配白字：按钮白字不可读
    expect(r2(contrastRatio('#00F0FF', '#FFFFFF'))).toBe(1.41);
    // 同一霓虹底配深字则达标
    expect(r2(contrastRatio('#00F0FF', '#0A0E1A'))).toBe(13.67);
    // 国潮深红底配白字达标
    expect(r2(contrastRatio('#C8102E', '#FFFFFF'))).toBe(5.88);
  });
  it('三段简写与大小写都要支持', () => {
    expect(r2(contrastRatio('#fff', '#000'))).toBe(21);
    expect(r2(contrastRatio('#FFF', '#000'))).toBe(21);
    expect(r2(contrastRatio('#abc', '#abc'))).toBe(1);
  });
  it('参数顺序无关（谁亮谁暗自动排）', () => {
    // 内部按亮度自动分亮暗，两次调用结果必然逐位相等
    expect(contrastRatio('#000', '#fff')).toBe(contrastRatio('#fff', '#000'));
  });
  it('非法输入抛中文错误，不静默错算', () => {
    expectThrow(() => contrastRatio('深蓝', '#fff'));
    expectThrow(() => contrastRatio('#12345', '#fff'));   // 5 位 hex 在 CSS 里非法
    expectThrow(() => contrastRatio('rgba(0,0,0,0.5)', '#fff'));  // 不支持 alpha，宁可抛错
    expectThrow(() => relativeLuminance('nope'));
  });
});

describe('relativeLuminance', () => {
  it('白 1.0 / 黑 0.0', () => {
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(relativeLuminance('#000000')).toBe(0);
  });
});
