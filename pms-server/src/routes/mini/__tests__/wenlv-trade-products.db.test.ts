// `/products` 合并列表的真库测试：场地字段（Task 1）、三件齐备闸（Task 2）、排序（Task 3）。
// 为什么必须有这个文件：`GET /api/mini/wenlv-trade/products` 是 C 端在用的文旅产品入口，
// 而它今天只过滤交易产品 `status` —— 上游架构 spec §5.5 点名的「能买不能玩」就活在这里。
//
// ⚠️ 本文件**碰库**（本机 `aipms`）⇒ 必须挂 `describe.skipIf(!process.env.RUN_DB)`：
//    缺了会给默认 config 的 `pnpm test`（连的是陈旧的 `test` 库）多添一个红文件，
//    而且用例会被计成 skipped —— 那正是「全绿而零执行」的假绿。
// ⚠️ 上游 BFF 在本机不可达 ⇒ `vi.stubGlobal('fetch')` 桩掉（照 `wenlv-trade-packages.test.ts`）。
//    `platformFetch` 走全局 fetch，而 `db` 是真的 —— 这正好逼出「合并逻辑 × 真库查询」的组合。
// ⚠️ 顶部 import 一次给全：下面的 describe 由 Task 1/2/3 **陆续追加**，别让后来的人以为要自己补。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { like } from 'drizzle-orm';
import route from '../wenlv-trade.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvVenues } from '../../../db/schema/index.js';

const TS = Date.now();
const cp = (k: string) => `cp5a-${k}-${TS}`;      // 内容产品 id
const vn = (k: string) => `vn5a-${k}-${TS}`;      // 场地 id
const tp = (k: string) => `trade5a-${k}-${TS}`;   // BFF 交易产品 UUID

// 三个显式时间：排序用例依赖它们的**大小关系**，不依赖「现在」
const T_OLD = new Date('2026-01-01T00:00:00Z');
const T_NEW = new Date('2026-03-01T00:00:00Z');
const T_MID = new Date('2026-02-01T00:00:00Z');

/** BFF 交易产品行（BFF 是交易表**整行** select：`pms-platform/pms-platform-server/src/routes/wenlv.ts:124`；
 *  本夹具只取**子集**（省 `status`/`playMode`）；列见 `pms-platform/pms-platform-server/src/db/schema/wenlv.ts:5-18`；金额是 decimal 字符串） */
