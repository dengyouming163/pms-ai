// /my-play 的数据分支：平台券侧 mock 掉（真打 HTTP 在本机恒失败，只能测到降级分支），
// 进度侧真查库（本机回环 aipms，见 vitest.local.config.ts 的 assertLoopback 硬闸）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, afterAll, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

// 工厂整体 as any + importOriginal 形参取真模块（vi API 是否可用以 src/types/vitest.d.ts 为准）
vi.mock('../../../services/platform-client.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  listWenlvTickets: vi.fn(),
})) as any);

import { db } from '../../../db/index.js';
import { pmsBuiWenlvProgress } from '../../../db/schema/index.js';
import { listWenlvTickets } from '../../../services/platform-client.js';
import route from '../wenlv-my-play.js';

type FnMock = { mockReset: () => void; mockResolvedValue: (v: unknown) => void };
const ticketsMock = listWenlvTickets as unknown as FnMock;

const signMiniToken = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

const GUEST = 'u-myplay-' + randomUUID().slice(0, 8);
const NOW = Date.now();
const D = (days: number) => new Date(NOW + days * 86400_000).toISOString();  // 相对过期时间（天）；🔴 绝不写绝对日期（那是定时炸弹：过了那天全线红）
const okTickets = (list: any[]) => ({ ok: true, status: 200, data: { success: true, data: { list, total: list.length } } }) as any;
const ticket = (over: any) => ({
  id: randomUUID(), orderId: randomUUID(), productId: 'tp-' + randomUUID().slice(0, 8),
  contentProductId: 'cp-1', miniUserId: GUEST, code: 'C1', status: 'unused',
  expiresAt: D(30), usedAt: null, productName: '龙门谜案', isGifted: false, ...over,
});

describe.skipIf(!process.env.RUN_DB)('GET /api/mini/wenlv/my-play（DB + mock 平台）', () => {
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, id));
    vi.clearAllMocks();
  });
  beforeEach(() => { ticketsMock.mockReset(); });

  const call = (token: string) => route.request('/', { headers: { Authorization: `Bearer ${token}` } });
  const mkProgress = async (contentProductId: string, status: string, updatedAt: Date, sessionId: string | null) => {
    const id = 'wp-' + randomUUID().slice(0, 12);
    ids.push(id);
    await db.insert(pmsBuiWenlvProgress).values({
      id, productId: contentProductId, miniUserId: GUEST, status, sessionId, updatedAt,
    } as any);
    return id;
  };

  it('无进度行 + 有可用券 ⇒ playState=none 且张数只数**可用**券', async () => {
    ticketsMock.mockResolvedValue(okTickets([
      ticket({ contentProductId: 'cp-none' }),
      ticket({ contentProductId: 'cp-none', status: 'used' }),
      ticket({ contentProductId: 'cp-none', status: 'refunded' }),
      ticket({ contentProductId: 'cp-none', expiresAt: D(-1) }),   // 🔴 付过钱但已过期：平台侧仍是 unused
      ticket({ contentProductId: 'cp-none', expiresAt: null }),    // 未激活：平台谓词要求 expiresAt 非空
    ]));
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    const row = body.list.find((x: any) => x.contentProductId === 'cp-none');
    expect(row.playState).toBe('none');
    expect(row.unusedTicketCount, 'used/refunded/已过期/无有效期的券都不得计入张数').toBe(1);
    expect(row.expiresAt, '过期券不得污染 expiresAt（要取的是可用券里最早一张）').toBe(D(30));
    expect(row.updatedAt).toBeNull();
    expect(row.productName).toBe('龙门谜案');
    expect(row.productId, '第 2 档要跳到 detail?productId=，所以必须带交易侧 productId').toBeTruthy();
    expect(body.degraded).toBeUndefined();
  });

  it('progress.status=active ⇒ playing；=completed ⇒ completed', async () => {
    await mkProgress('cp-playing', 'active', new Date(NOW), null);
    await mkProgress('cp-done', 'completed', new Date(NOW), null);
    ticketsMock.mockResolvedValue(okTickets([
      ticket({ contentProductId: 'cp-playing' }), ticket({ contentProductId: 'cp-done' }),
    ]));
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    expect(body.list.find((x: any) => x.contentProductId === 'cp-playing').playState).toBe('playing');
    expect(body.list.find((x: any) => x.contentProductId === 'cp-done').playState).toBe('completed');
  });

  it('🔴 同一 contentProductId 同时有散客行与团队行 ⇒ 取 updatedAt 较大的那行', async () => {
    // 两条**部分**唯一索引各管各的 ⇒ 同 (userId, productId) 可以同时有多行（散客行 + 多条团队行）。
    // 本读口补的确定规则是「最近在玩的那一场为准」。🔴 夹具必须让**期望行不落在返回序的两端** ——
    // 实测只有两行（期望行落在末位）时「不比较、后到者覆盖」这类错实现**全绿**（隔离副本实测）。
    await mkProgress('cp-two', 'active', new Date(NOW - 3600_000), null);
    await mkProgress('cp-two', 'completed', new Date(NOW), 'sess-1');
    await mkProgress('cp-two', 'active', new Date(NOW - 60_000), 'sess-2');
    ticketsMock.mockResolvedValue(okTickets([ticket({ contentProductId: 'cp-two' })]));
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    const row = body.list.find((x: any) => x.contentProductId === 'cp-two');
    expect(row.playState, '取最近更新的那一行（completed 那行更新）').toBe('completed');
    expect(new Date(row.updatedAt).getTime()).toBe(NOW);
  });

  it('expiresAt 取**可用**券里最早一张；无可用券 ⇒ null', async () => {
    ticketsMock.mockResolvedValue(okTickets([
      ticket({ contentProductId: 'cp-exp', expiresAt: D(30) }),
      ticket({ contentProductId: 'cp-exp', expiresAt: D(10) }),
      ticket({ contentProductId: 'cp-nous' , expiresAt: D(10), status: 'used' }),
    ]));
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    expect(body.list.find((x: any) => x.contentProductId === 'cp-exp').expiresAt).toBe(D(10));
    expect(body.list.find((x: any) => x.contentProductId === 'cp-nous').expiresAt).toBeNull();
  });

  it('🔴 券侧失败 ⇒ degraded:true + 空 list（**不是** 200 静默空列表）', async () => {
    ticketsMock.mockResolvedValue({ ok: false, status: 0, data: null } as any);
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    expect(body.degraded, '不标记 ⇒ 页面把「平台挂了」显示成「你没买过」').toBe(true);
    expect(body.list).toEqual([]);
  });

  it('🔴 券侧 200 但形状畸形 ⇒ degraded:true，不得 500', async () => {
    for (const bad of [
      { ok: true, status: 200, data: { success: true, data: {} } },
      { ok: true, status: 200, data: { success: true, data: { list: null } } },
      { ok: true, status: 200, data: { success: true, data: { list: 'nope' } } },
      { ok: false, status: 200, data: { success: false, data: { list: [ticket({})] } } },
    ]) {
      ticketsMock.mockResolvedValue(bad as any);
      const res = await call(signMiniToken(GUEST));
      expect(res.status).toBe(200);
      const body = (await res.json()).data;
      expect(body.degraded).toBe(true);
      expect(body.list).toEqual([]);
    }
  });
});
