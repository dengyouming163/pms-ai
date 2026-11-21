// 团队准入的真库测试（P2）。按端点分 describe（建队 / 名单 / 入队 / 移出 / 通道与并集读 / 并集读写）：本 Task 先写「建队」，其余 Task 往同一文件追加。
// 上游（pms-platform-server）在本机不可达 ⇒ 一律**桩掉全局 fetch**（照 wenlv-enter.test.ts 的先例）。
// 桩在**客户端封装之下**（`services/platform-client.ts`），所以本文件同时验证了 URL 路径与响应解包。⚠️ 顶部 import **一次给全**：含后面几个 Task 才会用到的 `beforeEach`（Task 9 起）与 scenes 相关表（Task 10 起）—— 本文件的 describe 由多个 Task 陆续往**同一个文件**追加，**别让后面的人以为要自己补 import**（少一个就是收集期 `ReferenceError`，整个文件全灭）。
delete process.env.WENLV_BYPASS_TICKET;
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvSessions, pmsBuiWenlvProducts, pmsBuiWenlvProgress, pmsBuiWenlvRewardTiers, pmsBuiWenlvClaims, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes } from '../../../db/schema/index.js';

// ── 0079 统一模型辅助：nodes/endings→scenes ──
async function ensureChapter(db: any, productId: string): Promise<string> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.insert(pmsBuiWenlvScriptRooms).values({ id: rid, contentId: productId, name: `${productId} 房` })
    .onConflictDoNothing({ target: pmsBuiWenlvScriptRooms.id });
  await db.insert(pmsBuiWenlvChapters).values({ id: cid, scriptRoomId: rid, title: '第一章', order: 0 })
    .onConflictDoNothing({ target: pmsBuiWenlvChapters.id });
  return cid;
}
async function deleteScenesOfProduct(db: any, productId: string): Promise<void> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, cid));
  await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, cid));
  await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.id, rid));
}

const mkMini = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json', 'X-Wenlv-Leader-Code': LEADER_CODE };
};

/** 只有登录态、**不带** X-Wenlv-Leader-Code（join 用登录态鉴权） */
const mkMiniNoLeader = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json' };
};

const TS = Date.now();
const LEADER_CODE = `LD${String(TS).slice(-10)}`;
const ORDER_ID = randomUUID();
const TRADE_PRODUCT = `p-trade-${TS}`;     // 交易侧 productId
const CONTENT_PRODUCT = `cp-content-${TS}`; // 内容产品 id —— 建队必须落**这个**

/** 桩上游：`data` 是订单对象的覆盖项（默认「已支付 + 有票 + 内容产品已绑」） */
function stubOrder(over: Record<string, unknown> = {}, httpStatus = 200, ok = true) {
  const data = {
    orderId: ORDER_ID, status: 'paid', paymentStatus: 'paid', quantity: 3,
    miniUserId: 'u-leader-1', slotId: null, productId: TRADE_PRODUCT,
    contentProductId: CONTENT_PRODUCT, availableTicketCount: 3,
    ...over,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok, status: httpStatus, json: async () => (ok ? { success: true, data } : { success: false, error: '领队码无效' }),
  }));
}

const H = mkMini('u-leader-1');
const post = (body: unknown, headers: Record<string, string> = H) =>
  wenlvRoute.request('/sessions', { method: 'POST', headers, body: JSON.stringify(body) });

const sessionsOfOrder = () => db.select().from(pmsBuiWenlvSessions).where(eq(pmsBuiWenlvSessions.orderId, ORDER_ID));

