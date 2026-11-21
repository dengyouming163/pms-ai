/**
 * admin 两个读端点（块 E Task 6）：
 *   · `GET /reports?productId=&category=&status=&page=&pageSize=` → 上报明细（createdAt 倒序，分页）
 *   · `GET /reports/summary`                    → 按剧本×类别归并
 *
 * ## 为什么每条断言都带 `?productId=<本次自造>`（🔴 别删这段）
 * 这两个端点**都是全表 `select()`**：`/reports` 不传 productId 时不加任何 where，
 * `/reports/summary` **永远**全表。而 `aipms` 是**大家共用的本地开发库**（块 E Task 5
 * 的测试也往同一张表插行），历史残留不可知。因此：
 *   · 裸调 `GET /reports` 再数 `list.length` 会被别人的残留行打红 —— **禁止**；
 *   · `/reports/summary` 也**不许**断言 `list.length` 或「排在第一条」，
 *     只能在自己的 productId 上找那一项、只在自己那几行内部比排序；
 *   · 「无数据」用例用**不落库的随机 productId** 制造，**不清表**（清表会踩别人）。
 *
 * ## 测试装置与两条判据陷阱
 * 装置照抄同目录 `wenlv-field-lookup.test.ts`：`adminWenlvRoute.request(...)`、
 * 内部令牌走 `X-Internal-Service-Token`、DB 用例用 `describe.skipIf(!process.env.RUN_DB)`
 * 门控（本地真跑用 `--config vitest.local.config.ts`，该配置自带 `assertLoopback` 硬闸）。
 *
 * ⚠️ **「不带令牌 ⇒ 403」这条证明不了端点存在**：该 admin 路由挂着 `route.use('*')` 的令牌闸，
 * 它**对未匹配路径同样生效**且同样回 403。端点没写时这条用例照样绿 —— 它的价值仅是
 * 「扣住令牌门确实挂在这两条路由的作用域上」，不是存在性判据。（存在性判据是用例 1/2/3：
 * 端点未实现时 Hono 回 **404**，见下条。）
 *
 * ⚠️ **Hono 对未注册路径默认回 404 + `text/plain` 的 `404 Not Found`**，`res.json()` 会抛
 * `SyntaxError`。所以「实现前」的红，形态是**带合法 token 请求 `/reports` 得 404**（不是 403）；
 * 断言里因此先断 `status` 再断 JSON 字段，避免把红伪装成 parser 崩溃。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvVenues, pmsBuiWenlvClientReports,
} from '../../../db/schema/index.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

// 全部 id 带 run 后缀：本地库是**大家共用的开发库**，绝不与别人的残留撞 pkey。
const RUN = Date.now().toString(36);
const P_A = `rep-route-pa-${RUN}`;
const P_B = `rep-route-pb-${RUN}`;
// 批 7 Task 24：分页/状态过滤/PATCH 闭环的专用产品（4 行，与 P_A/P_B 的既有断言完全隔离）。
const P_C = `rep-route-pc-${RUN}`;
/** 只在用例 3 的查询里出现，**不落库**。 */
const P_MISSING = `rep-route-missing-${RUN}`;
const V_A = `rep-route-va-${RUN}`;
const MINI = `rep-route-mini-${RUN}`;
const R1 = `rep-route-r1-${RUN}`;
const R2 = `rep-route-r2-${RUN}`;
const R3 = `rep-route-r3-${RUN}`;
const R4 = `rep-route-r4-${RUN}`;
const R5 = `rep-route-r5-${RUN}`;
const R6 = `rep-route-r6-${RUN}`;
const R7 = `rep-route-r7-${RUN}`;

const PRODUCT_A_NAME = '上报路由测试剧本A';
const PRODUCT_B_NAME = '上报路由测试剧本B';
const VENUE_A_NAME = '上报路由测试场地A';

// 三条上报的 createdAt 显式拉开（间隔 10s），否则「倒序」断言无法与「插入顺序」区分。
const T0 = new Date(Date.now() - 60_000);
const AT1 = new Date(T0.getTime());
const AT2 = new Date(T0.getTime() + 10_000);
const AT3 = new Date(T0.getTime() + 20_000);