const tradeRow = (k: string, over: Record<string, unknown> = {}) => ({
  id: tp(k), contentProductId: cp(k), name: `产品-${k}`,
  price: '99.00', originalPrice: null, validDays: 30,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
/** 桩 BFF：返回给定的交易产品行（都判作 active —— 真实 BFF 已按 status=active 过滤过了） */
function stubBff(rows: unknown[]) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ success: true, data: { list: rows, total: rows.length } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

/** 取列表里某个交易产品的行；不在列表里返回 undefined（「不出现」的判据就写它） */
const rowOf = (list: any[], k: string) => list.find((x) => x.productId === tp(k));

async function callProducts(): Promise<{ status: number; body: any }> {
  const res = await route.request('/products');
  return { status: res.status, body: await res.json() };
}

describe.skipIf(!process.env.RUN_DB)('GET /api/mini/wenlv-trade/products 合并列表', () => {
  beforeAll(async () => {
    // 场地：A 已运营（该给游客看）/ B 试运营（不该给游客看）
    await db.insert(pmsBuiWenlvVenues).values([
      { id: vn('A'), name: '甲场地', status: 'live', city: '安顺' },
      { id: vn('B'), name: '乙场地', status: 'pilot', city: '黔东南' },
    ]);
    // 内容产品四条；注意 **`noContent` 故意不插**（模拟 BFF 引用了不存在的内容产品）
    await db.insert(pmsBuiWenlvProducts).values([
      { id: cp('ok'), name: '已发布挂 live 场地', status: 'published', venueId: vn('A'), publishedAt: T_NEW },
      { id: cp('draft'), name: '草稿', status: 'draft', venueId: vn('A'), publishedAt: T_NEW },
      { id: cp('noVenue'), name: '无场地', status: 'published', venueId: null, publishedAt: T_NEW },
      { id: cp('pilotVenue'), name: '挂试运营场地', status: 'published', venueId: vn('B'), publishedAt: T_NEW },
    ]);
  });
  afterEach(() => { fetchMock.mockReset(); });
  afterAll(async () => {
    // 以本次运行的 TS 为界删掉本文件造的全部夹具 —— 后面 Task 追加用例时**不必回头改这一行**
    await db.delete(pmsBuiWenlvProducts).where(like(pmsBuiWenlvProducts.id, `cp5a-%-${TS}`));
    await db.delete(pmsBuiWenlvVenues).where(like(pmsBuiWenlvVenues.id, `vn5a-%-${TS}`));
    vi.unstubAllGlobals();
  });

  it('Task 1：带出 venueId / venueName / publishedAt（收窄 select 漏列会**静默变 null**）', async () => {
    stubBff([tradeRow('ok')]);
    const { status, body } = await callProducts();
    expect(status).toBe(200);
    const row = rowOf(body.data.list, 'ok');
    expect(row, '三件齐备的行必须出现（Task 2 加了闸之后仍然如此）').toBeTruthy();
    // 🔴 这三条就是判据本身：`pms-server/src/routes/mini/wenlv-public-fields.ts:13-15` 早已写明
    //    原文逐字：「若改用收窄 select 的写法，`venueName` 会**静默变 null**。」
    //    —— 漏加一列不报错、类型也不拦。
    expect(row.venueId).toBe(vn('A'));
    expect(row.venueName).toBe('甲场地');
    expect(row.publishedAt).toBe(T_NEW.toISOString());   // Date 经 c.json() 序列化成 ISO 字符串
  });

  it('Task 2：三件齐备闸 —— 缺内容行 / 草稿 / 场地非 live / 无场地，四条各自不出现', async () => {
    // 五条一起进桩：模拟「都过了交易闸（BFF 已按 status=active 过滤）」的情形
    stubBff([tradeRow('ok'), tradeRow('draft'), tradeRow('noContent'), tradeRow('noVenue'), tradeRow('pilotVenue')]);
    const { body } = await callProducts();
    const list = body.data.list;
    // 🔴 对照组必须有：缺了它，一个「恒返回空列表」的坏实现也能让下面四条全绿
    expect(rowOf(list, 'ok'), '三件齐备的必须在').toBeTruthy();
    expect(rowOf(list, 'draft'), '内容行不是 published').toBeUndefined();
    expect(rowOf(list, 'noContent'), '内容行不存在').toBeUndefined();
    expect(rowOf(list, 'noVenue'), 'venueId 为 null').toBeUndefined();
    expect(rowOf(list, 'pilotVenue'), '场地不是 live').toBeUndefined();
  });

  it('Task 2：交易侧 status=active 仍由出站 URL 携带（本层不重判 —— 重判就是第二个权威）', async () => {
    stubBff([tradeRow('ok')]);
    await callProducts();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('status=active');
    expect(url).toContain('pageSize=100');
  });

  it('Task 2：内容侧的 status 只为过闸而查，不得出现在响应里（防「顺手 spread」外泄）', async () => {
    stubBff([tradeRow('ok')]);
    const { body } = await callProducts();
    expect(rowOf(body.data.list, 'ok')).not.toHaveProperty('status');
  });

  it('Task 3：按 publishedAt 降序；缺章的排最后；同章用 createdAt 降序兜底', async () => {
    await db.insert(pmsBuiWenlvProducts).values([
      { id: cp('sOld'), name: '章旧', status: 'published', venueId: vn('A'), publishedAt: T_OLD },
      { id: cp('sNew'), name: '章新', status: 'published', venueId: vn('A'), publishedAt: T_NEW },
      { id: cp('sNull'), name: '无章', status: 'published', venueId: vn('A'), publishedAt: null },
      { id: cp('eOld'), name: '同章-早建', status: 'published', venueId: vn('A'), publishedAt: T_MID },
      { id: cp('eNew'), name: '同章-晚建', status: 'published', venueId: vn('A'), publishedAt: T_MID },
    ]);
    stubBff([
      tradeRow('sNull'), tradeRow('sOld'), tradeRow('sNew'),   // sNull 置**首**：让「缺章沉底」不能靠排序稳定性蒙对（去掉沉降分支即红）
      // 两条同一 publishedAt，只有交易侧 createdAt 不同 ⇒ 兜底键是唯一能决定顺序的东西
      tradeRow('eOld', { createdAt: '2026-01-05T00:00:00.000Z' }),
      tradeRow('eNew', { createdAt: '2026-01-09T00:00:00.000Z' }),
    ]);
    const { body } = await callProducts();
    const list = body.data.list;
    const idx = (k: string) => list.findIndex((x: any) => x.productId === tp(k));
    for (const k of ['sOld', 'sNew', 'sNull', 'eOld', 'eNew']) expect(idx(k), `${k} 丢了`).toBeGreaterThanOrEqual(0);
    expect(idx('sNew')).toBeLessThan(idx('sOld'));                 // 章新的在前
    expect(idx('sOld')).toBeLessThan(idx('sNull'));                // 有章的都在无章的前面
    expect(idx('eNew')).toBeLessThan(idx('eOld'));                 // 同章时 createdAt 降序兜底
    expect(list[list.length - 1].productId).toBe(tp('sNull'));    // 无章排**最后**（不是「排在某个有章之后」）
  });

  // ---- Task 2 加固（用户 2026-09-27 裁定「#1 Task 2 三条」；计划里**没有**这块字节 ⇒ 纯代码增补）----
  it('Task 2 加固：响应键集合是白名单（16 键）/ 场地行不存在也挡住 / total = 过滤后可见数', async () => {
    // ① 场地行**不存在**（venueId 指向从未插入的场地 id）：与 `noVenue`（venueId 为 null）不是同一格 ——
    //    前者在 `venueMap.get()` 未命中，后者在 `if (!ct.venueId)` 就被挡；但两者最终都落在
    //    `venueMap.get(ct.venueId)?.status === 'live'` 这**同一条** return 上 ⇒ 本条的边际判别力在
    //    **数据条件**（引用悬空 / 场地行被硬删），不在代码分支。⚠️ **故意不插** `vn('GHOST')`。
    await db.insert(pmsBuiWenlvProducts).values([
      { id: cp('ghostVenue'), name: '挂悬空场地引用', status: 'published', venueId: vn('GHOST'), publishedAt: T_NEW },
    ]);
    stubBff([tradeRow('ok'), tradeRow('ghostVenue')]);
    const { body } = await callProducts();
    const list = body.data.list;
    expect(rowOf(list, 'ok'), '对照组：三件齐备的必须在').toBeTruthy();
    expect(rowOf(list, 'ghostVenue'), 'venueId 指向不存在的场地行').toBeUndefined();
    // ② 白名单：钉住**整个**键集合。上面那条 `not.toHaveProperty('status')` 是**黑名单一条**，
    //    而 `merged` 是手写对象字面量 —— 谁把它改成 `...ct` / `...p` 展开，内容侧的 `id` / `status`
    //    （以及将来新增的任何列）就会**静默**进响应；反向，漏写/改名一列也会静默变 null。
    //    键集合相等**两个方向都钉**（同 `wenlv-public-fields` 的白名单先例）。
    expect(Object.keys(rowOf(list, 'ok')).sort()).toEqual([
      'config', 'contentProductId', 'coverImage', 'isFree', 'mode', 'name', 'originalPrice',
      'playMode', 'price', 'productId', 'publishedAt', 'subtitle', 'theme',
      'validDays', 'venueId', 'venueName',
    ]);
    // ③ `total`：此前全文件 0 处断言 ⇒ 它写错（原样透传 BFF 的 `total`、或写成过滤前的 `merged.length`）
    //    不会有任何测试红。合同见返回语句 `total: sorted.length` = **过滤后**可见数。
    expect(body.data.total).toBe(list.length);
    expect(body.data.total).toBe(1);   // 承重：BFF 进 2 条、闸后只剩 1 条（若两条都漏出，上一行会**通过**）
  });

  // ---- 读路径免费价（用户 2026-09-28 裁定增补；计划里**没有**这块字节 ⇒ 纯代码增补）----
  it('免费行：交易侧价格被投影成 0.00 / 原价清空；付费行价格**保持原样**', async () => {
    // 内容行：一条免费、一条付费。两条的**交易行都带真价格**（免费那条也带 originalPrice）——
    // 这正是线上形状：平台侧价格护栏要求 > 0，标 isFree 不会顺手清零交易侧。
    await db.insert(pmsBuiWenlvProducts).values([
      { id: cp('free'), name: '免费剧本', status: 'published', venueId: vn('A'), publishedAt: T_NEW, isFree: true },
      { id: cp('paid'), name: '付费剧本', status: 'published', venueId: vn('A'), publishedAt: T_NEW, isFree: false },
    ]);
    stubBff([
      tradeRow('free', { price: '99.00', originalPrice: '199.00' }),
      tradeRow('paid', { price: '88.00', originalPrice: '128.00' }),
    ]);
    const { body } = await callProducts();
    const free = rowOf(body.data.list, 'free');
    const paid = rowOf(body.data.list, 'paid');
    // 对照组：两条都必须在 —— 缺了它，「闸把两条都挡掉」也能让下面断言全绿
    expect(free, '免费行必须出现').toBeTruthy();
    expect(paid, '付费行必须出现').toBeTruthy();
    // 被测行为：免费行的**显示价**被投影成 0.00、原价清空。
    // ⚠️ `'0.00'` 是**字符串**：本投影透传平台 JSON，平台 decimal 列出来就是字符串。
    // ⚠️ 免费那条的原价故意给 '199.00'（非 null）—— 否则「清空原价」这条断言在**这是 null 的**夹具上恒真、零判别力。
    expect(free.isFree).toBe(true);
    expect(free.price).toBe('0.00');
    expect(free.originalPrice).toBeNull();
    // 🔴 阳性对照：付费行**保持原样**。缺了这一半，一个「恒返 '0.00' / 恒返 null」的坏实现也能让上面三条全绿。
    expect(paid.isFree).toBe(false);
    expect(paid.price).toBe('88.00');
    expect(paid.originalPrice).toBe('128.00');
  });

  // ---- Task 11 剧本房溢价：C 端展示价 = 票价 + config.premium（合成在输出层，非前端）----
  it('溢价行：price 投影成 票价+premium；无/负 premium 原样；免费行不受溢价影响', async () => {
    // 内容行：正溢价 / 负溢价（钳 0）/ 无 premium 键。config 走 productConfigSchema passthrough 的真实形状；
    // 🔴 列 $type 是收窄的 WenlvProductConfig（无 premium 键），passthrough 键须经 unknown 转型落库。
    const withPremium = (o: Record<string, unknown>) => o as unknown as typeof pmsBuiWenlvProducts.$inferInsert.config;
    await db.insert(pmsBuiWenlvProducts).values([
      { id: cp('prem'), name: '有溢价', status: 'published', venueId: vn('A'), publishedAt: T_NEW,
        config: withPremium({ premium: 10 }) },
      { id: cp('negPrem'), name: '负溢价', status: 'published', venueId: vn('A'), publishedAt: T_NEW,
        config: withPremium({ premium: -5 }) },
      { id: cp('noPrem'), name: '无溢价', status: 'published', venueId: vn('A'), publishedAt: T_NEW },
      { id: cp('freePrem'), name: '免费带溢价', status: 'published', venueId: vn('A'), publishedAt: T_NEW,
        isFree: true, config: withPremium({ premium: 20 }) },   // 免费行也带溢价 config：免费仍恒 '0.00'
    ]);
    stubBff([
      tradeRow('prem', { price: '88.00' }),
      tradeRow('negPrem', { price: '88.00' }),
      tradeRow('noPrem', { price: '88.00' }),
      tradeRow('freePrem', { price: '99.00' }),
    ]);
    const { body } = await callProducts();
    const list = body.data.list;
    // 对照组：四条都必须在 —— 缺了它，「闸全挡」也能让下面断言全绿
    for (const k of ['prem', 'negPrem', 'noPrem', 'freePrem']) {
      expect(rowOf(list, k), `${k} 必须出现`).toBeTruthy();
    }
    // 🔴 合成本体：88 + 10 = 98.00（两位小数字符串，与 decimal 透传同形）
    expect(rowOf(list, 'prem').price).toBe('98.00');
    // 负溢价钳 0 / 缺键缺省 0 ⇒ 原样透传 '88.00'（不归一化成 '88'）
    expect(rowOf(list, 'negPrem').price).toBe('88.00');
    expect(rowOf(list, 'noPrem').price).toBe('88.00');
    // 免费优先级更高：isFree 投影 '0.00'，溢价不参与
    expect(rowOf(list, 'freePrem').price).toBe('0.00');
  });
});