describe.skipIf(!process.env.RUN_DB)('建队 POST /api/mini/wenlv/sessions', () => {
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: CONTENT_PRODUCT, name: '建队剧本', status: 'published' });
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db.delete(pmsBuiWenlvSessions).where(eq(pmsBuiWenlvSessions.orderId, ORDER_ID));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, CONTENT_PRODUCT));
  });

  it('未登录 401 / 缺领队码 400 / 队数非正整数 400', async () => {
    stubOrder();
    const noAuth = await wenlvRoute.request('/sessions', { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    const noCode = await post({ teamCount: 2 }, { ...H, 'X-Wenlv-Leader-Code': '' });
    expect(noCode.status).toBe(400);
    for (const bad of [0, -1, 1.5, '2', null]) {
      const r = await post({ teamCount: bad });
      expect(r.status, `teamCount=${JSON.stringify(bad)} 应被拒`).toBe(400);
    }
  });

  it('领队码无效 ⇒ 404（上游 404 透传，不是 502）', async () => {
    stubOrder({}, 404, false);
    const res = await post({ teamCount: 2 });
    expect(res.status).toBe(404);
    // 🔴 只判 status 是**零判别力**的：本端点此时还不存在，Hono 对未注册路由也返 404
    //    （框架 404 冒充业务 404）⇒ 只断 status 的话这条在实现前就是绿的。
    //    框架的默认 404 是**纯文本** `404 Not Found`，`.json()` 会抛 ⇒ 这条断言把两者区分开。
    expect((await res.json()).error, '必须是业务 404，不是框架 404').toBe('领队码无效，请回订单页重新获取');
  });

  it('平台不可达 ⇒ 502，且**不**与「码无效」混用同一个状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await post({ teamCount: 2 });
    expect(res.status).toBe(502);
  });

  it('未支付 ⇒ 409；已退款/已取消 ⇒ 409（文案不同，两条都要点）', async () => {
    stubOrder({ status: 'pending', paymentStatus: 'unpaid' });
    const a = await post({ teamCount: 2 });
    expect(a.status).toBe(409);
    expect((await a.json()).error).toContain('未支付');
    stubOrder({ status: 'refunded' });
    const b = await post({ teamCount: 2 });
    expect(b.status).toBe(409);
    expect((await b.json()).error).not.toContain('未支付');
  });

  it('内容产品未绑定 ⇒ 409（拿交易侧 id 建队会造出永远打不开的队）', async () => {
    stubOrder({ contentProductId: null });
    const res = await post({ teamCount: 2 });
    expect(res.status).toBe(409);
  });

  it('paid 但池空 ⇒ 409（D1 补座失败单就停在这个状态）', async () => {
    stubOrder({ availableTicketCount: 0 });
    const res = await post({ teamCount: 2 });
    expect(res.status).toBe(409);
  });

  it('队数 > quantity ⇒ 400', async () => {
    stubOrder({ quantity: 2 });
    const res = await post({ teamCount: 3 });
    expect(res.status).toBe(400);
  });

  it('🔴 建 3 队：库里真有 3 行、seq/name 对、**product_id = 内容产品 id**、码各不同且在字符集内', async () => {
    stubOrder({ availableTicketCount: 3 });
    const res = await post({ teamCount: 3 });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.sessions).toHaveLength(3);
    expect(body.data.created).toBe(true);

    const rows = await sessionsOfOrder();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...rows].sort((a, b) => a.seq - b.seq).map((r) => r.name)).toEqual(['第 1 队', '第 2 队', '第 3 队']);   // ⚠️ `sessionsOfOrder()` **没有 orderBy** ⇒ 行序不保证（PG 堆序只是「通常」等于插入序）：**先按 seq 排再比 name**，判的才是「name 由 seq 派生」；直接比原数组是**假判据**（物理行序恰好是 1/2/3 只是巧合，换机器/换规划器就可能红）。
    // ★ spec §4.1③ 的判据：落错成交易侧 id 时，这里会读到 TRADE_PRODUCT
    for (const r of rows) expect(r.productId).toBe(CONTENT_PRODUCT);
    expect(rows.every((r) => r.status === 'forming')).toBe(true);
    expect(rows.every((r) => r.orderId === ORDER_ID)).toBe(true);
    const codes = rows.map((r) => r.code);
    expect(new Set(codes).size).toBe(3);
    for (const c of codes) expect(c).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  });

  it('幂等：再 POST 一次 ⇒ 不新建（仍是 3 行、id 不变）', async () => {
    stubOrder({ availableTicketCount: 3 });
    const before = await sessionsOfOrder();
    const res = await post({ teamCount: 2 });   // 队数**不同**也必须走幂等分支（已有 forming 队）
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.created).toBe(false);
    const after = await sessionsOfOrder();
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });

  it('teamCount=1 ⇒ 200（只断状态码；走幂等分支，不验「能建出 1 支」）', async () => {
    stubOrder({ availableTicketCount: 3, quantity: 1 });
    const res = await post({ teamCount: 1 });
    // 上一个用例已把 3 支队建成 forming ⇒ 这里走幂等分支返回既有的 3 支（**不是** 1 支）
    // ⇒ 本用例判的是「不因 teamCount=1 而报错」，不是「能建出 1 支」
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!process.env.RUN_DB)('名单 GET /api/mini/wenlv/sessions', () => {
  const TS2 = Date.now();
  const CP2 = `cp-roster-${TS2}`;
  const OTHER_ORDER = randomUUID();      // 别人的订单：它的队**不能**出现在本单名单里
  const SES_A = `ses-roster-a-${TS2}`;
  const SES_B = `ses-roster-b-${TS2}`;
  const SES_CLOSED = `ses-roster-c-${TS2}`;
  const SES_OTHER = `ses-roster-other-${TS2}`;

  beforeAll(async () => {
    // 防御：上一个 describe 的 afterAll 已经清掉本 ORDER_ID 的队，但「恰好 3 条」这条断言
    // 不该依赖兄弟 describe 的清理时机（单跑本 describe、或将来插了新的 describe 都会翻车）。
    await db.delete(pmsBuiWenlvSessions).where(eq(pmsBuiWenlvSessions.orderId, ORDER_ID));
    await db.insert(pmsBuiWenlvProducts).values({ id: CP2, name: '名单剧本', status: 'published' });
    await db.insert(pmsBuiWenlvSessions).values([
      { id: SES_B, productId: CP2, orderId: ORDER_ID, code: `RB${String(TS2).slice(-6)}`, seq: 2, name: '第 2 队', status: 'forming' },
      { id: SES_CLOSED, productId: CP2, orderId: ORDER_ID, code: `RC${String(TS2).slice(-6)}`, seq: 3, name: '第 3 队', status: 'closed' },
      { id: SES_A, productId: CP2, orderId: ORDER_ID, code: `RA${String(TS2).slice(-6)}`, seq: 1, name: '第 1 队', status: 'forming' },
      { id: SES_OTHER, productId: CP2, orderId: OTHER_ORDER, code: `RO${String(TS2).slice(-6)}`, seq: 1, name: '别人队', status: 'forming' },
    ]);
    // A 队两人（含下单人）、B 队一人、C 队（已封口）**零人** —— 三种形态各一条
    await db.insert(pmsBuiWenlvProgress).values([
      { id: `pg-roster-a2-${TS2}`, productId: CP2, miniUserId: 'u-mate-1', sessionId: SES_A },
      { id: `pg-roster-a1-${TS2}`, productId: CP2, miniUserId: 'u-leader-1', sessionId: SES_A },
      { id: `pg-roster-b1-${TS2}`, productId: CP2, miniUserId: 'u-mate-2', sessionId: SES_B },
    ]);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, CP2));
    await db.delete(pmsBuiWenlvSessions).where(inArray(pmsBuiWenlvSessions.id, [SES_A, SES_B, SES_CLOSED, SES_OTHER]));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, CP2));
  });

  const get = (headers: Record<string, string> = H) => wenlvRoute.request('/sessions', { headers });

  it('未登录 401 / 缺领队码 400 / 上游 404 ⇒ 404 / 上游挂 ⇒ 502', async () => {
    expect((await wenlvRoute.request('/sessions')).status).toBe(401);
    stubOrder();
    expect((await get({ ...H, 'X-Wenlv-Leader-Code': '' })).status).toBe(400);
    stubOrder({}, 404, false);
    expect((await get()).status).toBe(404);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect((await get()).status).toBe(502);
  });

  it('🔴 按队列成员、**不串队**，且别人的订单不进名单', async () => {
    stubOrder({ availableTicketCount: 1 });
    const res = await get();
    expect(res.status).toBe(200);
    const body: any = await res.json();

    const byId = new Map<string, any>(body.data.sessions.map((s: any) => [s.sessionId, s]));
    // 隔离判据：别人的订单的队不在名单里（少这一条时，「不按 order_id 过滤」照样全绿）
    expect(byId.has(SES_OTHER)).toBe(false);
    expect(body.data.sessions).toHaveLength(3);

    // 分组判据：A 队 2 人、B 队 1 人。若实现把 members 全塞进一个队，这里立刻红
    expect((byId.get(SES_A).members as any[]).map((m) => m.miniUserId).sort()).toEqual(['u-leader-1', 'u-mate-1']);
    expect((byId.get(SES_B).members as any[]).map((m) => m.miniUserId)).toEqual(['u-mate-2']);
    expect(byId.get(SES_CLOSED).members).toEqual([]);
    expect(byId.get(SES_CLOSED).memberCount).toBe(0);
    // 下单人标记（leader 由 order.miniUserId 判定，不是「第一个入队的人」）。⚠️ 夹具刻意让 A 队**先插入** u-mate-1（非下单人）⇒ 「第一个入队」型实现必红
    expect((byId.get(SES_A).members as any[]).find((m) => m.miniUserId === 'u-leader-1').isLeader).toBe(true);
    expect((byId.get(SES_A).members as any[]).find((m) => m.miniUserId === 'u-mate-1').isLeader).toBe(false);
    // seq 升序（领队台按它渲染「第 1/2/3 队」）。⚠️ 夹具刻意打乱插入序（B/CLOSED/A）⇒ 删掉 orderBy 这里必红
    expect(body.data.sessions.map((s: any) => s.seq)).toEqual([1, 2, 3]);
    // 封口的队**照样列出**（status 一并回传，由页面决定怎么显示）
    expect(byId.get(SES_CLOSED).status).toBe('closed');
    // 票池水位（orders.vue / leader.vue 解释「票一张张变少」用）
    expect(body.data.order).toMatchObject({ quantity: 3, availableTicketCount: 1, miniUserId: 'u-leader-1' });
  });
});

