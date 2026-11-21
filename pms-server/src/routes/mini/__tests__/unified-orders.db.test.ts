// 合并订单列表：住宿侧真查库（本机回环 aipms，见 vitest.local.config.ts 的 assertLoopback 硬闸），
// 文旅侧 mock 掉 platform-client —— 真打 HTTP 在本地恒失败，那样只能测到降级分支。
// ⚠️ MINI_JWT_SECRET 不在 constants.ts 的顶层 eager 读取里 —— parseMiniToken 请求时经 requireEnv 取
//    ⇒ 本行赋值只需早于首个 route.request()。（同 wenlv-trade-slots.test.ts 的同款注）
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

// ⚠️ 工厂整体 `as any`、用 `importOriginal` **形参**取真模块（不取 vi.importActual）。
//    vi API 是否可用一律以 src/types/vitest.d.ts 为准，不在此复述成员表。仓内既定做法见
//    src/routes/mini/__tests__/pay-notify-wenlv.test.ts（工厂写法与理由）；
//    另一份写了理由的是 src/routes/admin/__tests__/wenlv-style-bible.test.ts —— 后者**不在**
//    本目录（admin/__tests__ 下），引用时一律带上路径。
vi.mock('../../../services/platform-client.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  listWenlvOrders: vi.fn(),
  listProductOrders: vi.fn(),
})) as any);

import { db } from '../../../db/index.js';
import { pmsBuiOrders, pmsBuiStores } from '../../../db/schema/index.js';
import { listWenlvOrders, listProductOrders } from '../../../services/platform-client.js';
import unifiedOrdersRoute from '../unified-orders.js';

// 被 mock 的绑定运行时就是 vi.fn()；桩没有 `vi.mocked`，按被用到的调用面显式取类型
// （仓内先例：pay-notify-wenlv.test.ts 的 FnMock、wenlv-style-bible.test.ts 的 BsbMock）。
type FnMock = {
  mockReset: () => void;
  mockResolvedValue: (v: unknown) => void;
  mockImplementation: (f: () => Promise<unknown>) => void;
};
const listWenlvMock = listWenlvOrders as unknown as FnMock;
const listProductMock = listProductOrders as unknown as FnMock;

// ⚠️ 本仓**没有** signMiniToken 之类的辅助函数（见 wenlv-trade-slots.test.ts 的原文自述）⇒
//    照同目录先例的 `mkMini` 自己 jwt.sign，payload 形状与它一致。
const signMiniToken = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

const GUEST = 'u-unified-' + randomUUID().slice(0, 8);
const NOW = Date.now();
// 🔴 住宿侧 select 的别名键必须真被 mapper 读到 ⇒ 夹具里**必须**有一条 otaTimeout 非空的单。
//    否则「`payDeadline: pmsBuiOrders.otaTimeout` 被打成 payDeadlineTypo ⇒ 读到 undefined
//    ⇒ 静默变 null」这件事在端点上完全看不见（判别力寄存在夹具默认值上：原来两行的
//    otaTimeout 都没插，payDeadline 期望值本来就是 null）。
const DEADLINE = new Date('2026-12-31T15:45:00.000Z');
const CREATED_OLDER = new Date(NOW - 3 * 3600_000);
// 🔴 门店名必须**真联出来**：夹具若把每一行的 storeId 都留成 null，LEFT JOIN 就恒出 storeName=null，
//    标题恒等于 `[null, '大床房'].filter(Boolean).join(' · ')` = '大床房' ——
//    于是「storeName 这个别名键打错」与「打对」给出**同一个标题**，那条断言对它零判别力
//    （实测：把 `storeName:` 改成 `storeNameX:`，整批仍全绿）。所以夹具里必须有一行指向**真实存在的门店**。
const STORE_ID = 'st-uo-' + randomUUID().slice(0, 8);
const STORE_NAME = '黄果树观景客栈';
const mkLodging = (id: string, createdAt: Date, status = 'pending_confirm', otaTimeout: Date | null = null, storeId: string | null = null) => ({
  id, merchantId: 'default', orderNo: 'BUI-' + id, channel: 'mini', guestName: '测试', guestId: GUEST,
  checkIn: '2026-10-01', checkOut: '2026-10-02', roomType: '大床房', nights: 1, totalPrice: 120,
  source: 'mini', paymentStatus: 'unpaid', status, storeId, createdAt, otaTimeout,
});
const okWenlv = (list: any[]) => ({ ok: true, status: 200, data: { success: true, data: { list, total: list.length } } }) as any;
const okProduct = (list: any[]) => ({ ok: true, status: 200, data: { success: true, list, data: list } }) as any;

