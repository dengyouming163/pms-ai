// C端 JWT 用独立密钥；测试先注入桩值，避免 parseMiniToken 运行时 requireEnv 崩溃。
// 票券门测试旁路：仅测试/联调用，生产不设该 env（Task 7 红线核对）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
process.env.WENLV_BYPASS_TICKET = '1';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes,
  pmsBuiWenlvCollectibles,
  pmsBuiWenlvRewards, pmsBuiWenlvProgress, pmsBuiWenlvRewardTiers, pmsBuiWenlvClaims, pmsBuiWenlvEvents,
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints, pmsBuiWenlvDesignTemplates,
  pmsBuiWenlvCharacters, pmsBuiWenlvNpcs,
} from '../../../db/schema/index.js';

// ── 0079 统一模型辅助：nodes→scenes，需经 script_rooms→chapters 挂接 ──
async function ensureChapter(db: any, productId: string): Promise<string> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.insert(pmsBuiWenlvScriptRooms).values({ id: rid, contentId: productId, name: `${productId} 房` })
    .onConflictDoNothing({ target: pmsBuiWenlvScriptRooms.id });
  await db.insert(pmsBuiWenlvChapters).values({ id: cid, scriptRoomId: rid, title: '第一章', order: 0 })
    .onConflictDoNothing({ target: pmsBuiWenlvChapters.id });
  return cid;
}
async function insertScenes(db: any, productId: string, rows: any[]): Promise<void> {
  const cid = await ensureChapter(db, productId);
  await db.insert(pmsBuiWenlvScenes).values(rows.map((n) => {
    const out: any = {
      id: n.id, chapterId: cid,
      type: (n.nodeType === 'puzzle' ? 'puzzle' : (n.nodeType === 'npc' ? 'npc' : 'narrative')),
      title: n.title,
      venuePointId: n.venuePointId ?? null,
      grants: n.grants ?? null,
      requires: n.requires ?? null,
      order: n.order ?? 0,
      puzzle: n.puzzle ?? null,
    };
    if (n.npcId !== undefined) out.npcId = n.npcId;
    if (n.openingLine !== undefined) out.openingLine = n.openingLine;
    if (n.chapterGoal !== undefined) out.chapterGoal = n.chapterGoal;
    return out;
  }));
}
async function deleteScenesOfProduct(db: any, productId: string): Promise<void> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, cid));
  await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, cid));
  await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.id, rid));
}

// 游客 JWT（模块加载即能签发；env 已注入）
const mkMini = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json' };
};

describe('wenlv mini 路由冒烟', () => {
  it('列表返回 success:true 结构', async () => {
    const res = await wenlvRoute.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.list)).toBe(true);
  });

  it('不存在的产品详情返回 404', async () => {
    const res = await wenlvRoute.request('/no-such-id');
    expect(res.status).toBe(404);
  });
});

// 草稿守卫：连活库种一条 status 默认 draft 的产品，验证 GET /:id 被 published 过滤拦截。
// （改动守卫前该请求会查到 draft 行返回 200，故此用例能真证明过滤生效，非空转。）
// 门控说明：本文件既有列表/404 用例同样连库且未加 RUN_DB 门控，无库时整文件本就红；
// 为保持文件基调一致，本块不加 skipIf，与同文件其它用例共进退。
describe('wenlv mini 草稿守卫（DB）', () => {
  const DRAFT_ID = 'mini-test-draft-product';

  beforeAll(async () => {
    // 先清同 id 残留保证幂等（前次崩溃可能遗留），再插默认 draft 产品
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, DRAFT_ID));
    await db.insert(pmsBuiWenlvProducts).values({ id: DRAFT_ID, name: '草稿守卫测试' });
  });

  it('未发布（草稿）产品详情 404：GET /:id 不服务 draft', async () => {
    const res = await wenlvRoute.request(`/${DRAFT_ID}`);
    expect(res.status).toBe(404);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, DRAFT_ID));
  });
});

