// 铺码四态端点的路由级回归（Task 4）。
// 装置照抄 wenlv-survey.test.ts：直接 request Hono app、内部 token 走 X-Internal-Service-Token、
// DB 用例由 RUN_DB 门控（本地真跑用 vitest.local.config.ts，仅回环）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints } from '../../../db/schema/index.js';
import { eq } from 'drizzle-orm';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const U = Date.now();
const V1 = `pl-venue1-${U}`;
const V2 = `pl-venue2-${U}`;
const V3 = `pl-venue3-${U}`;
const P1 = `pl-p1-${U}`;
const P3 = `pl-p3-${U}`;
const P4 = `pl-p4-${U}`;
const P8 = `pl-p8-${U}`;
const PA = `pl-pa-${U}`;
const PB = `pl-pb-${U}`;
const PC = `pl-pc-${U}`;
const PD = `pl-pd-${U}`;
const PE = `pl-pe-${U}`;
const PF = `pl-pf-${U}`;
// 物料导出（qrcodes）投影用：一个推进到已验，一个全程不动
const P9 = `pl-p9-${U}`;
const P10 = `pl-p10-${U}`;

// PB 的初始 printed_at：批量标记必须原值保留（不刷新时间戳）
const T0 = new Date('2026-01-15T00:00:00Z');