describe.skipIf(!process.env.RUN_DB)('GET /api/mini/orders/unified（DB + mock 平台）', () => {
  const ids: string[] = [];
  let deadlineOrderNo = '';
  beforeAll(async () => {
    // 门店行必须先插：住宿侧那一行要 storeId 指向它，LEFT JOIN 才出真门店名（见上面 STORE_* 的理由）。
    // ⚠️ 这里用 raw SQL **只点名真有的四列**，不用 `db.insert(pmsBuiStores).values({...})`：
    //    本机库 aipms 尚未应用 migrations/002_add_store_region_tags.sql ⇒ 表里没有 region_tags，
    //    而 drizzle 的 insert 会把**整张表**的列都投影出来（没有的列也照写 `default`）⇒
    //    42703 column "region_tags" does not exist。生产库有那一列，本机只是迁移滞后；
    //    只碰 id/brand_id/brand_name/name ⇒ 迁移前后两种库态都能跑。
    await db.execute(sql`insert into pms_bui_stores (id, brand_id, brand_name, name)
      values (${STORE_ID}, ${'test-brand'}, ${'测试品牌'}, ${STORE_NAME})`);
    for (const [i, at] of [CREATED_OLDER, new Date(NOW - 3600_000)].entries()) {
      const id = 'uo-' + randomUUID().slice(0, 12);
      ids.push(id);
      // 第 1 行（最早的那条）带 otaTimeout 且挂到真门店 —— 它就是下面「键名契约」那条判据的被测行
      await db.insert(pmsBuiOrders).values(mkLodging(id, at, 'pending_confirm', i === 0 ? DEADLINE : null, i === 0 ? STORE_ID : null) as any);
      if (i === 0) deadlineOrderNo = 'BUI-' + id;
    }
    // 阳性对照：**别人**的单（同 source='mini'、不同 guestId）
    const otherId = 'uo-other-' + randomUUID().slice(0, 8);
    ids.push(otherId);
    await db.insert(pmsBuiOrders).values({ ...mkLodging(otherId, new Date(NOW)), guestId: 'someone-else' } as any);
  });
  afterAll(async () => {
    for (const id of ids) await db.delete(pmsBuiOrders).where(eq(pmsBuiOrders.id, id));
    // 门店行也要清掉（它不在 ids 里）—— 别给同库并行的 *.db.test.ts 留残留行
    await db.delete(pmsBuiStores).where(eq(pmsBuiStores.id, STORE_ID));
    vi.clearAllMocks();
  });
  beforeEach(() => {
    listWenlvMock.mockReset();
    listProductMock.mockReset();
    // 🔴 必须给默认成功值：裸 vi.fn() 返回 undefined ⇒ 路由读 r.ok 抛 TypeError ⇒ 整页 500，
    //    而走到取数那一步、又没自己设过它的用例会跟着红（症状是「莫名其妙的 500」）。
    listProductMock.mockResolvedValue(okProduct([]));
  });

  const call = (token: string) => unifiedOrdersRoute.request('/', { headers: { Authorization: `Bearer ${token}` } });

  it('未登录 → 401', async () => {
    expect((await unifiedOrdersRoute.request('/')).status).toBe(401);
  });

  it('🔴 两个来源合成一条按时间降序的列表，且只含自己的住宿单', async () => {
    listWenlvMock.mockResolvedValue(okWenlv([
      { id: 'w-new', orderNo: 'WENLV-NEW', productName: '龙门谜案', totalAmount: '88.00', quantity: 1, seatCount: 2, status: 'paid', paymentStatus: 'paid', slotId: 's1', createdAt: new Date(NOW).toISOString() },
    ]));
    const res = await call(signMiniToken(GUEST));
    expect(res.status).toBe(200);
    const { list, degraded } = (await res.json()).data;
    expect(list.map((o: any) => o.type)).toEqual(['wenlv', 'lodging', 'lodging']);
    expect(degraded, '上游成功时不得有降级标记').toBeUndefined();
    // 自己的两条都在、别人的那条不在
    expect(list.filter((o: any) => o.type === 'lodging')).toHaveLength(2);
    expect(list.some((o: any) => o.id.includes('other'))).toBe(false);
    expect(list[0].amount).toBe('88.00');
    expect(list[1].amount).toBe('120');
  });

  it('🔴 上游失败 ⇒ 住宿照常返回 + degraded 标记（**不是**静默空列表）', async () => {
    listWenlvMock.mockResolvedValue({ ok: false, status: 0, data: null } as any);
    const res = await call(signMiniToken(GUEST));
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.degraded).toBe(true);
    expect(body.degradedSources).toContain('wenlv');
    expect(body.list.filter((o: any) => o.type === 'lodging'), '平台挂了不该把住宿单一起吞掉').toHaveLength(2);
  });

  // 🔴 `db.select({...})` 的**别名键**与 order-feed.ts 里 mapper 读的键（`row.xxx`）之间
  //    没有任何类型在核（mapper 入参是 `any`，tsc 看不见）。把 `payDeadline: pmsBuiOrders.otaTimeout`
  //    打成 `payDeadlineTypo:` ⇒ `row.payDeadline === undefined` ⇒ `== null` 成立 ⇒ 每条住宿单的
  //    payDeadline 静默变 null：C 端支付倒计时永不显示，而 mini-scheduler 照旧超时取消订单。
  //    只有「真查库 + 断言那个字段的**值**」能钉住这个契约（键集合断言钉不住：mapper 是显式建对象）。
  it('🔴 住宿侧 select 的别名键必须真被 mapper 读到（改别名 ⇒ 字段静默变 null/空）', async () => {
    listWenlvMock.mockResolvedValue(okWenlv([]));
    const res = await call(signMiniToken(GUEST));
    expect(res.status).toBe(200);
    const { list } = (await res.json()).data;
    const row = list.find((o: any) => o.orderNo === deadlineOrderNo);
    expect(row, '带 otaTimeout 的夹具行必须出现在结果里').toBeDefined();
    expect(row.payDeadline, '别名与 mapper 读的键名不一致 ⇒ 支付倒计时永不显示，而超时取消照旧发生').toBe(DEADLINE.toISOString());
    // 同一条契约的其余别名 —— select 里每一个键都是一个可能的静默点
    expect(row.type).toBe('lodging');
    expect(row.createdAt, 'createdAt 别名打错 ⇒ 排序哨兵把住宿单挪到末尾（而条数断言看不出来）').toBe(CREATED_OLDER.toISOString());
    // 这一行挂的是**真门店**（上面 STORE_*），所以标题里两个字段都得出现：
    // storeName 别名打错 ⇒ 只剩房型；roomType 别名打错 ⇒ 只剩门店名。缺任何一个都红。
    expect(row.title, '标题由「门店名 · 房型」拼成：两个别名键任缺其一都会让这里少一段').toBe('黄果树观景客栈 · 大床房');
    expect(row.amount, 'totalPrice 别名打错 ⇒ 金额变空串').toBe('120');
    expect(row.status).toBe('pending_confirm');
    expect(row.paymentStatus).toBe('unpaid');
    expect(row.extra, 'checkIn/checkOut/nights/guestName 别名打错 ⇒ extra 里静默变 null').toMatchObject({
      checkIn: '2026-10-01', checkOut: '2026-10-02', nights: 1, guestName: '测试',
    });
  });

  // 🔴 「上游 HTTP 200 但形状畸形」这一格此前没有判据：上面两条用例的 mock 只覆盖了
  //    「成功（data.data.list 是数组）」与「非 2xx（ok:false）」两种形状。
  //    platformFetch 的返回约定是 `{ ok: res.ok && data?.success !== false, status, data }`
  //    （见 services/platform-client.ts 里 `platformFetch` 的 return）⇒ **HTTP 200 + 信封缺 list 时 ok 仍为 true**，
  //    唯一的防线就是 unified-orders.ts 里那半个 `Array.isArray(r.data?.data?.list)`。
  //    把守卫写成 `!r.ok`（去掉数组守卫）⇒ degraded=false ⇒ 直接 `r.data.data.list.map`
  //    ⇒ TypeError ⇒ 整页 500，而仓库原有用例全绿。
  it('🔴 上游 200 但形状畸形 ⇒ 不得 500（degraded + 住宿照常返回）', async () => {
    const shapes = [
      { label: '200 + data.data 为 {}', res: { ok: true, status: 200, data: { success: true, data: {} } } },
      { label: '200 + list 为 null', res: { ok: true, status: 200, data: { success: true, data: { list: null } } } },
      { label: '200 + 连 data 信封都没有', res: { ok: true, status: 200, data: { success: true } } },
      // 近失：真值但**不是数组** ⇒ 光判真值（`r.data?.data?.list`）挡不住，必须 Array.isArray
      { label: '200 + list 是非数组真值', res: { ok: true, status: 200, data: { success: true, data: { list: 'nope' } } } },
      // 🔴 反向的一条：`ok` 为假、而 `list` 是**合法数组**。上面那些形状都在 ok:true 上做变化，
      //    而「上游失败」那条用的 { ok:false, data:null } 又让 r.ok 与 Array.isArray **同时为假**
      //    ⇒ 两个合取项在整批里分不开：把守卫改成 `!Array.isArray(...)`（**漏掉 r.ok**）整批仍全绿。
      //    这一条让两者反向 ⇒ 漏掉 r.ok 就会采信一个**自己声明失败**的信封里的数据。
      { label: '200 + ok:false 但 list 是合法数组（错误信封不得被采信）', res: { ok: false, status: 200, data: { success: false, data: { list: [{ id: 'w-untrusted', orderNo: 'WENLV-UNTRUSTED', productName: '不该被采信', totalAmount: '1.00', quantity: 1, seatCount: 1, status: 'paid', paymentStatus: 'paid', slotId: 's1', createdAt: new Date(NOW).toISOString() }] } } } },
    ];
    for (const s of shapes) {
      listWenlvMock.mockResolvedValue(s.res as any);
      const res = await call(signMiniToken(GUEST));
      expect(res.status, s.label + '：畸形上游不得把整页打成 500').toBe(200);
      const body = (await res.json()).data;
      expect(body.degraded, s.label + '：形状不对必须落 degraded（守卫写成 !r.ok 就去掉了数组守卫）').toBe(true);
      expect(body.degradedSources, s.label + '：degradedSources 要点名 wenlv').toContain('wenlv');
      // 守卫的**意图**：一条坏数据不许吞掉另一个来源
      expect(body.list.filter((o: any) => o.type === 'lodging'), s.label + '：一条坏数据不许吞掉住宿源').toHaveLength(2);
      expect(body.list.some((o: any) => o.type === 'wenlv'), s.label + '：形状不对时文旅源应落空列表（不得半信半疑地采信）').toBe(false);
    }
  });

  it('🔴 三源：套餐单也进列表，且分源降级只点失败的那一侧', async () => {
    listWenlvMock.mockResolvedValue(okWenlv([]));
    listProductMock.mockResolvedValue(okProduct([
      { id: 'po-1', orderNo: 'PRD-1', productName: '黔村院子·两日解谜套餐', storeId: 'st-1',
        totalAmount: '1088.00', status: 'paid', paymentStatus: 'paid', mode: 'A', depositAmount: '288.00',
        reservationStatus: 'confirmed', roomNights: 2, quantity: 1, reservationDate: '2026-10-01',
        createdAt: new Date(NOW - 60_000).toISOString() },
    ]));
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    const row = body.list.find((o: any) => o.type === 'product');
    expect(body.list.map((o: any) => o.type), '合并序：套餐单在 NOW-60s（最新）⇒ 必须排第一；缺它就是第三来源没接上').toEqual(['product', 'lodging', 'lodging']);
    expect(row.title).toBe('黔村院子·两日解谜套餐');
    expect(row.amount, '金额取顶层 amount（旧代码的 totalAmount 取法已统一）').toBe('1088.00');
    expect(row.extra, 'extra 缺键 ⇒ 新订单页上「入住指南/去预约/订金」静默消失').toMatchObject({
      storeId: 'st-1', reservationStatus: 'confirmed', roomNights: 2, quantity: 1,
      reservationDate: '2026-10-01', mode: 'A', depositAmount: '288.00',
    });
    // 套餐侧成功、文旅侧成功 ⇒ 无降级
    expect(body.degraded).toBeUndefined();
    expect(body.degradedSources).toBeUndefined();
  });

  it('🔴 套餐侧失败 ⇒ degradedSources 恰为 [product]，且住宿与文旅照常', async () => {
    listWenlvMock.mockResolvedValue(okWenlv([
      { id: 'w-new', orderNo: 'WENLV-NEW', productName: '龙门谜案', totalAmount: '88.00', quantity: 1,
        seatCount: 2, status: 'paid', paymentStatus: 'paid', leaderCode: 'LK-1', createdAt: new Date(NOW).toISOString() },
    ]));
    listProductMock.mockResolvedValue({ ok: false, status: 0, data: null } as any);
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    expect(body.degraded).toBe(true);
    expect(body.degradedSources, '分源：不许再硬编码成 [wenvl]').toEqual(['product']);
    expect(body.list.filter((o: any) => o.type === 'lodging')).toHaveLength(2);
    expect(body.list.some((o: any) => o.type === 'wenlv'), '文旅侧没坏，它的单必须在').toBe(true);
  });

  it('🔴 两侧平台源同时降级 ⇒ 两项都在，list 仍含房型单、success 仍为 true', async () => {
    listWenlvMock.mockResolvedValue({ ok: false, status: 0, data: null } as any);
    listProductMock.mockResolvedValue({ ok: false, status: 0, data: null } as any);
    const res = await call(signMiniToken(GUEST));
    expect(res.status, '两源全挂也不是整页失败（房型是有效的）').toBe(200);
    const { success, data: body } = await res.json();
    expect(success).toBe(true);
    expect(body.degraded).toBe(true);
    expect([...body.degradedSources].sort()).toEqual(['product', 'wenlv']);
    expect(body.list.filter((o: any) => o.type === 'lodging')).toHaveLength(2);
  });

  it('🔴 三源无重叠：source=platform 的本地行不得混进房型源', async () => {
    // 不变量（spec §4.3）：房型源谓词是 source='mini'，而平台套餐单转化出的本地行写 source='platform'
    // ⇒ 互斥。**这是推断不是实测** —— 这条用例就是把它变成实测：造一条同 guestId、source='platform' 的行。
    const convId = 'uo-conv-' + randomUUID().slice(0, 8);
    ids.push(convId);
    await db.insert(pmsBuiOrders).values({
      ...mkLodging(convId, new Date(NOW), 'confirmed'),
      source: 'platform', platformOrderId: 'po-' + convId, // ⚠️ 跟 convId 随机，别写死：pms_bui_orders 上有部分唯一索引 uq_orders_platform_order（非空时唯一）⇒ 写死字面量时，跑到一半被杀（afterAll 没执行）就留下这行，下次重跑直接 23505（本文件其余 id 也都是 randomUUID 后缀）
    } as any);
    listWenlvMock.mockResolvedValue(okWenlv([]));
    listProductMock.mockResolvedValue(okProduct([]));
    const body = (await (await call(signMiniToken(GUEST))).json()).data;
    expect(body.list.some((o: any) => o.id === convId),
      'source=platform 的本地行出现在房型源 ⇒ 同一笔购买会被显示两次（谓词漏了 source 条件）').toBe(false);
    expect(body.list.filter((o: any) => o.type === 'lodging')).toHaveLength(2);
  });

  it('🔴 套餐侧 200 但形状畸形 ⇒ 不得 500，且不得采信错误信封', async () => {
    const shapes = [
      { label: '200 + 缺 list', res: { ok: true, status: 200, data: { success: true, data: [] } } },
      { label: '200 + list 为 null', res: { ok: true, status: 200, data: { success: true, list: null } } },
      { label: '200 + list 是非数组真值', res: { ok: true, status: 200, data: { success: true, list: 'nope' } } },
      { label: '200 + ok:false 但 list 是合法数组（错误信封不得采信）',
        res: { ok: false, status: 200, data: { success: false, list: [{ id: 'po-untrusted', orderNo: 'PRD-X' }] } } },
    ];
    for (const s of shapes) {
      listWenlvMock.mockResolvedValue(okWenlv([]));
      listProductMock.mockResolvedValue(s.res as any);
      const res = await call(signMiniToken(GUEST));
      expect(res.status, s.label + '：畸形上游不得把整页打成 500').toBe(200);
      const body = (await res.json()).data;
      expect(body.degraded, s.label + '：形状不对必须落 degraded').toBe(true);
      expect(body.degradedSources, s.label + '：必须点名 product').toEqual(['product']);
      expect(body.list.some((o: any) => o.type === 'product'), s.label + '：形状不对时套餐源应落空').toBe(false);
    }
  });

  it('🔴 两个平台源**并行**发起，且超时/窗口按契约传参（串行实现会卡死在闸上直到超时）', async () => {
    // 判据机制：两个 mock 各自 await 一道「直到**双方都已被调用过**才开」的闸。
    // 真并行 ⇒ Promise.all 的同步段里两个都已被调用 ⇒ 闸开 ⇒ 双双返回。
    // 串行（先 await 文旅侧）⇒ 第二个永不被调用 ⇒ 闸永不开 ⇒ 本用例超时 = 红。
    let calls = 0;
    let release!: () => void;
    const bothCalled = new Promise<void>((r) => { release = r; });
    const gate = async (): Promise<void> => { calls += 1; if (calls === 2) release(); await bothCalled; };
    listWenlvMock.mockImplementation(async () => { await gate(); return okWenlv([]); });
    listProductMock.mockImplementation(async () => { await gate(); return okProduct([]); });
    const res = await call(signMiniToken(GUEST));
    expect(res.status).toBe(200);
    // 参数契约：文旅侧 (miniUserId, timeoutMs)；套餐侧 (miniUserId, limit, timeoutMs)
    expect(listWenlvMock, '文旅侧必须显式 6000，别退回 platformFetch 的默认 10000').toHaveBeenCalledWith(GUEST, 6000);
    expect(listProductMock, '套餐侧窗口 50 + 显式 6000').toHaveBeenCalledWith(GUEST, 50, 6000);
  });
});