describe.skipIf(!process.env.RUN_DB)('入队 POST /api/mini/wenlv/sessions/join', () => {
  const TS3 = Date.now();
  const CP3 = `cp-join-${TS3}`;
  const ORDER_J = randomUUID();
  const SES_J = `ses-join-a-${TS3}`;
  const SES_J2 = `ses-join-b-${TS3}`;
  const SES_G = `ses-join-departing-${TS3}`;
  const CODE_J = `J${String(TS3).slice(-7)}`;
  const CODE_J2 = `K${String(TS3).slice(-7)}`;
  const CODE_G = `G${String(TS3).slice(-7)}`;

  let transferCalls = 0;
  let transferBody: any = null;

  /** 桩：transfer 的三种结局（成功 / 池空 409 / 平台挂 status 0） */
  function stubTransfer(kind: 'ok' | 'full' | 'down') {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      if (String(url).includes('/internal/tickets/transfer')) {
        transferCalls++;
        transferBody = JSON.parse(opts.body);
        if (kind === 'down') throw new Error('ECONNREFUSED');
        if (kind === 'full') return { ok: false, status: 409, json: async () => ({ success: false, error: '本场名额已满' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { transferred: true, ticketId: 'tk1' } }) };
      }
      throw new Error('本 describe 不该打别的端点：' + url);
    }));
  }
  const join = (code: string, who: string) => wenlvRoute.request('/sessions/join', {
    method: 'POST', headers: mkMiniNoLeader(who), body: JSON.stringify({ code }),
  });
  const membersOf = (sid: string) => db.select().from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.sessionId, sid));

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: CP3, name: '入队剧本', status: 'published' });
    await db.insert(pmsBuiWenlvSessions).values([
      { id: SES_J, productId: CP3, orderId: ORDER_J, code: CODE_J, seq: 1, name: '第 1 队', status: 'forming' },
      { id: SES_J2, productId: CP3, orderId: ORDER_J, code: CODE_J2, seq: 2, name: '第 2 队', status: 'forming' },
      { id: SES_G, productId: CP3, orderId: ORDER_J, code: CODE_G, seq: 3, name: '第 3 队', status: 'departing' } // ⚠️ 刻意用 departing（非 closed）⇒ 把守卫写成 === 'closed' 的实现在此必红,
    ]);
    // SES_J2 预置一名「早已在队里」的人（下面「池空 + **既有**成员行」那条用例用它）
    await db.insert(pmsBuiWenlvProgress).values({
      id: `pg-join-old-${TS3}`, productId: CP3, miniUserId: 'u-old-1', sessionId: SES_J2,
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); transferCalls = 0; transferBody = null; });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, CP3));
    await db.delete(pmsBuiWenlvSessions).where(inArray(pmsBuiWenlvSessions.id, [SES_J, SES_J2, SES_G]));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, CP3));
  });

  it('未登录 401 / 缺码 400 / 码不存在 404', async () => {
    expect((await wenlvRoute.request('/sessions/join', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await join('', 'u-join-0')).status).toBe(400);
    const r = await join('NOSUCHCODE', 'u-join-0');
    expect(r.status).toBe(404);
  });

  it('封口的队（fixture 用 departing 而非 closed）⇒ 409「已出发」，且**不建行、不调 transfer**', async () => {
    stubTransfer('ok');
    const res = await join(CODE_G, 'u-join-1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('已出发');
    expect(await membersOf(SES_G)).toHaveLength(0);
    expect(transferCalls, '封口判定必须在建行之前').toBe(0);
  });

  it('入队成功：建 1 行、返回 memberCount、transfer 打到**本队所属订单**', async () => {
    stubTransfer('ok');
    const res = await join(CODE_J, 'u-join-1');
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toMatchObject({ sessionId: SES_J, seq: 1, name: '第 1 队', code: CODE_J, memberCount: 1 });

    const rows = await membersOf(SES_J);
    expect(rows).toHaveLength(1);
    expect(rows[0].miniUserId).toBe('u-join-1');
    expect(rows[0].productId).toBe(CP3);
    // ★ 拿错订单 = 从**别人的票池**取票（票少了、没人报错）
    expect(transferBody).toEqual({ orderId: ORDER_J, toMiniUserId: 'u-join-1' });
  });

  it('重复扫码：仍是 1 行（成员幂等），且 transfer **又被调了一次**（不跳过）', async () => {
    stubTransfer('ok');
    const res = await join(CODE_J, 'u-join-1');
    expect(res.status).toBe(200);
    expect(await membersOf(SES_J), '重复入队不得建第二行').toHaveLength(1);
    // 本用例是**同一个人第二次**扫码 ⇒ 若实现因「本地已有成员行」而跳过 transfer，这里会是 0。
    // 不能跳的根因：「他有没有票」的真相在平台侧（本订单 + 票池谓词），本地读不到 ——
    // 一旦跳过，第一次 transfer 失败（平台抖动）后他再怎么重扫也永远挂不上票。
    expect(transferCalls, 'transfer 不得被本地幂等短路').toBe(1);
  });

  it('🔴 池空（新成员）⇒ 409「名额已满」且本次新建的成员行被**回滚**', async () => {
    stubTransfer('full');
    const before = await membersOf(SES_J);
    const res = await join(CODE_J, 'u-join-9');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('名额已满');
    // 不回滚的话，名单里会列着「没票、/start 恒 403」的人 —— 而那正是本片要消灭的状态
    expect(await membersOf(SES_J)).toHaveLength(before.length);
    // 🔴 只判「不在名单里」**不够**：`set({ sessionId: null })` 型的「回滚」也能绿
    //    —— 那行会变成散客行，下一次扫码就被当成老散客。I4 要的是**行不存在**
    //    （与 Task 8 的 orphanRow 判别式同一把尺子）。
    expect(await db.select().from(pmsBuiWenlvProgress).where(and(
      eq(pmsBuiWenlvProgress.productId, CP3), eq(pmsBuiWenlvProgress.miniUserId, 'u-join-9'),
    )), '本次新建的 progress 行必须**不存在**（不是被置成散客行）').toHaveLength(0);
  });

  it('池空（**既有**成员行）⇒ 409 但那行**不动**（券过期后的重试就长这样）', async () => {
    stubTransfer('full');
    const res = await join(CODE_J2, 'u-old-1');
    expect(res.status).toBe(409);
    const rows = await membersOf(SES_J2);
    expect(rows, '既有行是别人的历史，回滚只许删本次新建的那行').toHaveLength(1);
    expect(rows[0].miniUserId).toBe('u-old-1');
  });

  it('池空 + 他在**别处**有历史行 ⇒ 只回滚本次新建的那行（不得按 product+user 连坐删）', async () => {
    stubTransfer('full');
    const res = await join(CODE_J, 'u-old-1'); // 他在 SES_J2 有行、在 SES_J 没有 ⇒ created 非 null
    expect(res.status).toBe(409);
    expect(await membersOf(SES_J2), '别处的历史行不得被连坐删除').toHaveLength(1);
    expect((await membersOf(SES_J)).some((r) => r.miniUserId === 'u-old-1'), '本次新建的行必须回滚').toBe(false);
  });

  it('平台不可达 ⇒ 502（不是 409），且本次新建的行被回滚', async () => {
    stubTransfer('down');
    const res = await join(CODE_J2, 'u-join-8');
    expect(res.status).toBe(502);
    expect((await membersOf(SES_J2)).some((r) => r.miniUserId === 'u-join-8')).toBe(false);
    // 同上：必须是**行不存在**，不是被置成散客行（该 describe 只预置了 u-old-1 一行）
    expect(await db.select().from(pmsBuiWenlvProgress).where(and(
      eq(pmsBuiWenlvProgress.productId, CP3), eq(pmsBuiWenlvProgress.miniUserId, 'u-join-8'),
    )), '本次新建的 progress 行必须**不存在**（不是被置成散客行）').toHaveLength(0);
  });
});