// 集章 rally 全链路（脱敏分派/触发打卡/答题判定/档位领取幂等/领取台账）：连活库真实执行，
// 与同文件其它用例一致不加 skipIf。WENLV_BYPASS_TICKET=1 已绕票券门（生产不设）。
describe('wenlv mini 集章 rally（DB）', () => {
  const PRODUCT = 'rally-product';
  const MINI = 'rally-mini';
  // 到场证明夹具：rally 的发章节点必须绑定点位，C 端打卡/答题须凭点位码（发布闸 + 运行时闸双补）
  const VENUE = 'rally-venue';
  const PT1 = 'rally-pt1';
  const PT2 = 'rally-pt2';
  const CODE1 = 'WLP-RALLY0001';
  const CODE2 = 'WLP-RALLY0002';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const get = (path: string) => wenlvRoute.request(path, { headers: { Authorization: H.Authorization } });
  let claimCode = '';

  beforeAll(async () => {
    // 清残留：按 productId 逐表（先子后父），保证前次崩溃/重跑幂等
    await Promise.all([
      db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT)),
      db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT)),
      db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT)),
      db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, PRODUCT)),
      db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, PRODUCT)),
      deleteScenesOfProduct(db, PRODUCT),
      db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PRODUCT)),
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT)),
    ]);
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT1));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
    // 场地 + 两个带码点位（两个发章节点各绑一个）
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '集章测试场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT1, venueId: VENUE, name: '打卡点一', code: CODE1 });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT2, venueId: VENUE, name: '谜题点一', code: CODE2 });
    // 集章产品（published 才能被 GET /:id 详情服务）+ 节点 + 集章 + 档位 + 进度
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '集章测试', status: 'published', mode: 'rally', venueId: VENUE });
    await insertScenes(db, PRODUCT, [
      {
        id: 'rally-n1', nodeType: 'scene', title: '打卡点一',
        venuePointId: PT1,
        grants: ['rally-s1'], requires: null, order: 1, puzzle: null,
      },
      {
        id: 'rally-n2', nodeType: 'scene', title: '谜题点一',
        venuePointId: PT2,
        grants: ['rally-s2'], requires: null, order: 2,
        puzzle: { type: 'multiple', question: '选正确集合', options: ['a', 'b'], answer: ['a', 'b'] },
      },
    ]);
    await db.insert(pmsBuiWenlvCollectibles).values([
      { id: 'rally-s1', productId: PRODUCT, name: '章一', type: 'stamp', stampMeta: { shape: 'circle' } },
      { id: 'rally-s2', productId: PRODUCT, name: '章二', type: 'stamp', stampMeta: { shape: 'square' } },
    ]);
    await db.insert(pmsBuiWenlvRewards).values({ id: 'rally-r1', productId: PRODUCT, name: '奖励一', type: 'digital', value: 'LY-DIGITAL-001' });
    await db.insert(pmsBuiWenlvRewardTiers).values({
      id: 'rally-t1', productId: PRODUCT, name: '档1', description: '集1章即可领',
      order: 1, rewardId: 'rally-r1', icon: 'badge',
      condition: {
        type: 'nofM', n: 1,
        of: [{ type: 'ref', ref: { kind: 'collected', id: 'rally-s1' } }, { type: 'ref', ref: { kind: 'collected', id: 'rally-s2' } }],
      },
    });
    await db.insert(pmsBuiWenlvProgress).values({
      id: 'rally-prg', productId: PRODUCT, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
  });

  it('详情下发档位展示字段且谜题答案脱敏（multiple→[]、无 condition、含 stamp_meta）', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT}`);
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    const pz = d.nodes.find((n: any) => n.id === 'rally-n2');
    expect(pz).toBeTruthy();
    expect(pz.puzzle.answer).toEqual([]); // 不泄漏 multiple 正确答案（0065 起 DTO 为 puzzle 单对象）
    expect(pz.triggerCredential).toBe(undefined);   // 公开详情不下发触发凭证
    const stamp = d.collectibles.find((c: any) => c.id === 'rally-s1');
    expect(stamp).toBeTruthy();
    expect(stamp.stampMeta).toEqual({ shape: 'circle' });
    expect(Array.isArray(d.tiers)).toBe(true);      // 档位仅下发展示字段
    const t1 = d.tiers.find((t: any) => t.id === 'rally-t1');
    expect(t1).toMatchObject({ name: '档1', order: 1, rewardId: 'rally-r1', rewardName: '奖励一', rewardType: 'digital' });
    expect(t1.condition).toBe(undefined);           // 阈值不下发，防作弊
  });

  it('尚未集章时 redeem 档位 403（档位未达成）', async () => {
    const res = await post(`/${PRODUCT}/redeem`, { tierId: 'rally-t1' });
    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
  });

  it('绑定点位的场景节点：无码 403、凭点位码打卡后 grant 生效', async () => {
    // 到场证明：节点绑了带码点位后，triggerType='manual' 不再放行，唯一凭证是点位码
    const miss = await post('/trigger', { productId: PRODUCT, nodeId: 'rally-n1' });
    expect(miss.status).toBe(403);
    const res = await post('/trigger', { productId: PRODUCT, nodeId: 'rally-n1', credential: CODE1 });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.state.collected['rally-s1']).toBe(true);
  });

  it('集齐后 redeem 返回核销码，重复 redeem 幂等同码', async () => {
    const r1 = await post(`/${PRODUCT}/redeem`, { tierId: 'rally-t1' });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.success).toBe(true);
    expect(b1.data.tierId).toBe('rally-t1');
    expect(b1.data.status).toBe('claimed');
    expect(b1.data.code).toMatch(/^LY[A-Z0-9]{10}$/);
    claimCode = b1.data.code;

    const r2 = await post(`/${PRODUCT}/redeem`, { tierId: 'rally-t1' });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.data.code).toBe(claimCode); // 幂等：不二次发码
  });

  it('multiple 答题乱序等值判定正确（经 HTTP 验证集合语义）', async () => {
    // 到场证明：绑定点位的谜题节点须先凭点位码 /trigger 记 visited，否则 /answer 403
    const trig = await post('/trigger', { productId: PRODUCT, nodeId: 'rally-n2', credential: CODE2 });
    expect(trig.status).toBe(200);
    const btrig = await trig.json();
    // 二元模型锚点：scene+puzzle 节点在 /trigger 只标 visited、绝不发章（isPuzzle=!!node.puzzle）。
    // 若 L1697 退回 nodeType==='puzzle'（二元下恒假）⇒ 打卡即 applyGrants，此断言必红。
    expect(btrig.data.state.visited['rally-n2']).toBe(true);
    expect(btrig.data.state.collected['rally-s2']).toBe(undefined);
    // 缺项（非全集）判错
    const w = await post('/answer', { productId: PRODUCT, nodeId: 'rally-n2', interactionIndex: 0, answer: ['b'] });
    const bw = await w.json();
    expect(w.status).toBe(200);
    expect(bw.data.correct).toBe(false);
    expect(bw.data.state.collected['rally-s2']).toBe(undefined);
    // 乱序全集判对
    const ok = await post('/answer', { productId: PRODUCT, nodeId: 'rally-n2', interactionIndex: 0, answer: ['b', 'a'] });
    const bok = await ok.json();
    expect(bok.data.correct).toBe(true);
    expect(bok.data.state.collected['rally-s2']).toBe(true);
  });

  it('claims 台账返回已领取档位（含 tierName/核销码/状态）', async () => {
    const res = await get(`/${PRODUCT}/claims`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(Array.isArray(b.data)).toBe(true);
    expect(b.data.length).toBe(1);
    expect(b.data[0]).toMatchObject({ tierId: 'rally-t1', tierName: '档1', code: claimCode, status: 'claimed' });
  });

  it('claim-state 返回已集印章数 + 每档 met/claimed/need', async () => {
    const res = await get(`/${PRODUCT}/claim-state`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.collectedStampCount).toBe(2); // rally-s1(trigger) + rally-s2(answer)
    expect(b.data.tiers.length).toBe(1);        // 仅档1（rally-t1）；仓库 expect 类型缺 toHaveLength，用 length+toBe
    expect(b.data.tiers[0]).toMatchObject({ id: 'rally-t1', order: 1, met: true, claimed: true, need: 1 });
  });

  afterAll(async () => {
    await Promise.all([
      db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT)),
      db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT)),
      db.delete(pmsBuiWenlvProgress).where(and(eq(pmsBuiWenlvProgress.productId, PRODUCT))),
      db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, PRODUCT)),
      db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, PRODUCT)),
      deleteScenesOfProduct(db, PRODUCT),
      db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PRODUCT)),
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT)),
    ]);
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT1));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });
});

// 集章到场证明的**运行时**闸门：发布闸不随 PATCH 重跑，故发布后被改回未绑点位的
// 发章节点仍会被 /trigger、/answer 应用效果。本块直接构造这种「只可能由带外/PATCH 产生」
// 的产品（不经 publish），证明运行时确实拒发章 —— 去掉 production 里的 rallyStampOnSiteErr
// 调用，本块必红（scene 那条会 200 且 collected 落章）。
describe('wenlv mini 集章到场证明运行时闸门（DB）', () => {
  const PRODUCT = 'rally-onsite-guard-product';
  const MINI = 'rally-onsite-guard-mini';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

  const readState = async () => {
    const [row] = await db.select().from(pmsBuiWenlvProgress)
      .where(and(eq(pmsBuiWenlvProgress.productId, PRODUCT), eq(pmsBuiWenlvProgress.miniUserId, MINI))).limit(1);
    return (row?.state ?? { visited: {}, collected: {}, completed: {} }) as { collected: Record<string, boolean | undefined>; visited: Record<string, boolean | undefined> };
  };

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    // 直接构造「rally + 发章节点未绑定点位」的产品：这正是发布闸拒绝、但 PATCH 后可能存在于库里的形态
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '未绑定守门测试', status: 'published', mode: 'rally' });
    await insertScenes(db, PRODUCT, [
      {
        id: 'ru-n1', nodeType: 'scene', title: '远程打卡点',
        grants: ['ru-s1'], requires: null, order: 1, puzzle: null,
      },
      {
        id: 'ru-p1', nodeType: 'scene', title: '远程谜题点',
        grants: ['ru-s2'], requires: null, order: 2,
        puzzle: { type: 'single', question: '口令？', options: ['对', '错'], answer: '对' },
      },
    ]);
    await db.insert(pmsBuiWenlvCollectibles).values([
      { id: 'ru-s1', productId: PRODUCT, name: '远程章一', type: 'stamp' },
      { id: 'ru-s2', productId: PRODUCT, name: '远程章二', type: 'stamp' },
    ]);
    await db.insert(pmsBuiWenlvProgress).values({
      id: 'ru-prg', productId: PRODUCT, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
  });

  it('scene 发章节点未绑定点位 → /trigger 403，且不发章', async () => {
    const res = await post('/trigger', { productId: PRODUCT, nodeId: 'ru-n1' });
    expect(res.status).toBe(403);
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(String(b.error)).toContain('未绑定点位');
    expect((await readState()).collected['ru-s1']).toBe(undefined);
  });

  it('puzzle 发章节点未绑定点位 → 答对 /answer 403，且不发章', async () => {
    // 谜题 /trigger 只标 visited、不发章，故放行；发章发生在 /answer，须在那里被拦
    const trig = await post('/trigger', { productId: PRODUCT, nodeId: 'ru-p1' });
    expect(trig.status).toBe(200);
    const res = await post('/answer', { productId: PRODUCT, nodeId: 'ru-p1', interactionIndex: 0, answer: '对' });
    expect(res.status).toBe(403);
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(String(b.error)).toContain('未绑定点位');
    expect((await readState()).collected['ru-s2']).toBe(undefined);
  });
});

// 点位触发的凭证判定：节点挂了点位后，唯一凭证是「点位的 code」——
// 同一个码天然服务所有引用它的剧本（这就是「10 个点位服务 8 个剧本」在 C 端的体现）。
// 连活库真实执行，与同文件其它用例一致**不加 skipIf**（见「wenlv mini 草稿守卫（DB）」块上方的基调说明：
// 本文件既有用例本就无 RUN_DB 门控，无库时整文件红，新块与它们共进退 —— 故不要给本块加 skipIf）。
describe('wenlv mini 点位触发凭证（DB）', () => {
  const PRODUCT = 'pt-trigger-product';
  const VENUE = 'pt-trigger-venue';
  const PT = 'pt-trigger-point';
  const N1 = 'pt-trigger-n1';
  const PUZZLE = 'pt-trigger-puzzle';
  const MINI = 'pt-trigger-mini';
  const PRG = 'pt-trigger-prg';
  const CODE = 'WLP-TESTCODE0001';
  // 同一场地里的第二个点位（有自己的码）：用来证明「B 点的真码」推不开「绑给 A 点的节点」。
  // 单点位时无从区分「按 code 命中」与「按 node.venuePointId 命中」——
  // 把 mini 路由的查找改成只看 code，全部用例照样绿（已用变异实测）。
  const PT2 = 'pt-trigger-point2';
  const CODE2 = 'WLP-TESTCODE0002';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    // 清残留：先子后父，保证前次崩溃/重跑幂等
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));

    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '触发测试场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT, venueId: VENUE, name: '古井', code: CODE });
    // 第二个点位：只在「B 点位的真码能否推开绑给 A 点位的节点」那条用例里出场
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT2, venueId: VENUE, name: '石桥', code: CODE2 });
    // 必须 published，否则 GET /:id 被草稿守卫拦截
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '点位触发测试', status: 'published', venueId: VENUE });
    // triggerType/triggerCredential 刻意设成「非 manual 且与点位码不同」：
    //   有 venuePointId 时唯一凭证是点位 code → CODE 命中 200；
    //   若将来有人删掉 /trigger 的 `if (node.venuePointId)` 分支，就会落到 else-if ——
    //   'qrcode' 要求凭证匹配，而 triggerCredential='LEGACY-NOT-THE-CODE' ≠ CODE → 403，用例变红。
    //   （若留默认 manual，else-if 会直接短路成 200，这条用例就钉不住点位分支的存在。）
    await insertScenes(db, PRODUCT, [
      {
        id: N1, nodeType: 'scene', title: '古井打卡',
        venuePointId: PT,
        grants: [], requires: null, order: 1, puzzle: null,
      },
    ]);
    // /answer 的到场证明回归夹具：绑了点位的节点（新 schema 无 triggerType 字段）。
    await insertScenes(db, PRODUCT, [
      {
        id: PUZZLE, nodeType: 'scene', title: '远程谜题',
        venuePointId: PT, grants: [], requires: null, order: 2,
        puzzle: { type: 'single', question: '口令？', options: ['正确', '错误'], answer: '正确' },
      },
    ]);
    // /trigger 在凭证判定之后还会要求「已开始体验」（无进度行返 400），
    // 故夹具必须先建进度行，否则本块第 1 条会因 400 而非凭证逻辑变红（与断言目标无关的假红）。
    await db.insert(pmsBuiWenlvProgress).values({
      id: PRG, productId: PRODUCT, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  it('点位码匹配 → 触发通过', async () => {
    const res = await post('/trigger', { productId: PRODUCT, nodeId: N1, credential: CODE });
    expect(res.status).toBe(200);
  });

  it('点位码不匹配 → 403', async () => {
    const res = await post('/trigger', { productId: PRODUCT, nodeId: N1, credential: 'WRONG' });
    expect(res.status).toBe(403);
  });

  // 上一条用的 'WRONG' 是个**不存在**的码，它证明不了「必须是该节点所绑点位的码」：
  // 把查找改成「只看 code、忽略 node.venuePointId」，对 'WRONG' 仍然 404/403，用例照样绿（已用变异实测）。
  // 本条的码是**真实存在**的另一个点位（PT2）的码，只是不归这个节点 —— 只有把查找
  // 收在 node.venuePointId 上才会被拒。放宽查找 ⇒ 命中 PT2 ⇒ 200，本条必红。
  it('同场地另一点位（B）的真码不能触发绑给点位 A 的节点 → 403', async () => {
    const res = await post('/trigger', { productId: PRODUCT, nodeId: N1, credential: CODE2 });
    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
  });

  it('点位存在但 code 为空 → 403（fail-closed，不是放行）', async () => {
    await db.update(pmsBuiWenlvVenuePoints).set({ code: null })
      .where(eq(pmsBuiWenlvVenuePoints.id, PT));
    try {
      const res = await post('/trigger', { productId: PRODUCT, nodeId: N1, credential: '' });
      expect(res.status).toBe(403);
    } finally {
      // 用 try/finally 还原，而不是「靠下一条用例之前再改回来」——
      // 后者会让两条用例互相依赖执行顺序，单跑或重排就假绿/假红。
      await db.update(pmsBuiWenlvVenuePoints).set({ code: CODE })
        .where(eq(pmsBuiWenlvVenuePoints.id, PT));
    }
  });

  it('点位 code 为空串 + 空凭证 → 403（fail-closed 的唯一分支）', async () => {
    // 这一条才真正钉住 `!pt.code`：code='' 且 credential='' 时，
    // 若守卫退化成裸比较 `pt.code !== credential`，'' === '' 会放行到 200。
    // （上面 code=null 的那条钉不住——null !== '' 本就为真，通用不匹配分支也会拒。）
    await db.update(pmsBuiWenlvVenuePoints).set({ code: '' })
      .where(eq(pmsBuiWenlvVenuePoints.id, PT));
    try {
      const res = await post('/trigger', { productId: PRODUCT, nodeId: N1, credential: '' });
      expect(res.status).toBe(403);
    } finally {
      await db.update(pmsBuiWenlvVenuePoints).set({ code: CODE })
        .where(eq(pmsBuiWenlvVenuePoints.id, PT));
    }
  });

  it('已绑点位但未到场 → /answer 403（不能远程答题刷印章）', async () => {
    // 回归：/answer 原先只看已废弃的 triggerType，绑定点位、triggerType 停在默认 'manual'
    // 的谜题节点会被直接放行 —— 持票者可远程答题拿印章，到场证明形同虚设。
    // 删掉 production 里的 `node.venuePointId ||` 这一段，本用例必须变红（实得 200）。
    const res = await post('/answer', {
      productId: PRODUCT, nodeId: PUZZLE, interactionIndex: 0, answer: '正确',
    });
    expect(res.status).toBe(403);
  });

  it('凭证被拒的触发不留 visited 痕迹（否则可先撞错码解锁答题）', async () => {
    // 钉住 /trigger 的判序：凭证校验必须早于 markVisited。
    // 若有人把 markVisited 提到凭证校验之前，错码也会把 visited 打上，
    // 随后 /answer 的到场门就被绕过 —— 而只断言 403 的用例对此毫无反应。
    const bad = await post('/trigger', { productId: PRODUCT, nodeId: PUZZLE, credential: 'WRONG' });
    expect(bad.status).toBe(403);
    // 关键断言：被拒的触发不能成为「到场」的证据。
    // 用正确答案（'正确'，与夹具一致）请求 —— 若 visited 被误打上，/answer 会 200，
    // 故这里的 403 只能归因于 visited 缺失，而非答案错误。
    const after = await post('/answer', { productId: PRODUCT, nodeId: PUZZLE, interactionIndex: 0, answer: '正确' });
    expect(after.status).toBe(403);
  });

  it('详情接口把点位名投影进 location，且不下发 code / venuePointId', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT}`, { headers: { Authorization: H.Authorization } });
    expect(res.status).toBe(200);
    const b = await res.json();
    const n = b.data.nodes.find((x: any) => x.id === N1);
    expect(n.location).toBe('古井');
    // 这两个是防「游客免凭证远程打卡」的红线断言：code 一旦下发，整个到场证明就废了。
    // **不要写 toBeUndefined()** —— 仓库自写的类型桩 pms-server/src/types/vitest.d.ts 没声明它，
    // 写了 `pnpm ts-check` 会红。用 toBe(undefined)，与 stores-region-tags.test.ts 等 3 处既有处理一致。
    expect(n.code).toBe(undefined);
    expect(n.venuePointId).toBe(undefined);
  });

  // 正向到场闭环：正确码 → /trigger 200（且 visited 落库）→ /answer 200 且判对。
  // 上面几条只钉了「错的时候 403」。它们对「/trigger 记 visited 时写错 key（或根本不写）」
  // 完全无感：那种回归会让**绑定点位的谜题节点永远答不了**（到场门恒 403），
  // 现场剧本直接不可通关，而整个文件依然全绿（已用变异实测）。
  // 位置刻意放在两条「PUZZLE 未被到访」的负例**之后**：它们依赖 visited 缺失，本条会把它打上。
  it('正确点位码触发后，谜题节点可答题（正向到场闭环，visited 真落库）', async () => {
    const trig = await post('/trigger', { productId: PRODUCT, nodeId: PUZZLE, credential: CODE });
    expect(trig.status).toBe(200);
    const bt = await trig.json();
    // visited 必须真记在**本节点 id** 下：只断言 200 的话，一个「记在别的 key 上」的实现
    // （甚至只写 events 不写 state）照样绿，随后 /answer 的到场门就永远打不开。
    expect(bt.data.state.visited[PUZZLE]).toBe(true);

    const ans = await post('/answer', {
      productId: PRODUCT, nodeId: PUZZLE, interactionIndex: 0, answer: '正确',
    });
    expect(ans.status).toBe(200);
    const ba = await ans.json();
    expect(ba.data.correct).toBe(true);
  });
});

