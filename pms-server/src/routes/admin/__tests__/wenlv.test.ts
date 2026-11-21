import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvScenes, pmsBuiWenlvChapters, pmsBuiWenlvScriptRooms,
  pmsBuiWenlvCollectibles,
  pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers, pmsBuiWenlvClaims, pmsBuiWenlvProgress, pmsBuiWenlvEvents,
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints,
  pmsBuiWenlvCultureMaterials,
  pmsBuiWenlvDesignAssets,   // 「删要素解绑」用例要直接 insert / 查这张表（Task 11）
  pmsBuiWenlvCharacters,     // publish R1（至少 1 角色）夹具：NARR/RALLY 合法 publish 用例需喂角色
} from '../../../db/schema/index.js';
import { eq } from 'drizzle-orm';
// 纯度量函数直接引入：Req2 的「status 权威」用例要证明**裸推导**确实与 status 打架，
// 光靠 HTTP 响应对拍不出这一点。
import { deriveDeliveryStage, scriptDeliveryDays } from '../../../services/wenlv-delivery.js';

// 内部 token 从 vitest.config 注入的 env 读取，与 pms-server constants.js 顶层取值一致
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const TEST_ID = 'admin-test-' + Date.now();

describe('wenlv 内容 admin 端点（内部 token）', () => {
  it('无内部 token 返回 403', async () => {
    const res = await adminWenlvRoute.request('/products', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
  });
});

// DB 用例：默认无库自动跳过；本地真跑用 --config vitest.local.config.ts（仅回环，见该文件顶部说明）
describe.skipIf(!process.env.RUN_DB)('wenlv 内容 admin 端点（DB 冒烟）', () => {
  // 场地夹具：venueId 现为必填，而 POST 会做场地存在性校验 —— 没有这一行会 400「场地不存在」
  const SMOKE_VENUE = 'venue-smoke-' + Date.now();

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: SMOKE_VENUE, name: '冒烟测试场地' }).onConflictDoNothing();
  });

  it('建产品返回 draft', async () => {
    const res = await adminWenlvRoute.request('/products', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: TEST_ID, name: '集成测试产品', subtitle: '测', venueId: SMOKE_VENUE }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.status).toBe('draft');
    expect(b.data.publishedVersion).toBe(0);
  });

  it('publish 一个无场景产品被完整性校验拦截（409）', async () => {
    const res = await adminWenlvRoute.request(`/products/${TEST_ID}/publish`, { method: 'POST', headers: H });
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(Array.isArray(b.errors)).toBe(true);
    expect(b.errors.length).toBeGreaterThan(0);
  });

  // 「必填」这条性质**只有这一条用例在守**：纯空白/空串/null 三条都只证明「拒绝空值」——
  // 它们即使把 venueId 放宽成 .optional()（transform + refine 原样保留）也仍然全绿。
  // 只有「键整个不传」才区分 required 与 optional。
  it('POST /products 不传 venueId ⇒ 400，且一行都不落库（「必填」的唯一看守）', async () => {
    const id = 'prod-no-venue-' + Date.now();
    try {
      const res = await adminWenlvRoute.request('/products', {
        method: 'POST', headers: H,
        body: JSON.stringify({ id, name: '无归属剧本' }),
      });
      expect(res.status).toBe(400);
      // 消息是 zod **类型层**的（z.string() 收不到 undefined），不是 refine 那句
      //「必须选择场地」——后者只有空串/纯空白才命中。与 PATCH 的 null 那条同族。
      expect((await res.json()).error).toContain('expected string');
      // 承重：只断言状态码的话，「先插入再报错」的实现也会绿
      const rows = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, TEST_ID));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, SMOKE_VENUE));
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 内容 admin 子资源', () => {
  const PROD = 'admin-test-' + Date.now();
  const ROOM_ID = `room-${PROD}`;
  const CH_ID = `ch-${PROD}`;
  let nodeId = '';

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '子资源测试' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM_ID, contentId: PROD, name: '子资源房', mode: 'narrative' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({ id: CH_ID, scriptRoomId: ROOM_ID, title: '第一章', order: 0 }).onConflictDoNothing();
  });

  it('POST scene 返回带 order 的行', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH_ID}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '村口', order: 1 }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.scene.title).toBe('村口');
    nodeId = b.data.scene.id;
  });

  it('GET /products/:id/full 能读回新加场景（覆盖读路径）', async () => {
    const res = await adminWenlvRoute.request(`/products/${PROD}/full`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    const hit = b.data.nodes.find((n: any) => n.id === nodeId);
    expect(hit).toBeTruthy();
    expect(hit.title).toBe('村口');
  });

  it('PATCH scene 就地改标题', async () => {
    const res = await adminWenlvRoute.request(`/scenes/${nodeId}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ title: '村口改名' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.scene.title).toBe('村口改名');
  });

  it('POST collectible / ending / reward 均成功', async () => {
    const mk = (path: string, obj: any) => adminWenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(obj) });
    const c = await mk(`/products/${PROD}/collectibles`, { name: '密信', type: 'clue' });
    expect((await c.json()).success).toBe(true);
    const e = await mk(`/script-rooms/${ROOM_ID}/endings`, { chapterId: CH_ID, title: '圆满', triggerCondition: null, rewardId: null });
    expect((await e.json()).success).toBe(true);
    const r = await mk(`/products/${PROD}/rewards`, { name: '锦囊', type: 'coupon' });
    expect((await r.json()).success).toBe(true);
  });

  afterAll(async () => {
    await Promise.all([
      db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH_ID)),
      db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PROD)),
      db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, PROD)),
      db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_ID)),
      db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PROD)),
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD)),
    ]);
  });
});

// 集章 rally admin 能力（连 test 库真实执行，与 mini wenlv.test.ts 的 rally 全链路基调一致，
// 不加 RUN_DB 门控——本地 test 库已应用 0020/0021 迁移，运行即真库）。
// fixture 拆多独立产品 id：HEAD 测头字段、RALLY 测合法集章全链、WITH_ENDING/NO_TIER 测发布负例、NARR 测剧情旧路径回归。
describe('wenlv 内容 admin 集章 rally（DB）', () => {
  const U = Date.now();
  const HEAD = `admin-rally-${U}-head`;
  const RALLY = `admin-rally-${U}-rally`;
  const WITH_ENDING = `admin-rally-${U}-we`;
  const NO_TIER = `admin-rally-${U}-nt`;
  const NARR = `admin-rally-${U}-narr`;
  const MINI = 'admin-rally-mini-user';
  // 三个 rally 夹具共用一个场地 + 三个带码点位：发章节点必须绑定点位（到场证明闸门），
  // 否则 publish 一律 409 —— 负例（带结局/无档位）若发章节点不绑定，就会因**错误的**理由变红，
  // 掩盖掉它们真正要钉的那条校验。绑定后它们只可能因各自的目标缺陷而 409。
  const RALLY_VENUE = `admin-rally-${U}-venue`;
  const RALLY_PT1 = `admin-rally-${U}-pt1`;
  const RALLY_PT2 = `admin-rally-${U}-pt2`;
  const RALLY_PT3 = `admin-rally-${U}-pt3`;
  const RALLY_CODES = [`WLP-RA1${U}`, `WLP-RA2${U}`, `WLP-RA3${U}`];
  const P = [RALLY, WITH_ENDING, NO_TIER, NARR];

  const post = (path: string, body: unknown) => adminWenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) => adminWenlvRoute.request(path, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
  const del = (path: string) => adminWenlvRoute.request(path, { method: 'DELETE', headers: H });
  const get = (path: string) => adminWenlvRoute.request(path, { headers: H });

  let tier1Id = '';
  let tier2Id = '';
  let claimId = '';
  let claimCode = '';

  beforeAll(async () => {
    // 清残留（先子后父），保证前次崩溃/重跑幂等
    const chapterIds = P.map((id) => `ch-${id}`);
    // scenes 先删（外键依赖 chapters），再 chapters，再 rooms，再 products
    for (const cid of chapterIds) await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, cid));
    for (const id of P) await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, `room-${id}`));
    for (const id of P) await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, id));
    await Promise.all([
      db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, RALLY)),
      db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, RALLY)),
      db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, RALLY)),
      ...P.map((id) => db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id))),
    ]);
    // 场地 + 三个带码点位（先清残留再插，重跑幂等）
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, RALLY_VENUE));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, RALLY_VENUE));
    await db.insert(pmsBuiWenlvVenues).values({ id: RALLY_VENUE, name: '集章测试场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values([
      { id: RALLY_PT1, venueId: RALLY_VENUE, name: '打卡点', code: RALLY_CODES[0], sortOrder: 1 },
      { id: RALLY_PT2, venueId: RALLY_VENUE, name: '打卡点', code: RALLY_CODES[1], sortOrder: 2 },
      { id: RALLY_PT3, venueId: RALLY_VENUE, name: '打卡点', code: RALLY_CODES[2], sortOrder: 3 },
    ]);
    // RALLY：合法集章产品（scene 打卡点绑带码点位 grant 章；后续 tier CRUD/claims/assist/publish 共用）
    await db.insert(pmsBuiWenlvProducts).values({ id: RALLY, name: '集章测试-rally', mode: 'rally', venueId: RALLY_VENUE });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${RALLY}`, contentId: RALLY, name: '集章房', mode: 'rally' });
    await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${RALLY}`, scriptRoomId: `room-${RALLY}`, title: '第一章', order: 0 });
    await db.insert(pmsBuiWenlvScenes).values({
      id: `${RALLY}-n1`, chapterId: `ch-${RALLY}`, type: 'narrative', title: '打卡点',
      venuePointId: RALLY_PT1,
      grants: [`${RALLY}-s1`], puzzle: null, order: 1,
    });
    await db.insert(pmsBuiWenlvCollectibles).values({
      id: `${RALLY}-s1`, productId: RALLY, name: '章一', type: 'stamp', stampMeta: { shape: 'circle' },
    });
    await db.insert(pmsBuiWenlvRewards).values({ id: `${RALLY}-r1`, productId: RALLY, name: '奖励一', type: 'digital', value: 'RALLY-DIG-001' });
    // R1（spec §9）：产品至少需要 1 个角色。合法 publish 用例必须喂角色，
    // 否则 R1 拦下 ⇒ publish 409（与「带结局 409」「无档位 409」撞形，测不到 200 路径）。
    await db.insert(pmsBuiWenlvCharacters).values({
      id: `${RALLY}-ch1`, productId: RALLY, order: 1, name: '主角', faction: '正派',
      identity: '侠客', vitality: 50, wisdom: 50, insight: 50,
    });
    await db.insert(pmsBuiWenlvProgress).values({
      id: `${RALLY}-prg`, productId: RALLY, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
    // WITH_ENDING：rally 带结局（publish 应 409；节点已绑点位，故只可能因「含结局」而拒）
    await db.insert(pmsBuiWenlvProducts).values({ id: WITH_ENDING, name: '集章带结局', mode: 'rally', venueId: RALLY_VENUE });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${WITH_ENDING}`, contentId: WITH_ENDING, name: '带结局房', mode: 'rally' });
    await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${WITH_ENDING}`, scriptRoomId: `room-${WITH_ENDING}`, title: '第一章', order: 0 });
    await db.insert(pmsBuiWenlvScenes).values({
      id: `${WITH_ENDING}-n1`, chapterId: `ch-${WITH_ENDING}`, type: 'narrative', title: '打卡',
      venuePointId: RALLY_PT2,
      grants: [`${WITH_ENDING}-s1`], puzzle: null, order: 1,
    });
    await db.insert(pmsBuiWenlvCollectibles).values({ id: `${WITH_ENDING}-s1`, productId: WITH_ENDING, name: '章', type: 'stamp' });
    await db.insert(pmsBuiWenlvRewards).values({ id: `${WITH_ENDING}-r1`, productId: WITH_ENDING, name: '奖励', type: 'digital', value: 'WE-DIG-001' });
    await db.insert(pmsBuiWenlvRewardTiers).values({
      id: `${WITH_ENDING}-t1`, productId: WITH_ENDING, name: '档1', order: 1, rewardId: `${WITH_ENDING}-r1`,
      condition: { type: 'ref', ref: { kind: 'collected', id: `${WITH_ENDING}-s1` } },
    });
    // 结局 = scenes type='ending'
    await db.insert(pmsBuiWenlvScenes).values({ id: `${WITH_ENDING}-e1`, chapterId: `ch-${WITH_ENDING}`, type: 'ending', title: '错误结局', triggerCondition: { type: 'all', conditions: [] } });
    // NO_TIER：rally 无档位（publish 应 409；节点已绑点位，故只可能因「无档位」而拒）
    await db.insert(pmsBuiWenlvProducts).values({ id: NO_TIER, name: '集章无档位', mode: 'rally', venueId: RALLY_VENUE });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${NO_TIER}`, contentId: NO_TIER, name: '无档位房', mode: 'rally' });
    await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${NO_TIER}`, scriptRoomId: `room-${NO_TIER}`, title: '第一章', order: 0 });
    await db.insert(pmsBuiWenlvScenes).values({
      id: `${NO_TIER}-n1`, chapterId: `ch-${NO_TIER}`, type: 'narrative', title: '打卡',
      venuePointId: RALLY_PT3,
      grants: [`${NO_TIER}-s1`], puzzle: null, order: 1,
    });
    await db.insert(pmsBuiWenlvCollectibles).values({ id: `${NO_TIER}-s1`, productId: NO_TIER, name: '章', type: 'stamp' });
    // NARR：剧情回归（mode 缺省 narrative + scene + ending）
    await db.insert(pmsBuiWenlvProducts).values({ id: NARR, name: '剧情回归', mode: 'narrative' });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${NARR}`, contentId: NARR, name: '剧情房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${NARR}`, scriptRoomId: `room-${NARR}`, title: '第一章', order: 0 });
    await db.insert(pmsBuiWenlvScenes).values({
      id: `${NARR}-n1`, chapterId: `ch-${NARR}`, type: 'narrative', title: '场景一',
      grants: [], puzzle: null, order: 1,
    });
    // 结局 = scenes type='ending'
    await db.insert(pmsBuiWenlvScenes).values({ id: `${NARR}-e1`, chapterId: `ch-${NARR}`, type: 'ending', title: '结局一', triggerCondition: { type: 'all', conditions: [] }, rewardId: null });
    // NARR 同样需喂角色（R1 拦下则 publish 409，测不到 200 回归路径）。
    await db.insert(pmsBuiWenlvCharacters).values({
      id: `${NARR}-ch1`, productId: NARR, order: 1, name: '主角', faction: '正派',
      identity: '侠客', vitality: 50, wisdom: 50, insight: 50,
    });
  });

  it('产品头 POST 支持 mode 与运营窗口字段', async () => {
    const res = await post('/products', {
      id: HEAD, name: '集章头测试', mode: 'rally', venueId: RALLY_VENUE,
      opsStartAt: '2026-09-01T00:00:00.000Z', opsEndAt: '2026-10-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.mode).toBe('rally');
    expect(new Date(b.data.opsStartAt).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(new Date(b.data.opsEndAt).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('产品头 PATCH 可改 mode（narrative/rally 互切）', async () => {
    const res = await patch(`/products/${HEAD}`, { mode: 'narrative' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.mode).toBe('narrative');
  });

  it('POST tiers 创建档位：order 缺省从 1 起', async () => {
    const res = await post(`/products/${RALLY}/tiers`, { name: '档一', description: '集1章领奖' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.name).toBe('档一');
    expect(b.data.order).toBe(1);
    expect(b.data.productId).toBe(RALLY);
    tier1Id = b.data.id;
  });

  it('POST 第二条档位 order 缺省自增为 max+1=2', async () => {
    const res = await post(`/products/${RALLY}/tiers`, { name: '档二' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.order).toBe(2);
    tier2Id = b.data.id;
  });

  it('GET /products/:id/tiers 列表含两条', async () => {
    const res = await get(`/products/${RALLY}/tiers`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.length).toBe(2);
    expect((b.data as any[]).map((t: any) => t.id)).toContain(tier1Id);
  });

  it('GET /products 列表行带 tierCount 计数', async () => {
    const res = await get('/products');
    expect(res.status).toBe(200);
    const b = await res.json();
    const row = (b.data.list as any[]).find((r: any) => r.id === RALLY);
    expect(row).toBeTruthy();
    expect(row.tierCount).toBe(2);
    expect(row.mode).toBe('rally');
  });

  it('PATCH tiers 就地改 name/挂 condition+reward', async () => {
    const res = await patch(`/tiers/${tier1Id}`, {
      name: '档一·章',
      condition: { type: 'ref', ref: { kind: 'collected', id: `${RALLY}-s1` } },
      rewardId: `${RALLY}-r1`,
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.name).toBe('档一·章');
    expect(b.data.rewardId).toBe(`${RALLY}-r1`);
    expect(b.data.condition.ref.id).toBe(`${RALLY}-s1`);
  });

  it('GET /products/:id/full 载入 tiers（nodes/collectibles/endings/rewards 齐全）', async () => {
    const res = await get(`/products/${RALLY}/full`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.mode).toBe('rally');
    expect(Array.isArray(b.data.tiers)).toBe(true);
    expect((b.data.tiers as any[]).map((t: any) => t.id)).toContain(tier1Id);
    expect(b.data.nodes.find((n: any) => n.id === `${RALLY}-n1`)).toBeTruthy();
    expect(b.data.collectibles.find((c: any) => c.id === `${RALLY}-s1`)).toBeTruthy();
    expect(Array.isArray(b.data.endings)).toBe(true);
    expect(b.data.rewards.find((r: any) => r.id === `${RALLY}-r1`)).toBeTruthy();
  });

  it('GET /products/:id/full 载入 npcs（与 characters 同构）', async () => {
    // 先 POST 一个 npc
    const postRes = await post(`/products/${RALLY}/npcs`, { id: `${RALLY}-npc1`, name: 'NPC甲', lines: [{ id: 'l1', text: '你好' }] });
    expect(postRes.status).toBe(200);
    const res = await get(`/products/${RALLY}/full`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Array.isArray(b.data.npcs)).toBe(true);
    expect(b.data.npcs).toHaveLength(1);
    expect(b.data.npcs[0].name).toBe('NPC甲');
  });

  it('POST scene 带 geo 对象经 HTTP 落库回读等值', async () => {
    const geo = { lat: 1.5, lng: 2.25, radius: 500 };
    const res = await post(`/chapters/ch-${RALLY}/scenes`, { title: 'GPS打卡点', geo });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.scene.geo).toEqual(geo);
    const createdId = b.data.scene.id;
    // 无 GET /chapters/:id/scenes，走 /full 投影回读
    const back = await get(`/products/${RALLY}/full`);
    const row = ((await back.json()).data.nodes as any[]).find((n: any) => n.id === createdId);
    expect(row.geo).toEqual(geo);
  });

  it('POST collectible 带 type:stamp + stampMeta 经 HTTP 落库等值', async () => {
    const stampMeta = { shape: 'square', color: '#e6a23c' };
    const res = await post(`/products/${RALLY}/collectibles`, { name: '集章·方形章', type: 'stamp', stampMeta });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.type).toBe('stamp');
    expect(b.data.stampMeta).toEqual(stampMeta);
    const back = await get(`/products/${RALLY}/collectibles`);
    const row = ((await back.json()).data as any[]).find((n: any) => n.id === b.data.id);
    expect(row.stampMeta).toEqual(stampMeta);
  });

  it('DELETE tiers 删除档二，列表余 1', async () => {
    const res = await del(`/tiers/${tier2Id}`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    const after = await get(`/products/${RALLY}/tiers`);
    expect(((await after.json()).data as any[]).length).toBe(1);
  });

  it('员工协助 GET /products/:id/progresses 按 query(miniUserId) 命中', async () => {
    const res = await get(`/products/${RALLY}/progresses?query=${MINI}`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.find((p: any) => p.id === `${RALLY}-prg`)).toBeTruthy();
  });

  it('员工协助补印 assist-grant 使 collected 置 true', async () => {
    const res = await post(`/products/${RALLY}/assist-grant`, { progressId: `${RALLY}-prg`, collectibleIds: [`${RALLY}-s1`], by: 'staff9' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.state.collected[`${RALLY}-s1`]).toBe(true);
  });

  it('assist-grant 含不存在线索返回 400', async () => {
    const res = await post(`/products/${RALLY}/assist-grant`, { progressId: `${RALLY}-prg`, collectibleIds: ['nope-col'], by: 'staff9' });
    expect(res.status).toBe(400);
  });

  it('assist-grant 不存在/跨产品进度返回 404', async () => {
    const res = await post(`/products/${RALLY}/assist-grant`, { progressId: 'no-such-progress', collectibleIds: [`${RALLY}-s1`], by: 'staff9' });
    expect(res.status).toBe(404);
  });

  it('claims 台账：直插 claim 后列表可见', async () => {
    claimCode = `LY${U}CL1`;
    const [ins] = await db.insert(pmsBuiWenlvClaims).values({
      id: `${RALLY}-cl1`, productId: RALLY, miniUserId: MINI, progressId: `${RALLY}-prg`,
      tierId: tier1Id, rewardId: `${RALLY}-r1`, code: claimCode, status: 'claimed',
      claimedAt: new Date(), updatedAt: new Date(),
    }).returning();
    claimId = ins.id;
    const res = await get(`/products/${RALLY}/claims`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Array.isArray(b.data)).toBe(true);
    expect((b.data as any[]).map((x: any) => x.id)).toContain(claimId);
  });

  it('GET /claims/by-code/:code 命中，错误码 404', async () => {
    const ok = await get(`/claims/by-code/${claimCode}`);
    expect(ok.status).toBe(200);
    const b = await ok.json();
    expect(b.data.id).toBe(claimId);
    const miss = await get('/claims/by-code/ZZ-NOT-EXIST');
    expect(miss.status).toBe(404);
  });

  it('POST /claims/:id/redeem 核销后 status=redeemed、redeemedBy 落库', async () => {
    const res = await post(`/claims/${claimId}/redeem`, { by: 'staff1' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('redeemed');
    expect(b.data.redeemedBy).toBe('staff1');
  });

  it('重复核销同 claim 返回 409（已核销）', async () => {
    const res = await post(`/claims/${claimId}/redeem`, { by: 'staff2' });
    expect(res.status).toBe(409);
  });

  it('无档位 rally publish 409（独立产品不污染合法 fixture）', async () => {
    const res = await post(`/products/${NO_TIER}/publish`, {});
    expect(res.status).toBe(409);
    const b = await res.json();
    expect((b.errors as string[]).join('|')).toContain('至少 1 个档位');
  });

  it('带结局 rally publish 409 且 errors 含「不能包含结局」', async () => {
    const res = await post(`/products/${WITH_ENDING}/publish`, {});
    expect(res.status).toBe(409);
    const b = await res.json();
    expect((b.errors as string[]).join('|')).toContain('不能包含结局');
  });

  it('narrative 回归：scene+ending publish 200（传 tiers 后旧路径仍绿）', async () => {
    const res = await post(`/products/${NARR}/publish`, {});
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('published');
    expect(b.data.publishedVersion).toBe(1);
  });

  it('rally 合法结构（scene+collectible+tier condition/reward）publish 200', async () => {
    const res = await post(`/products/${RALLY}/publish`, {});
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('published');
    expect(b.data.publishedVersion).toBe(1);
  });

  afterAll(async () => {
    // scenes→chapters→rooms（外键依赖顺序）
    for (const id of P) {
      await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, `ch-${id}`));
      await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, `room-${id}`));
      await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, id));
    }
    await Promise.all([
      db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, RALLY)),
      db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, RALLY)),
      db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, RALLY)),
      ...P.map((id) => db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, id))),
      ...P.map((id) => db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, id))),
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, HEAD)),
      ...P.map((id) => db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id))),
      db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, RALLY_VENUE)),
      db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, RALLY_VENUE)),
    ]);
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 场地端点', () => {
  const VENUE = 'venue-test-' + Date.now();
  let pointId = '';

  it('POST /venues 建场地，初始 lead', async () => {
    const res = await adminWenlvRoute.request('/venues', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: VENUE, name: '龙门镇测试场地', city: '黔南' }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('lead');
  });

  it('POST /venues/:id/stage 跳级被拒（lead → live）', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}/stage`, {
      method: 'POST', headers: H, body: JSON.stringify({ to: 'live' }),
    });
    expect(res.status).toBe(409);
  });

  it('lead → surveying 盖 surveyStartedAt', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}/stage`, {
      method: 'POST', headers: H, body: JSON.stringify({ to: 'surveying' }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('surveying');
    expect(b.data.surveyStartedAt).toBeTruthy();
  });

  it('重复进入同一阶段被拒', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}/stage`, {
      method: 'POST', headers: H, body: JSON.stringify({ to: 'surveying' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /venues/:id/points 自动生成 WLP- 码', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: '古井' }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.triggerType).toBe('qrcode');
    expect(b.data.code).toMatch(/^WLP-[0-9A-HJKMNP-TV-Z]{12}$/);
    pointId = b.data.id;
  });

  // 🔴 本组于 2026-09-23 **重写**：原先这里只有一条
  // `POST points triggerType=beacon 缺 code 被拒 400`。那条闸已被**有意删除**
  // （旧模型里 code 存的就是信标 ID；新模型信标凭证改走广播帧，`code` 与信标无关，
  // 「纯信标点位没有码」成了合法形态）。旧断言不是被放宽，是**前提没了**。
  //
  // 删闸的连带后果必须逐条重新推，所以这里不是「把 400 改成 200」了事：
  //   ① 「省略 code」与「显式 null」是**两件事**，前者仍走生成器 —— 这条区分
  //      正是 App 用它表达「要码 / 不要码」的全部依据，必须锁死。
  //   ② 新加的 `generateCode`（补码）与 `code: null`（清空）各自的行为。
  //
  // ⚠️ 本组每条都自建自删点位：下游 `GET /venues/:id 带点数与码数` 断言
  //    `points.length === 1`，漏删一条就会把那条打红，而红的位置离真正的原因很远。
  describe('点位类型与短码（2026-09-23 新模型）', () => {
    it('triggerType=beacon 且省略 code → 200，且**照旧自动生成**一个码（省略 ≠ 清空）', async () => {
      const res = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
        method: 'POST', headers: H, body: JSON.stringify({ name: '山门', triggerType: 'beacon' }),
      });
      expect(res.status).toBe(200);
      const b = await res.json();
      try {
        expect(b.data.triggerType).toBe('beacon');
        // 省略 code ⇒ 服务端 `d.code === undefined` ⇒ 走生成器。删掉那条 400 闸
        // **没有**改变这一点 —— 它从来只管「triggerType=beacon 且没有码」这种组合。
        expect(b.data.code).toMatch(/^WLP-[0-9A-HJKMNP-TV-Z]{12}$/);
      } finally {
        await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, b.data.id));
      }
    });

    it('显式 code: null → 200 且落 null（「只装信标、不贴二维码」是合法形态）', async () => {
      const res = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ name: '崖壁（纯信标）', triggerType: 'beacon', code: null }),
      });
      expect(res.status).toBe(200);
      const b = await res.json();
      try {
        // 🔴 必须是 null 而不是空串：`if (p.code)` 的读路径当空串没值、
        // `code !== null` 的读路径当它有值，两种读法都「看着对」，于是没人发现。
        expect(b.data.code).toBeNull();
      } finally {
        await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, b.data.id));
      }
    });

    it('PATCH code: null 清空已有码（取消二维码）', async () => {
      const mk = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
        method: 'POST', headers: H, body: JSON.stringify({ name: '待撤码' }),
      });
      const id = (await mk.json()).data.id;
      try {
        const res = await adminWenlvRoute.request(`/points/${id}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ code: null }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).data.code).toBeNull();
      } finally {
        await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id));
      }
    });

    // `generateCode` 是本次新增的：没有它，「先建了纯信标点位、后来想补个二维码」
    // 这条路上服务端根本不会调生成器 —— 表单勾上二维码、保存返回 200、库里仍然没有码。
    // 没有这条用例，把 PATCH 里那段 `if (d.generateCode && …)` 整段删掉也**全绿**。
    it('PATCH generateCode: true 给没有码的点位补一个码；已有码时不覆盖', async () => {
      const mk = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ name: '先信标后补码', triggerType: 'beacon', code: null }),
      });
      const id = (await mk.json()).data.id;
      try {
        const res = await adminWenlvRoute.request(`/points/${id}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ generateCode: true }),
        });
        expect(res.status).toBe(200);
        const b = await res.json();
        expect(b.data.code).toMatch(/^WLP-[0-9A-HJKMNP-TV-Z]{12}$/);
        const first = b.data.code;

        // ② 已有码时再补一次 —— **不许覆盖**。覆盖会把一张已印出去的物料变成查无此码。
        const again = await adminWenlvRoute.request(`/points/${id}`, {
          method: 'PATCH', headers: H, body: JSON.stringify({ generateCode: true }),
        });
        expect(again.status).toBe(200);
        expect((await again.json()).data.code).toBe(first);
      } finally {
        await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id));
      }
    });
  });

  it('PATCH 只改名不会把 beacon 点位重置成 qrcode（zod .partial() 默认值注入回归）', async () => {
    const mk = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '山门', triggerType: 'beacon', code: 'BEACON-UUID-0001' }),
    });
    expect(mk.status).toBe(200);
    const beaconId = (await mk.json()).data.id;

    const res = await adminWenlvRoute.request(`/points/${beaconId}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '山门（东）' }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.name).toBe('山门（东）');
    expect(b.data.triggerType).toBe('beacon');   // 必须守住
    expect(b.data.code).toBe('BEACON-UUID-0001'); // 必须守住

    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, beaconId));
  });

  it('GET /venues/:id 带点数与码数', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.points.length).toBe(1);
    expect(b.data.points[0].id).toBe(pointId);
  });

  it('GET /venues/:id/points/qrcodes 返回可打印清单', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}/points/qrcodes`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.venue.name).toBe('龙门镇测试场地');
    expect(b.data.points.length).toBe(1);
    expect(b.data.points[0].code).toMatch(/^WLP-/);
    expect(b.data.missing).toBe(0);
  });

  // ⚠️ 上面那条 `missing).toBe(0)` 是**空断言** —— 场地里压根没有缺码的点位，
  // 所以 handler 就算写死 `missing: 0` 它照样过。下面这条把它变成真的。
  // 位置刻意放在上面那条**之后**：本条的场地状态是「2 个点位、其中 1 个缺码」，
  // 而上面几条都断言 `points.length === 1`，放到前面会把它们全打红。
  it('清空码的点位计入 missing（物料导出要能看出还差几张）', async () => {
    const mk = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
      method: 'POST', headers: H, body: JSON.stringify({ name: '尚未铺码' }),
    });
    expect(mk.status).toBe(200);
    const id = (await mk.json()).data.id;

    // code 显式置空 = 撤下已印物料；库里应落 null 而不是空串
    const clr = await adminWenlvRoute.request(`/points/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ code: '' }),
    });
    expect(clr.status).toBe(200);
    expect((await clr.json()).data.code).toBeNull();

    const res = await adminWenlvRoute.request(`/venues/${VENUE}/points/qrcodes`, { headers: H });
    const b = await res.json();
    // 注意：响应里的 `points` 是**可打印清单**（只含已铺码的），不是场地点位全集 ——
    // 场地点位总数体现在 `missing` 的口径里（全集 2 − 可打印 1）。
    expect(b.data.points.length).toBe(1);
    expect(b.data.missing).toBe(1); // handler 若写死 0，这条必红

    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id));
  });

  // GET /venues/:id/points 的 404 守卫：不存在的场地必须 404，而不是 200 + []。
  // 修复前 handler 不查场地存在性，空数组会被端面读成「该场地确实没有点位」。
  it('GET 不存在场地的 points → 404（不是 200 + []）', async () => {
    const res = await adminWenlvRoute.request('/venues/no-such-venue-xyz/points', { headers: H });
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.success).toBe(false);
  });

  it('GET /venues/:id/points 按 sortOrder 升序返回（不因插入顺序回归）', async () => {
    // 先建 sortOrder=20、后建 sortOrder=10：handler 若丢掉 orderBy，返回的就是插入序（20 在前），本条必红
    const mk = (name: string, sortOrder: number) => adminWenlvRoute.request(`/venues/${VENUE}/points`, {
      method: 'POST', headers: H, body: JSON.stringify({ name, sortOrder }),
    });
    const rBig = await mk('排序大', 20);
    const rSmall = await mk('排序小', 10);
    expect(rBig.status).toBe(200);
    expect(rSmall.status).toBe(200);
    const idBig = (await rBig.json()).data.id;
    const idSmall = (await rSmall.json()).data.id;
    try {
      const res = await adminWenlvRoute.request(`/venues/${VENUE}/points`, { headers: H });
      expect(res.status).toBe(200);
      const ids = ((await res.json()).data as any[]).map((p) => p.id);
      // 用布尔断言而非 toBeLessThan：本文件既有写法。
      // ⚠️ 2026-09-19 更正：原注释给的理由（「桩未声明、ts-check 会报 TS2339」）已不成立 ——
      //    toBeLessThan 自 d5a65359 起已在桩内。是否可用以 src/types/vitest.d.ts 为准。
      expect(ids.indexOf(idSmall) < ids.indexOf(idBig)).toBe(true);
    } finally {
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, idBig));
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, idSmall));
    }
  });

  it('DELETE 有点位的场地被拒 409', async () => {
    const res = await adminWenlvRoute.request(`/venues/${VENUE}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(409);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VENUE));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });
});

// `DELETE /venues/:id` 的三条判据：空场地必须删得掉、有点位/有剧本必须拦住。
//
// 这里刻意新建独立 fixture（不复用上面「场地端点」的 VENUE）：上面那个场地在跑到
// 「DELETE 有点位的场地被拒 409」时状态是「1 个点位」，「空场地」那条会与之互相污染。
//
// 本 describe 是 2026-09-13 修复「删除恒 409」时补的：修复前 `const [pt, prod] =
// await Promise.all([...limit(1)])` 只解一层，拿到的是数组 `[]`（truthy），
// `pt || prod` 无条件为真 —— **每一条**删除都被 409 拒掉，而当时套件里偏偏只有
// 「有点位→409」这一条，恰好吃不到那个 bug。空场地那条就是为咬住它而存在。
describe.skipIf(!process.env.RUN_DB)('wenlv 场地删除（空可删 / 有引用则 409）', () => {
  const V_EMPTY = 'venue-del-ok-' + Date.now();
  const V_POINT = 'venue-del-pt-' + Date.now();
  const V_SCRIPT = 'venue-del-sc-' + Date.now();
  const V_MATERIAL = 'venue-del-mat-' + Date.now();
  const PT = 'venuedelpoint-' + Date.now();
  const P = 'venuedelscript-' + Date.now();
  const M = 'venuedelmat-' + Date.now();

  const del = (path: string) => adminWenlvRoute.request(path, { method: 'DELETE', headers: H });
  const get = (path: string) => adminWenlvRoute.request(path, { headers: H });

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.id, M));
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V_MATERIAL));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    for (const id of [V_EMPTY, V_POINT, V_SCRIPT, V_MATERIAL]) {
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
    }
    await db.insert(pmsBuiWenlvVenues).values([
      { id: V_EMPTY, name: '空场地' },
      { id: V_POINT, name: '有点位场地' },
      { id: V_SCRIPT, name: '有剧本场地' },
      { id: V_MATERIAL, name: '有素材场地' },
    ]);
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT, venueId: V_POINT, name: '挡删除的点位' });
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '挡删除的剧本', venueId: V_SCRIPT });
    // 只有**场地级**素材（venuePointId 为 null）、无点位无剧本：旧守卫只查点位与剧本，
    // 看不见这行素材 —— 场地会被删掉，素材行沦为任何读路径（都按 venueId 过滤）都查不到的孤儿。
    await db.insert(pmsBuiWenlvCultureMaterials).values({
      id: M, venueId: V_MATERIAL, type: 'history', title: '挡删除的场地级素材', content: 'x', venuePointId: null,
    });
  });

  it('空场地删除 200，且行真的消失（GET 404 + 库里查不到）', async () => {
    const res = await del(`/venues/${V_EMPTY}`);
    // 修复前这里恒为 409（数组 truthy）——本条是那次 bug 的唯一哨兵。
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    // 只断言 200 不够：一个「返回 200 但根本没删」的实现同样会绿。
    const gone = await get(`/venues/${V_EMPTY}`);
    expect(gone.status).toBe(404);
    const rows = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V_EMPTY));
    expect(rows.length).toBe(0);
  });

  it('有点位的场地删除 409，且场地行仍在', async () => {
    const res = await del(`/venues/${V_POINT}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('场地下仍有点位、素材或剧本，不能删除');
    const rows = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V_POINT));
    expect(rows.length).toBe(1);
  });

  it('有剧本（归属该场地的内容产品）的场地删除 409', async () => {
    const res = await del(`/venues/${V_SCRIPT}`);
    expect(res.status).toBe(409);
    const rows = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V_SCRIPT));
    expect(rows.length).toBe(1);
  });

  it('只有场地级文化素材（无点位无剧本）的场地删除 409，且场地与素材行都仍在', async () => {
    const res = await del(`/venues/${V_MATERIAL}`);
    expect(res.status).toBe(409);
    // 只断 409 不够：一个「先删场地再回 409」的实现同样会绿 —— 素材行必须也活着。
    const venueRows = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V_MATERIAL));
    expect(venueRows.length).toBe(1);
    const matRows = await db.select().from(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.id, M));
    expect(matRows.length).toBe(1);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.id, M));
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V_MATERIAL));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    for (const id of [V_EMPTY, V_POINT, V_SCRIPT, V_MATERIAL]) {
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
    }
  });
});

// 点位码全局唯一（uq_wenlv_venue_points_code）的冲突语义。
// 独立 fixture：不复用上面「场地端点」describe 的 VENUE 常量，避免被别的用例的清理/计数断言牵连。
describe.skipIf(!process.env.RUN_DB)('wenlv 场地点位码唯一冲突', () => {
  const VENUE = 'venue-code-' + Date.now();
  const P1 = `${VENUE}-p1`;
  const P2 = `${VENUE}-p2`;
  const DUP_CODE = 'WLP-DUPCOLLIDE01';

  const mkPoint = (body: unknown) => adminWenlvRoute.request(`/venues/${VENUE}/points`, {
    method: 'POST', headers: H, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等。
    // 额外按 code 清：上次跑崩在 afterAll 之前时，残留行挂在**另一个**（更早的 Date.now）venue 上，
    // 只按 venue 清会让本 describe 的「200」首条直接撞码变 409。
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VENUE));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.code, DUP_CODE));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '码冲突测试场地' });
  });

  it('手填全局唯一 code 建点 200', async () => {
    const res = await mkPoint({ id: P1, name: '井口', code: DUP_CODE });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.code).toBe(DUP_CODE);
  });

  it('换 id 用同一 code 建点返回 409（而非 500）', async () => {
    // id 不同 ⇒ 走不到「幂等重入」那条 200 分支，必然撞 uq_wenlv_venue_points_code。
    // 修复前：DrizzleQueryError 无 e.code，异常冒泡成全局 500 —— 本条会红。
    const res = await mkPoint({ id: P2, name: '井口副本', code: DUP_CODE });
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(b.error).toContain('已被占用');
  });

  it('未手填 code 时服务端生成 WLP- 码且 200', async () => {
    try {
      const res = await mkPoint({ id: `${VENUE}-p3`, name: '自动码点' });
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.success).toBe(true);
      expect(b.data.code).toMatch(/^WLP-[0-9A-HJKMNP-TV-Z]{12}$/);
    } finally {
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, `${VENUE}-p3`));
    }
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VENUE));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 产品归属与交付时间戳', () => {
  const V = 'venue-attr-' + Date.now();
  const P = 'prod-attr-' + Date.now();
  // 顺序守卫 / 优先级用例各自独立的 fixture，不复用 V/P —— 三条用例的库内状态互不污染
  const PREMATURE = 'prod-attr-prem-' + Date.now();
  const LEGACY = 'prod-attr-legacy-' + Date.now();
  const DIRTY = 'prod-attr-dirty-' + Date.now();
  // 反向半成品对：已有定稿章、起稿章为 null。API 走不出来（ready 要有 start），
  // 只有存量/带外写入才可能有这行状态 —— 正是 start 侧对称守卫要拦的输入。
  const READY_ONLY = 'prod-attr-readyonly-' + Date.now();

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '归属测试场地' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '归属测试剧本' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({ id: PREMATURE, name: '未起稿剧本' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({
      id: READY_ONLY, name: '只有定稿章的剧本',
      contentReadyAt: new Date(), generationStartedAt: null,
    }).onConflictDoNothing();
    // 存量行：本 Task 之前 publish 从不盖 publishedAt，线上真实存在 status='published' 三章全空的行
    await db.insert(pmsBuiWenlvProducts).values({ id: LEGACY, name: '存量已发布剧本', status: 'published' }).onConflictDoNothing();
    // 反向脏行：未发布却盖了 publishedAt（撤回后未清章）
    await db.insert(pmsBuiWenlvProducts).values({ id: DIRTY, name: '未发布却盖发布章', status: 'draft' }).onConflictDoNothing();
  });

  it('PATCH /products/:id 可归到场地', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ venueId: V }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.venueId).toBe(V);
  });

  it('归到不存在的场地被拒 400', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ venueId: 'no-such-venue' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /products?venueId=<空> 只回未归属的，不回本产品', async () => {
    const res = await adminWenlvRoute.request('/products?venueId=', { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.list.every((p: any) => !p.venueId)).toBe(true);
    // 注：仓库自写的类型桩 src/types/vitest.d.ts 未声明 toBeUndefined（同 stores-region-tags.test.ts 的处理）
    expect(b.data.list.some((p: any) => p.id === P)).toBe(false);
  });

  // 顺序约束（保留自旧版）：以下三条必须在 `GET /products?venueId=<空>`（只回未归属的）之后 ——
  // 那条断言 P 不在未归属列表里，依赖此前刚把 P 归到 V。而这三条都不再改动 P 的归属
  // （前两条已被 400 拒绝、第三条显式只改名），所以整组跑完 P 仍归属 V。
  it('venueId=null 解绑 → 400（旧语义是 200 + 落 NULL，已反转）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ venueId: null }),
    });
    expect(res.status).toBe(400);
    // null 落在 zod **类型层**（z.string() 不收 null），报的是类型消息，不是 refine 那句
    //「必须选择场地」——后者只有空串/纯空白才命中。两者同为 400，产品语义一致。
    expect((await res.json()).error).toContain('expected string');
    // 打在 DB 行上：只断言状态码的话，「先解绑再报错」的实现也会绿
    const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(row.venueId).toBe(V);
  });

  it("venueId='' → 400（旧语义是归一为 SQL NULL，已反转）", async () => {
    const res = await adminWenlvRoute.request(`/products/${P}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ venueId: '' }),
    });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(row.venueId).toBe(V);
  });

  it('PATCH 不传 venueId 键 → 200 且归属不变（「不改」语义）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '只改名' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(row.venueId).toBe(V);
  });

  // 纯空白是「用户什么都没选」的孪生形态（表单 trim 前后），与空串同归一 ——
  // 但这里不再是「归 NULL」，而是**拒绝**：产品不允许无场地。
  it('POST /products venueId 为纯空白时 400（旧语义是归一为 SQL NULL，已反转）', async () => {
    const id = 'prod-blank-venue-' + Date.now();
    try {
      const res = await adminWenlvRoute.request('/products', {
        method: 'POST', headers: H,
        body: JSON.stringify({ id, name: '空白归属剧本', venueId: '   ' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('必须选择场地');
      // 关键：**一行都不许落库**。只断言状态码的话，「先插入再报错」的实现也会绿。
      const rows = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
      expect(rows).toHaveLength(0);
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  it('delivery/start 盖 generationStartedAt，重复调用不覆盖', async () => {
    const r1 = await adminWenlvRoute.request(`/products/${P}/delivery/start`, { method: 'POST', headers: H });
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()).data.generationStartedAt;
    expect(t1).toBeTruthy();
    const r2 = await adminWenlvRoute.request(`/products/${P}/delivery/start`, { method: 'POST', headers: H });
    expect((await r2.json()).data.generationStartedAt).toBe(t1);
  });

  it('delivery/ready 盖 contentReadyAt', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/delivery/ready`, { method: 'POST', headers: H });
    expect(res.status).toBe(200);
    expect((await res.json()).data.contentReadyAt).toBeTruthy();
  });

  // ---- Req1：盖章顺序不变量（选择解法 (a) 拒绝式 409，理由见路由注释）----
  it('未起稿就定稿被拒 409，库里不留倒挂对、度量不报「1 天」', async () => {
    const res = await adminWenlvRoute.request(`/products/${PREMATURE}/delivery/ready`, { method: 'POST', headers: H });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, PREMATURE)).limit(1);
    expect(row.contentReadyAt).toBeNull();          // 没有留下「只有定稿没有起稿」的半个对
    // 这才是本要求的关键：不能出现「请求成功 + 库里倒挂 + 度量报 1 天」的组合。
    // scriptDeliveryDays 在缺起稿章时返回 null —— 而不是 ceilDays 把倒挂兜出的那个好看数字。
    expect(scriptDeliveryDays(row)).toBeNull();
  });

  it('起稿后定稿：两章正向有序，度量算得出且 >= 1', async () => {
    const s = await adminWenlvRoute.request(`/products/${P}/delivery/start`, { method: 'POST', headers: H });
    expect(s.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(row.generationStartedAt).toBeTruthy();
    expect(row.contentReadyAt).toBeTruthy();
    // 不变量本体：定稿不得早于起稿（可以相等，等于时 ceilDays 按文档记 1 天）。
    // 写成布尔断言而非 toBeGreaterThanOrEqual：类型桩同样没声明这个匹配器。
    expect(row.contentReadyAt!.getTime() >= row.generationStartedAt!.getTime()).toBe(true);
    const days = scriptDeliveryDays(row);
    expect(days).not.toBeNull();
    expect(days!).toBeGreaterThan(0);
  });

  it('库里已有倒挂的定稿章时，ready 不返回 200（不允许成功即留下倒挂对）', async () => {
    const id = 'prod-attr-back-' + Date.now();
    const start = new Date();
    const back = new Date(start.getTime() - 3_600_000); // 定稿早于起稿 1 小时
    await db.insert(pmsBuiWenlvProducts).values({
      id, name: '倒挂脏数据剧本', generationStartedAt: start, contentReadyAt: back,
    }).onConflictDoNothing();
    try {
      const res = await adminWenlvRoute.request(`/products/${id}/delivery/ready`, { method: 'POST', headers: H });
      expect(res.status).toBe(409);
      const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id)).limit(1);
      expect(row.contentReadyAt!.getTime()).toBe(back.getTime()); // 未被覆盖成新值
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  // 不变量是对称的：ready 侧拦「无起稿就定稿」，start 侧也必须拦「已有定稿却无起稿」。
  // 半守的写法会把这条脏行「补」出一个晚于定稿的起稿章 —— 伪造了起稿时间，
  // 之后 ceilDays 把倒挂对兜成「1 天」，异常就被一个好看的数字吃掉了。
  // 与 ready 侧同口径：409 拒绝，不做 clamp。
  it('已有定稿章却无起稿章时 start 被拒 409，不伪造起稿时间', async () => {
    const [before] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, READY_ONLY)).limit(1);
    expect(before.contentReadyAt).toBeTruthy();
    expect(before.generationStartedAt).toBeNull();

    const res = await adminWenlvRoute.request(`/products/${READY_ONLY}/delivery/start`, { method: 'POST', headers: H });
    expect(res.status).toBe(409);

    const [after] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, READY_ONLY)).limit(1);
    expect(after.generationStartedAt).toBeNull(); // 未被补章
    // 关键组合：不得出现「请求成功 + 库里倒挂 + 度量报 1 天」。
    // 缺起稿章时度量必须 null，而不是 ceilDays 兜出的那个好看数字。
    expect(scriptDeliveryDays(after)).toBeNull();
  });

  // ---- Req2：交付阶段与 status 打架时以 status 为准 ----
  it('status=published 但 publishedAt 为空：交付阶段仍报 live（status 权威）', async () => {
    const res = await adminWenlvRoute.request(`/products/${LEGACY}/full`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('published');
    // 「裸推导会打架」必须拿库内行证明：HTTP JSON 会把 Date 序列化成 ISO 字符串，
    // 对响应体调 deriveDeliveryStage 只会因为 isValidDate(字符串)=false 而恒得 not_started，
    // 那样断言等于什么都没证明。
    const [row] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, LEGACY)).limit(1);
    expect(deriveDeliveryStage(row)).toBe('not_started'); // 章全空 → 未起稿，与 status 冲突
    // 路由必须让 status 赢：同一行不能并排出现「published」+「未起稿」
    expect(b.data.deliveryStage).toBe('live');
  });

  it('status≠published 却盖了 publishedAt：不越权报 live', async () => {
    await db.update(pmsBuiWenlvProducts)
      .set({ publishedAt: new Date(), contentReadyAt: new Date() })
      .where(eq(pmsBuiWenlvProducts.id, DIRTY));
    const res = await adminWenlvRoute.request(`/products/${DIRTY}/full`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.status).toBe('draft');
    const [row] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, DIRTY)).limit(1);
    expect(deriveDeliveryStage(row)).toBe('live'); // 裸推导越权
    expect(b.data.deliveryStage).toBe('ready');    // 降级到内容层，绝不报 live
  });

  afterAll(async () => {
    for (const id of [P, PREMATURE, LEGACY, DIRTY, READY_ONLY]) {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

// Gap 1：publish 用 `product.publishedAt ?? new Date()` —— 首次上架才盖章，
// 「下架→重上」不得刷新交付度量。把 `??` 去掉只留 `new Date()` 时，本条必须变红。
// 独立 fixture（自带 product/venue id），不复用上面 describe 的常量。
describe.skipIf(!process.env.RUN_DB)('wenlv publish 首次盖章语义', () => {
  const PUB = 'prod-pub-' + Date.now();
  const post = (path: string) => adminWenlvRoute.request(path, { method: 'POST', headers: H });

  beforeAll(async () => {
    const chId = `ch-${PUB}`;
    const roomId = `room-${PUB}`;
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, chId));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, roomId));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PUB));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PUB));
    // narrative 最小可发布骨架：1 scene + 1 ending（同上面 NARR 回归的构造）
    await db.insert(pmsBuiWenlvProducts).values({ id: PUB, name: '首次盖章测试', mode: 'narrative' });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: roomId, contentId: PUB, name: '盖章房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: chId, scriptRoomId: roomId, title: '第一章', order: 0 });
    await db.insert(pmsBuiWenlvScenes).values({
      id: `${PUB}-n1`, chapterId: chId, type: 'narrative', title: '场景',
      grants: [], puzzle: null, order: 1,
    });
    // 结局 = scenes type='ending'
    await db.insert(pmsBuiWenlvScenes).values({
      id: `${PUB}-e1`, chapterId: chId, type: 'ending', title: '结局', triggerCondition: { type: 'all', conditions: [] }, rewardId: null,
    });
  });

  it('下架后重上不刷新 publishedAt（??= 语义）', async () => {
    const r1 = await post(`/products/${PUB}/publish`);
    expect(r1.status).toBe(200);
    const first = (await r1.json()).data.publishedAt;
    expect(first).toBeTruthy();

    const off = await post(`/products/${PUB}/unpublish`);
    expect(off.status).toBe(200);

    const r2 = await post(`/products/${PUB}/publish`);
    expect(r2.status).toBe(200);
    const second = (await r2.json()).data.publishedAt;
    // JSON 里 Date 会序列化成 ISO 串，两端同为串，直接对拍。
    // 若 publish 改成无条件 `new Date()`，第二枚章会晚于第一枚 ⇒ 必红。
    expect(second).toBe(first);

    // 再落一次库对拍，防「响应恰好没刷新、库里却被刷新」这种偏差。
    const [row] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, PUB)).limit(1);
    expect(row.publishedAt!.getTime()).toBe(new Date(first).getTime());
    expect(row.publishedVersion).toBe(2); // 版本号照常自增，只有章不刷
  });

  afterAll(async () => {
    const chId = `ch-${PUB}`;
    const roomId = `room-${PUB}`;
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, chId));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, roomId));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PUB));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PUB));
  });
});

// Task 5 的欠账：`DELETE /points/:id` 的「被剧本节点引用则 409」守卫此前无测试
// （建夹具要连带建 product，Task 7 正好要造 node/product 夹具，顺手还掉）。
// 这条守卫是三层模型的**引用完整性**底线：点位是可被 8 个剧本共用的物理资源，
// 一旦节点还指着它就被删掉，游客到现场扫的就是一张指向空气的码。
describe.skipIf(!process.env.RUN_DB)('点位删除的地引用守卫', () => {
  const V = 'venue-del-' + Date.now();
  const PT = 'pt-del-' + Date.now();
  const P = 'prod-del-' + Date.now();
  const N = 'node-del-' + Date.now();
  const CH = `ch-${P}`;
  const ROOM = `room-${P}`;

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '删除守卫场地' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT, venueId: V, name: '被引用点位' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '删除守卫剧本', venueId: V }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM, contentId: P, name: '删除守卫房', mode: 'narrative' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({ id: CH, scriptRoomId: ROOM, title: '第一章', order: 0 }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScenes).values({
      id: N, chapterId: CH, type: 'narrative', title: '引用点位的场景', venuePointId: PT,
    }).onConflictDoNothing();
  });

  // 一条用例走完整条链，不做跨用例的顺序依赖（那种「必须按声明顺序跑」的测试是缺陷不是特性）。
  // 同一个 URL 先 409 后 200，正好证明**拦住它的是那条引用，而不是别的什么**。
  it('被场景引用的点位删除返回 409；删掉引用场景后可删成功', async () => {
    const blocked = await adminWenlvRoute.request(`/points/${PT}`, { method: 'DELETE', headers: H });
    expect(blocked.status).toBe(409);

    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));

    const ok = await adminWenlvRoute.request(`/points/${PT}`, { method: 'DELETE', headers: H });
    expect(ok.status).toBe(200);

    // 只断言 200 不够：一个「返回 200 但根本没删」的实现同样会绿。
    // 断言行真的消失，才把「成功」钉在状态之外。
    const rows = await db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    expect(rows.length).toBe(0);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

// Task 7：`venuePointId` 的空串归一。
// 对**节点的点位引用**而言，`''` 的语义就是「解绑」，归一为 NULL 是正确答法 ——
// 不绑点位的节点是合法态。（本用例直接送 `''`，不经编辑器：编辑器走 `__none__`→null，
// 而 `''` 是 Radix 与本仓素材侧表单至今仍在用的「未选中」形态 —— 注意那是**文化素材**字段
// （`culture-materials.tsx:155`），走另一组端点。归一守的是直连 API 的调用方。）
// ⚠️ 别拿 `productHeadSchema.venueId` 当先例：那个字段（剧本的归属）**是必填 + 拒绝空值**，
//    因为「无场地的剧本」不是合法态。两者刻意不同款，理由见 `admin/wenlv.ts` 里它的注释。
// 若不归一：
//   1) `''` 会落成一条**对所有读路径都不可见**的脏引用（既非 NULL 也非任何真实点位 id）；
//   2) PATCH 的守卫对 `''` 为真，会去查一个 id 为 `''` 的点位 → 400「点位不存在」，
//      把一次本该成功的解绑变成报错。
// 归一须同时覆盖 POST（nodeSchema 的 transform）与 PATCH（手写白名单，见路由内注释）。
describe.skipIf(!process.env.RUN_DB)('场景引用点位的空串归一', () => {
  const V = 'venue-np-' + Date.now();
  const PT = 'pt-np-' + Date.now();
  const P = 'prod-np-' + Date.now();
  const N = 'node-np-' + Date.now();
  const N2 = 'node-np2-' + Date.now();
  const CH = `ch-${P}`;
  const ROOM = `room-${P}`;

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等（id 带 Date.now 本不冲突，但残留行会污染计数类断言）
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '空串归一场地' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: PT, venueId: V, name: '合法点位', code: 'WLP-AAAABBBBCCCC',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '空串归一剧本', venueId: V }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM, contentId: P, name: '空串归一房', mode: 'narrative' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({ id: CH, scriptRoomId: ROOM, title: '第一章', order: 0 }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScenes).values({
      id: N, chapterId: CH, type: 'narrative', title: '待绑定场景',
    }).onConflictDoNothing();
  });

  // 一条用例走完整条链：先绑上（证明这条路本身是通的），再用空串解绑。
  // 若直接拿一个从未绑定的节点测空串，「没落脏值」也可能只是因为压根没写 —— 分不清。
  it("venuePointId='' 归一为 NULL（解绑），而不是落成脏串或 400", async () => {
    const bound = await adminWenlvRoute.request(`/scenes/${N}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ venuePointId: PT }),
    });
    expect(bound.status).toBe(200);

    // 绑上必须**真的落库**。只断言 200 的话，一个「静默忽略 venuePointId」的 PATCH
    // （白名单漏了这个键）也能让本条全绿 —— 后面的「解绑后是 null」本来就是它没写过，那是假绿。
    const [boundRow] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    expect(boundRow.venuePointId).toBe(PT);

    const cleared = await adminWenlvRoute.request(`/scenes/${N}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ venuePointId: '' }),
    });
    expect(cleared.status).toBe(200);

    // 断言落库的值，不是断言响应体 —— JSON 序列化会把 undefined 抹掉，
    // 让「没写进去」和「写成了 null」在响应体上看起来一模一样
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    expect(row.venuePointId).toBe(null);
  });

  // 纯空白是空串的孪生形态（表单 trim 前后），必须同归一。
  // 必须覆盖 POST 而不是只覆盖 PATCH：POST 的 `body.id` 若缺省由服务端生成 randomUUID，
  // 「建完再按 productId+title 查回」只能拿到一个含糊的行；这里显式自带 id，
  // 断言才打在**本次请求真的写进去的那一行**上（否则是一条永远绿的假测试）。
  // 归一未做时 `'   '` 是真值 ⇒ 守卫去查 id 为 `'   '` 的点位 ⇒ 400，本条必红。
  it("POST 场景 venuePointId='   '（纯空白）同样归一为 NULL，而非 400「点位不存在」", async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '纯空白场景', venuePointId: '   ' }),
    });
    expect(res.status).toBe(200);
    const createdId = (await res.json()).data.scene.id;
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, createdId));
    expect(row.venuePointId).toBe(null);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

// ===== 节点背景图 / 旁白音频的 create+patch 通路（T16）=====
// 创作台的「应用精修」是**删光再重建**：先硬删全部节点，再按 AI 精修结果逐个 POST /nodes。
// image / narrationUrl 是 S3 资产流水线（asset-gen 的 writeback）回写的两列，AI 的语义输出里
// 没有它们，靠前端 refine-mapping.mapNode 从旧资源回填后随 body 一起送来。
//
// ⚠️ 本用例断言的是**落库的行**，不是响应回显：只断言响应的话，一个「schema 收了但 insert 没写」
// 的实现照样全绿。这里要钉的恰恰是「列真的被写进去了」。
// ⚠️ 正是因此，这条用例钉住了 web 侧测试**看不见**的那一层：refine-mapping.test.ts 只加载纯
// 映射函数（裸 node --test，strip-types 不转 JSX），而 zod 的 strip 发生在服务端 ——
// 把 nodeSchema 里的 image 键删掉，web 侧那 208 条照样全绿，只有这里会红。
describe.skipIf(!process.env.RUN_DB)('场景背景图与旁白音频的 create/patch 通路（T16）', () => {
  const P = 'prod-na-' + Date.now();
  const CH = `ch-${P}`;
  const ROOM = `room-${P}`;
  const N = 'node-na-' + Date.now();
  const N2 = 'node-na2-' + Date.now();
  const IMG = 'https://oss.example/t16-node.png';
  const NARR = 'https://oss.example/t16-node.mp3';

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '场景资产列剧本' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM, contentId: P, name: '资产列房', mode: 'narrative' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({ id: CH, scriptRoomId: ROOM, title: '第一章', order: 0 }).onConflictDoNothing();
  });

  // 判别力核心：删掉 scenePatchSchema 的 image 键 ⇒ zod strip 掉 body.image ⇒ insert 写 null ⇒ 必红。
  it('POST /chapters/:id/scenes 带 image/narrationUrl ⇒ 真的落到 DB 行上（不是被 zod strip 丢掉）', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: N, title: '有图有旁白的场景', image: IMG, narrationUrl: NARR }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    expect(row.image).toBe(IMG);
    expect(row.narrationUrl).toBe(NARR);
  });

  // 负例（契约文档）：AI 没产出这两列的场景必须落 SQL NULL，不能落成空串脏值
  it('不传这两列时落 SQL NULL（不是空串脏值，也不报错）', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: N2, title: '无图无旁白的场景' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N2));
    expect(row.image).toBe(null);
    expect(row.narrationUrl).toBe(null);
  });

  // PATCH 的白名单是手写的、**不经过 sceneCreateSchema**，漏键在本端点没有任何报错（静默丢弃）。
  it('PATCH /scenes/:id 能改这两列（白名单成对，否则重建后用户再也编辑不动）', async () => {
    const res = await adminWenlvRoute.request(`/scenes/${N}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ image: IMG + '.v2', narrationUrl: NARR + '.v2' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    expect(row.image).toBe(IMG + '.v2');
    expect(row.narrationUrl).toBe(NARR + '.v2');
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});

// ===== 奖励配图（rewards.image）的 create+patch 通路（T17）=====
// 与上面 T16 同族：`rewards.image` 是 S3 素材生成回写（asset-gen 的 `case 'reward'`）的**目标列**
// （列宽 varchar(500)，见 db/schema/wenlv.ts 的 pmsBuiWenlvRewards），AI 的语义输出里没有它。
// 但这条「删光重建」通路此前三处都缺 —— 前端 refine-mapping.mapReward 不回填、POST 的 insert
// 不收、PATCH 的白名单没有 'image' ⇒ 用户花钱生成的奖励配图，点一次「应用精修」就被静默清空。
//
// ⚠️ 与 T16 的点位/线索/结局不同，本端点**没有 zod schema**（直接读 `body.*`）：漏一列不会有
//    第二道闸兜底，「静默」是字面意义上的静默。故这里断言的是**落库的行**（db.select 回读），
//    不是响应回显 —— 只断言响应的话，「收了但没写进去」的实现照样全绿。
describe.skipIf(!process.env.RUN_DB)('奖励配图的 create/patch 通路（T17）', () => {
  const P = 'prod-rw-' + Date.now();
  const R = 'reward-rw-' + Date.now();
  const R2 = 'reward-rw2-' + Date.now();
  const IMG = 'https://oss.example/t17-reward.png';

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等
    await db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '奖励配图列剧本' }).onConflictDoNothing();
  });

  // 判别力核心：删掉 insert 里的 `image: body.image ?? null` ⇒ 落库行的 image 为 null ⇒ 必红。
  it('POST /products/:id/rewards 带 image ⇒ 真的落到 DB 行上', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/rewards`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: R, name: '带配图的奖励', image: IMG }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, R));
    expect(row.image).toBe(IMG);
  });

  // 负例（**契约文档型**，不是核心闸）：不传 image ⇒ 落 SQL NULL，而不是空串脏值
  // （本仓有「zod 空串脏引用」的前科：`''` 在读路径上不可见）。
  // ⚠️ 它对 `image: body.image`（省掉 `?? null`）**没有判别力** —— drizzle 把 `undefined`
  //    当"省略该键"，列默认仍是 NULL，本条照样绿。它拦的是 `?? ''` / `?? ' '` 这类写法。
  it('不传 image 时落 SQL NULL（不是空串脏值，也不报错）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/rewards`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: R2, name: '无配图的奖励' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, R2));
    expect(row.image).toBe(null);
  });

  // PATCH 的白名单是**手写的、不经过任何 schema**，漏键在本端点没有任何报错（静默丢弃）。
  // 只测 POST 的话，「create 收而 patch 不收」这条不对称会被整段漏掉 ——
  // 而它正是「重建后用户再也编辑不动这一列」的原因。
  it('PATCH /rewards/:id 能改 image（白名单与 POST 成对）', async () => {
    const res = await adminWenlvRoute.request(`/rewards/${R}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ image: IMG + '.v2' }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, R));
    expect(row.image).toBe(IMG + '.v2');
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});

// 写入时的场地归属守卫（POST/PATCH nodes）。
// publish 的完整性校验是**事后**兜底；这两条守卫是**写时**拦截，防的是
// 「A 场地的剧本引用 B 场地的点位」——那种引用在 publish 时才发现，编剧已经白等一轮。
// 上面「空串归一」用例只覆盖了守卫的放行侧（合法点位 200），拒绝侧此前无测试：
// 把守卫整段删掉，只有本 describe 会红。
describe.skipIf(!process.env.RUN_DB)('场景引用点位的写入时场地归属守卫', () => {
  const VA = 'venue-wg-a-' + Date.now();
  const VB = 'venue-wg-b-' + Date.now();  // 异场地
  const PA = 'pt-wg-a-' + Date.now();
  const PB = 'pt-wg-b-' + Date.now();
  const P = 'prod-wg-' + Date.now();
  const N = 'node-wg-' + Date.now();
  const CH = `ch-${P}`;
  const ROOM = `room-${P}`;
  // 未归属场地的剧本 + 它的场景：`!product.venueId` 分支此前没有任何用例覆盖，
  // 「删掉那个分支」能 70/70 全绿。这条剧本就是专为咬住那个分支而造。
  const PN = 'prod-wg-nov-' + Date.now();
  const NN = 'node-wg-nov-' + Date.now();
  const CH_N = `ch-${PN}`;
  const ROOM_N = `room-${PN}`;

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH_N));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VA));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VB));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_N));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PN));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PN));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VA));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VB));
    await db.insert(pmsBuiWenlvVenues).values([{ id: VA, name: '守卫场地A' }, { id: VB, name: '别家场地B' }]);
    await db.insert(pmsBuiWenlvVenuePoints).values([
      { id: PA, venueId: VA, name: '本场地点位', code: 'WLP-WGAABBBBCCCC' },
      { id: PB, venueId: VB, name: '别家点位', code: 'WLP-WGBBBBBBCCCC' },
    ]);
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '守卫剧本', venueId: VA });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM, contentId: P, name: '守卫房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: CH, scriptRoomId: ROOM, title: '第一章', order: 0 });
    // 刻意不传 venueId（= SQL NULL）。下面的用例会拿它去引用一个**合法存在**的点位，
    // 逼「未归属场地」这条分支在点位存在时也必须命中（先查点位就会漏掉它）。
    await db.insert(pmsBuiWenlvProducts).values({ id: PN, name: '未归属场地剧本' });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM_N, contentId: PN, name: '未归属场地房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: CH_N, scriptRoomId: ROOM_N, title: '第一章', order: 0 });
    // PATCH 侧要有一条**已存在**的场景可改（PATCH 会先按 scene 反查产品场地）。
    await db.insert(pmsBuiWenlvScenes).values({ id: NN, chapterId: CH_N, type: 'narrative', title: '未归属场地场景' });
  });

  it('POST 引用不存在的点位 400「点位不存在」', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '幽灵点位场景', venuePointId: 'no-such-point' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('点位不存在');
  });

  it('POST 引用异场地（B）的点位 400「不属于本产品的场地」', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '跨场地场景', venuePointId: PB }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('点位不属于本产品的场地');
  });

  it('POST 引用本场地（A）的点位 200 且落库', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: N, title: '本场地场景', venuePointId: PA }),
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    expect(row.venuePointId).toBe(PA);
  });

  // PATCH 侧守卫的越权面与 POST 不同：它要先按 scene 反查产品场地，
  // 「查错产品」或「忘了查场地」都会把上面那条 200 变成这里的一条误放行。
  it('PATCH 改绑到异场地（B）的点位 400，且原绑定不被改动', async () => {
    const res = await adminWenlvRoute.request(`/scenes/${N}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ venuePointId: PB }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('点位不属于本产品的场地');
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    expect(row.venuePointId).toBe(PA); // 拒绝必须是原子的：不能先改再报错
  });

  // ===== 未归属场地（`!product.venueId`）分支 =====
  it('POST 未归属场地的剧本引用合法点位 → 400「未归属场地」', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH_N}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '未归属场地合法点位场景', venuePointId: PA }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('产品未归属场地，不能引用点位');
  });

  it('POST 未归属场地 + 幽灵点位 → 报「未归属场地」而非误导性的「不存在」', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH_N}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '未归属场地幽灵点位场景', venuePointId: 'no-such-point' }),
    });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('未归属场地');
    expect(error).not.toContain('不存在');
  });

  it('PATCH 未归属场地 + 幽灵点位 → 报「未归属场地」而非「不存在」，且原绑定不变', async () => {
    const res = await adminWenlvRoute.request(`/scenes/${NN}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ venuePointId: 'no-such-point' }),
    });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain('未归属场地');
    expect(error).not.toContain('不存在');
    const [row] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, NN));
    expect(row.venuePointId).toBe(null);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH_N));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VA));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VB));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_N));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PN));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PN));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VA));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VB));
  });
});

// Gap 2：GET /products?venueId= 的三态里，「具体值」这条 eq 分支此前无测试
// （只有空串 isNull 那条被覆盖）。这里补第三态：归属本场地者进、异场地/未归属者出。
describe.skipIf(!process.env.RUN_DB)('wenlv 产品按 venueId 具体值过滤', () => {
  const VA = 'venue-filter-a-' + Date.now();
  const VB = 'venue-filter-b-' + Date.now();
  const PA = 'prod-filter-a-' + Date.now(); // 归属 VA
  const PB = 'prod-filter-b-' + Date.now(); // 归属 VB（异场地）
  const PN = 'prod-filter-n-' + Date.now(); // 未归属

  beforeAll(async () => {
    for (const id of [PA, PB, PN]) await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    for (const id of [VA, VB]) await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
    await db.insert(pmsBuiWenlvVenues).values([{ id: VA, name: '过滤场地A' }, { id: VB, name: '过滤场地B' }]);
    await db.insert(pmsBuiWenlvProducts).values([
      { id: PA, name: '归属A剧本', venueId: VA },
      { id: PB, name: '归属B剧本', venueId: VB },
      { id: PN, name: '未归属剧本', venueId: null },
    ]);
  });

  it('venueId=<具体值> 只回该场地的产品，异场地/未归属都被排掉', async () => {
    const res = await adminWenlvRoute.request(`/products?venueId=${VA}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    const ids = (b.data.list as any[]).map((p: any) => p.id);
    expect(ids).toContain(PA);
    // 这两条是本条的要害：退化成 isNull（空串分支）或不过滤时，二者至少一条会进列表 ⇒ 必红
    expect(ids).not.toContain(PB);
    expect(ids).not.toContain(PN);
    expect((b.data.list as any[]).every((p: any) => p.venueId === VA)).toBe(true);
  });

  // 三态里的第三态：**不传参数**。上面两条分别覆盖了空串（isNull）与具体值（eq），
  // 但「省略 venueId」只是被间接带过。若有人把缺省也误当成 isNull，归属场地的行会凭空消失。
  it('不传 venueId 时不过滤：归属者与未归属者都在全量列表里', async () => {
    const res = await adminWenlvRoute.request('/products', { headers: H });
    expect(res.status).toBe(200);
    const ids = ((await res.json()).data.list as any[]).map((p: any) => p.id);
    expect(ids).toContain(PA);
    expect(ids).toContain(PB);
    expect(ids).toContain(PN);
  });

  afterAll(async () => {
    for (const id of [PA, PB, PN]) await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    for (const id of [VA, VB]) await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
  });
});