describe.skipIf(!process.env.RUN_DB)('移出 POST /api/mini/wenlv/sessions/:id/members/:uid/remove', () => {
  const TS4 = Date.now();
  const CP4 = `cp-rm-${TS4}`;
  const ORDER_R = randomUUID();
  const OTHER_ORDER_R = randomUUID();
  const SES_R = `ses-rm-a-${TS4}`;
  const SES_RX = `ses-rm-x-${TS4}`;      // 属于**别人订单**的队
  const U_RM = 'u-rm-1';
  const CODE_R = `M${String(TS4).slice(-7)}`;
  // ★ 复核轮补：上面 SES_R 只有**一名**成员 ⇒ 「删除键放宽成只按 sessionId（丢 miniUserId）」
  //   与「memberCount 恒 0」两种变异都能活。下面三队专为堵这两个洞：
  //   SES_R2 = 同队两名成员（移出不得连坐）；SES_R3/SES_R4 = **同一个 uid** 跨两个会话。
  const SES_R2 = `ses-rm-b-${TS4}`;
  const SES_R3 = `ses-rm-c-${TS4}`;
  const SES_R4 = `ses-rm-d-${TS4}`;
  const U_RM_B1 = 'u-rm-b1';
  const U_RM_B2 = 'u-rm-b2';
  const U_RM_C = 'u-rm-c1';

  let returnCalls = 0;
  let returnBody: any = null;

  /** 桩：按 URL 分流（本路由要打两个平台端点：by-leader-code 与 tickets/return） */
  function stubRemove(kind: 'ok' | 'redeemed' | 'down' | 'transfer-full') {
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      const u = String(url);
      if (u.includes('/internal/orders/by-leader-code')) {
        return { ok: true, status: 200, json: async () => ({ success: true, data: {
          orderId: ORDER_R, status: 'paid', paymentStatus: 'paid', quantity: 3,
          miniUserId: 'u-leader-1', slotId: null, productId: `p-trade-${TS4}`,
          contentProductId: CP4, availableTicketCount: 3,
        } }) };
      }
      if (u.includes('/internal/tickets/return')) {
        returnCalls++;
        returnBody = JSON.parse(opts.body);
        if (kind === 'down') throw new Error('ECONNREFUSED');
        if (kind === 'redeemed') return { ok: false, status: 409, json: async () => ({ success: false, error: '票已核销' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { returned: true } }) };
      }
      if (u.includes('/internal/tickets/transfer')) {
        if (kind === 'transfer-full') return { ok: false, status: 409, json: async () => ({ success: false, error: '本场名额已满' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: { transferred: true } }) };
      }
      throw new Error('本 describe 不该打这个端点：' + u);
    }));
  }
  const remove = (sid: string, uid: string, headers = H) => wenlvRoute.request(
    `/sessions/${sid}/members/${uid}/remove`, { method: 'POST', headers });
  const memberRow = (sid: string, uid: string) => db.select().from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.sessionId, sid), eq(pmsBuiWenlvProgress.miniUserId, uid)));
  /** I4 的负判据：这条查询**才是**「删了还是置 NULL 了」的判别式 */
  const orphanRow = (uid: string) => db.select().from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.productId, CP4), eq(pmsBuiWenlvProgress.miniUserId, uid),
               isNull(pmsBuiWenlvProgress.sessionId)));

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: CP4, name: '移出剧本', status: 'published' });
    await db.insert(pmsBuiWenlvSessions).values([
      { id: SES_R, productId: CP4, orderId: ORDER_R, code: CODE_R, seq: 1, name: '第 1 队', status: 'forming' },
      { id: SES_RX, productId: CP4, orderId: OTHER_ORDER_R, code: `N${String(TS4).slice(-7)}`, seq: 1, name: '别人的队', status: 'forming' },
      // seq 2/3/4 只为贴合真实建队形态（本表 seq 无唯一约束）；三队都属**本单** ORDER_R
      { id: SES_R2, productId: CP4, orderId: ORDER_R, code: `B${String(TS4).slice(-7)}`, seq: 2, name: '两人队', status: 'forming' },
      { id: SES_R3, productId: CP4, orderId: ORDER_R, code: `C${String(TS4).slice(-7)}`, seq: 3, name: '跨会话 A', status: 'forming' },
      { id: SES_R4, productId: CP4, orderId: ORDER_R, code: `D${String(TS4).slice(-7)}`, seq: 4, name: '跨会话 B', status: 'forming' },
    ]);
    await db.insert(pmsBuiWenlvProgress).values([
      { id: `pg-rm-1-${TS4}`, productId: CP4, miniUserId: U_RM, sessionId: SES_R },
      { id: `pg-rm-x-${TS4}`, productId: CP4, miniUserId: 'u-other-1', sessionId: SES_RX },
      // (miniUserId, productId, sessionId) 是 uq_wenlv_progress_team ⇒ 同 uid 跨会话合法
      { id: `pg-rm-b1-${TS4}`, productId: CP4, miniUserId: U_RM_B1, sessionId: SES_R2 },
      { id: `pg-rm-b2-${TS4}`, productId: CP4, miniUserId: U_RM_B2, sessionId: SES_R2 },
      { id: `pg-rm-c3-${TS4}`, productId: CP4, miniUserId: U_RM_C, sessionId: SES_R3 },
      { id: `pg-rm-c4-${TS4}`, productId: CP4, miniUserId: U_RM_C, sessionId: SES_R4 },
    ]);
  });
  afterEach(() => { vi.unstubAllGlobals(); returnCalls = 0; returnBody = null; });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, CP4));
    await db.delete(pmsBuiWenlvSessions).where(inArray(pmsBuiWenlvSessions.id, [SES_R, SES_RX, SES_R2, SES_R3, SES_R4]));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, CP4));
  });

  // ⚠️ 名字只列**本用例真断言了的** 4 个场景。原稿还写了「领队码无效 404」，但 `stubRemove`
  //    没有那个分支 ⇒ 该场景在本 describe 里**没有判据**（它在 Task 2 / Task 5 的
  //    「by-leader-code：无效码 404」用例里判）。名字宽于断言 = 替缺口担保，比漏本身更难抓。
  it('未登录 401 / 缺领队码 400 / 队不存在 404 / 平台挂 502', async () => {
    stubRemove('ok');
    expect((await wenlvRoute.request(`/sessions/${SES_R}/members/${U_RM}/remove`, { method: 'POST' })).status).toBe(401);
    expect((await remove(SES_R, U_RM, { ...H, 'X-Wenlv-Leader-Code': '' })).status).toBe(400);
    expect((await remove(`ses-nope-${TS4}`, U_RM)).status).toBe(404);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect((await remove(SES_R, U_RM)).status).toBe(502);
  });

  it('🔴 越权：**别人订单**的队 ⇒ 404，且那个队的成员行**必须还在**', async () => {
    stubRemove('ok');
    const res = await remove(SES_RX, 'u-other-1');
    // 回 404（不 403）：不向持码者泄露「这个 id 存在、只是不属于你」
    expect(res.status).toBe(404);
    // 少这一条时，「按 id 删行、不校验归属」照样全绿 —— 那是个能隔单踢人的洞
    expect(await memberRow(SES_RX, 'u-other-1')).toHaveLength(1);
    expect(returnCalls).toBe(0);
  });

  it('🔴 移出成功：行被**删掉**（不是置 NULL）、return 收到本单与本人、200', async () => {
    stubRemove('ok');
    const res = await remove(SES_R, U_RM);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toMatchObject({ removed: true, ticketReturned: true, memberCount: 0 });

    expect(await memberRow(SES_R, U_RM)).toHaveLength(0);
    // ★ I4 的判别式：`set({sessionId: null})` 会让上面那条**也是 0 行**（假绿）——
    //   只有这条能区分「删了」与「置 NULL 了」。置 NULL 的行既进不了场、又占着散客唯一索引的槽位。
    expect(await orphanRow(U_RM), 'I4：绝不允许 NULL 化出孤儿行').toHaveLength(0);
    expect(returnBody).toEqual({ orderId: ORDER_R, fromMiniUserId: U_RM });
  });

  it('幂等：再移一次 ⇒ 200 且 removed=false（行仍 0、不再产生孤儿行）', async () => {
    stubRemove('ok');
    const res = await remove(SES_R, U_RM);
    expect(res.status).toBe(200);
    expect((await res.json()).data.removed).toBe(false);
    expect(await memberRow(SES_R, U_RM)).toHaveLength(0);
    expect(await orphanRow(U_RM)).toHaveLength(0);
  });

  it('🔴 他的票已核销 ⇒ 200 + ticketReturned=false + warning，**且行已删**（诚实：移出确实生效了）', async () => {
    await db.insert(pmsBuiWenlvProgress).values({ id: `pg-rm-2-${TS4}`, productId: CP4, miniUserId: U_RM, sessionId: SES_R });
    stubRemove('redeemed');
    const res = await remove(SES_R, U_RM);
    // 不是 409：走到这一步成员行**已经删了**，回「无法移出」是说假话（P2 §4.3② 的文案在此顺序下不可达）
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.ticketReturned).toBe(false);
    expect(body.data.warning).toContain('核销');
    expect(await memberRow(SES_R, U_RM)).toHaveLength(0);
  });

  it('平台挂 ⇒ 502，行已删；**重试自愈**（DELETE 0 行仍幂等、return 对无票幂等）', async () => {
    await db.insert(pmsBuiWenlvProgress).values({ id: `pg-rm-3-${TS4}`, productId: CP4, miniUserId: U_RM, sessionId: SES_R });
    stubRemove('down');
    expect((await remove(SES_R, U_RM)).status).toBe(502);
    expect(await memberRow(SES_R, U_RM)).toHaveLength(0);
    stubRemove('ok');                       // 领队照提示重试
    expect((await remove(SES_R, U_RM)).status).toBe(200);
  });

  it('移出后**可以重新入队**（P2 §4.3 末句：行已删、票回池）', async () => {
    stubRemove('ok');
    const res = await wenlvRoute.request('/sessions/join', {
      method: 'POST', headers: mkMiniNoLeader(U_RM), body: JSON.stringify({ code: CODE_R }),
    });
    expect(res.status).toBe(200);
    expect(await memberRow(SES_R, U_RM)).toHaveLength(1);
  });

  // ★ 复核轮（代码质量）补的两条：原 7 条对下面两个洞**零判别力**（变异重放实测存活）
  it('🔴 移出**不连坐**同队其他人：只删本人那行，且 memberCount 减到 1（不是恒 0）', async () => {
    stubRemove('ok');
    const res = await remove(SES_R2, U_RM_B1);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    // ⚠️ memberCount 上面只在「移出成功」里断过一次、**且值是 0** ⇒ 把它硬编码成 0 也能全绿。
    //    这里断言 **1**（还剩另一名成员）才有判别力；顺带钉死「按 product 计数」那种写法。
    expect(body.data).toMatchObject({ removed: true, memberCount: 1 });
    expect(await memberRow(SES_R2, U_RM_B1), '本人那行该没了').toHaveLength(0);
    // ★ 判别式：删除键若放宽成只按 `sessionId`（丢掉 miniUserId）⇒ 这条变 0 行
    expect(await memberRow(SES_R2, U_RM_B2), '同队另一名成员的行**必须还在**').toHaveLength(1);
  });

  it('🔴 同一个 uid 在两个队都有行：只删**本会话**那行，不跨会话连坐', async () => {
    stubRemove('ok');
    const res = await remove(SES_R3, U_RM_C);
    expect(res.status).toBe(200);
    expect(await memberRow(SES_R3, U_RM_C), '本会话那行该没了').toHaveLength(0);
    // ★ 判别式：删除键若放宽成只按 `miniUserId`（丢掉 sessionId）⇒ 这条变 0 行
    expect(await memberRow(SES_R4, U_RM_C), '另一会话的行**必须还在**').toHaveLength(1);
  });
});

