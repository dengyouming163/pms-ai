import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../../db/index.js', () => ({ db: { select: vi.fn() } }));

import route from '../products.js';

const app = new Hono();
app.route('/api/mini/products', route);

const originalFetch = global.fetch;

// 与 products-region.test.ts 同款：每例先复位全局 fetch（本项目 tsc 下 vi.stubGlobal /
// vi.unstubAllGlobals 类型不可用，沿用 kf.test.ts 的手动复位写法）+ 清空 mock 调用记录
beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = originalFetch;
});

/** 让平台详情口返回指定 status 的商品；命中非详情口一律抛错，避免 Mock 语义被误扩 */
function mockPlatformDetail(status: string) {
  global.fetch = vi.fn().mockImplementation(async (url: string | Request) => {
    const u = String(url);
    if (!u.includes('/api/products/')) throw new Error(`未预期的平台请求：${u}`);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          id: 'p1',
          name: 'A',
          storeId: 'store_1',
          status,
          productType: 'travel',
          extraAttrs: {},
          pricing: [],
          images: [],
        },
      }),
    };
  });
}

describe('GET /api/mini/products/:id — 非「已上架」商品视为不存在', () => {
  it('status=offline（已下架）→ 404', async () => {
    mockPlatformDetail('offline');
    const res = await app.request('/api/mini/products/p1');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('status=deleted（已软删）→ 404', async () => {
    mockPlatformDetail('deleted');
    const res = await app.request('/api/mini/products/p1');
    expect(res.status).toBe(404);
  });

  // 阳性对照：证明上面两条 404 是 status 闸产生的，而不是这个 URL 本来就返回非 200
  it('status=approved → 200（阳性对照）', async () => {
    mockPlatformDetail('approved');
    const res = await app.request('/api/mini/products/p1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('p1');
  });
});
