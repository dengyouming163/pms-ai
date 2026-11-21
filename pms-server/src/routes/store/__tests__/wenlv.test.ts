// S4 商户现场端领奖码核销路由测试：直打本地 test 库（同 mini rally 先例，无 RUN_DB 门控）；
// 依赖 T1 已在 test 库应用 0022（redeemed_store_id 列）。
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import storeWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers, pmsBuiWenlvClaims } from '../../../db/schema/index.js';

// 员工上下文注入（模拟全局 authMiddleware/tenantMiddleware 之后的 state；scope=store 无 homeStoreId → 需 X-Store-Id 才有具体门店）
const app = new Hono();
app.use('*', async (c: any, next: any) => {
  c.set('authUser', { userId: 'staff-s4', name: '王店长', scope: 'store' });
  await next();
});
app.route('/api/store/wenlv', storeWenlvRoute);

const H_STORE = { 'X-Store-Id': 's4-outlet', 'Content-Type': 'application/json' };
const OUTLET = 's4-outlet';
// 固定 fixture 前缀：beforeAll 先删固定前缀 → 崩溃残留亦被自愈，测试可幂等重跑
const PRODUCT = 's4p-fixed';
const T1ID = 's4t1-fixed'; const T2ID = 's4t2-fixed'; const RID = 's4r-fixed';
let claimId = ''; let claimCode = '';