describe.skipIf(!process.env.RUN_DB)('通道判定 + 并集读路径', () => {
  const TS5 = Date.now();
  const CP5 = `cp-union-${TS5}`;
  const SES5 = `ses-union-${TS5}`;
  const U_ME = 'u-union-me';        // 团队行 + **更新的**散客行（通道判定的判别式）
  const U_MATE = 'u-union-mate';    // 队友：有 visited.X
  const U_SOLO = 'u-union-solo';    // 只有散客行
  const T5 = `tier-union-${TS5}`;
  const X = `node-x-${TS5}`;
  const U_DONE = 'u-union-done';   // 纯散客且**已通关**：`/start` 的 M5 回看分支（散客零回归的判据）

  /** 票桩：本 describe 里**只有 redeem** 会打平台（`assertTicket` ⇒ `/internal/tickets/check`）。 */
  const stubTicket = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/internal/tickets/check')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { valid: true, ticketId: 'tk' } }) };
    }
    throw new Error('本 describe 不该打别的端点：' + url);
  }));

  // ⚠️ 桩必须装在 `beforeEach` 里：写在 describe 体里是**模块收集期**执行，而本文件前面几个
  //    describe 的 `afterEach` 会 `unstubAllGlobals()` 把它卸掉 ⇒ 轮到本 describe 时无桩可用。
  beforeEach(() => stubTicket());
  afterEach(() => vi.unstubAllGlobals());

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: CP5, name: '并集剧本', status: 'published' });
    await db.insert(pmsBuiWenlvSessions).values({ id: SES5, productId: CP5, orderId: randomUUID(), code: `U${String(TS5).slice(-7)}`, seq: 1, name: '第 1 队', status: 'forming' });
    await db.insert(pmsBuiWenlvRewardTiers).values({ id: T5, productId: CP5, name: '档1', order: 1, condition: { type: 'ref', ref: { kind: 'collected', id: 's1' } } });
    await db.insert(pmsBuiWenlvProgress).values([
      // u-me 的散客行：updatedAt **更新**，且**先插入**（物理序在前）⇒ 「不排序」与「只按 updatedAt」两种实现都会取到它
      { id: `pg-un-me-solo-${TS5}`, productId: CP5, miniUserId: U_ME, sessionId: null,
        state: { visited: { soloOnly: true }, collected: {}, completed: {} }, updatedAt: new Date() },
      // u-me 的团队行：updatedAt 故意**更旧**、**后插入** ⇒ 只有 Step 7(a) 的 `is not null desc` 能把它排到最前
      { id: `pg-un-me-team-${TS5}`, productId: CP5, miniUserId: U_ME, sessionId: SES5,
        state: { visited: {}, collected: {}, completed: {} }, updatedAt: new Date(Date.now() - 60_000) },
      // 队友：有 X；另有一枚印章（用于负判据里「并集也不该让团队通道发档位」）
      { id: `pg-un-mate-${TS5}`, productId: CP5, miniUserId: U_MATE, sessionId: SES5,
        state: { visited: { [X]: true }, collected: { s1: true }, completed: {} } },
      // 纯散客：有 s1 ⇒ 档1 达成（claim-state 的**负判据**用他）
      { id: `pg-un-solo-${TS5}`, productId: CP5, miniUserId: U_SOLO, sessionId: null,
        state: { visited: {}, collected: { s1: true }, completed: {} } },
      // 纯散客且**已通关** ⇒ `/start` 的 M5 回看分支（散客路径不许因「通道判定」变成 403 或新建行）
      { id: `pg-un-done-${TS5}`, productId: CP5, miniUserId: U_DONE, sessionId: null, status: 'completed',
        state: { visited: { fin: true }, collected: {}, completed: { e1: true } } },
    ]);
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, CP5));
    await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, CP5));
    await db.delete(pmsBuiWenlvSessions).where(eq(pmsBuiWenlvSessions.id, SES5));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, CP5));
  });

  const progressOf = (uid: string) => wenlvRoute.request(`/${CP5}/progress`, { headers: mkMiniNoLeader(uid) });
  const claimStateOf = (uid: string) => wenlvRoute.request(`/${CP5}/claim-state`, { headers: mkMiniNoLeader(uid) });
  const startOf = (uid: string) => wenlvRoute.request(`/${CP5}/start`, { method: 'POST', headers: mkMiniNoLeader(uid) });

  it('🔴 团队通道：取**团队行**（散客行虽更新）⇒ sessionId 是队、union 与 mine 都下发', async () => {
    const res = await progressOf(U_ME);
    expect(res.status).toBe(200);
    const d: any = (await res.json()).data;
    // 判别式：若实现按 updatedAt 取最近（或干脆不排序），这里会拿到散客行 ⇒ sessionId=null、mine 里冒出 soloOnly
    expect(d.sessionId, '有团队行 ⇒ 团队通道（不靠 PG 行序、也不靠 updatedAt）').toBe(SES5);
    expect(d.union.visited[X], '队友的进度并进来').toBe(true);
    expect(d.mine.visited[X], '我的进度里没有 X').toBeUndefined();
    expect(d.mine.visited.soloOnly, 'mine 必须是我**本队那行**，不是散客行').toBeUndefined();
  });

  it('🔴 并集只读不写：库内我那一行**不许**出现队友的 X', async () => {
    const [row] = await db.select().from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, `pg-un-me-team-${TS5}`));
    expect(row.state.visited[X], 'I3：并集写回 = 静默的进度污染（不报错，只能这样抓）').toBeUndefined();
    expect(row.state.visited.soloOnly).toBeUndefined();
  });

  it('散客零回归：sessionId 为 null，且 union 与 mine 同内容（形状统一，客户端不必分叉）', async () => {
    const res = await progressOf(U_SOLO);
    const d: any = (await res.json()).data;
    expect(d.sessionId).toBeNull();
    // ⚠️ 只写这一行是**近失**：改前 `union` 与 `mine` 两边都读不到时它也平凡通过（绿得对称）。
    //    必须另有一条**点名读到**的断言承重。
    expect(d.union.collected.s1, 'union 必须真的读到并集（两侧都 undefined 时 toEqual 平凡通过）').toBe(true);
    expect(d.union).toEqual(d.mine);
    expect(d.mine.collected.s1).toBe(true);
  });

  it('claim-state：团队 ⇒ **空档位**；散客 ⇒ 正常档位（负判据：不是把整条端点关掉）', async () => {
    const team: any = await (await claimStateOf(U_MATE)).json();
    // 依据 §八 U1(b)「团队场次不发个人档位」：拿并集算会造出「并集满足 ⇒ 人人可领」
    expect(team.data).toEqual({ collectedStampCount: 0, tiers: [] });
    const solo: any = await (await claimStateOf(U_SOLO)).json();
    expect(solo.data.collectedStampCount).toBe(1);
    expect(solo.data.tiers[0]).toMatchObject({ id: T5, met: true, claimed: false });
  });

  it('redeem：团队通道 ⇒ 403「不发个人档位」且**不写 claim 行**', async () => {
    const before = await db.select().from(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, CP5));
    const res = await wenlvRoute.request(`/${CP5}/redeem`, {
      method: 'POST', headers: mkMiniNoLeader(U_MATE), body: JSON.stringify({ tierId: T5 }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('团队场次');
    const after = await db.select().from(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, CP5));
    expect(after.length, '挡住请求还不够：核销码一旦发出去就要收回实物').toBe(before.length);
  });

  it('无进度行 ⇒ data 为 null（既有语义不变）', async () => {
    const d: any = await (await progressOf('u-none-' + TS5)).json();
    expect(d).toEqual({ success: true, data: null });
  });

  it('🔴 `/start` 用同一条通道判定：有团队行 ⇒ 取团队行（散客行虽更新）', async () => {
    const res = await startOf(U_ME);
    expect(res.status).toBe(200);
    const d: any = (await res.json()).data;
    // 判别式：内联无排序 `.limit(1)`（或只按 updatedAt 排序）⇒ 拿到散客行 ⇒ sessionId 为 null
    expect(d.sessionId, '有团队行 ⇒ 团队通道（P2 §4.4 第 3 落点）').toBe(SES5);
    expect(d.miniUserId).toBe(U_ME);
  });

  // ⚠️ 这一条是**回归闸**、不是判据威力：修前修后都绿（只有一个散客行 ⇒ 任何实现都返回它）。
  //    靶子是**过度修法**「没有团队行就返回 null」；但它**测不到**另一种写法（见下一条）——
  //    completed 行会被 M5 回看分支短路 ⇒ 两种写法响应逐字相同。
  it('散客零回归：只有散客行 ⇒ `/start` 照旧返回它（**已通关**行原样放行）', async () => {
    const res = await startOf(U_DONE);
    expect(res.status).toBe(200);
    const d: any = (await res.json()).data;
    expect(d.sessionId).toBeNull();
    expect(d.status, '已通关的散客行原样放行（回看）').toBe('completed');
  });

  // 🔴 补上一条**测不到**的那种过度修法：`if (existing?.sessionId) return …`（有散客行但不是团队行
  //    ⇒ 当成「没有 existing」）放在 M5 **之后** ⇒ 落回 INSERT ⇒ 撞 `uq_wenlv_progress_solo` ⇒ **500**。
  //    必须用 **active** 的散客行才测得到（U_SOLO）：completed 行被 M5 短路，两种写法响应逐字相同。
  it('散客零回归（active 行）：只有散客行 ⇒ `/start` 返 200、不落回 INSERT', async () => {
    const res = await startOf(U_SOLO);
    expect(res.status, '落回 INSERT ⇒ 撞 uq_wenlv_progress_solo ⇒ 500').toBe(200);
    const d: any = (await res.json()).data;
    expect(d.sessionId).toBeNull();
    expect(d.status).toBe('active');
  });
});

