import { describe, it, expect } from 'vitest';
import { db } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { pmsBuiWenlvProducts } from '../../db/schema/index.js';
import { loadDesignTokensForProducts } from '../wenlv-design-load.js';

// RUN_DB 门控：仅显式 RUN_DB=1 时执行（默认 vitest.config 指向本地测试库）
const run = !!process.env.RUN_DB;

describe.skipIf(!run)('design token DB 接线（只读冒烟）', () => {
  it('已发布产品都能解析出 designTokens 对象（不抛错、恒为对象）', async () => {
    const rows = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.status, 'published'));
    // 空库视为「无可验证数据」，跳过断言（本冒烟不造数据）；有数据时才真正校验接线
    if (rows.length === 0) return;
    const m = await loadDesignTokensForProducts(rows);
    expect(m.size).toBe(rows.length);
    for (const r of rows) {
      const t = m.get(r.id);
      expect(typeof t).toBe('object');   // {} 也算通过：未接主题的产品合法
      expect(t).not.toBeNull();
    }
  });

  it('引用 tpl-guochao 的产品解析出模板主色 #C8102E（若库里存在该类产品）', async () => {
    const rows = await db.select().from(pmsBuiWenlvProducts);
    const refsTpl = rows.filter((r) => (r.theme as any)?.templateId === 'tpl-guochao');
    if (refsTpl.length === 0) return; // 无引用则跳过断言（本冒烟不造数据）
    const m = await loadDesignTokensForProducts(refsTpl);
    expect(m.get(refsTpl[0].id)?.colors?.primary).toBe('#C8102E');
  });
});
