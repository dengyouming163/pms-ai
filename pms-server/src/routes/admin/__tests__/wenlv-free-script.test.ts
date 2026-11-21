// 第一段：schema 层（DB-free、无鉴权）。范式照抄同目录 wenlv-playmode.test.ts ——
// 那条「.partial() 不得凭空注入默认值」的纪律在本字段上同样致命，且**只有这一层能钉它**。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import adminWenlvRoute, { productHeadSchema, productHeadPatchSchema, freeModeReject } from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvProgress, pmsBuiWenlvVenues } from '../../../db/schema/index.js';

const base = { name: '测试剧本', venueId: 'v-1' };

describe('productHeadSchema 接受 isFree（DB-free）', () => {
  it('不传 → undefined（不注入默认值）', () => {
    const r = productHeadSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.data!.isFree).toBeUndefined();
  });
  it('传 true → true', () => {
    expect(productHeadSchema.safeParse({ ...base, isFree: true }).data!.isFree).toBe(true);
  });
  it('传 false → false（不是「假值被吞成 undefined」）', () => {
    expect(productHeadSchema.safeParse({ ...base, isFree: false }).data!.isFree).toBe(false);
  });
  it('传非布尔 → 失败', () => {
    expect(productHeadSchema.safeParse({ ...base, isFree: 'yes' }).success).toBe(false);
  });
});

describe('🔴 productHeadPatchSchema 不得凭空注入 isFree（DB-free）', () => {
  // 与 playMode 同坑：一旦写成 `.default(false)`，任何不传该键的 PATCH 都会被注入 false，
  // 而 PATCH 是 set({ ...parsed.data }) 直接展开 ⇒ 改一次标题就把免费剧本静默关成付费。
  it('空 body 的 patch 结果里不含 isFree 键', () => {
    const r = productHeadPatchSchema.safeParse({});
    expect(r.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(r.data!, 'isFree')).toBe(false);
  });
  it('patch 里显式传 true 正常收下', () => {
    expect(productHeadPatchSchema.safeParse({ isFree: true }).data!.isFree).toBe(true);
  });
});

// 2026-10-01 放宽后：免费剧本允许 group/both（测试剧本需要免费+多人，组队已不依赖订单）。
// 保留函数签名以兼容旧调用方与单测，但永远返回 null。
describe('freeModeReject（纯函数，放宽后）', () => {
  it('免费 + group ⇒ 放（测试剧本允许免费多人）', () => {
    expect(freeModeReject(true, 'group')).toBeNull();
  });
  it('免费 + both ⇒ 放', () => {
    expect(freeModeReject(true, 'both')).toBeNull();
  });
  it('免费 + solo ⇒ 放', () => {
    expect(freeModeReject(true, 'solo')).toBeNull();
  });
  it('付费 + group ⇒ 放', () => {
    expect(freeModeReject(false, 'group')).toBeNull();
  });
  it('免费 + playMode 未给 ⇒ 放（不强制 solo）', () => {
    expect(freeModeReject(true, undefined)).toBeNull();
  });
});

// 第二段：路由接线（证 `freeModeReject` 真的被调用了 —— 纯函数测试证明不了这一点）。
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