describe.skipIf(!process.env.RUN_DB)('并集写侧：判定用并集、写回用自己、到场门用自己', () => {
  const TS6 = Date.now();
  const CP6 = `cp-write-${TS6}`;
  const SES6 = `ses-write-${TS6}`;
  const U_A = 'u-write-a';        // 队友：夹具里已到过到场门节点 ZA
  const U_B = 'u-write-b';        // 主角：进度里什么都还没有
  const U_B2 = 'u-write-b2';      // 结局用例专用（要一行**未结算**的进度）
  const U_SOLO6 = 'u-write-solo';
  const U_SOLO2 = 'u-write-solo2';    // 第二名散客、**有** s1 —— 用例 4 的判别力就寄存在这一行
  const U_B3 = 'u-write-b3';      // `/answer` 成功路径专用：自己的进度为空、**无**散客行（与 A/B2 同待遇）
  const NQ = `n-q-${TS6}`;        // 答题节点：`triggerType='manual'` + `venuePointId=null` ⇒ 不过到场门；unlock 需 s1
  const NX = `n-x-${TS6}`;        // 发 s1 的节点（无凭证）
  const NY = `n-y-${TS6}`;        // unlock 需要 s1（这就是「队友的进度能开门」的判据）
  const NZ = `n-z-${TS6}`;        // 不需 unlock：只用来跑一次结算
  const NZA = `n-za-${TS6}`;      // 需要**到场凭证**（triggerType='arrive'）
  const E1 = `e-team-${TS6}`;
  const S1 = `s1-${TS6}`;

  const stubTicket = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/internal/tickets/check')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { valid: true, ticketId: 'tk' } }) };
    }
    throw new Error('本 describe 不该打别的端点：' + url);
  }));
  beforeEach(() => stubTicket());
  afterEach(() => vi.unstubAllGlobals());

  const post = (path: string, body: unknown, uid: string) => wenlvRoute.request(path, {
    method: 'POST', headers: mkMiniNoLeader(uid), body: JSON.stringify(body),
  });
  const rowOf = async (uid: string) => {
    const [r] = await db.select().from(pmsBuiWenlvProgress).where(and(
      eq(pmsBuiWenlvProgress.productId, CP6), eq(pmsBuiWenlvProgress.miniUserId, uid)));
    return r;
  };

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: CP6, name: '并集写侧剧本', status: 'published' });
    await db.insert(pmsBuiWenlvSessions).values({ id: SES6, productId: CP6, orderId: randomUUID(), code: `W${String(TS6).slice(-7)}`, seq: 1, name: '第 1 队', status: 'forming' });
    const ch6 = await ensureChapter(db, CP6);
    await db.insert(pmsBuiWenlvScenes).values([
      { id: NX, chapterId: ch6, type: 'narrative', title: '发章点',
        grants: [S1], requires: null, order: 1, puzzle: null },
      { id: NY, chapterId: ch6, type: 'narrative', title: '需要 s1 的门',
        requires: { type: 'ref', ref: { kind: 'collected', id: S1 } }, order: 2, puzzle: null },
      { id: NZ, chapterId: ch6, type: 'narrative', title: '随便一个点',
        requires: null, order: 3, puzzle: null },
      // 需要到场凭证的节点：`nodeRequiresCredential = !!venuePointId`
      { id: NZA, chapterId: ch6, type: 'narrative', title: '到场关口',
        venuePointId: null, requires: null, order: 4,
        puzzle: { type: 'single', question: '口令？', options: ['甲'], answer: '甲' } },
      // 答题节点：无点位 ⇒ `nodeRequiresCredential` 为 false（不过到场门），
      // 但 unlock 需要 s1 ⇒ 只有**并集**能放行（钉 `/answer` 的 ① 副本）。
      { id: NQ, chapterId: ch6, type: 'narrative', title: '答题点',
        venuePointId: null, requires: { type: 'ref', ref: { kind: 'collected', id: S1 } }, order: 5,
        grants: [],
        puzzle: { type: 'single', question: '口令？', options: ['甲'], answer: '甲' } },
      // 结局场景（type='ending'）
      { id: E1, chapterId: ch6, type: 'ending', title: '队伍结局',
        triggerCondition: { type: 'ref', ref: { kind: 'collected', id: S1 } }, priority: 1, order: 6 },
    ]);
    await db.insert(pmsBuiWenlvProgress).values([
      // A：夹具里已到过 ZA（**关键夹具** —— 用例 2 的判别力就寄存在这里）
      { id: `pg-w-a-${TS6}`, productId: CP6, miniUserId: U_A, sessionId: SES6,
        state: { visited: { [NZA]: true }, collected: {}, completed: {} } },
      { id: `pg-w-b-${TS6}`, productId: CP6, miniUserId: U_B, sessionId: SES6,
        state: { visited: {}, collected: {}, completed: {} } },
      { id: `pg-w-b2-${TS6}`, productId: CP6, miniUserId: U_B2, sessionId: SES6,
        state: { visited: {}, collected: {}, completed: {} } },
      { id: `pg-w-b3-${TS6}`, productId: CP6, miniUserId: U_B3, sessionId: SES6,
        state: { visited: {}, collected: {}, completed: {} } },
      // A 自己在队里 ⇒ 他的进度会进并集。B2/A 都有散客行会干扰通道判定，故**不**给他们造散客行，
      // 只给两名散客各造一行（U_SOLO6 = 无 s1 的对照；U_SOLO2 = **有** s1，用例 4 的判别力来源）
      // 第二名散客、**有** s1：若实现把散客也接进并集（或对 CP6 全表取 OR），SOLO6 会被这一行放开
      //    ⇒ 用例 4 从 403 变 200 ⇒ 红。没有它，用例 4 对「散客被误接进并集」是**空断言**。
      { id: `pg-w-solo2-${TS6}`, productId: CP6, miniUserId: U_SOLO2, sessionId: null,
        state: { visited: {}, collected: { [S1]: true }, completed: {} } },
      { id: `pg-w-solo-${TS6}`, productId: CP6, miniUserId: U_SOLO6, sessionId: null,
        state: { visited: {}, collected: {}, completed: {} } },
    ]);
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, CP6));
    await deleteScenesOfProduct(db, CP6);
    await db.delete(pmsBuiWenlvSessions).where(eq(pmsBuiWenlvSessions.id, SES6));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, CP6));
  });

  it('🔴 判定用并集：队友发的 s1 能开我的门，且**我的行里不许出现 s1**（I3）', async () => {
    // 前提自证：A 先真触发 NX 拿到 s1（不是靠夹具塞进去的）
    expect((await post('/trigger', { productId: CP6, nodeId: NX }, U_A)).status).toBe(200);
    expect((await rowOf(U_A)).state.collected[S1]).toBe(true);

    const res = await post('/trigger', { productId: CP6, nodeId: NY }, U_B);
    expect(res.status, 'B 自己没有 s1，靠队友的并集才该放行').toBe(200);
    const b = await rowOf(U_B);
    expect(b.state.visited[NY]).toBe(true);
    // ★ 少这条断言时，「把 evalState 写回」的实现照样全绿 —— 而那是静默的进度污染
    expect(b.state.collected[S1], 'I3：并集只许喂判定，不许写进我的行').toBeUndefined();
  });

  it('🔴 到场门用**自己**：队友到过 ZA，我仍拿 403「请先到场触发该节点」', async () => {
    // 前提自证：并集里**确实**含 ZA（否则本用例是空断言）
    const union: any = await (await wenlvRoute.request(`/${CP6}/progress`, { headers: mkMiniNoLeader(U_B) })).json();
    expect(union.data.union.visited[NZA], '夹具必须真的让并集含 ZA').toBe(true);
    expect(union.data.mine.visited[NZA]).toBeUndefined();

    const before = await rowOf(U_B);
    // 提交的是**正确答案**：若到场门被错写成读并集，请求会一路走到 applyEffects 并落库 ⇒ 这条才抓得住
    const res = await post('/answer', { productId: CP6, nodeId: NZA, interactionIndex: 0, answer: '甲' }, U_B);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('到场');
    const after = await rowOf(U_B);
    expect(after.state, '被拒的请求不得写任何进度').toEqual(before.state);
  });

  it('🔴 结局拆两半：队伍结局按并集进响应主位，**我自己的行不许被写成队伍结局**（S §6.3 / S:585）', async () => {
    // 前提自证（**不**依赖用例 1 的执行顺序）：A 真触发 NX 拿到 s1 ⇒ 并集里才有 s1
    expect((await post('/trigger', { productId: CP6, nodeId: NX }, U_A)).status).toBe(200);

    const res = await post('/trigger', { productId: CP6, nodeId: NZ }, U_B2);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    // 主位 = 队伍结局（并集求值）：B2 自己没发过 s1，队友 A 发过 ⇒ 队伍的 E1 达成
    expect(body.data.endings, '队伍结局为主，按并集求值（S §6.3）').toContain(E1);
    // 次位 = 我的个人结局（读自己那行）：B2 自己没发过 s1 ⇒ 不该含 E1
    expect(body.data.mine, '个人结局读自己那行 ⇒ B2 不该拿到 E1').not.toContain(E1);
    // 🔴 承重断言（**读库**，S:585）：队员自己没达成任何结局 ⇒ 他那行必须仍是 active / endingId 为 null /
    //    completedAt 为 null。把并集写进他自己那行 = 个人结局被队伍结局覆盖，**不报任何错**，只能靠这三行抓。
    const b2 = await rowOf(U_B2);
    expect(b2.endingId, 'S:585/593：个人结局读自己那行 ⇒ 不得落队伍结局').toBeNull();
    expect(b2.status, '个人结局未达成 ⇒ 不得被翻成 completed').toBe('active');
    expect(b2.completedAt).toBeNull();
  });

  it('散客零回归：散客没有队 ⇒ 判定只用自己那行（**别的散客有 s1 也不算数**）（unlock 未满足 ⇒ 403）', async () => {
    // 前提自证：库里**确实**有另一名散客拿着 s1（否则本用例对「散客被误接进并集」零判别力）
    expect((await rowOf(U_SOLO2)).state.collected[S1], '夹具必须真的让 s1 存在于第二名散客那行').toBe(true);

    const res = await post('/trigger', { productId: CP6, nodeId: NY }, U_SOLO6);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('前置条件');
  });

  it('🔴 /answer 成功路径同样是「结局拆两半」：队伍结局进主位、个人结局读自己那行（**只钉 /trigger 的那 4 条管不到这里**）', async () => {
    // 前提自证：并集里**确实**有 s1（否则「endings 含 E1」与「mine 不含 E1」两边都是空集 ⇒ 判别力为 0）
    expect((await post('/trigger', { productId: CP6, nodeId: NX }, U_A)).status).toBe(200);
    const u: any = await (await wenlvRoute.request(`/${CP6}/progress`, { headers: mkMiniNoLeader(U_B3) })).json();
    expect(u.data.union.collected[S1], '夹具必须真的让并集含 s1').toBe(true);
    expect(u.data.mine.collected[S1], '前提：B3 自己没有 s1').toBeUndefined();

    // NQ 不过到场门，但 unlock 需要 s1 ⇒ 只有「判定用并集」才放行
    const res = await post('/answer', { productId: CP6, nodeId: NQ, interactionIndex: 0, answer: '甲' }, U_B3);
    expect(res.status, 'NQ 无到场凭证，且 B3 不能靠自己那行开门').toBe(200);
    const body: any = await res.json();
    expect(body.data.correct).toBe(true);
    expect(body.data.endings, '队伍结局为主，按并集求值').toContain(E1);
    expect(body.data.mine, '个人结局读自己那行 ⇒ B3 不该拿到 E1').not.toContain(E1);
    // 🔴 承重断言（**读库**）：把并集喂给 `/answer` 的 settleEndings ⇒ B3 那行被写成队伍结局，**不报任何错**。
    //    ⚠️ 它们的**唯一**职责是「落库那一半」：M7 会先在 `mine` 那条断言上红（`settleEndings` 的返回值就是 `satisfiedIds`），而「按自己求 mine、却又拿并集多落一次库」这类**只改落库**的写法（复核实测 M9）**只有**它们抓得住。
    const b3 = await rowOf(U_B3);
    expect(b3.endingId, 'S:585：个人结局读自己那行 ⇒ 不得落队伍结局').toBeNull();
    expect(b3.status, '个人结局未达成 ⇒ 不得被翻成 completed').toBe('active');
    expect(b3.completedAt).toBeNull();
    // ③ 的 `/answer` 副本：写回也必须用自己那行（与用例 1 对 `/trigger` 的断言同形）
    expect(b3.state.visited[NQ], '正向前提：请求确实落了 visited').toBe(true);
    expect(b3.state.collected[S1], 'I3：并集只许喂判定，不许写进我的行').toBeUndefined();
  });
});
