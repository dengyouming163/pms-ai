// 场地网络调研 admin 端点（DB 冒烟）。
// 纯判定（看门狗 / 并发保护 / 逐节状态）在 services/__tests__/wenlv-research.test.ts —— 那批
// **永远在跑**，本文件的 DB 用例在默认配置下会被整块跳过。两批的分工是刻意的：把判定留在
// 纯函数里，才不会因为「默认跳过了 DB 用例」而静默零覆盖。
//
// 本地真跑（唯一真基线）：pnpm exec vitest run --config vitest.local.config.ts <本文件>
// ⛔ 绝不用 vitest.db.config.ts（明文生产库口令 + 指向生产）
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import wenlvResearchRoute from '../wenlv-research.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvVenues, pmsBuiWenlvVenueResearch } from '../../../db/schema/index.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
// 操作人归属走这个头（BFF 从已验签 JWT 现场构造）。**仅审计归属，不是权限边界。**
const HU = { ...H, 'X-Platform-User-Id': 'u-test' };
const U = Date.now();
const V = `res-venue-${U}`;

const get = (p: string, h: Record<string, string> = H) => wenlvResearchRoute.request(p, { headers: h });
const post = (p: string, body: unknown, h: Record<string, string> = HU) =>
  wenlvResearchRoute.request(p, { method: 'POST', headers: h, body: JSON.stringify(body) });
const patch = (p: string, body: unknown) =>
  wenlvResearchRoute.request(p, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

const ANCHOR = {
  name: '镇山村', region: '贵州贵阳', one_liner: 'x',
  source_urls: [], confidence: 'high' as const, why: 'y',
};

describe('wenlv-research 鉴权（内部 token）', () => {
  it('无内部 token 返回 403', async () => {
    const res = await wenlvResearchRoute.request(`/venues/${V}/research`);
    expect(res.status).toBe(403);
  });
});

// 默认无库自动跳过；本地真跑用 --config vitest.local.config.ts（仅回环，见该文件顶部说明）
describe.skipIf(!process.env.RUN_DB)('wenlv-research（DB）', () => {
  beforeAll(async () => {
    // 先子后父清残留，崩溃/重跑幂等
    await db.delete(pmsBuiWenlvVenueResearch).where(eq(pmsBuiWenlvVenueResearch.venueId, V));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '调研测试场地' });
  });

  it('场地不存在 ⇒ 404（读与写都是）', async () => {
    expect((await get('/venues/no-such-venue/research')).status).toBe(404);
    expect((await post('/venues/no-such-venue/research', {})).status).toBe(404);
  });

  it('没做过调研 ⇒ 200 + data: null（**不是 404**）', async () => {
    const res = await get(`/venues/${V}/research`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data).toBeNull();
  });

  it('POST 建行 ⇒ running，带 anchor 与操作人', async () => {
    const res = await post(`/venues/${V}/research`, { id: `res-${U}`, anchor: ANCHOR });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('running');
    expect(b.data.anchor.name).toBe('镇山村');
    expect(b.data.startedBy).toBe('u-test');
    expect(b.data.report).toBeNull();
  });

  it('再 GET 读到同一行（venue 1:1）', async () => {
    const b = await (await get(`/venues/${V}/research`)).json();
    expect(b.data.status).toBe('running');
    expect(b.data.venueId).toBe(V);
  });

  it('PATCH 回写逐节：report/progress/search_log 整体替换，id 不变', async () => {
    const b0 = await (await get(`/venues/${V}/research`)).json();
    const id = b0.data.id;
    const res = await patch(`/research/${id}`, {
      progress: { history: 'done' },
      report: {
        history: {
          items: [{ title: 't', content: 'c', sources: [1] }],
          sources: [{ title: 'a', site_name: 'b', url: 'https://x' }],
          note: '', not_found: false,
        },
      },
      search_log: [{ section: 'history', query: 'q', source_count: 1, truncated: false }],
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.id).toBe(id);
    expect(b.data.progress).toEqual({ history: 'done' });
    expect(b.data.report.history.items[0].title).toBe('t');
    expect(b.data.searchLog).toHaveLength(1);
  });

  it('PATCH 不收非法 status（400，不是静默吞）', async () => {
    const b0 = await (await get(`/venues/${V}/research`)).json();
    const res = await patch(`/research/${b0.data.id}`, { status: 'DONE' });
    expect(res.status).toBe(400);
  });

  it('PATCH 不存在的 research ⇒ 404', async () => {
    expect((await patch('/research/no-such-research', { status: 'ready' })).status).toBe(404);
  });

  it('PATCH 未提供的键不被清掉（逐键赋值，不是整体覆盖行）', async () => {
    const b0 = await (await get(`/venues/${V}/research`)).json();
    const res = await patch(`/research/${b0.data.id}`, { status: 'partial' });
    const b = await res.json();
    expect(b.data.status).toBe('partial');
    expect(b.data.report.history.items[0].title).toBe('t'); // 上一条用例写的 report 还在
  });

  it('终态后可重跑：POST 同场地 ⇒ 覆盖同一行、清空上一轮产出', async () => {
    const b0 = await (await get(`/venues/${V}/research`)).json();
    const id = b0.data.id;
    await patch(`/research/${id}`, { status: 'ready', finished_at: new Date().toISOString() });

    const res = await post(`/venues/${V}/research`, { id: `res2-${U}`, anchor: ANCHOR });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.id).toBe(id);          // 🔴 同一行，不是新行
    expect(b.data.status).toBe('running');
    expect(b.data.report).toBeNull();    // 覆盖：上一轮正文清空
    expect(b.data.progress).toBeNull();
    expect(b.data.searchLog).toBeNull();
    expect(b.data.finishedAt).toBeNull();
  });

  it('running 且带另一个 id ⇒ 409（并发保护），且文案带发起人', async () => {
    const res = await post(`/venues/${V}/research`, { id: `other-${U}` });
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b.error).toContain('正在调研');
    expect(b.error).toContain('u-test');
  });

  it('running 且带同一个 id ⇒ 200（断网重试自己那次请求，幂等重入）', async () => {
    const b0 = await (await get(`/venues/${V}/research`)).json();
    const res = await post(`/venues/${V}/research`, { id: b0.data.id });
    expect(res.status).toBe(200);
  });

  it('同一场地只有一行（venue_id 唯一索引兑现 1:1）', async () => {
    const rows = await db.select().from(pmsBuiWenlvVenueResearch)
      .where(eq(pmsBuiWenlvVenueResearch.venueId, V));
    expect(rows).toHaveLength(1);
  });
});
