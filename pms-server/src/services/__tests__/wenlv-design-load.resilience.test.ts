import { describe, it, expect, vi } from 'vitest';

// 模拟 DB 不可用：db.select() 立即抛错（模板表故障场景）
vi.mock('../../db/index.js', () => ({
  db: {
    select: () => {
      throw new Error('模拟模板表不可用');
    },
  },
}));

import { loadDesignTokensForProducts } from '../wenlv-design-load.js';

describe('loadDesignTokensForProducts 降级韧性', () => {
  it('模板查询抛错时降级为仅 theme 覆盖，不向上抛错', async () => {
    // 注：本项目 tsc 下 vi.spyOn 类型不可用（同 kf.test.ts 约定），改用手动替换 console.warn
    const warns: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      const m = await loadDesignTokensForProducts([
        { id: 'p1', theme: { templateId: 'tpl-guochao', primaryColor: '#123456' } },
        { id: 'p2', theme: {} },
      ]);
      // 模板拿不到 → 退化为仅 theme 覆盖；关键：函数本身不抛错，业务接口不会 500
      expect(m.get('p1')).toEqual({ colors: { primary: '#123456' } });
      expect(m.get('p2')).toEqual({});
      expect(warns.length > 0).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});