// 象限三：**未绑点位 + triggerType !== 'manual'** —— 靠旧 triggerCredential 的存量扫码/信标节点。
// 这是谓词 nodeRequiresCredential 抽出**之前就存在**的测试盲区：把它退化成 `!!venuePointId`
// （等价于删掉本象限的凭证检查），/trigger 的行为从「403 拒绝」变成「放行」——
// 任何人都能远程触发存量扫码节点（真实越权），而既有的 admin 90 条 + mini 66 条用例**全绿**。
// 本块把该象限在 /trigger（凭证门）与 /answer（到场门）两个消费点上的行为钉住。
// 连活库真实执行，与同文件其它块一致**不加 skipIf**（见「wenlv mini 草稿守卫（DB）」块上方的基调说明）。
describe('wenlv mini 旧式凭证节点（未绑点位 + triggerType 非 manual，DB）', () => {
  const PRODUCT = 'legacy-cred-product';
  const MINI = 'legacy-cred-mini';
  const PRG = 'legacy-cred-prg';
  const SCENE = 'legacy-cred-scene';
  const PUZZLE = 'legacy-cred-puzzle';
  const CRED = 'LEGACY-K';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    // 产品用默认 mode='narrative'、节点 effects.grant=[]：/trigger 的三类 403 里，
    // 「前置条件未满足」（unlockCondition=null 恒真）与「集章未绑点位」（rallyStampOnSiteErr，
    // 且 narrative 直接短路）都被排除 —— **唯一可能的 403 来源就是凭证门本身**，断言才不恒真。
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '旧式凭证测试', status: 'published' });
    await insertScenes(db, PRODUCT, [
      // ★ 不挂点位的节点（新 schema 无 triggerType/triggerCredential 字段）
      {
        id: SCENE, nodeType: 'scene', title: '旧式扫码点',
        grants: [], requires: null, order: 1, puzzle: null,
      },
      {
        id: PUZZLE, nodeType: 'scene', title: '旧式扫码谜题',
        grants: [], requires: null, order: 2,
        puzzle: { type: 'single', question: '口令？', options: ['对', '错'], answer: '对' },
      },
    ]);
    // /trigger 的凭证判定之后还有「已开始体验」检查（无进度行返 400），故先建进度行 ——
    // 否则会因 400 而非凭证逻辑变红（与断言目标无关的假红）。
    await db.insert(pmsBuiWenlvProgress).values({
      id: PRG, productId: PRODUCT, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
  });

  // ---- /trigger 的凭证门 ----
  it('错凭证触发未绑点位的旧式扫码节点 → 403「触发凭证不匹配」', async () => {
    const res = await post('/trigger', { productId: PRODUCT, nodeId: SCENE, credential: 'WRONG' });
    expect(res.status).toBe(403);
    const b = await res.json();
    // 断文案而非只断状态码：/trigger 另有「前置条件未满足」「集章未绑点位」两种 403，
    // 只断 403 会把「拦对了」与「拦错了」混为一谈（既有 ru-n1 用例的 403 就来自后者）。
    expect(String(b.error)).toContain('触发凭证不匹配');
  });

  it('正确凭证触发同一节点 → 200 且 visited 落库（证明比对真生效，不是恒拒）', async () => {
    const res = await post('/trigger', { productId: PRODUCT, nodeId: SCENE, credential: CRED });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.state.visited[SCENE]).toBe(true);
  });

  // ---- /answer 的到场门 ----
  it('未到场答题未绑点位的旧式扫码谜题 → 403「请先到场触发该节点」', async () => {
    const res = await post('/answer', { productId: PRODUCT, nodeId: PUZZLE, interactionIndex: 0, answer: '对' });
    expect(res.status).toBe(403);
    const b = await res.json();
    expect(String(b.error)).toContain('请先到场触发该节点');
  });

  // 正向：证明到场门是「先到场」而非「永久拒绝」。
  // 位置刻意在「PUZZLE 未被到访」的负例**之后**（同文件既有先例：负例依赖 visited 缺失）。
  it('凭正确凭证触发出场后，同一谜题可答题（证明门是「到场」而非永久拒绝）', async () => {
    const trig = await post('/trigger', { productId: PRODUCT, nodeId: PUZZLE, credential: CRED });
    expect(trig.status).toBe(200);
    const ans = await post('/answer', { productId: PRODUCT, nodeId: PUZZLE, interactionIndex: 0, answer: '对' });
    expect(ans.status).toBe(200);
    const ba = await ans.json();
    expect(ba.data.correct).toBe(true);
  });
});