describe('store wenlv claims 核销（DB）', () => {
  beforeAll(async () => {
    // 固定前缀自愈：先删上次崩溃可能残留的同前缀行，再建 fixture（幂等可重跑）
    await db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT));
    await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, PRODUCT));
    await db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '集章测试产品', status: 'published', mode: 'rally' });
    await db.insert(pmsBuiWenlvRewards).values({ id: RID, productId: PRODUCT, name: '纪念杯', type: 'merchant_rights', value: 'LYR-001' });
    await db.insert(pmsBuiWenlvRewardTiers).values([
      { id: T1ID, productId: PRODUCT, name: '集齐3章', order: 1, rewardId: RID, condition: null },
      { id: T2ID, productId: PRODUCT, name: '集齐5章', order: 2, rewardId: RID, condition: null },
    ]);
  });

  it('by-code 富化字段正确且不下发 miniUserId/condition', async () => {
    claimCode = 'LYTEST' + randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    const [c] = await db.insert(pmsBuiWenlvClaims).values({
      id: 's4c1-fixed', productId: PRODUCT, miniUserId: 'u1', progressId: 's4prg1-fixed', tierId: T1ID, rewardId: RID, code: claimCode, status: 'claimed',
    }).returning();
    claimId = c.id;
    const res = await app.request(`/api/store/wenlv/claims/by-code/${claimCode}`, { headers: H_STORE });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d).toMatchObject({ code: claimCode, status: 'claimed', productTitle: '集章测试产品', productMode: 'rally', tierName: '集齐3章', rewardName: '纪念杯', rewardType: 'merchant_rights' });
    expect(d.miniUserId).toBe(undefined);
    expect(d.condition).toBe(undefined);
  });

  it('by-code 不存在返回 404', async () => {
    const res = await app.request('/api/store/wenlv/claims/by-code/LYNOTFOUND', { headers: H_STORE });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('领奖码不存在');
  });

  it('无门店员工（无 X-Store-Id）操作被 403', async () => {
    const res = await app.request(`/api/store/wenlv/claims/by-code/${claimCode}`, { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('请先选择门店后再核销');
  });

  it('redeem claimed→redeemed 并记经办员工/门店', async () => {
    const res = await app.request(`/api/store/wenlv/claims/${claimId}/redeem`, { method: 'POST', headers: H_STORE, body: '{}' });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row).toMatchObject({ status: 'redeemed', redeemedBy: 'staff-s4', redeemedStoreId: OUTLET });
    expect(row.redeemedAt).toBeTruthy();
    // 脱敏锁：redeem 响应不下发 miniUserId/progressId（同 by-code 纪律）
    expect(row.miniUserId).toBe(undefined);
    expect(row.progressId).toBe(undefined);
  });

  it('二次核销返回 409 已核销', async () => {
    const res = await app.request(`/api/store/wenlv/claims/${claimId}/redeem`, { method: 'POST', headers: H_STORE, body: '{}' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('该领奖码已核销');
  });

  it('cancelled 领奖码不可核销（409 已取消）', async () => {
    const code2 = 'LYCANCEL' + randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
    const [c] = await db.insert(pmsBuiWenlvClaims).values({
      id: 's4c2-fixed', productId: PRODUCT, miniUserId: 'u2', progressId: 's4prg2-fixed', tierId: T2ID, rewardId: RID, code: code2, status: 'cancelled',
    }).returning();
    const res = await app.request(`/api/store/wenlv/claims/${c.id}/redeem`, { method: 'POST', headers: H_STORE, body: '{}' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('该领奖码已取消');
  });

  it('redeem 不存在的 id 返回 404', async () => {
    const res = await app.request('/api/store/wenlv/claims/no-such-fixed/redeem', { method: 'POST', headers: H_STORE, body: '{}' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('领奖码不存在');
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT));
    await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, PRODUCT));
    await db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
  });
});

const jsonResp = (status: number, obj: any) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

describe('store wenlv 门票代理（fetch 桩）', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('by-code 预览转发 platform 路径 + 透传状态/数据', async () => {
    let calledUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrl = url;
      return jsonResp(200, { success: true, data: { code: 'WS4TESTABCDEF', status: 'unused', productName: '门票A', orderNo: 'WENLV1' } });
    }));
    const res = await app.request('/api/store/wenlv/tickets/by-code/WS4TESTABCDEF', { headers: H_STORE });
    expect(calledUrl).toContain('/api/wenlv/internal/tickets/by-code/WS4TESTABCDEF');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data).toMatchObject({ code: 'WS4TESTABCDEF', status: 'unused' });
  });

  it('consume 注入门店 storeId 转发 + 透传 409', async () => {
    let body = ''; let calledUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calledUrl = url; body = init?.body ?? '';
      return jsonResp(409, { success: false, error: '券已核销或失效' });
    }));
    const res = await app.request('/api/store/wenlv/tickets/consume', { method: 'POST', headers: H_STORE, body: JSON.stringify({ code: 'WS4TESTABCDEF' }) });
    expect(calledUrl).toContain('/api/wenlv/internal/tickets/consume-by-code');
    expect(JSON.parse(body)).toMatchObject({ code: 'WS4TESTABCDEF', storeId: OUTLET });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('券已核销或失效');
  });

  it('无门店员工 consume 被 403（不发代理请求）', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await app.request('/api/store/wenlv/tickets/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'WS4TESTABCDEF' }) });
    expect(res.status).toBe(403);
    expect(fn).not.toHaveBeenCalled();
  });

  it('空/纯空格 code consume 被 400（不发代理请求）', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await app.request('/api/store/wenlv/tickets/consume', { method: 'POST', headers: H_STORE, body: JSON.stringify({ code: '   ' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('参数错误');
    expect(fn).not.toHaveBeenCalled();
  });

  it('body 为 JSON null consume 被 400（非 500）', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await app.request('/api/store/wenlv/tickets/consume', { method: 'POST', headers: H_STORE, body: 'null' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('参数错误');
    expect(fn).not.toHaveBeenCalled();
  });

  it('平台请求超时回 504 稳定中文，不透传技术原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted', 'TimeoutError'); }));
    const res = await app.request('/api/store/wenlv/tickets/by-code/WS4TESTABCDEF', { headers: H_STORE });
    expect(res.status).toBe(504);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('平台服务繁忙，请稍后再试');
    expect(text).not.toContain('TimeoutError');
    expect(text).not.toContain('The operation');
  });
});
