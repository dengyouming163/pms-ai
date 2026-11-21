// 值守「标记已处理」端点（批 7 Task 23，迁移 0082）：
//   POST /products/:id/director/reports/:progressId/handle  body { nodeKey, note?, handledBy }
// 核心断言 = upsert 幂等：同 (progressId, nodeKey) POST 两次仍一行、handledBy/note 后值覆盖；
// 不同 nodeKey 各自一行。DB 用例 RUN_DB 门控（本机 docker postgres 15433 / aipms_test）。
// ⚠️ 夹具表 pms_bui_wenlv_director_alert_handles 由迁移 0082 建立——跑 DB 用例前
//    先把 0082 应用到测试库（迁移是可重入的 IF NOT EXISTS，重复执行无副作用）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvVenues, pmsBuiWenlvProducts, pmsBuiWenlvProgress,
  pmsBuiWenlvDirectorAlertHandles, pmsBuiWenlvDirectorStates,
} from '../../../db/schema/index.js';

const run = !!process.env.RUN_DB;
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const TAG = 'dh-' + Date.now();
const VENUE = TAG + '-v';
const PROD = TAG + '-p';
const PROG = TAG + '-prog';

const post = (progressId: string, body: unknown) =>
  wenlvRoute.request(`/products/${PROD}/director/reports/${progressId}/handle`, {
    method: 'POST', headers: H, body: JSON.stringify(body),
  });

describe('POST /products/:id/director/reports/:progressId/handle（无库）', () => {
  it('缺内部令牌 → 403', async () => {
    const r = await wenlvRoute.request(`/products/${PROD}/director/reports/${PROG}/handle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeKey: 'stall:n1', handledBy: 'u1' }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain('内部服务');
  });

  it('缺 nodeKey → 400', async () => {
    const r = await post(PROG, { handledBy: 'u1' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('nodeKey');
  });

  it('缺 handledBy → 400（BFF 注入是强契约，服务端不放行无处理人的留痕）', async () => {
    const r = await post(PROG, { nodeKey: 'stall:n1' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('handledBy');
  });
});

describe.skipIf(!run)('POST /products/:id/director/reports/:progressId/handle（DB）', () => {
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '已处理场地' });
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '已处理剧本', venueId: VENUE });
    await db.insert(pmsBuiWenlvProgress).values({ id: PROG, productId: PROD, miniUserId: TAG + '-u' });
    // board 合流夹具：导演状态行带两条报警——一条将被 handle（board:n1），一条保持未处理（board:n2），
    // 用来同时断言「handled 三字段并回」与「alertCount 只计未处理」。
    const nowIso = new Date().toISOString();
    await db.insert(pmsBuiWenlvDirectorStates).values({
      id: TAG + '-ds', productId: PROD, progressId: PROG,
      state: { lastActionAt: nowIso },
      alerts: [
        { id: 'stall:board:n1', level: 'warn', kind: 'stall', message: '卡关待处置', createdAt: nowIso },
        { id: 'stall:board:n2', level: 'warn', kind: 'stall', message: '卡关未处置', createdAt: nowIso },
      ],
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvDirectorAlertHandles)
      .where(eq(pmsBuiWenlvDirectorAlertHandles.productId, PROD));
    await db.delete(pmsBuiWenlvDirectorStates).where(eq(pmsBuiWenlvDirectorStates.id, TAG + '-ds'));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, PROG));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  const rowsOf = (nodeKey: string) =>
    db.select().from(pmsBuiWenlvDirectorAlertHandles)
      .where(and(
        eq(pmsBuiWenlvDirectorAlertHandles.progressId, PROG),
        eq(pmsBuiWenlvDirectorAlertHandles.nodeKey, nodeKey),
      ));

  it('同 (progressId, nodeKey) POST 两次 ⇒ 仍一行，handledBy/note 为后值', async () => {
    const r1 = await post(PROG, { nodeKey: 'stall:n1:a1', note: '第一次', handledBy: 'op-a' });
    expect(r1.status).toBe(200);
    expect((await r1.json()).success).toBe(true);

    const r2 = await post(PROG, { nodeKey: 'stall:n1:a1', note: '第二次', handledBy: 'op-b' });
    expect(r2.status).toBe(200);

    const rows = await rowsOf('stall:n1:a1');
    expect(rows.length).toBe(1);
    expect(rows[0].handledBy).toBe('op-b');
    expect(rows[0].note).toBe('第二次');
  });

  it('不同 nodeKey ⇒ 两行', async () => {
    const r = await post(PROG, { nodeKey: 'static:n2', handledBy: 'op-a' });
    expect(r.status).toBe(200);
    const a = await rowsOf('stall:n1:a1');
    const b = await rowsOf('static:n2');
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });

  it('重复标记可清空备注（note 缺省 ⇒ 覆盖为 null，后值胜的完整语义）', async () => {
    const r = await post(PROG, { nodeKey: 'stall:n1:a1', handledBy: 'op-c' });
    expect(r.status).toBe(200);
    const rows = await rowsOf('stall:n1:a1');
    expect(rows.length).toBe(1);
    expect(rows[0].handledBy).toBe('op-c');
    expect(rows[0].note).toBeNull();
  });

  it('progress 不存在 → 404', async () => {
    const r = await post(TAG + '-missing', { nodeKey: 'stall:n1', handledBy: 'op-a' });
    expect(r.status).toBe(404);
  });

  it('board 合流：handle 后 GET /director 带回 handled 三字段，alertCount 不再计入该条', async () => {
    const r = await post(PROG, { nodeKey: 'stall:board:n1', note: '已电话处置', handledBy: 'op-board' });
    expect(r.status).toBe(200);

    const g = await wenlvRoute.request(`/products/${PROD}/director?active=1`, { headers: H });
    expect(g.status).toBe(200);
    const data = (await g.json()).data as any;

    // 已处理的报警：handled=true + 处理人/时间并回（nodeKey=alert.id 的合流键）。
    const handled = data.alerts.find((x: any) => x.progressId === PROG && x.id === 'stall:board:n1');
    expect(handled).toBeTruthy();
    expect(handled.handled).toBe(true);
    expect(handled.handledBy).toBe('op-board');
    expect(handled.handledAt).toBeTruthy();

    // 未处理的报警不受牵连（同队另一条仍为未处理）。
    const open = data.alerts.find((x: any) => x.progressId === PROG && x.id === 'stall:board:n2');
    expect(open).toBeTruthy();
    expect(open.handled).toBe(false);

    // 队伍 alertCount 只计未处理：2 条报警 - 1 条已处理 = 1。
    const team = data.list.find((t: any) => t.progressId === PROG);
    expect(team).toBeTruthy();
    expect(team.alertCount).toBe(1);
  });
});