// 领取并发 / 唯一冲突（DB）：钉住 redeem 的 23505 守卫。
//
// 生产缺陷：drizzle-orm 0.45.2 的 queryWithCache 把 pg 错误包成 DrizzleQueryError，
// 该类的 message 只有 `Failed query: <SQL>\nparams: <参数>` —— **不含 SQLSTATE**，
// 也没有 code / constraint（二者都在 cause 上；见 node_modules/drizzle-orm/errors.js）。
// 旧读法 `e?.code ?? e?.message` 因此恒不命中 → 同档并发双击的落后者被 rethrow →
// 外层 catch 返 500，并把 `Failed query: <SQL> params: <含 productId/progressId/tierId/刚生成的核销码>`
// 原文透给客户端（信息泄露）。
//
// 本块两条用例分别钉两个唯一约束分支：progress_tier（同档并发，读回既有 claim 幂等返 200 同码）
// 与 code（换新码重试）。连活库真实执行，与同文件其它块一致不加 skipIf。
describe('wenlv mini 集章领取唯一冲突（DB）', () => {
  const PRODUCT = 'race-claim-product';
  const MINI = 'race-claim-mini';
  const PRG = 'race-claim-prg';
  const T1 = 'race-claim-t1';   // 已有 claim：模拟并发先手已落库
  const T2 = 'race-claim-t2';   // 无 claim：核销码撞车分支
  const EXISTING_ID = 'race-claim-existing';
  const EXISTING_CODE = 'RACECODE0001';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    // 事件表也要清：测试 B 会写 redeem 事件，漏清会让测试 A 的「未写 redeem 事件」断言随上次运行结果而定
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '领取冲突测试', status: 'published' });
    // condition 留空 ⇒ evalCondition(null) === true，把用例聚焦在冲突处理而非达成判定
    await db.insert(pmsBuiWenlvRewardTiers).values([
      { id: T1, productId: PRODUCT, name: '并发档', order: 1 },
      { id: T2, productId: PRODUCT, name: '撞码档', order: 2 },
    ]);
    await db.insert(pmsBuiWenlvProgress).values({
      id: PRG, productId: PRODUCT, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
    // 先手 claim：真实的 (progress_id, tier_id) 冲突源
    await db.insert(pmsBuiWenlvClaims).values({
      id: EXISTING_ID, productId: PRODUCT, miniUserId: MINI, progressId: PRG,
      tierId: T1, code: EXISTING_CODE, status: 'claimed', claimedAt: new Date(), updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
  });

  it('同档并发双击：pre-check 读在并发先手提交之前（读到空）→ 插入撞 uq_wenlv_claims_progress_tier → 读回既有 claim 返 200 同码（非 500）', async () => {
    // 构造「pre-check 空窗」：让 redeem 的第 3 次 DB 读（幂等 pre-check）返回空数组，
    // 而库里其实已有 T1 的 claim —— 这正是并发双击里落后者读在先手提交之前的时序。
    // 插入随即撞真实 Postgres 的唯一约束，错误被 drizzle 真实包装成 DrizzleQueryError。
    // redeem 的 DB 读序（BYPASS_TICKET 下 assertTicket 不查库）：1=getProgress 2=档位 3=pre-check 4=守卫读回
    const origSelect = db.select.bind(db);
    let calls = 0;
    let precheckMadeStale = false;
    let empty: any;
    empty = { from: () => empty, where: () => empty, limit: () => Promise.resolve([]), orderBy: () => empty };
    // 直接接管 db.select，不用 vi.spyOn —— 仓库自写的 vitest.d.ts 类型桩没声明 spyOn，用了会挂 ts-check。
    // select 定义在 PgDatabase 原型上，给实例赋一个遮蔽属性即可；finally 里 delete 还原到原型方法
    // （还原是否成功由 finally 之后的真实 db.select 查询隐式验证：没还原就 TypeError 变红）。
    (db as any).select = (...args: any[]) => {
      calls += 1;
      if (calls === 3) { precheckMadeStale = true; return empty; }
      return (origSelect as any)(...args);
    };
    try {
      const res = await post(`/${PRODUCT}/redeem`, { tierId: T1 });
      // 先钉住「本用例真的走到了插入冲突路径」：pre-check 被读成空且插入被执行。
      // 若少了这条，一个「pre-check 正常命中」的实现也会给出 200 同码，用例就空转了。
      expect(precheckMadeStale).toBe(true);
      expect(res.status).toBe(200);     // 修复前：500 + `Failed query: ...` 原文
      expect(calls).toBe(4);            // 第 4 次 = 守卫读回先手行（未读回则说明守卫分支没跑）
      const b = await res.json();
      expect(b.success).toBe(true);
      expect(b.data.id).toBe(EXISTING_ID);   // 读回既有行，不是新发码
      expect(b.data.code).toBe(EXISTING_CODE);
    } finally {
      delete (db as any).select;
    }
    // 未重复发码：T1 仍只有先手那一行
    const rows = await db.select().from(pmsBuiWenlvClaims).where(eq(pmsBuiWenlvClaims.productId, PRODUCT));
    expect(rows.filter((r) => r.tierId === T1).length).toBe(1);
    // 且未写 redeem 事件（fresh=false：先手已写过）
    const events = await db.select().from(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    expect(events.filter((e) => e.eventType === 'redeem').length).toBe(0);
  });

  it('核销码撞 uq_wenlv_claims_code → 换新码重试成功（不误判为同档冲突读回空行）', async () => {
    // 用真的 DrizzleQueryError 形状注入一次冲突：message 不含 23505、code/constraint 只在 cause 上。
    // 只看 23505 而不比对 constraint 的实现会误走「读回同档 claim」分支 → 读回空 → row undefined → 500，
    // 故本用例同时钉住「按 constraint 精确匹配」。
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_wenlv_claims_code"'),
      { code: '23505', constraint: 'uq_wenlv_claims_code' },
    );
    const wrapped = new DrizzleQueryError('insert into "pms_bui_wenlv_claims" (...) values (...)', [], cause);
    // 只让**第一次** claims 插入抛冲突，随后交还原实现（换码重试应当成功落库）。
    // 同上：不用 vi.spyOn（类型桩没声明），直接接管 + finally delete 还原。
    const origInsert = db.insert.bind(db);
    let injected = false;
    (db as any).insert = (...args: any[]) => {
      if (!injected) { injected = true; throw wrapped; }
      return (origInsert as any)(...args);
    };
    try {
      const res = await post(`/${PRODUCT}/redeem`, { tierId: T2 });
      expect(injected).toBe(true);      // 冲突确实被注入（否则本用例空转）
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.success).toBe(true);
      expect(b.data.status).toBe('claimed');
      expect(b.data.code).toMatch(/^LY[A-Z0-9]{10}$/);  // 换新码后成功落库
      expect(b.data.tierId).toBe(T2);
    } finally {
      delete (db as any).insert;
    }
  });
});