// Gap 4（S1 §5.3）：首剧本交付度量（含场地建设）此前**无任何生产调用方** ——
// `firstScriptDeliveryDays` 只有它自己的纯函数单测，`GET /venues` / `GET /venues/:id`
// 一律只发 `scriptDeliveryDays`（纯内容口径），于是「3 天出首剧本」这个招牌数字
// 在运行时根本读不到：列表页没有它的列，详情页每行给的都是另一个数。
// 本 describe 钉住三件事：值算得对、没有首剧本时为 null、缺章时为 null（**不是 0**）。
describe.skipIf(!process.env.RUN_DB)('wenlv 首剧本交付度量（含场地建设）', () => {
  const U = Date.now();
  const V_OK = `venue-fs-ok-${U}`;         // 完整首剧本
  const V_NONE = `venue-fs-none-${U}`;     // 一个剧本都没有
  const V_NO_TS = `venue-fs-nots-${U}`;    // 有已定稿剧本，但场地缺采风章
  const V_NO_READY = `venue-fs-noready-${U}`;// 有剧本，但一个都没定稿
  const P_FIRST = `prod-fs-first-${U}`;
  const P_LATER = `prod-fs-later-${U}`;
  const P_NOTS = `prod-fs-nots-${U}`;
  const P_RAW = `prod-fs-raw-${U}`;
  const T = (s: string) => new Date(s);

  const get = (path: string) => adminWenlvRoute.request(path, { headers: H });

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等
    for (const id of [P_FIRST, P_LATER, P_NOTS, P_RAW]) {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
    for (const id of [V_OK, V_NONE, V_NO_TS, V_NO_READY]) {
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
    }
    await db.insert(pmsBuiWenlvVenues).values([
      // 采风 9/10 开始、9/11 铺完码 ⇒ 首剧本（两剧本里 9/13 先定稿的那个）
      // = max(9/11, 9/13) − 9/10 = 3 天
      { id: V_OK, name: '首剧本完整场地', surveyStartedAt: T('2026-09-10T00:00:00Z'), deployedAt: T('2026-09-11T00:00:00Z') },
      { id: V_NONE, name: '无剧本场地', surveyStartedAt: T('2026-09-10T00:00:00Z'), deployedAt: T('2026-09-11T00:00:00Z') },
      // 刻意留空两个场地章：度量**算不出来**，只能是 null
      { id: V_NO_TS, name: '缺采风章场地', surveyStartedAt: null, deployedAt: null },
      { id: V_NO_READY, name: '剧本未定稿场地', surveyStartedAt: T('2026-09-10T00:00:00Z'), deployedAt: null },
    ]);
    await db.insert(pmsBuiWenlvProducts).values([
      // ⚠️ createdAt 与 contentReadyAt **人为倒挂**：P_LATER 先建（9/1）却后定稿（9/20），
      // P_FIRST 后建（9/2）却先定稿（9/13）。按 createdAt 选首剧本 ⇒ 得 10 天；按 §5.3
      // 的交付语义（最先定稿）选 ⇒ 得 3 天。这条倒挂就是「选错判据必红」的哨兵。
      { id: P_LATER, name: '后定稿剧本', venueId: V_OK, generationStartedAt: T('2026-09-19T00:00:00Z'), contentReadyAt: T('2026-09-20T00:00:00Z'), createdAt: T('2026-09-01T00:00:00Z') },
      { id: P_FIRST, name: '先定稿剧本', venueId: V_OK, generationStartedAt: T('2026-09-12T00:00:00Z'), contentReadyAt: T('2026-09-13T00:00:00Z'), createdAt: T('2026-09-02T00:00:00Z') },
      // 已定稿，但场地没盖章 ⇒ 唯一导致 null 的原因是场地缺时间戳（不是「没剧本」）
      { id: P_NOTS, name: '缺章场地的已定稿剧本', venueId: V_NO_TS, contentReadyAt: T('2026-09-13T00:00:00Z') },
      // 起稿未定稿 ⇒ 没有首剧本
      { id: P_RAW, name: '未定稿剧本', venueId: V_NO_READY, generationStartedAt: T('2026-09-12T00:00:00Z') },
    ]);
  });

  it('列表：首剧本按「最先定稿」选，值 = max(部署, 定稿) − 采风开始 = 3 天', async () => {
    const res = await get('/venues');
    expect(res.status).toBe(200);
    const rows = (await res.json()).data.list as any[];
    const ok = rows.find((r) => r.id === V_OK);
    expect(ok).toBeTruthy();
    expect(ok.scriptCount).toBe(2);
    // 按 createdAt 选会得到 P_LATER 的 10 天 ⇒ 这条同时咬住「判据选错」
    expect(ok.firstScriptDeliveryDays).toBe(3);
  });

  it('详情：首剧本口径只落在首剧本行，另一行为 null；纯内容口径不被替代', async () => {
    const res = await get(`/venues/${V_OK}`);
    expect(res.status).toBe(200);
    const scripts = (await res.json()).data.scripts as any[];
    const first = scripts.find((s) => s.id === P_FIRST);
    const later = scripts.find((s) => s.id === P_LATER);
    expect(first).toBeTruthy();
    expect(later).toBeTruthy();
    // 两个口径是**两个不同的数**，且必须并存：删掉任一个字段，这里必红。
    expect(first.deliveryDays).toBe(1);            // 纯内容：9/12 起稿 → 9/13 定稿
    expect(first.firstScriptDeliveryDays).toBe(3); // 含建设：9/10 采风 → max(9/11, 9/13)
    // 非首剧本行不给「首剧本时长」——场地建设只摊一次，重复数字会让界面读不出哪行是首剧本
    expect(later.firstScriptDeliveryDays).toBeNull();
    expect(later.deliveryDays).toBe(1);            // 纯内容口径照常对每一行都在
  });

  it('场地一个剧本都没有：列表值为 null（不是 0）', async () => {
    const rows = ((await (await get('/venues')).json()).data.list as any[]);
    const none = rows.find((r) => r.id === V_NONE);
    expect(none.scriptCount).toBe(0);
    // 0 会被读成「当天就交付了」——一个彻头彻尾的假数字
    expect(none.firstScriptDeliveryDays).toBeNull();
  });

  it('场地缺采风章（但剧本已定稿）：列表与详情均为 null，而不是 0', async () => {
    const rows = ((await (await get('/venues')).json()).data.list as any[]);
    const nots = rows.find((r) => r.id === V_NO_TS);
    // 先证明「这条行确实有已定稿的剧本」——否则下面那个 null 可能只是因为没剧本，是假绿
    expect(nots.scriptCount).toBe(1);
    expect(nots.firstScriptDeliveryDays).toBeNull();

    const detail = (await (await get(`/venues/${V_NO_TS}`)).json()).data;
    expect(detail.scripts.length).toBe(1);
    expect(detail.scripts[0].contentReadyAt).toBeTruthy();
    expect(detail.scripts[0].firstScriptDeliveryDays).toBeNull();
  });

  it('剧本都没定稿：没有首剧本 ⇒ 列表值为 null', async () => {
    const rows = ((await (await get('/venues')).json()).data.list as any[]);
    const nr = rows.find((r) => r.id === V_NO_READY);
    expect(nr.scriptCount).toBe(1);
    // 起稿未定稿 ⇒ 交付尚未发生，还没有「首剧本」可量
    expect(nr.firstScriptDeliveryDays).toBeNull();
  });

  afterAll(async () => {
    for (const id of [P_FIRST, P_LATER, P_NOTS, P_RAW]) {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
    for (const id of [V_OK, V_NONE, V_NO_TS, V_NO_READY]) {
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
    }
  });
});