describe.skipIf(!process.env.RUN_DB)('免费剧本写入口 —— 路由接线（DB）', () => {
  const V = 'fv-' + Date.now();
  const P = 'fb-' + Date.now();
  const patch = (body: any) =>
    adminWenlvRoute.request(`/products/${P}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  // POST 走**新建**路径，与 PATCH 是两条独立的接线（守卫在 POST 处理函数里另有一处）
  // ⇒ 必须分开测。⚠️ 这条接线此前**零覆盖**：删掉 POST 那行守卫，整份测试仍全绿（2026-09-28 变异实测）。
  const post = (body: any) =>
    adminWenlvRoute.request('/products', { method: 'POST', headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    // 场地夹具：venueId 是必填，且 POST/PATCH 都会做存在性校验
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '免费测试场地' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: '写入口测试', venueId: V, status: 'draft', playMode: 'solo', isFree: false,
    });
  });

  it('isFree=true + playMode=solo ⇒ 200 且落库为 true', async () => {
    const res = await patch({ isFree: true, playMode: 'solo' });
    expect(res.status).toBe(200);
    const [row] = await db.select({ v: pmsBuiWenlvProducts.isFree })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    expect(row.v).toBe(true);
  });

  // 2026-10-01 放宽后：免费剧本允许 group/both。约束已撤，PATCH 应放行 200。
  it('已是免费的剧本改成 group ⇒ 200（允许免费多人）', async () => {
    const res = await patch({ playMode: 'group' });   // body 里**没有** isFree
    expect(res.status).toBe(200);
  });

  it('已是免费的剧本改成 both ⇒ 200', async () => {
    expect((await patch({ playMode: 'both' })).status).toBe(200);
  });

  it('不传 isFree 的 PATCH 不会把它抹成 false', async () => {
    const res = await patch({ name: '只改名字' });
    expect(res.status).toBe(200);
    const [row] = await db.select({ v: pmsBuiWenlvProducts.isFree })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    expect(row.v).toBe(true);   // ← 抹掉了就是 bug
  });

  // 2026-10-01：原「400 文案必须带出路」用例随约束一起撤掉（约束没了，文案也就没了）。

  // ---- POST 新建路径：守卫接线 + `isFree` 真的落库 ----
  // 🔴 这三条堵的是一个**静默失效**：schema 接受 `isFree`、守卫放行、但 `db.insert(...).values()` 里
  //    **没有这个键** ⇒ 行按列默认落 `false`，响应体还会回显 `"isFree":false`（200，无任何报错）。
  //    客户端送 `true` 却拿回 `false` —— 这正是 2026-09-28 质量复核抓出的 C1。
  it('🔴 POST 建免费剧本 ⇒ 200 且 isFree 真的落库（创建路径不得静默丢弃）', async () => {
    const id = 'fp-' + Date.now();
    try {
      const res = await post({ id, name: '新建免费剧本', venueId: V, isFree: true, playMode: 'solo' });
      expect(res.status).toBe(200);
      const [row] = await db.select({ v: pmsBuiWenlvProducts.isFree })
        .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
      expect(row.v).toBe(true);   // ← insert 漏写 isFree 就是 false
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  it('POST 建剧本不传 isFree ⇒ 落库 false（阴性对照：堵「insert 里硬写 true」这种坏实现）', async () => {
    const id = 'fp2-' + Date.now();
    try {
      const res = await post({ id, name: '默认付费剧本', venueId: V });
      expect(res.status).toBe(200);
      const [row] = await db.select({ v: pmsBuiWenlvProducts.isFree })
        .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
      expect(row.v).toBe(false);   // ← 上面那条断 true、这条断 false，两条互为对照 ⇒ 证明落的是**请求的值**而非常量
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  // 2026-10-01 放宽后：免费 + group 允许，应 200 且落库（不再 400 也不留空）。
  it('🔴 POST 建免费剧本 + group ⇒ 200 且落库（允许免费多人）', async () => {
    const id = 'fp3-' + Date.now();
    try {
      const res = await post({ id, name: '免费多人', venueId: V, isFree: true, playMode: 'group' });
      expect(res.status).toBe(200);
      const rows = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0].isFree).toBe(true);
      expect(rows[0].playMode).toBe('group');
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    // 场地**成对删**（照 `wenlv.test.ts:79-81`）：只删产品会每次跑都残留一行孤儿 `fv-<ts>`。
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

describe.skipIf(!process.env.RUN_DB)('免费试玩读口（汇总 + 明细）', () => {
  const P = 'agg-' + Date.now();
  const mk = (uid: string, v: number, s: string) => ({
    id: `${P}-${uid}`, productId: P, miniUserId: uid, status: s, visitCount: v,
    ...(s === 'completed' ? { completedAt: new Date() } : {}),
  });

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '汇总测试', status: 'published', isFree: true });
    // 3 人：a 玩 2 次（活跃）、b 玩 5 次（已完成）、c 玩 1 次（活跃）
    await db.insert(pmsBuiWenlvProgress).values([mk('a', 2, 'active'), mk('b', 5, 'completed'), mk('c', 1, 'active')]);
  });

  it('汇总：人数 3 / 总次数 8 / 完成 1', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/free-trial-stats`, { headers: H });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.players).toBe(3);
    expect(d.totalVisits).toBe(8);      // 2+5+1
    expect(d.completed).toBe(1);
  });

  it('🔴 明细带 visit_count ⇒ 能答「哪些用户、各玩几次」（spec §九.6）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/progresses`, { headers: H });
    expect(res.status).toBe(200);
    const rows = (await res.json()).data;
    const byU = new Map(rows.map((r: any) => [r.miniUserId, r.visitCount]));
    expect(byU.get('a')).toBe(2);
    expect(byU.get('b')).toBe(5);
    expect(byU.get('c')).toBe(1);
    // 🔴 逐人不同 ⇒ 证明这个数是**每人各自的**，不是被摊平/取错的同一个值
    expect(new Set([...byU.values()]).size).toBe(3);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});