// 详情 DTO 下发：证书需要的场地名 + 环境音地址。
// 这两项都是「创作台知道、C 端此前拿不到」的字段，故单列一个 describe 钉住。
describe('wenlv mini 详情 DTO 补字段（DB）', () => {
  const PRODUCT = 'dto-venue-product';
  const PRODUCT_NOVENUE = 'dto-novenue-product';
  const VENUE = 'dto-venue';
  const TPL = 'dto-venue-tpl';
  const PRODUCT_TPL = 'dto-tpl-product';

  beforeAll(async () => {
    await Promise.all([
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT)),
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_NOVENUE)),
      db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_TPL)),
    ]);
    await db.delete(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, TPL));
    // 模板由本测试自插自删：本地 aipms 恰好人手 seed 过内置模板行，但裸测试库不会有，
    // 依赖它就成了「依赖 dev seed 的脆弱用例」。notNull 只有 id/name/styleTag，其余有默认值。
    await db.insert(pmsBuiWenlvDesignTemplates).values({
      id: TPL, name: 'DTO 测试模板', styleTag: '水墨', tokens: { soundStyle: '空灵古琴' },
    });
    // 生产真实形状：创作台只选模板，风格在 design_templates.tokens 里，产品 theme 上**没有** soundStyle。
    await db.insert(pmsBuiWenlvProducts).values({
      id: PRODUCT_TPL, name: '模板路径剧本', status: 'published', theme: { templateId: TPL },
    });
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '龙门镇' });
    await db.insert(pmsBuiWenlvProducts).values({
      id: PRODUCT, name: 'DTO 测试剧本', status: 'published', venueId: VENUE,
      // 主题里带一个**中文标签** soundStyle —— 这是落库的真实形状（内置模板用的就是中文标签）。
      // 有了它，bgmUrl 才能被断言到**具体曲名**，从而证明 soundStyle 真的被传进了 resolveBgmUrl。
      theme: { soundStyle: '空灵古琴' },
    });
    // 不绑场地的剧本：venue_id 留 NULL（真实存在的状态）；**也不配 theme**，用来看默认曲兜底
    await db.insert(pmsBuiWenlvProducts).values({
      id: PRODUCT_NOVENUE, name: '无场地剧本', status: 'published',
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_NOVENUE));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_TPL));
    await db.delete(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, TPL));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  it('详情下发 venueName（按 products.venue_id 查 venues.name）与 bgmUrl', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.venueName).toBe('龙门镇');
    // ⚠️ 断言**具体曲名**，不要退化成 /bgm-[a-z-]+\.mp3$/ 这种形状断言：
    // 形状断言在「handler 写死 resolveBgmUrl(undefined)」时**照样绿**，证明不了
    // designTokens.soundStyle 真的被传进去了 —— 那是本 Task 唯一要验的接线。
    // theme.soundStyle='空灵古琴'（中文标签）→ SOUND_STYLE_ALIAS → bgm-relaxing。
    expect(body.data.bgmUrl).toContain('/pms/bgm/bgm-relaxing.mp3');
  });

  it('venue_id 为 NULL 时 venueName 为 null，且接口仍 200（不 404、不 500）', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT_NOVENUE}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.venueName).toBeNull();
    // bgmUrl 与场地无关，照常下发；且**未配 theme 时必须有声**（落 spec §4.3 的默认 chinese），
    // 不能返回 undefined/空串 —— 「没人配风格 ⇒ 整场静音」是这条要挡住的失败模式。
    expect(body.data.bgmUrl).toContain('/pms/bgm/bgm-chinese-style.mp3');
  });

  // 为什么需要这第三条：上面两条把 soundStyle 直接写在 product.theme 上，
  // 于是 handler 读 designTokens.soundStyle 还是读 product.theme?.soundStyle 答案完全相同 ——
  // 它们对本 Task 的唯一接线点（模板 tokens → resolveProductTokens → designTokens）**没有区分力**。
  // 而生产走的正是模板路径：创作台只能选模板（theme.templateId），
  // 风格来自 design_templates.tokens，产品 theme 上根本没有 soundStyle。
  // 把 handler 改成 resolveBgmUrl(product.theme?.soundStyle) 时上面两条仍全绿，只有这条会红。
  it('风格来自模板 tokens（theme 无 soundStyle）时，bgmUrl 仍按模板风格下发', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT_TPL}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 模板 tokens.soundStyle='空灵古琴' → resolveProductTokens 保留 → 'relaxing' → bgm-relaxing
    expect(body.data.bgmUrl).toContain('/pms/bgm/bgm-relaxing.mp3');
  });
});

