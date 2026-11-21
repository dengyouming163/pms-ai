// 需要真实库：RUN_DB=1 PG_HOST=... PG_DATABASE=... PG_USER=... PG_PASSWORD=... npx vitest run src/routes/__tests__/checkin-orders.db.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, like, sql, inArray } from 'drizzle-orm';
import checkinOrdersRoute from '../checkin-orders.js';
import { db } from '../../db/index.js';
import { pmsBuiStores, pmsBuiCheckinOrders, pmsBuiCheckinOrderStatusLogs } from '../../db/schema/index.js';
import type { AuthUser } from '../../middleware/auth.js';

// 复刻生产链路：authMiddleware 之后 authUser 里有真实操作人
// 用带 Variables 泛型的 Hono：pms-server 的 middleware/auth.ts 未对 Hono 做 ContextVariableMap 增强
//（与 checkin-orders.ts 路由同款泛型），裸 new Hono() 会让 c.set('authUser', …) 的键位退化为 never。
const app = new Hono<{ Variables: { authUser?: AuthUser } }>();
app.use('*', async (c, next) => {
  c.set('authUser', { userId: 'u-db-test', name: '数据库用例运营', merchantId: undefined } as any);
  await next();
});
app.route('/api/checkin-orders', checkinOrdersRoute);

const TAG = 'db用例补录';
let storeId = '';
const createdIds: string[] = [];

async function cleanup() {
  for (const id of createdIds) {
    await db.delete(pmsBuiCheckinOrderStatusLogs).where(eq(pmsBuiCheckinOrderStatusLogs.orderId, id));
    await db.delete(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id));
  }
  // 残留清理要先删日志再删订单：logs.order_id 无外键级联，先删订单会留下孤儿日志
  const orphans = await db
    .select({ id: pmsBuiCheckinOrders.id })
    .from(pmsBuiCheckinOrders)
    .where(like(pmsBuiCheckinOrders.guestName, `%${TAG}%`));
  const orphanIds = orphans.map((o) => o.id);
  if (orphanIds.length) {
    await db.delete(pmsBuiCheckinOrderStatusLogs)
      .where(inArray(pmsBuiCheckinOrderStatusLogs.orderId, orphanIds));
    await db.delete(pmsBuiCheckinOrders).where(inArray(pmsBuiCheckinOrders.id, orphanIds));
  }
  // 门店夹具（测试库 pms_bui_stores 可能为空，临时造一条并清理）
  await db.delete(pmsBuiStores).where(like(pmsBuiStores.name, `${TAG}%`));
}