const withUser = (uid: string) => ({ ...H, 'X-Platform-User-Id': uid });
const doPatch = (p: string, body: unknown, h: Record<string, string> = H) =>
  adminWenlvRoute.request(p, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
const doPost = (p: string, body: unknown, h: Record<string, string> = H) =>
  adminWenlvRoute.request(p, { method: 'POST', headers: h, body: JSON.stringify(body) });

const readPoint = async (id: string) => {
  const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
    .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
  return row;
};

// DB 用例：默认无库自动跳过；本地真跑用 --config vitest.local.config.ts（仅回环）
describe.skipIf(!process.env.RUN_DB)('wenlv 铺码四态端点（DB）', () => {
  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等
    for (const v of [V1, V2, V3]) {
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, v));
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, v));
    }
    await db.insert(pmsBuiWenlvVenues).values([
      { id: V1, name: '铺码测试场地1' },
      { id: V2, name: '铺码测试场地2' },
      { id: V3, name: '铺码测试场地3' },
    ]);
    await db.insert(pmsBuiWenlvVenuePoints).values([
      // 四态推进用
      { id: P1, venueId: V1, name: '未印点位', code: 'PL-C1' },
      { id: P3, venueId: V1, name: '已验点位', code: 'PL-C3',
        printedAt: new Date('2026-01-01T00:00:00Z'), placedAt: new Date('2026-01-02T00:00:00Z'),
        verifiedAt: new Date('2026-01-03T00:00:00Z') },
      { id: P4, venueId: V1, name: '重置点位', code: 'PL-C4',
        printedAt: new Date('2026-01-01T00:00:00Z'), placedAt: new Date('2026-01-02T00:00:00Z'),
        verifiedAt: new Date('2026-01-03T00:00:00Z') },
      { id: P8, venueId: V1, name: '匿名点位', code: 'PL-C8' },
      // 物料导出投影用（用例 9/10）
      { id: P9, venueId: V1, name: '导出已验点位', code: 'PL-C9' },
      { id: P10, venueId: V1, name: '导出未印点位', code: 'PL-C10' },
      // 批量标记用
      { id: PA, venueId: V2, name: '有待印', code: 'PL-CA' },
      { id: PB, venueId: V2, name: '已印过', code: 'PL-CB', printedAt: T0, printedBy: 'pu-orig' },
      { id: PC, venueId: V2, name: '无码点位', code: null },
      // ids 形式用
      { id: PD, venueId: V3, name: '目标A', code: 'PL-CD' },
      { id: PE, venueId: V3, name: '目标B', code: 'PL-CE' },
      { id: PF, venueId: V3, name: '非目标', code: 'PL-CF' },
    ]);
  });

  it('1. 推进到 printed：200 且落库 printed_at 非空、printed_by=操作人', async () => {
    const res = await doPatch(`/points/${P1}/placement`, { to: 'printed' }, withUser('pu-print-1'));
    expect(res.status).toBe(200);
    const row = await readPoint(P1);
    expect(row.printedAt).toBeTruthy();
    expect(row.printedBy).toBe('pu-print-1');
  });

  it('2. 同阶段再推一次：200 且 printed_at 未被刷新（幂等）', async () => {
    const before = await readPoint(P1);
    const t0 = new Date(before.printedAt as any).getTime();
    const res = await doPatch(`/points/${P1}/placement`, { to: 'printed' }, withUser('pu-print-2'));
    expect(res.status).toBe(200);
    const row = await readPoint(P1);
    expect(new Date(row.printedAt as any).getTime()).toBe(t0);
  });

  it('3. 从 verified 回推 placed：400 且文案含「重置」', async () => {
    const res = await doPatch(`/points/${P3}/placement`, { to: 'placed' }, withUser('pu-x'));
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(b.error).toContain('重置');
  });

  it('4. reset 到 placed：清 placed/verified 时间戳，保留 printed', async () => {
    const res = await doPost(`/points/${P4}/placement/reset`, { stage: 'placed' }, withUser('pu-x'));
    expect(res.status).toBe(200);
    const row = await readPoint(P4);
    expect(row.placedAt).toBeNull();
    expect(row.verifiedAt).toBeNull();
    expect(row.printedAt).toBeTruthy();
  });

  it('5. mark-printed all:true：只打有码的点位，已印的原值不变', async () => {
    const res = await doPost(`/venues/${V2}/points/mark-printed`, { all: true }, withUser('pu-batch'));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.marked).toBe(1);

    const pa = await readPoint(PA);
    expect(pa.printedAt).toBeTruthy();
    expect(pa.printedBy).toBe('pu-batch');

    const pb = await readPoint(PB);
    expect(new Date(pb.printedAt as any).getTime()).toBe(T0.getTime());
    expect(pb.printedBy).toBe('pu-orig');

    const pc = await readPoint(PC);
    expect(pc.printedAt).toBeNull();
  });

  it('6. mark-printed ids:[...]：只影响列出的 id', async () => {
    const res = await doPost(`/venues/${V3}/points/mark-printed`, { ids: [PD, PE] }, withUser('pu-batch2'));
    expect(res.status).toBe(200);
    const pd = await readPoint(PD);
    const pe = await readPoint(PE);
    const pf = await readPoint(PF);
    expect(pd.printedAt).toBeTruthy();
    expect(pe.printedAt).toBeTruthy();
    expect(pf.printedAt).toBeNull();
  });

  it('7. 点位不存在 → 404 且文案为「点位不存在」', async () => {
    const res = await doPatch('/points/no-such-point-xyz/placement', { to: 'printed' }, withUser('pu-x'));
    expect(res.status).toBe(404);
    // 端点未实现时框架默认 404 的文案不是这个 —— 断文案才有区分力
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(b.error).toContain('点位不存在');
  });

  it('8. 无 X-Platform-User-Id ⇒ 200 且 printed_by 落 NULL', async () => {
    const res = await doPatch(`/points/${P8}/placement`, { to: 'printed' });
    expect(res.status).toBe(200);
    const row = await readPoint(P8);
    expect(row.printedAt).toBeTruthy();
    expect(row.printedBy).toBeNull();
  });

  // ── 物料导出（GET /venues/:id/points/qrcodes）投影 ─────────────────────
  // 该端点是**显式投影**（手写字段清单），漏字段不报错、只是静默丢：
  // 前端 pms-wenlv-web/src/lib/placement.ts 靠这三个时间戳渲染四态徽标，
  // 丢了 ⇒ 每张卡片恒显「未印」。所以这两条断「键存在且值正确」，不断 falsy ——
  // `expect(x).toBeTruthy()` 对 undefined 也绿，等于把缺口又盖回去。
  const getQrcodes = async (venueId: string) => {
    const res = await adminWenlvRoute.request(`/venues/${venueId}/points/qrcodes`, { headers: H });
    expect(res.status).toBe(200);
    return res.json();
  };
  const findPoint = (body: any, id: string) => body.data.points.find((p: any) => p.id === id);

  it('9. qrcodes 投影透出三时间戳：已验点位三键存在且非 null', async () => {
    // 三阶段逐级推进（**不能直接 none→verified**：patchForAdvance 只写目标阶段的
    // at/by，跳级会让 printedAt/placedAt 停在 null —— 那是服务端既有语义，非本次缺口）。
    for (const to of ['printed', 'placed', 'verified'] as const) {
      const adv = await doPatch(`/points/${P9}/placement`, { to }, withUser('pu-qr'));
      expect(adv.status).toBe(200);
    }

    const pt = findPoint(await getQrcodes(V1), P9);
    expect(pt).toBeTruthy();
    for (const k of ['printedAt', 'placedAt', 'verifiedAt'] as const) {
      expect(Object.hasOwn(pt, k)).toBe(true);
      expect(pt[k]).not.toBeNull();
    }
  });

  it('10. qrcodes 投影：未推进点位三键存在且为 null（不是缺键）', async () => {
    const pt = findPoint(await getQrcodes(V1), P10);
    expect(pt).toBeTruthy();
    // 契约是「总是三键」：前端 placementOf 拿到 null → 「未印」。
    // 若退化成缺键（undefined），今天同样走 falsy 分支，但 `x ?? 默认值` 就会出差别。
    for (const k of ['printedAt', 'placedAt', 'verifiedAt'] as const) {
      expect(Object.hasOwn(pt, k)).toBe(true);
      expect(pt[k]).toBeNull();
    }
  });

  afterAll(async () => {
    for (const v of [V1, V2, V3]) {
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, v));
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, v));
    }
  });
});