// Task 14：mini 详情下发角色（spec §7 的**最小投影**）。
// 两块承重：① 只下发展示所需键 —— 用**键集全等**钉住。逐字段 `expect('x' in c).toBe(false)`
// 在实现改成 `{ ...c }` 整行下发时**照样全绿**（多出来的键不违反任何一条 per-key 断言）。
// ② 恒返回数组（`[]` 而非 undefined）—— 端面 v-for 拿到 undefined 不报错，只会**整块不渲染**，
//    表现为「选角页空白但页面正常」，是最难查的失败模式。
// 连活库真实执行，与同文件其它块一致**不加 skipIf**（见「wenlv mini 草稿守卫（DB）」块上方的基调说明）。
describe('wenlv mini 详情角色投影（DB）', () => {
  const P = 'chars-detail-product';
  const P_EMPTY = 'chars-detail-empty-product';
  const C1 = 'chars-detail-c1';
  const C2 = 'chars-detail-c2';
  // 哨兵值：把生成侧字段的**实际内容**也钉死。只断言「键不在」挡不住「换个键名照样下发原文」。
  const PROMPT_SENTINEL = 'PROMPT_SENTINEL_9f3a';
  const ROLE_SENTINEL = 'ROLE_SENTINEL_9f3a';
  // 期望键集**只写一份**并复用于两条断言，避免两处手抄漂移。
  const EXPECTED_KEYS = [
    'avatarUrl', 'faction', 'factionColor', 'hiddenQuest', 'id', 'identity',
    'identityDesc', 'insight', 'name', 'skills', 'vitality', 'wisdom',
  ].sort();

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P_EMPTY));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P_EMPTY));
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '角色投影剧本', status: 'published' });
    await db.insert(pmsBuiWenlvProducts).values({ id: P_EMPTY, name: '无角色剧本', status: 'published' });
    // 插入序**故意与 order 相反**（先 C1@order=1，后 C2@order=0）：同序插入时「按 order 排」
    // 与「按物理行序」答案相同 ⇒ 那条排序断言就没有判别力了。
    await db.insert(pmsBuiWenlvCharacters).values([
      {
        id: C1, productId: P, order: 1, name: '沈砚', faction: '江湖', identity: '剑客',
        identityDesc: '旧日同门', role: ROLE_SENTINEL, avatarUrl: 'https://x/c1.png',
        ipPrompt: PROMPT_SENTINEL, vitality: 7, wisdom: 8, insight: 9,
        skills: [{ id: 'sk-1', label: '听风', description: '辨位' }],
        hiddenQuest: { title: '隐秘·旧约', description: '找回信物', collectible_ids: ['col-1'] },
      },
      {
        id: C2, productId: P, order: 0, name: '柳娘', faction: '市井', identity: '茶博士',
        vitality: 5, wisdom: 6, insight: 7, skills: [], hiddenQuest: null,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P_EMPTY));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P_EMPTY));
  });

  it('详情下发 characters：键集恰为展示所需，ipPrompt/role 等生成侧与内部列不进该投影', async () => {
    const res = await wenlvRoute.request(`/${P}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const chars = body.data.characters;
    expect(Array.isArray(chars)).toBe(true);
    expect(chars).toHaveLength(2);
    // 夹具插入序 C1,C2 与 order 相反 ⇒ 这条真在验 orderBy(order, createdAt)
    expect(chars.map((c: any) => c.id)).toEqual([C2, C1]);

    const c = chars[1];   // 沈砚（order=1，排在后）
    expect(c.name).toBe('沈砚');
    expect(c.avatarUrl).toBe('https://x/c1.png');
    expect(c.identityDesc).toBe('旧日同门');
    expect(c.factionColor).toBeNull();       // 无值列仍**在键集里**，值为 null（不是键缺席）
    expect(c.skills).toEqual([{ id: 'sk-1', label: '听风', description: '辨位' }]);
    expect(c.hiddenQuest).toEqual({ title: '隐秘·旧约', description: '找回信物', collectible_ids: ['col-1'] });

    // 承重断言：**键集全等**（先例 wenlv-public-fields.test.ts 的白名单用例）。
    expect(Object.keys(c).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(chars[0]).sort()).toEqual(EXPECTED_KEYS);
    // 整行下发会让下面的哨兵出境 —— 与上面的键集断言互为兜底（一个挡「多键」、一个挡「改名的键」）。
    expect(JSON.stringify(body)).not.toContain(PROMPT_SENTINEL);
    expect(JSON.stringify(body)).not.toContain(ROLE_SENTINEL);
  });

  it('产品没有角色 ⇒ characters 是 [] 而不是缺席（端面 v-for 拿到 undefined 会整块不渲染）', async () => {
    const res = await wenlvRoute.request(`/${P_EMPTY}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.characters).toEqual([]);
  });
});