const get = (path: string, headers: Record<string, string> = H) =>
  adminWenlvRoute.request(path, { headers });

const patch = (id: string, body: unknown) =>
  adminWenlvRoute.request(`/reports/${id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify(body),
  });

// 门禁用例不需要 DB，放在 skipIf 之外。
// ⚠️ 见文件头：它对**未匹配**路径同样生效，绿不代表端点存在，只代表令牌门在作用域上。
describe('现场问题读端点门禁', () => {
  it('未带内部 token 返回 403（挂牌不对：端点没写时这里也是 403）', async () => {
    const res = await get('/reports', { 'Content-Type': 'application/json' });
    expect(res.status).toBe(403);
  });
});

// PATCH /reports/:id 的入参校验（批 7 Task 24）：全部在触库**之前**拦下，无需 DB 夹具。
describe('PATCH /reports/:id 入参校验（无库）', () => {
  it('缺内部令牌 → 403', async () => {
    const res = await adminWenlvRoute.request(`/reports/${R4}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handleStatus: 'resolved', handledBy: 'u1' }),
    });
    expect(res.status).toBe(403);
  });

  it('非法 handleStatus → 400', async () => {
    const res = await patch(R4, { handleStatus: 'done', handledBy: 'u1' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('handleStatus');
  });

  it('缺 handleStatus → 400', async () => {
    const res = await patch(R4, { handledBy: 'u1' });
    expect(res.status).toBe(400);
  });

  it('缺 handledBy → 400（BFF 注入是强契约，服务端不放行无处理人的留痕）', async () => {
    const res = await patch(R4, { handleStatus: 'resolved' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('handledBy');
  });

  it('GET /reports 非法 status 过滤值 → 400', async () => {
    const res = await get('/reports?status=done');
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!process.env.RUN_DB)('admin 现场问题读端点（DB）', () => {
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: V_A, name: VENUE_A_NAME }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values([
      // A 归属场地 V_A ⇒ 覆盖「联场地名」这条路径；B 不归属 ⇒ 覆盖 venueName 显式 null。
      { id: P_A, name: PRODUCT_A_NAME, venueId: V_A },
      { id: P_B, name: PRODUCT_B_NAME, venueId: null },
      { id: P_C, name: '上报路由测试剧本C', venueId: null },
    ]);
    await db.insert(pmsBuiWenlvClientReports).values([
      { id: R1, productId: P_A, miniUserId: MINI, category: 'audio', source: 'manual', createdAt: AT1 },
      { id: R2, productId: P_A, miniUserId: MINI, category: 'image', source: 'auto', createdAt: AT2 },
      { id: R3, productId: P_B, miniUserId: MINI, category: 'cert', source: 'manual', createdAt: AT3 },
      // P_C 四行（createdAt 依次 +10s）：R4 留给 PATCH 流转用例，R5-R7 保持 new 供分页/过滤断言。
      { id: R4, productId: P_C, miniUserId: MINI, category: 'audio', source: 'manual', createdAt: new Date(T0.getTime() + 30_000) },
      { id: R5, productId: P_C, miniUserId: MINI, category: 'image', source: 'manual', createdAt: new Date(T0.getTime() + 40_000) },
      { id: R6, productId: P_C, miniUserId: MINI, category: 'other', source: 'auto', createdAt: new Date(T0.getTime() + 50_000) },
      { id: R7, productId: P_C, miniUserId: MINI, category: 'cert', source: 'manual', createdAt: new Date(T0.getTime() + 60_000) },
    ]);
  });

  afterAll(async () => {
    // 按自己造的 id 清单删 —— 绝不用「全表删」或按时间删（会误伤并发写入的别人）。
    await db.delete(pmsBuiWenlvClientReports).where(inArray(pmsBuiWenlvClientReports.id, [R1, R2, R3, R4, R5, R6, R7]));
    await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, [P_A, P_B, P_C]));
    await db.delete(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, [V_A]));
  });

  // 用例 1：3 条上报（两个产品）分**两次带 productId 的查询**看，绝不裸调 `/reports`。
  // 每次断言的 list.length 都只在**那一次查询**的过滤条件下成立。
  it('GET /reports?productId ⇒ 只含本产品各条、createdAt 倒序、带剧本名与场地名', async () => {
    // A 产品 2 条（R1 audio < R2 image）
    const resA = await get(`/reports?productId=${P_A}`);
    expect(resA.status).toBe(200);      // 端点未实现时这里是 404（Hono 默认），故本条有区分力
    const bA = await resA.json();
    expect(bA.success).toBe(true);
    expect(bA.data.total).toBe(2);
    expect(bA.data.list.length).toBe(2);
    expect(bA.data.list.map((r: any) => r.id)).toEqual([R2, R1]);   // 倒序
    for (let i = 0; i < bA.data.list.length - 1; i++) {
      const a = new Date(bA.data.list[i].createdAt).getTime();
      const n = new Date(bA.data.list[i + 1].createdAt).getTime();
      expect(a >= n).toBe(true);       // 只在**自己那两条**内部比（拿全表首行当基准会被残留打红）
    }
    // 联表补名（光有 id 没法行动）：A 归属场地 ⇒ 场地名。
    expect(bA.data.list[0].productName).toBe(PRODUCT_A_NAME);
    expect(bA.data.list[0].venueName).toBe(VENUE_A_NAME);

    // B 产品 1 条，且**未归属场地** ⇒ venueName 必须是显式 null（不是缺键、不是空串）。
    const resB = await get(`/reports?productId=${P_B}`);
    expect(resB.status).toBe(200);
    const bB = await resB.json();
    expect(bB.data.total).toBe(1);
    expect(bB.data.list.map((r: any) => r.id)).toEqual([R3]);
    expect(bB.data.list[0].productName).toBe(PRODUCT_B_NAME);
    expect(bB.data.list[0].venueName).toBeNull();

    // category 条件：两个 cond 一起用 ⇒ 只剩 R1。这条同时钉住「category 过滤真的下推到 SQL」。
    const resC = await get(`/reports?productId=${P_A}&category=audio`);
    expect(resC.status).toBe(200);
    const bC = await resC.json();
    expect(bC.data.total).toBe(1);
    expect(bC.data.list.map((r: any) => r.id)).toEqual([R1]);
  });

  // 用例 2：`/reports/summary` 全表 ⇒ 只在自己的 productId 上找那一项，绝不断 list.length / 首条。
  it('GET /reports/summary ⇒ 本产品归并正确（四类键齐全、total 正确）、按 total 降序', async () => {
    const res = await get('/reports/summary');
    expect(res.status).toBe(200);       // 未实现时是 404；此处钉住「可达」
    const b = await res.json();
    expect(b.success).toBe(true);

    const rowA = b.data.list.find((x: any) => x.productId === P_A);
    const rowB = b.data.list.find((x: any) => x.productId === P_B);
    expect(rowA).toBeTruthy();
    expect(rowB).toBeTruthy();

    expect(rowA.total).toBe(2);
    expect(rowA.byCategory).toEqual({ audio: 1, image: 1, cert: 0, other: 0 });
    expect(Object.keys(rowA.byCategory).sort()).toEqual(['audio', 'cert', 'image', 'other']);
    expect(rowA.productName).toBe(PRODUCT_A_NAME);
    // 场地名：创作台汇总表的「场地」列的数据来源。少了它那一列只能恒空。
    // A 归属 V_A ⇒ 联出名字；B 未归属 ⇒ 必须是**显式 null**（不是缺键、不是空串），
    // 否则前端 `?? 默认值` 的两条分支行为不定。
    expect('venueName' in rowA).toBe(true);
    expect(rowA.venueName).toBe(VENUE_A_NAME);
    expect('venueName' in rowB).toBe(true);
    expect(rowB.venueName).toBeNull();

    expect(rowB.total).toBe(1);
    expect(rowB.byCategory).toEqual({ audio: 0, image: 0, cert: 1, other: 0 });

    // 降序：只在**自己这两项**之间比（全局还可能有 total 更大的别的产品）。
    const idxA = b.data.list.findIndex((x: any) => x.productId === P_A);
    const idxB = b.data.list.findIndex((x: any) => x.productId === P_B);
    expect(idxA >= 0 && idxB >= 0).toBe(true);
    expect(idxA < idxB).toBe(true);     // total 2 的必须排在 total 1 之前
  });

  // 用例 3：无数据 —— 用**不落库**的随机 productId 制造，绝不清表。
  it('GET /reports?productId=<不存在的> ⇒ 200 且 { list: [], total: 0 }（不是 500）', async () => {
    const res = await get(`/reports?productId=${P_MISSING}`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.list).toEqual([]);
    expect(b.data.total).toBe(0);
  });

  // 用例 4（批 7 Task 24）：分页。P_C 共 4 行（createdAt R7>R6>R5>R4），pageSize=3 ⇒
  // page1 = [R7,R6,R5]、page2 = [R4]；total 恒为过滤总数 4，page/pageSize 原样回显。
  it('GET /reports 分页：page/pageSize 切片正确，total=过滤总数', async () => {
    const p1 = await get(`/reports?productId=${P_C}&pageSize=3&page=1`);
    expect(p1.status).toBe(200);
    const b1 = await p1.json();
    expect(b1.data.total).toBe(4);
    expect(b1.data.page).toBe(1);
    expect(b1.data.pageSize).toBe(3);
    expect(b1.data.list.map((r: any) => r.id)).toEqual([R7, R6, R5]);

    const p2 = await get(`/reports?productId=${P_C}&pageSize=3&page=2`);
    expect(p2.status).toBe(200);
    const b2 = await p2.json();
    expect(b2.data.total).toBe(4);
    expect(b2.data.page).toBe(2);
    expect(b2.data.list.map((r: any) => r.id)).toEqual([R4]);

    // 默认 pageSize=50：不传分页参数时 P_C 四行一页全出。
    const p0 = await get(`/reports?productId=${P_C}`);
    expect((await p0.json()).data.list.length).toBe(4);
  });

  // 用例 5（批 7 Task 24）：PATCH 三态流转真落库（new→processing→resolved），
  // 后值覆盖前值（handledBy/note），handled_at 每次刷新；list 读回同一份状态。
  it('PATCH /reports/:id ⇒ 三态流转落库，note/handledBy 后值胜', async () => {
    const r1 = await patch(R4, { handleStatus: 'processing', note: '已派现场同事核', handledBy: 'op-a' });
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()).data;
    expect(d1.handleStatus).toBe('processing');
    expect(d1.handleNote).toBe('已派现场同事核');
    expect(d1.handledBy).toBe('op-a');
    expect(d1.handledAt).toBeTruthy();

    const r2 = await patch(R4, { handleStatus: 'resolved', note: '换素材后复测通过', handledBy: 'op-b' });
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()).data;
    expect(d2.handleStatus).toBe('resolved');
    expect(d2.handledBy).toBe('op-b');

    // 直读库行确认「不是响应里演出来的」：刷新后状态仍在。
    const [row] = await db.select().from(pmsBuiWenlvClientReports)
      .where(inArray(pmsBuiWenlvClientReports.id, [R4]));
    expect(row.handleStatus).toBe('resolved');
    expect(row.handleNote).toBe('换素材后复测通过');
    expect(row.handledBy).toBe('op-b');
    expect(row.handledAt).toBeTruthy();

    // list 端读回同一份状态（状态过滤的数据源就是这四列）。
    const g = await get(`/reports?productId=${P_C}&status=resolved`);
    const gb = await g.json();
    expect(gb.data.list.map((r: any) => r.id)).toEqual([R4]);
    expect(gb.data.total).toBe(1);
  });

  // 用例 6（批 7 Task 24）：status 过滤 + 404。
  it('GET /reports?status=new ⇒ 只回未处理行；PATCH 不存在的 id → 404', async () => {
    // R4 已 resolved（用例 5），P_C 剩 R5-R7 为 new。
    const res = await get(`/reports?productId=${P_C}&status=new`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.total).toBe(3);
    expect(b.data.list.map((r: any) => r.id).sort()).toEqual([R5, R6, R7].sort());
    for (const r of b.data.list) expect(r.handleStatus).toBe('new');

    const nf = await patch(`rep-route-missing-${RUN}`, { handleStatus: 'resolved', handledBy: 'op-a' });
    expect(nf.status).toBe(404);
  });
});