// Gap 3：`GET /venues/:id` 的 scripts[].deliveryStage（wenlv.ts 的 venue 侧调用点）。
// 上面两条优先级用例都只打 `/products/:id/full`，把这个调用点换回裸 deriveDeliveryStage
// 不会有任何用例变红 —— 而场地详情页正是「status 与交付阶段并排渲染」的另一个真实界面。
describe.skipIf(!process.env.RUN_DB)('wenlv 场地详情的剧本交付阶段', () => {
  const V = 'venue-stage-' + Date.now();
  const P = 'prod-stage-' + Date.now();

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '阶段测试场地' });
    // 存量行：status='published' 但三章全空（本 Task 之前 publish 从不盖 publishedAt）
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '存量已发布剧本', status: 'published', venueId: V });
  });

  it('无章的存量 published 行在 scripts[0] 仍报 live（status 权威），不是裸推导的 not_started', async () => {
    const [row] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(deriveDeliveryStage(row)).toBe('not_started'); // 裸推导：章全空 → 未起稿，与 status 冲突

    const res = await adminWenlvRoute.request(`/venues/${V}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.scripts.length).toBe(1);
    expect(b.data.scripts[0].id).toBe(P);
    expect(b.data.scripts[0].status).toBe('published');
    expect(b.data.scripts[0].deliveryStage).toBe('live'); // 拨回裸 deriveDeliveryStage ⇒ 得 not_started，必红
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

// 短码约束：长度 ≤64、字符集 [A-Za-z0-9_-]、空串归一为 null。上限由 beacon UUID 决定（见 wenlv-venue.ts）。
// 拒绝类用例断言状态码（400 在 insert 之前返回，不会落库）；
// 落库类用例断言**库行**——响应回显恰好正确而库里是脏值，是本项目栽过的坑。
describe.skipIf(!process.env.RUN_DB)('wenlv 点位短码约束', () => {
  const VENUE = 'venue-code-' + Date.now();
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '短码校验场地' }).onConflictDoNothing();
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VENUE));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  async function createPoint(code: unknown) {
    return adminWenlvRoute.request(`/venues/${VENUE}/points`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '短码点位', ...(code === undefined ? {} : { code }) }),
    });
  }

  // 上限 64 由 beacon UUID（36 位）决定，见 wenlv-venue.ts 的 POINT_CODE_MAX_LENGTH 注释。
  it('超过 64 位的短码被拒（400）', async () => {
    const res = await createPoint('WLP-' + 'A'.repeat(70));
    expect(res.status).toBe(400);
  });

  it('含非法字符的短码被拒（400）', async () => {
    const res = await createPoint('LMD 03/甲');
    expect(res.status).toBe(400);
  });

  it('合法短码 LMD-03 原样落库', async () => {
    const res = await createPoint('LMD-03');
    expect(res.status).toBe(200);
    const id = (await res.json()).data.id;
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
    expect(row.code).toBe('LMD-03');
  });

  it('空串归一为 null，不是空串入库', async () => {
    const res = await createPoint('');
    expect(res.status).toBe(200);
    const id = (await res.json()).data.id;
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
    expect(row.code).toBeNull();
  });

  it('不传 code 仍由服务端生成 WLP- 码（生成器行为不变）', async () => {
    const res = await createPoint(undefined);
    expect(res.status).toBe(200);
    const id = (await res.json()).data.id;
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
    expect(row.code).toMatch(/^WLP-[0-9A-HJKMNP-TV-Z]{12}$/);
  });

  it('beacon 点位可存 36 位 iBeacon UUID（上限由硬件 ID 决定，不是印刷短码）', async () => {
    const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const res = await adminWenlvRoute.request(`/venues/${VENUE}/points`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: '山门信标', triggerType: 'beacon', code: UUID }),
    });
    expect(res.status).toBe(200);
    const id = (await res.json()).data.id;
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, id)).limit(1);
    expect(row.code).toBe(UUID);
  });
});

// 依赖：迁移 0038（design_assets.target_kind / target_id）
// 语义：删要素 ⇒ 它的素材**不删**，只把 `target_*` 两列置 NULL（决策 2：解绑不删）。
// 为什么要素侧要主动做这件事：不做的话 `target_id` 会**当场**指向一个不存在的行，
// 全景页把这种行算作孤儿 ⇒ 每删一个要素就凭空多一条脏数据。
describe.skipIf(!process.env.RUN_DB)('删要素时解绑其素材坐标（不删素材行）', () => {
  const TAG = 'unbind-' + Date.now();
  const PROD = TAG + '-p';
  const CH = `ch-${PROD}`;
  const ROOM = `room-${PROD}`;
  const H_URL = 'https://oss.test/unbind.png';

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '解绑夹具剧本' });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM, contentId: PROD, name: '解绑房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: CH, scriptRoomId: ROOM, title: '第一章', order: 0 });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.productId, PROD));
    await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PROD));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PROD));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
  });

  it('删图鉴条目后：素材行还在、target 两列置 NULL，且**只解绑这一条**', async () => {
    const COLL = TAG + '-c';
    const ASSET = 'ma-' + TAG + '-c';               // 真正被删要素所绑的那条
    const DECOY_ID = 'ma-' + TAG + '-decoy-id';     // 同 kind、**别的** targetId
    const DECOY_KIND = 'ma-' + TAG + '-decoy-kind'; // 同 targetId、**别的** kind
    await db.insert(pmsBuiWenlvCollectibles).values({ id: COLL, productId: PROD, name: '线索' });
    await db.insert(pmsBuiWenlvDesignAssets).values([
      {
        id: ASSET, type: 'collectible', name: '线索图', url: H_URL,
        productId: PROD, targetKind: 'collectible', targetId: COLL,
      },
      // 🔴 两条**诱饵**，必须**绑着**，且下面断言它们**没**被解绑。
      //    只留 ASSET 一条的话，解绑语句的 WHERE 掉**任一**条件本用例都照样绿
      //    （本仓前科：单实例夹具让 AND 的每个条件都零判别力）。
      //    DECOY_ID 钉住 `targetId` 条件；DECOY_KIND 钉住 `targetKind` 条件 ——
      //    掉了后者会**跨全库**解绑所有 collectible 类素材，正是最该被抓的那种错。
      {
        id: DECOY_ID, type: 'collectible', name: '诱饵A', url: H_URL,
        productId: PROD, targetKind: 'collectible', targetId: COLL + '-other',
      },
      {
        id: DECOY_KIND, type: 'collectible', name: '诱饵B', url: H_URL,
        productId: PROD, targetKind: 'node', targetId: COLL,
      },
    ]);

    const r = await adminWenlvRoute.request('/collectibles/' + COLL, { method: 'DELETE', headers: H });
    expect(r.status).toBe(200);

    const rows = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.productId, PROD));
    const byId = new Map(rows.map((x) => [x.id, x]));

    const a = byId.get(ASSET);
    expect(a).toBeTruthy();                 // **不删素材行**
    expect(a!.targetKind).toBeNull();       // 但解绑
    expect(a!.targetId).toBeNull();
    expect(a!.url).toBe(H_URL);             // url 保留，仍可复用
    // 诱饵原样不动 —— 这两条才是 WHERE 两个条件的真正判据
    expect(byId.get(DECOY_ID)!.targetKind).toBe('collectible');
    expect(byId.get(DECOY_ID)!.targetId).toBe(COLL + '-other');
    expect(byId.get(DECOY_KIND)!.targetKind).toBe('node');
    expect(byId.get(DECOY_KIND)!.targetId).toBe(COLL);
  });

  it('删不存在的要素 → 404，且解绑不得发生在 404 早返回之前', async () => {
    // 🔴 夹具的素材必须**绑在「那个不存在的 id」上**，才测得出「解绑在 404 之后」。
    //    绑在别的 id 上的话，解绑写没写在 404 之前，这条素材都不会被动 ⇒ 恒真
    //    （第一版就是这么写的，是假绿；终态观测量对无操作恒真是本仓前科）。
    const GHOST = 'no-such-' + TAG;
    const ASSET = 'ma-' + TAG + '-orphan';
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: ASSET, type: 'collectible', name: '孤儿图',
      productId: PROD, targetKind: 'collectible', targetId: GHOST,
    });

    const r = await adminWenlvRoute.request('/collectibles/' + GHOST, { method: 'DELETE', headers: H });
    expect(r.status).toBe(404);

    const [asset] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, ASSET)).limit(1);
    expect(asset.targetKind).toBe('collectible');   // 仍绑着 ⇒ 解绑确实在 404 早返回**之后**
    expect(asset.targetId).toBe(GHOST);
  });

  it('删场景同样解绑 —— 第二个调用点（防「五个端点只改了三个」）', async () => {
    // 这条与上条**故意重复解绑本身的动作**：本仓前科是「加一处、漏其余」，
    // 而 helper 共享 ⇒ 只测一个端点无法证明另外四个真的调了它。
    // 这里挑 `/scenes`（新表，kind 字符串仍为 'node' 因 writeback entity kind 未改）作为第二个调用点的证据。
    const NODE = TAG + '-n';
    const ASSET = 'ma-' + TAG + '-n';
    await db.insert(pmsBuiWenlvScenes).values({ id: NODE, chapterId: CH, type: 'narrative', title: '场景' });
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: ASSET, type: 'background', name: '场景图',
      productId: PROD, targetKind: 'node', targetId: NODE,
    });

    const r = await adminWenlvRoute.request('/scenes/' + NODE, { method: 'DELETE', headers: H });
    expect(r.status).toBe(200);

    const [asset] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, ASSET)).limit(1);
    expect(asset.targetKind).toBeNull();
    expect(asset.targetId).toBeNull();
  });
});

// ===== 内容产品软删除（DELETE /products/:id → status='deleted'）=====
// 这是本轮新增的功能，本文件是它**唯一**的回归面。
//
// 用例之间的**顺序是承重的**（本 describe 内 `it` 按声明序执行）：
// 「列表不含 / 详情 404 / 场地仍被诱饵阻塞」三条都建立在「P_DEL 已被软删」之上，
// 故软删那一条必须排在最前。改动顺序前请先重读这一段。
describe.skipIf(!process.env.RUN_DB)('wenlv 内容产品软删除', () => {
  const TAG = 'softdel-' + Date.now();
  const V_BOTH = TAG + '-v1';       // 场地A：一条已软删剧本 + 一条**活**剧本（诱饵）
  const V_ONLY = TAG + '-v2';       // 场地B：只有一条待软删剧本
  const P_DEL = TAG + '-p-del';     // 要软删的（带子资源）
  const P_DECOY = TAG + '-p-decoy'; // 诱饵：**没**被软删 ⇒ 钉住场地A 的 409 与各条阳性对照
  const P_ONLY = TAG + '-p-only';   // 场地B 的那一条
  const P_PUB = TAG + '-p-pub';     // 已发布 ⇒ 删不动
  const N1 = TAG + '-n1';
  const C1 = TAG + '-c1';
  const CH_DEL = `ch-${P_DEL}`;
  const ROOM_DEL = `room-${P_DEL}`;
  const CH_DECOY = `ch-${P_DECOY}`;
  const ROOM_DECOY = `room-${P_DECOY}`;
  const PRODUCT_IDS = [P_DEL, P_DECOY, P_ONLY, P_PUB];

  const del = (p: string) => adminWenlvRoute.request(p, { method: 'DELETE', headers: H });
  const get = (p: string) => adminWenlvRoute.request(p, { headers: H });

  beforeAll(async () => {
    // 先子后父清残留，保证跑崩后重跑幂等
    for (const id of PRODUCT_IDS) {
      const chId = `ch-${id}`;
      const roomId = `room-${id}`;
      await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, chId));
      await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, id));
      await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, roomId));
      await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, id));
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
    for (const id of [V_BOTH, V_ONLY]) await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));

    await db.insert(pmsBuiWenlvVenues).values([
      { id: V_BOTH, name: '软删夹具场地A' },
      { id: V_ONLY, name: '软删夹具场地B' },
    ]);
    await db.insert(pmsBuiWenlvProducts).values([
      { id: P_DEL, name: '待软删剧本', venueId: V_BOTH },
      // 诱饵**不软删**：没有它，「场地A 仍 409」与「列表里还有别的产品」两条阳性对照都无从谈起
      { id: P_DECOY, name: '诱饵剧本', venueId: V_BOTH },
      { id: P_ONLY, name: '场地B唯一剧本', venueId: V_ONLY },
      { id: P_PUB, name: '已发布剧本', status: 'published' },
    ]);
    await db.insert(pmsBuiWenlvScriptRooms).values([
      { id: ROOM_DEL, contentId: P_DEL, name: '待软删房', mode: 'narrative' },
      { id: ROOM_DECOY, contentId: P_DECOY, name: '诱饵房', mode: 'narrative' },
    ]);
    await db.insert(pmsBuiWenlvChapters).values([
      { id: CH_DEL, scriptRoomId: ROOM_DEL, title: '第一章', order: 0 },
      { id: CH_DECOY, scriptRoomId: ROOM_DECOY, title: '第一章', order: 0 },
    ]);
    // 子资源**各恰好 1 行**：软删后断言它们「仍是 1」才有意义（0 行夹具会让断言恒真）
    await db.insert(pmsBuiWenlvScenes).values({ id: N1, chapterId: CH_DEL, type: 'narrative', title: '软删夹具场景' });
    await db.insert(pmsBuiWenlvCollectibles).values({ id: C1, productId: P_DEL, name: '软删夹具线索' });
  });

  afterAll(async () => {
    for (const id of PRODUCT_IDS) {
      const chId = `ch-${id}`;
      const roomId = `room-${id}`;
      await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, chId));
      await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, id));
      await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, roomId));
      await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, id));
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
    for (const id of [V_BOTH, V_ONLY]) await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id));
  });

  it('① DELETE /products/:id → 200，status 落成 deleted（行仍在 —— 不是物理删）', async () => {
    const res = await del(`/products/${P_DEL}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('deleted');

    const rows = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P_DEL));
    // 承重：物理删的实现会让这两条红
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('deleted');
  });

  it('② 软删后子资源一行未删（scenes/collectibles 仍是 1）', async () => {
    // 夹具各插了**恰好 1 行** ⇒ 「级联删掉子表」的实现会在这里变成 0 行
    const scenes = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH_DEL));
    const cols = await db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, P_DEL));
    expect(scenes).toHaveLength(1);
    expect(cols).toHaveLength(1);
  });

  it('③ 已发布的产品拒绝删除：409，且 status 仍是 published', async () => {
    const res = await del(`/products/${P_PUB}`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('已发布');
    // 只断 409 不够：「先改成 deleted 再回 409」的实现同样绿 —— 库里那行必须还活着
    const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P_PUB));
    expect(row.status).toBe('published');
  });

  it('④ 列表默认不含已软删；显式 ?status=deleted 仍查得到', async () => {
    const all = await (await get('/products')).json();
    expect(all.data.list.some((r: any) => r.id === P_DEL)).toBe(false);
    // 阳性对照：诱饵必须**在** —— 否则「不含」可能只是列表整个空了
    expect(all.data.list.some((r: any) => r.id === P_DECOY)).toBe(true);

    const onlyDel = await (await get('/products?status=deleted')).json();
    expect(onlyDel.data.list.some((r: any) => r.id === P_DEL)).toBe(true);
    // 反向：显式筛 deleted 时不得混进未软删的行
    expect(onlyDel.data.list.some((r: any) => r.id === P_DECOY)).toBe(false);
  });

  it('⑤ 已软删产品的 /full → 404（编辑器载入即「不存在」）', async () => {
    expect((await get(`/products/${P_DEL}/full`)).status).toBe(404);
    // 阳性对照：诱饵的 /full 仍 200 —— 否则 404 可能只是整条路由挂了
    expect((await get(`/products/${P_DECOY}/full`)).status).toBe(200);
  });

  it('⑥ 已软删产品的**章节作用域**子资源写路径一并 404，且不落行', async () => {
    const res = await adminWenlvRoute.request(`/chapters/${CH_DEL}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '不该被建出来的场景' }),
    });
    expect(res.status).toBe(404);
    // 承重：404 不能掩盖「其实已经写进去了」
    const scenes = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH_DEL));
    expect(scenes).toHaveLength(1);
    // 阳性对照：同一请求打在诱饵上是 200 —— 证明 404 来自 deleted 过滤而非路由本身不可用
    const ok = await adminWenlvRoute.request(`/chapters/${CH_DECOY}/scenes`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ title: '诱饵场景' }),
    });
    expect(ok.status).toBe(200);
  });

  it('⑦ 场地A 仍被**未软删的诱饵剧本**阻塞 → 409（409 不是整体失效）', async () => {
    const res = await del(`/venues/${V_BOTH}`);
    expect(res.status).toBe(409);
    // 同族前科：只断 409 的话，「先删场地再回 409」的实现也绿
    const rows = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V_BOTH));
    expect(rows).toHaveLength(1);
  });

  it('⑧ 只剩已软删剧本的场地：不再被它阻塞 → 200，且场地真的消失', async () => {
    expect((await del(`/products/${P_ONLY}`)).status).toBe(200);
    const res = await del(`/venues/${V_ONLY}`);
    expect(res.status).toBe(200);
    const rows = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V_ONLY));
    expect(rows).toHaveLength(0);
  });

  it('⑨ 对已软删产品再删一次 → 404（getProductOr404 的 deleted 过滤带来的幂等语义）', async () => {
    expect((await del(`/products/${P_DEL}`)).status).toBe(404);
  });

  it('⑩ 【已知缺口·非期望行为】按要素 id 直连的端点仍能改到已软删产品的子行', async () => {
    // 这条**不是**在钉「应该如此」，而是把 choke point 的**边界**写成可执行的观测：
    // `PATCH /scenes/:id` 不经过产品查询（它只查场景），所以 deleted 过滤够不到它。
    // 与 ⑥ 配对看：⑥ 是「章节作用域」路径被挡住，这条是「要素作用域」路径挡不住。
    const res = await adminWenlvRoute.request(`/scenes/${N1}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ title: '改到了看不见的场景' }),
    });
    expect(res.status).toBe(200);
    const [n] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N1));
    expect(n.title).toBe('改到了看不见的场景');   // 承重：真写进去了，不只是回了个 200
  });
});