// S4④：scene 节点承载「剧情回味题」。生产库里已有 AI 写出的 scene 题，但改动前 /answer 的
// 节点类型硬门（`nodeType !== 'puzzle'`）会把它们**全部**挡在 400 之外，任何客户端都提交不了。
// 本块钉两件事：① scene 的题能提交且**真在判答案**（答错 false / 答对 true）；
// ② photo / meditate 这类没有答案的现场动作仍不可提交。
// 夹具刻意用 narrative（默认 mode）+ 未绑点位 + triggerType='manual' ⇒ nodeRequiresCredential 为假：
// 于是 /answer 上唯一可能拦下请求的就是「节点类型 + 题型」这两行（本 Task 的改写点），
// 不会因到场门/前置门假红（那是别的块在钉的语义）。
// 连活库真实执行，与同文件其它块一致**不加 skipIf**（见「wenlv mini 草稿守卫（DB）」块上方的基调说明）。
describe('wenlv mini scene 节点答题（DB）', () => {
  const PRODUCT = 'scene-answer-product';
  const MINI = 'scene-answer-mini';
  const PRG = 'scene-answer-prg';
  const SCENE_QUIZ = 'sa-quiz';
  const SCENE_ACTION = 'sa-action';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: 'scene 答题测试', status: 'published', mode: 'narrative' });
    await insertScenes(db, PRODUCT, [
      {
        id: SCENE_QUIZ, nodeType: 'scene', title: '剧情回味',
        grants: [], requires: null, order: 1,
        puzzle: { type: 'single', question: '回味题', options: ['A', 'B'], answer: 'A' },
      },
      {
        id: SCENE_ACTION, nodeType: 'scene', title: '现场动作',
        grants: [], requires: null, order: 2,
        puzzle: { type: 'meditate', question: '静坐', seconds: 60 },
      },
    ]);
    await db.insert(pmsBuiWenlvProgress).values({
      id: PRG, productId: PRODUCT, miniUserId: MINI, status: 'active',
      state: { visited: {}, collected: {}, completed: {} },
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
  });

  it('scene 节点的剧情回味题可提交：答错判 false、答对判 true', async () => {
    // 先答错：证明这条路径真的**在判答案**，而不是「放行即恒对」——
    // 只断答对那条的话，一个把 correct 写死的实现照样绿。
    const wrong = await post('/answer', { productId: PRODUCT, nodeId: SCENE_QUIZ, interactionIndex: 0, answer: 'B' });
    expect(wrong.status).toBe(200);
    expect((await wrong.json()).data.correct).toBe(false);

    const ok = await post('/answer', { productId: PRODUCT, nodeId: SCENE_QUIZ, interactionIndex: 0, answer: 'A' });
    expect(ok.status).toBe(200);
    const bok = await ok.json();
    expect(bok.data.correct).toBe(true);
  });

  it('scene 节点的现场动作（meditate / photo）仍不可提交 → 400「无此交互」', async () => {
    // 断文案而非只断 400：改动前这两条也返 400（但文案是「该节点不是谜题」，来自节点类型门）。
    // 只断状态码就分不清「题型门拦的」与「节点门拦的」，等题型门被误删也照样绿。
    const med = await post('/answer', { productId: PRODUCT, nodeId: SCENE_ACTION, interactionIndex: 0, answer: 'x' });
    expect(med.status).toBe(400);
    expect(String((await med.json()).error)).toContain('无此交互');

    const pho = await post('/answer', { productId: PRODUCT, nodeId: SCENE_ACTION, interactionIndex: 1, answer: 'x' });
    expect(pho.status).toBe(400);
    expect(String((await pho.json()).error)).toContain('无此交互');
  });
});

