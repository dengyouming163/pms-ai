import { describe, it, expect } from 'vitest';
import { resolveDesignTokensForProducts } from '../wenlv-design-load.js';
import type { WenlvTokens } from '../../db/schema/wenlv.js';

// 固定模板表：模拟 design_templates 一次查回来的结果
const tplTable = new Map<string, WenlvTokens>([
  ['tpl-guochao', {
    colors: { primary: '#C8102E', accent: '#F5C518' },
    fonts: { heading: '思源宋体' },
    radius: 8,
    motion: { duration: 300, easing: 'ease-out' },
  }],
]);

describe('resolveDesignTokensForProducts（模板继承 + theme 覆盖）', () => {
  it('有 templateId → 模板 tokens 为底，theme 覆盖其上', () => {
    const m = resolveDesignTokensForProducts(
      [{ id: 'p1', theme: { templateId: 'tpl-guochao', primaryColor: '#123456' } }],
      tplTable,
    );
    expect(m.get('p1')).toEqual({
      colors: { primary: '#123456', accent: '#F5C518' }, // primary 被覆盖，accent 保留
      fonts: { heading: '思源宋体' },
      radius: 8,
      motion: { duration: 300, easing: 'ease-out' },
    });
  });

  it('templateId 指向不存在的模板 → 退化为仅 theme 覆盖，不抛错', () => {
    const m = resolveDesignTokensForProducts(
      [{ id: 'p2', theme: { templateId: 'tpl-不存在', primaryColor: '#000000' } }],
      tplTable,
    );
    expect(m.get('p2')).toEqual({ colors: { primary: '#000000' } });
  });

  it('无 theme / theme 为空对象 → 空对象（调用端统一处理，不返回 null）', () => {
    const m = resolveDesignTokensForProducts([{ id: 'p3' }, { id: 'p4', theme: {} }], tplTable);
    expect(m.get('p3')).toEqual({});
    expect(m.get('p4')).toEqual({});
  });

  it('批量解析：每个产品独立，互不串味', () => {
    const m = resolveDesignTokensForProducts(
      [{ id: 'a', theme: { templateId: 'tpl-guochao' } }, { id: 'b', theme: { primaryColor: '#00ff00' } }],
      tplTable,
    );
    expect(m.get('a')?.colors?.primary).toBe('#C8102E');   // 继承模板
    expect(m.get('b')?.colors?.primary).toBe('#00ff00');   // 仅 theme
    // 注：仓库**自写**的类型桩 src/types/vitest.d.ts 未声明 toBeUndefined（桩头部约定用时补桩）；toBe(undefined) 语义等价
    expect(m.get('b')?.radius).toBe(undefined);            // 未引用模板 → 无模板字段
  });

  it('空产品数组 → 空 Map（不抛错）', () => {
    expect(resolveDesignTokensForProducts([], tplTable).size).toBe(0);
  });
});
