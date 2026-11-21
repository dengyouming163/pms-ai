import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { internalAuthMiddleware } from '../../../middleware/internal-auth.js';

// mock db：路由只做「存在性检查 + 更新」，不直连 DB（与 platform-orders.test.ts 同模式）
vi.mock('../../../db/index.js', () => ({ db: { select: vi.fn(), update: vi.fn() } }));

import { db } from '../../../db/index.js';
import route from '../stores.js';

const app = new Hono();
app.use('*', internalAuthMiddleware);
app.route('/api/internal/stores', route);

const authHeaders = { 'Content-Type': 'application/json', 'X-Internal-Service-Token': 'test-internal-token' };

/** 门店存在性检查返回一个门店（模拟 db.select().from().where().limit()） */
function mockStoreExists() {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ id: 'store_1' }]),
  };
  (db.select as any).mockReturnValue(chain);
  return chain;
}

/** 捕获 db.update().set() 的入参 */
function captureUpdate() {
  const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  (db.update as any).mockReturnValue({ set: setMock });
  return setMock;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('PUT /api/internal/stores/:storeId/city-tags — regionTags 校验与保存', () => {
  it('无内部 Token → 403', async () => {
    const res = await app.request('/api/internal/stores/store_1/city-tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferenceTags: ['亲子'] }),
    });
    expect(res.status).toBe(403);
  });

  it('只传 preferenceTags（无 regionTags）→ 200，setData 不含 regionTags（幂等不覆盖）', async () => {
    mockStoreExists();
    const setMock = captureUpdate();
    const res = await app.request('/api/internal/stores/store_1/city-tags', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ preferenceTags: ['亲子'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.preferenceTags).toEqual(['亲子']);
    expect(setMock.mock.calls[0][0].preferenceTags).toEqual(['亲子']);
    // 注：仓库**自写**的类型桩 src/types/vitest.d.ts 未声明 toBeUndefined（桩头部约定用时补桩）；toBe(undefined) 语义等价
    expect(setMock.mock.calls[0][0].regionTags).toBe(undefined);
  });

  it('regionTags 含非法值 → 400，指明第一个非法值', async () => {
    const res = await app.request('/api/internal/stores/store_1/city-tags', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ regionTags: ['黄果树', '不存在的地方'] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('不存在的地方');
  });

  it('regionTags 合法 → 200，setData 写入去重后的 regionTags', async () => {
    mockStoreExists();
    const setMock = captureUpdate();
    const res = await app.request('/api/internal/stores/store_1/city-tags', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ regionTags: ['黄果树', '安顺', '黄果树'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.regionTags).toEqual(['黄果树', '安顺']);
    expect(setMock.mock.calls[0][0].regionTags).toEqual(['黄果树', '安顺']);
  });

  it('regionTags 数组含非字符串元素 → 被过滤不报错', async () => {
    mockStoreExists();
    const setMock = captureUpdate();
    const res = await app.request('/api/internal/stores/store_1/city-tags', {
      method: 'PUT', headers: authHeaders, body: JSON.stringify({ regionTags: ['黄果树', 123, null] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.regionTags).toEqual(['黄果树']);
    expect(setMock.mock.calls[0][0].regionTags).toEqual(['黄果树']);
  });
});