// 节点二元契约的版本投影（GET /:id 按 x-client-version 头区分新老小程序）：
// · 旧版（无头 / 1.0.x）：nodeType 按 legacy_node_type 影子列回吐历史线格式（0074 封存的
//   v1:npc/v1:puzzle/v1:scene…，玩家侧零变化）；无影子的二元新生行才按真实类型+puzzle 派生。
//   driverType 恒补 'traditional'（线上旧版从未点亮过 NPC 对话模式，不能报 'npc' 凭空激活）。
// · 新版（1.1.0+）：nodeType 仅 scene/npc（挂 puzzle 的节点也是 scene），响应绝无 driverType /
//   legacyNodeType 键。
// 连活库真实执行，与同文件其它块一致不加 skipIf。
describe('wenlv mini 详情节点版本投影（DB）', () => {
  const PRODUCT = 'node-projection-product';
  const NPC = 'np-npc-row';
  const N_SCENE = 'np-scene';
  const N_PUZZLE = 'np-puzzle';
  const N_NPC = 'np-npc';
  // 模拟 0074 执行后的存量行：真实类型已落平为 scene，但影子列封存着切换前原值。
  const N_LEGACY_NPC = 'np-legacy-npc';       // 原 npc + puzzle（TONGGU 形态）
  const N_LEGACY_SCENE_PZ = 'np-legacy-scpz'; // 原 scene 但挂 puzzle（9 行存量形态）
  const N_LEGACY_PUZZLE_NULL = 'np-legacy-pznull'; // 原 puzzle 但 puzzle 列为空的脏行
  // 答案哨兵：除断 puzzle.answer==='' 外，再钉「整份响应不含答案原文」。
  const ANSWER_SENTINEL = 'NP_SECRET_ANSWER_7f3a';

  beforeAll(async () => {
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.insert(pmsBuiWenlvProducts).values({ id: PRODUCT, name: '节点投影测试', status: 'published' });
    await db.insert(pmsBuiWenlvNpcs).values({ id: NPC, productId: PRODUCT, name: '客栈掌柜' });
    await insertScenes(db, PRODUCT, [
      // 普通 scene：无 puzzle、无 npc
      {
        id: N_SCENE, nodeType: 'scene', title: '普通剧情',
        grants: [], requires: null, order: 1, puzzle: null,
      },
      // scene + puzzle：谜题就是 narrative 场景内挂 puzzle JSON
      {
        id: N_PUZZLE, nodeType: 'scene', title: '谜题剧情',
        grants: [], requires: null, order: 2,
        puzzle: { type: 'single', question: '口令？', options: ['a', 'b'], answer: ANSWER_SENTINEL },
      },
      // npc：npcId + chapterGoal + openingLine 三件套
      {
        id: N_NPC, nodeType: 'npc', title: 'NPC 剧情', npcId: NPC,
        grants: [], requires: null, order: 3, puzzle: null,
        openingLine: '客官里边请。',
        chapterGoal: { type: 'reveal', description: '问出暗号', answerCriteria: ['明月'], minTurns: 1 },
      },
      // 0079 新模型无 legacyNodeType；以下存量形态以 type 区分：
      // npc 类型场景（带 npcId）
      {
        id: N_LEGACY_NPC, nodeType: 'npc',
        title: '历史 NPC 节点', npcId: NPC, grants: [], requires: null, order: 4,
        chapterGoal: { type: 'puzzle', description: '旧目标', answerCriteria: [], minTurns: 1 },
        puzzle: { type: 'single', question: '旧题？', options: ['x', 'y'], answer: ANSWER_SENTINEL },
      },
      // narrative 场景挂 puzzle（旧版 scene 挂题形态）
      {
        id: N_LEGACY_SCENE_PZ, nodeType: 'scene',
        title: '历史场景挂题', grants: [], requires: null, order: 5,
        puzzle: { type: 'single', question: '回味题？', options: ['a', 'b'], answer: ANSWER_SENTINEL },
      },
      // puzzle 类型但 puzzle 空（脏行）
      {
        id: N_LEGACY_PUZZLE_NULL, nodeType: 'puzzle',
        title: '历史谜题空壳', grants: [], requires: null, order: 6, puzzle: null,
      },
    ]);
  });

  afterAll(async () => {
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
  });

  // 拉详情并按 id 索引节点；version 缺省 = 不带头（模拟线上无该头的 1.0.x）。
  const getNodes = async (version?: string) => {
    const res = await wenlvRoute.request(`/${PRODUCT}`, {
      headers: version ? { 'x-client-version': version } : undefined,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId: Record<string, any> = Object.fromEntries(body.data.nodes.map((n: any) => [n.id, n]));
    return { body, byId };
  };

  // 旧版投影的核心断言组（无头与 1.0.1 必须逐字一致）。
  const assertOldProjection = (byId: Record<string, any>) => {
    // 0079 新模型无 legacyNodeType 影子列，旧版投影走 fallback：
    // nodeType==='npc' → 'npc'；否则有 puzzle → 'puzzle'；否则 'scene'。
    expect(byId[N_SCENE].nodeType).toBe('scene');
    expect(byId[N_PUZZLE].nodeType).toBe('puzzle');   // narrative + puzzle
    expect(byId[N_NPC].nodeType).toBe('npc');
    expect(byId[N_LEGACY_NPC].nodeType).toBe('npc');  // type='npc'
    expect(byId[N_LEGACY_SCENE_PZ].nodeType).toBe('puzzle'); // narrative + puzzle
    expect(byId[N_LEGACY_PUZZLE_NULL].nodeType).toBe('scene'); // type='puzzle' 但 puzzle 空
    // driverType 恒为 traditional 占位（任何节点都不能报 npc，防旧版凭空点亮 NpcChatStage）。
    for (const id of [N_SCENE, N_PUZZLE, N_NPC, N_LEGACY_NPC, N_LEGACY_SCENE_PZ, N_LEGACY_PUZZLE_NULL]) {
      expect(byId[id].driverType).toBe('traditional');
    }
    // 影子列是服务端内部派生依据，绝不进任何版本的 DTO。
    for (const n of Object.values(byId)) {
      expect(Object.prototype.hasOwnProperty.call(n, 'legacyNodeType')).toBe(false);
    }
  };

  it('不带 x-client-version 头（旧版投影）：新生行按二元派生，历史行逐字回吐影子值', async () => {
    const { byId } = await getNodes();
    assertOldProjection(byId);
  });

  it('x-client-version: 1.0.1（旧版投影）：与无头相同', async () => {
    const { byId } = await getNodes('1.0.1');
    assertOldProjection(byId);
  });

  it('x-client-version: 1.1.0（二元新契约）：历史行也是真实 scene/npc，且全部无 driverType/影子键', async () => {
    const { body, byId } = await getNodes('1.1.0');
    // 二元新契约：nodeType 仅 scene/npc（puzzle 由 puzzle 对象是否存在决定）。
    expect(byId[N_SCENE].nodeType).toBe('scene');
    expect(byId[N_PUZZLE].nodeType).toBe('scene');
    expect(byId[N_NPC].nodeType).toBe('npc');
    expect(byId[N_LEGACY_NPC].nodeType).toBe('npc');   // type='npc'
    expect(byId[N_LEGACY_SCENE_PZ].nodeType).toBe('scene');
    expect(byId[N_LEGACY_PUZZLE_NULL].nodeType).toBe('scene');
    for (const n of body.data.nodes) {
      // 钉「键不存在」而非 undefined：防止实现塞个 driverType:null 进来（旧版读到 null 会走错分支）。
      expect(Object.prototype.hasOwnProperty.call(n, 'driverType')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(n, 'legacyNodeType')).toBe(false);
    }
  });

  it('x-client-version: 2.0.0 同走二元新契约', async () => {
    const { body, byId } = await getNodes('2.0.0');
    expect(byId[N_PUZZLE].nodeType).toBe('scene');
    expect(byId[N_NPC].nodeType).toBe('npc');
    for (const n of body.data.nodes) {
      expect(Object.prototype.hasOwnProperty.call(n, 'driverType')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(n, 'legacyNodeType')).toBe(false);
    }
  });

  it('谜题 answer 在新旧两版响应中均被 stripAnswers 脱敏（不回归）', async () => {
    for (const version of [undefined, '1.0.1', '1.1.0']) {
      const { body, byId } = await getNodes(version);
      // single 题答案脱敏为空串（不是删除 puzzle 对象 —— 题目本身仍要下发）。
      expect(byId[N_PUZZLE].puzzle.answer).toBe('');
      expect(byId[N_PUZZLE].puzzle.question).toBe('口令？');
      // 历史行挂的谜题同样脱敏（无论旧版收到什么 nodeType）。
      expect(byId[N_LEGACY_NPC].puzzle.answer).toBe('');
      expect(byId[N_LEGACY_SCENE_PZ].puzzle.answer).toBe('');
      expect(JSON.stringify(body)).not.toContain(ANSWER_SENTINEL);
    }
  });
});
