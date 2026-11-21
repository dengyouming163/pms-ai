import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../../db/index.js', () => ({ db: { select: vi.fn() } }));

import { db } from '../../../db/index.js';
import route from '../products.js';

const app = new Hono();
app.route('/api/mini/products', route);

const originalFetch = global.fetch;

// 每例先复位全局 fetch（本项目 tsc 下 vi.stubGlobal / vi.unstubAllGlobals 类型不可用，
// 沿用 kf.test.ts 的手动复位写法）+ 清空 mock 调用记录
beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = originalFetch;
});

// mock 平台产品列表：store_1 绑「黄果树」、store_2 未绑
function mockPlatform(products: any[]) {
  // products.ts 内部 fetch 用全局 fetch 代理到平台
  global.fetch = vi.fn().mockImplementation(async (url: string | Request) => {
    const u = String(url);
    if (u.includes('/api/products/')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'p1', pricing: [], images: [], extraAttrs: {} } }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { list: products, total: products.length } }) };
  });
}

/** 模拟地域门店查询：黄果树 → 门店集合 */
function mockRegionStores(rows: { id: string }[]) {
  const selectPromise = Promise.resolve(rows);
  // 让地域查询返回 rows；select 是 async 方法（await db.select(...)），链对象需实现 then/catch 成为 thenable
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: selectPromise.then.bind(selectPromise),
    catch: selectPromise.catch.bind(selectPromise),
  };
  (db.select as any).mockReturnValue(chain);
  return chain;
}

describe('GET /api/mini/products — region 本地过滤', () => {
  it('region=黄果树 → 只返回绑黄果树门店的产品', async () => {
    mockPlatform([
      { id: 'p1', name: 'A', storeId: 'store_1', status: 'approved', productType: 'travel', extraAttrs: {} },
      { id: 'p2', name: 'B', storeId: 'store_2', status: 'approved', productType: 'travel', extraAttrs: {} },
    ]);
    mockRegionStores([{ id: 'store_1' }]);

    // 注意：type 默认 travel,group_buy 会拆成两次请求（列表翻倍），固定 type=travel 使 total 断言确定
    const res = await app.request('/api/mini/products?type=travel&region=%E9%BB%84%E6%9E%9C%E6%A0%91&limit=10');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].storeId).toBe('store_1');
  });

  it('region + tag AND 叠加：只返回同时满足两者的产品', async () => {
    // 平台端已按 tag=X 过滤（mock 语义），store_1 绑黄果树、store_2 未绑
    mockPlatform([
      { id: 'p1', name: 'A', storeId: 'store_1', status: 'approved', productType: 'travel', extraAttrs: {} },
      { id: 'p2', name: 'B', storeId: 'store_2', status: 'approved', productType: 'travel', extraAttrs: {} },
    ]);
    mockRegionStores([{ id: 'store_1' }]);

    // tag=X 交给平台（mock 已按 tag 过滤返回上述 list），region=黄果树 本地再过滤 → 交集
    const res = await app.request('/api/mini/products?type=travel&tag=X&region=%E9%BB%84%E6%9E%9C%E6%A0%91&limit=10');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(1);
    expect(body.data.list[0].storeId).toBe('store_1');
  });

  it('无 region → 不过滤门店', async () => {
    mockPlatform([
      { id: 'p1', name: 'A', storeId: 'store_1', status: 'approved', productType: 'travel', extraAttrs: {} },
      { id: 'p2', name: 'B', storeId: 'store_2', status: 'approved', productType: 'travel', extraAttrs: {} },
    ]);
    const res = await app.request('/api/mini/products?type=travel&limit=10');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total).toBe(2);
  });
});