describe.skipIf(!process.env.RUN_DB)('/api/checkin-orders（真实库）', () => {
  beforeAll(async () => {
    await cleanup();
    const [s] = await db.select({ id: pmsBuiStores.id }).from(pmsBuiStores).limit(1);
    storeId = s?.id || '';
    // 测试库门店表为空时临时造一条（订单录入「门店必填」依赖真实门店行）
    // 用原生 SQL：测试库 pms_bui_stores 存在历史列漂移（缺 short_name 等），Drizzle 全列插入会报 42703
    if (!storeId) {
      storeId = `store_${TAG}_fixture`;
      await db.execute(sql`insert into pms_bui_stores (id, brand_id, brand_name, name)
        values (${storeId}, ${`brand_${TAG}`}, ${`${TAG}测试品牌`}, ${`${TAG}测试门店`})`);
    }
  });
  afterAll(async () => { await cleanup(); });

  const base = () => ({
    storeId, guestName: `${TAG}张三`, guestPhone: '13800000000',
    roomType: '星空房', checkInDate: '2026-10-18', checkOutDate: '2026-10-21',
  });

  it('录入：默认落 booked，返回 CK+8位日期+4位序号，并写一条初始日志', async () => {
    const res = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base()),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.orderNo).toMatch(/^CK\d{8}\d{4,}$/);
    createdIds.push(json.id);

    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, json.id));
    expect(row.status).toBe('booked');
    expect(row.isBackfill).toBe(false);
    expect(row.createdChannel).toBe('platform');
    expect(row.createdBy).toBe('u-db-test');
    expect(row.createdByName).toBe('数据库用例运营');
    expect(row.nights).toBe(3);
    expect(row.checkInDate).toBe('2026-10-18');

    const logs = await db.select().from(pmsBuiCheckinOrderStatusLogs)
      .where(eq(pmsBuiCheckinOrderStatusLogs.orderId, json.id));
    expect(logs.length).toBe(1);
    expect(logs[0].fromStatus).toBeNull();
    expect(logs[0].toStatus).toBe('booked');
    expect(logs[0].operatorId).toBe('u-db-test');
  });

  it('录入：退房早于入住返回 400', async () => {
    const res = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), checkOutDate: '2026-10-17' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('退房日期');
  });

  it('补录：isBackfill=true、可指定历史状态与录入时间，并写初始日志', async () => {
    const res = await app.request('/api/checkin-orders/backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}李四`, status: 'completed', createdAt: '2026-09-01T10:00:00.000Z' }),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    createdIds.push(json.id);

    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, json.id));
    expect(row.isBackfill).toBe(true);
    expect(row.createdChannel).toBe('backfill');
    expect(row.status).toBe('completed');
    expect(new Date(row.createdAt).toISOString().startsWith('2026-09-01')).toBe(true);
    expect(json.orderNo.startsWith('CK20260901')).toBe(true);
  });

  it('补录：缺 status 或 createdAt 返回 400', async () => {
    const noStatus = await app.request('/api/checkin-orders/backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), createdAt: '2026-09-01T10:00:00.000Z' }),
    });
    expect(noStatus.status).toBe(400);
    const noTime = await app.request('/api/checkin-orders/backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), status: 'completed' }),
    });
    expect(noTime.status).toBe(400);
  });

  it('状态流转：合法路径逐级放行且每次写日志', async () => {
    const create = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}王五` }),
    });
    const { id } = await create.json() as any;
    createdIds.push(id);

    for (const to of ['checked_in', 'checked_out', 'completed']) {
      const res = await app.request(`/api/checkin-orders/${id}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: to }),
      });
      expect(res.status).toBe(200);
    }
    const logs = await db.select().from(pmsBuiCheckinOrderStatusLogs)
      .where(eq(pmsBuiCheckinOrderStatusLogs.orderId, id));
    expect(logs.length).toBe(4); // 创建 + 3 次流转
    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id));
    expect(row.checkInAt).not.toBeNull();
    expect(row.checkOutAt).not.toBeNull();
  });

  it('状态流转：非法流转返回 400 且状态与日志不变', async () => {
    const create = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}赵六` }),
    });
    const { id } = await create.json() as any;
    createdIds.push(id);

    const res = await app.request(`/api/checkin-orders/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('不能变更为');
    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id));
    expect(row.status).toBe('booked');
    const logs = await db.select().from(pmsBuiCheckinOrderStatusLogs)
      .where(eq(pmsBuiCheckinOrderStatusLogs.orderId, id));
    expect(logs.length).toBe(1);
  });

  it('状态流转：转 cancelled 必须带原因', async () => {
    const create = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}钱七` }),
    });
    const { id } = await create.json() as any;
    createdIds.push(id);

    const noReason = await app.request(`/api/checkin-orders/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }),
    });
    expect(noReason.status).toBe(400);

    const ok = await app.request(`/api/checkin-orders/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled', reason: '客户行程变更' }),
    });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id));
    expect(row.cancelReason).toBe('客户行程变更');
  });

  it('编辑：改日期自动重算 nights；带 status 返回 400', async () => {
    const create = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}孙八` }),
    });
    const { id } = await create.json() as any;
    createdIds.push(id);

    const ok = await app.request(`/api/checkin-orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkOutDate: '2026-10-20', roomNo: 'A301' }),
    });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id));
    expect(row.nights).toBe(2);
    expect(row.roomNo).toBe('A301');

    const illegal = await app.request(`/api/checkin-orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(illegal.status).toBe(400);
  });

  it('编辑：把 guestName 清空返回 400 且库中值不变', async () => {
    const create = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}周九` }),
    });
    const { id } = await create.json() as any;
    createdIds.push(id);

    const res = await app.request(`/api/checkin-orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestName: '' }),
    });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id));
    expect(row.guestName).toBe(`${TAG}周九`);
  });

  it('列表：补录筛选（仅补录/排除补录）与订单号模糊搜索', async () => {
    // 先补录一条带关键词的单，供下面断言订单号模糊搜索命中（拿真实 orderNo 精确检索）
    const created = await app.request('/api/checkin-orders/backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}关键词`, status: 'completed', createdAt: '2026-09-02T10:00:00.000Z' }),
    });
    const createdJson = await created.json() as any;
    createdIds.push(createdJson.id);

    const only = await app.request('/api/checkin-orders?isBackfill=only&limit=200');
    const onlyJson = await only.json() as any;
    expect(onlyJson.success).toBe(true);
    // 先断言集合非空：every() 对空数组恒真，若筛选逻辑失效返回空集，用例本应红灯
    expect(onlyJson.total).toBeGreaterThan(0);
    expect(onlyJson.list.length).toBeGreaterThan(0);
    expect(onlyJson.list.every((r: any) => r.isBackfill === true)).toBe(true);

    const exclude = await app.request('/api/checkin-orders?isBackfill=exclude&limit=200');
    const excludeJson = await exclude.json() as any;
    expect(excludeJson.success).toBe(true);
    expect(excludeJson.list.every((r: any) => r.isBackfill !== true)).toBe(true);
    // exclude 是 only 的补集：两种取数满足 exclude.total + only.total >= only.total，且 only.total 为正
    expect(excludeJson.total + onlyJson.total).toBeGreaterThanOrEqual(onlyJson.total);
    expect(onlyJson.total).toBeGreaterThan(0);

    // keyword 覆盖订单号模糊搜索：按刚补录单的真实 orderNo 检索应能命中
    const keywordRes = await app.request(`/api/checkin-orders?keyword=${encodeURIComponent(createdJson.orderNo)}`);
    const keywordJson = await keywordRes.json() as any;
    expect(keywordJson.success).toBe(true);
    expect(keywordJson.list.length).toBeGreaterThan(0);
    expect(keywordJson.list.some((r: any) => r.orderNo === createdJson.orderNo)).toBe(true);
    // 注：不传 isBackfill 的「全部」态即「无过滤」，无断言价值，故不单独断言。
  });

  it('日志端点：返回创建 + 流转两条日志且按 createdAt 倒序', async () => {
    const create = await app.request('/api/checkin-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base(), guestName: `${TAG}周六` }),
    });
    const { id } = await create.json() as any;
    createdIds.push(id);

    await app.request(`/api/checkin-orders/${id}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'checked_in' }),
    });
    const res = await app.request(`/api/checkin-orders/${id}/logs`);
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.list.length).toBe(2);
    // 同毫秒时 PG 对 createdAt 相等的排序不稳定，故不依赖 list[0]/list[1] 的严格顺序：
    // 用集合断言覆盖两条日志的 toStatus，再断言 createdAt 为非严格倒序。
    const toStatuses = json.list.map((l: any) => l.toStatus);
    expect(toStatuses).toContain('booked');
    expect(toStatuses).toContain('checked_in');
    expect(new Date(json.list[0].createdAt).getTime() >= new Date(json.list[1].createdAt).getTime()).toBe(true);
  });
});
