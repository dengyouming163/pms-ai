// 扫码入口端点。**判据设计说明（很重要）**：
// 「不存在的码 → 404」这条用例**证明不了端点写对了** —— 端点整个没实现时，
// Hono 也会返回 404（而且把 /enter 追加到文件末尾、被 /:id 吃掉时，也是 404）。
// 所以真正的判据是那条「码有效 → 200 且 body 带 venue/point/candidates」，
// 它只在路由顺序正确、查询真的跑通时才绿。
// 防御性兜底：显式清掉旁路 env。同目录 wenlv.test.ts 设了 WENLV_BYPASS_TICKET=1 会跨文件泄漏；
// 本端点是**纯查询**、根本不读该 env（它只影响 assertTicket），留着会让后来人误以为付费墙被旁路。
delete process.env.WENLV_BYPASS_TICKET;
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvScenes, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters,
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints,
  pmsBuiWenlvSessions, pmsBuiWenlvProgress,
} from '../../../db/schema/index.js';

const mkMini = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json' };
};

// 把 checkTicket 的上游（pms-platform-server）钉死为指定结局。
// 不桩的话本机 PLATFORM_SERVER_URL 不可达 ⇒ 永远落到 unknown 分支，三态只能测到一个取值。
// 写法照抄同目录 wenlv-m5.test.ts 的先例。
const jsonResp = (obj: any) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
function stubTicketUpstream(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe.skipIf(!process.env.RUN_DB)('wenlv 扫码入口 /enter', () => {
  const TS = Date.now();
  const VENUE = `ven-enter-${TS}`;
  const POINT = `pt-enter-${TS}`;
  const CODE = `ENT-${TS}`;
  const PUB = `prod-enter-pub-${TS}`;
  const DRAFT = `prod-enter-draft-${TS}`;
  const UNRELATED = `prod-enter-unrel-${TS}`;
  const FREE = `prod-enter-free-${TS}`;
  const H = mkMini('u-enter-1');

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '入口测试场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: POINT, venueId: VENUE, name: '入口测试点位', code: CODE, sortOrder: 1 });
    await db.insert(pmsBuiWenlvProducts).values([
      { id: PUB, name: '已发布剧本', status: 'published' },
      { id: DRAFT, name: '草稿剧本', status: 'draft' },
      { id: UNRELATED, name: '不挂点位的已发布剧本', status: 'published' },
      { id: FREE, name: '免费剧本', status: 'published', isFree: true },
    ]);
    // 每个产品建一个剧本房 + 章节，再挂场景（新模型：nodes→scenes）。
    const sceneInserts: any[] = [];
    for (const [pid, withPoint] of [[PUB, true], [DRAFT, true], [UNRELATED, false], [FREE, true]] as const) {
      const rid = `room-${pid}`, cid = `ch-${pid}`;
      await db.insert(pmsBuiWenlvScriptRooms).values({ id: rid, contentId: pid, name: `${pid} 房` });
      await db.insert(pmsBuiWenlvChapters).values({ id: cid, scriptRoomId: rid, title: '第一章', order: 0 });
      sceneInserts.push({
        id: `n-${pid}-${TS}`, chapterId: cid, type: 'narrative', title: '开场',
        venuePointId: withPoint ? POINT : null, order: 1,
      });
    }
    await db.insert(pmsBuiWenlvScenes).values(sceneInserts);
  });

  afterAll(async () => {
    const rids = [`room-${PUB}`, `room-${DRAFT}`, `room-${UNRELATED}`, `room-${FREE}`];
    const cids = [`ch-${PUB}`, `ch-${DRAFT}`, `ch-${UNRELATED}`, `ch-${FREE}`];
    await db.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.chapterId, cids));
    await db.delete(pmsBuiWenlvChapters).where(inArray(pmsBuiWenlvChapters.id, cids));
    await db.delete(pmsBuiWenlvScriptRooms).where(inArray(pmsBuiWenlvScriptRooms.id, rids));
    await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, [PUB, DRAFT, UNRELATED, FREE]));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, POINT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  it('未登录返回 401', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CODE}`);
    expect(res.status).toBe(401);
  });

  it('缺 c 返回 400', async () => {
    const res = await wenlvRoute.request('/enter', { headers: H });
    expect(res.status).toBe(400);
  });

  it('不存在的码返回 404，且是**本端点的**业务文案（不是被 /:id 吃掉的「产品不存在」）', async () => {
    const res = await wenlvRoute.request('/enter?c=NO-SUCH-CODE', { headers: H });
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.success).toBe(false);
    // 路由错序时 /:id 会回「产品不存在」—— 断文案才能真正区分这两条路径
    expect(b.error).not.toBe('产品不存在');
  });

  // ★ 这条才是真判据：路由顺序错（被 /:id 吃掉）时它必红。
  it('码有效 → 200，且带 venue / point / candidates', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.venue?.id).toBe(VENUE);
    expect(b.data.point?.id).toBe(POINT);
    expect(Array.isArray(b.data.candidates)).toBe(true);
  });

  it('候选只含「挂了该点位 + 已发布」的产品（draft 与不挂点位都被排除）', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    const b = await res.json();
    const ids = b.data.candidates.map((x: any) => x.contentProductId);
    expect(ids).toContain(PUB);
    expect(ids).not.toContain(DRAFT);
    expect(ids).not.toContain(UNRELATED);
  });

  // 与 spec 的有意偏离：候选**不按有无门票过滤**，只标注 hasTicket。
  // 否则「码没挂剧本」与「有剧本但没票」会塌成同一个空列表，入口页只能显示一句话，必错其一。
  //
  // hasTicket 是**三态**（true 有票／false 确定没票／null 问不到 —— 上游故障）。
  // 三条用例缺一不可：只测 boolean 会恒测到 unknown 折叠后的那一个取值。
  afterEach(() => { vi.unstubAllGlobals(); });

  it('hasTicket=true：上游明确有票', async () => {
    stubTicketUpstream(async () => jsonResp({ success: true, data: { valid: true, ticketId: 't1' } }));
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    const b = await res.json();
    const cand = b.data.candidates.find((x: any) => x.contentProductId === PUB);
    expect(cand.hasTicket).toBe(true);
  });

  it('hasTicket=false：上游明确无票，且该候选仍在列表里（不过滤）', async () => {
    stubTicketUpstream(async () => jsonResp({ success: true, data: { valid: false } }));
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    const b = await res.json();
    const cand = b.data.candidates.find((x: any) => x.contentProductId === PUB);
    expect(cand).toBeTruthy();
    expect(cand.hasTicket).toBe(false);
  });

  // ★ I-1 的判据：上游问不到时必须 null，绝不能折成 false。
  // 折成 false ⇒ 持票游客在 BFF 抖动时看到「你没买票 + 去购买」⇒ 重复购票；且同一次故障下全站游客同此。
  it('hasTicket=null：上游故障（问不到）绝不折成 false', async () => {
    stubTicketUpstream(async () => { throw new Error('ECONNREFUSED 模拟 BFF 抖动'); });
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    const b = await res.json();
    const cand = b.data.candidates.find((x: any) => x.contentProductId === PUB);
    expect(cand.hasTicket).toBeNull();
  });

  // ★ 免费剧本**没有任何票可查**：入口页不能对它显示「你还没有门票 + 去购买」。
  // 两条判据缺一不可 ——
  //   ① hasTicket 必须是 true。坏实现会走 checkTicket，而下面这个桩给 valid:false
  //      ⇒ 前端落 kind:'purchase' ⇒ 免费剧本在扫码入口被说成「去购买」。
  //   ② 不得为它发跨服务请求（与 assertTicket 免费分支同一条语义）。
  it('免费剧本（isFree）恒 hasTicket=true，且不为它发跨服务请求', async () => {
    const mock = vi.fn(async () => jsonResp({ success: true, data: { valid: false } }));
    vi.stubGlobal('fetch', mock);
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    const b = await res.json();
    const cand = b.data.candidates.find((x: any) => x.contentProductId === FREE);
    expect(cand, '免费剧本必须在候选列表里（只标注、不过滤）').toBeTruthy();
    expect(cand.hasTicket, '免费剧本被要求买票 ⇒ 前端会渲染「去购买」').toBe(true);
    const urls = mock.mock.calls.map((c: any) => String(c[0]));
    expect(urls.some((u: string) => u.includes(FREE)), '免费剧本不该产生跨服务请求').toBe(false);
  });

  it('点位存在但没有任何剧本挂它 → 200 + 空候选（不是 404）', async () => {
    const LONE = `pt-lone-${TS}`;
    const LONE_CODE = `LONE-${TS}`;
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: LONE, venueId: VENUE, name: '孤立点位', code: LONE_CODE, sortOrder: 2 });
    const res = await wenlvRoute.request(`/enter?c=${LONE_CODE}`, { headers: H });
    expect(res.status).toBe(200);
    expect((await res.json()).data.candidates).toEqual([]);
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, LONE));
  });

  // M-5：短码生成器产出大写，游客手输常写成小写。
  // 精确未命中时大小写不敏感兜底 —— 否则「码有效、只是大小写不对」被说成「码无效」，
  // 还把游客推给现场工作人员（B5 把 H5 手动输码作为兜底加了回来，正是会踩的场景）。
  it('小写短码走大小写不敏感兜底，命中的是同一个点位', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CODE.toLowerCase()}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.point?.id).toBe(POINT);
  });

  // M-10：同一张二维码所有游客 URL 相同，一旦被 nginx 缓存会把第一个游客的 hasTicket 回放给后来者。
  it('200 响应带 Cache-Control: no-store', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('响应里不含点位短码本身（防止把它当输出回吐）', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CODE}`, { headers: H });
    const raw = await res.text();
    expect(raw).not.toContain(CODE);
  });
});

// 节点 DTO 的 requiresCredential。
// 起因：venuePointId 被服务端显式剔除（防游客免凭证远程打卡），客户端于是只能拿
// triggerType !== 'manual' 当近似 —— 而「挂了点位 + triggerType 默认 manual」的节点
// 在前端会渲染成「继续剧情」、不带凭证直接触发，必然 403。这是既有的潜在 bug。
describe.skipIf(!process.env.RUN_DB)('wenlv 节点 DTO requiresCredential', () => {
  const TS = Date.now();
  const VENUE = `ven-req-${TS}`;
  const POINT = `pt-req-${TS}`;
  const CODE = `REQ-${TS}`;
  const P_WITH = `prod-req-with-${TS}`;
  const P_MANUAL = `prod-req-manual-${TS}`;
  const H = mkMini('u-req-1');

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '凭证判定场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: POINT, venueId: VENUE, name: '凭证点位', code: CODE, sortOrder: 1 });
    await db.insert(pmsBuiWenlvProducts).values([
      { id: P_WITH, name: '挂点位剧本', status: 'published' },
      { id: P_MANUAL, name: '纯手动剧本', status: 'published' },
    ]);
    // 建剧本房 + 章节
    for (const pid of [P_WITH, P_MANUAL]) {
      await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${pid}`, contentId: pid, name: `${pid} 房` });
      await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${pid}`, scriptRoomId: `room-${pid}`, title: '第一章', order: 0 });
    }
    await db.insert(pmsBuiWenlvScenes).values([
      // 关键：挂了点位（nodeRequiresCredential 仅看 venuePointId）
      { id: `n-with-${TS}`, chapterId: `ch-${P_WITH}`, type: 'narrative', title: '到场点', venuePointId: POINT, order: 1 },
      { id: `n-manual-${TS}`, chapterId: `ch-${P_MANUAL}`, type: 'narrative', title: '纯剧情', order: 1 },
      // 未绑点位 → requiresCredential=false（新模型无 triggerCredential 列）
      { id: `n-legacy-${TS}`, chapterId: `ch-${P_MANUAL}`, type: 'narrative', title: '旧式扫码点', order: 2 },
    ]);
  });

  afterAll(async () => {
    const cids = [`ch-${P_WITH}`, `ch-${P_MANUAL}`];
    const rids = [`room-${P_WITH}`, `room-${P_MANUAL}`];
    await db.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.chapterId, cids));
    await db.delete(pmsBuiWenlvChapters).where(inArray(pmsBuiWenlvChapters.id, cids));
    await db.delete(pmsBuiWenlvScriptRooms).where(inArray(pmsBuiWenlvScriptRooms.id, rids));
    await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, [P_WITH, P_MANUAL]));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, POINT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  it('挂了点位的节点 requiresCredential=true（即便 triggerType 是默认 manual）', async () => {
    const res = await wenlvRoute.request(`/${P_WITH}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    const n = b.data.nodes.find((x: any) => x.id === `n-with-${TS}`);
    expect(n.requiresCredential).toBe(true);
  });

  it('纯手动节点 requiresCredential=false', async () => {
    const res = await wenlvRoute.request(`/${P_MANUAL}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.nodes.find((x: any) => x.id === `n-manual-${TS}`).requiresCredential).toBe(false);
  });

  // 第三象限：未绑点位的节点 → requiresCredential=false。
  // 新模型 nodeRequiresCredential 仅看 venuePointId（旧 triggerCredential 列已随 nodes 表退役）。
  it('未绑点位的节点 → requiresCredential=false', async () => {
    const res = await wenlvRoute.request(`/${P_MANUAL}`, { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.nodes.find((x: any) => x.id === `n-legacy-${TS}`).requiresCredential).toBe(false);
  });

  it('venuePointId、triggerCredential 与点位短码仍然不下发（老约束不能被顺手破坏）', async () => {
    const res = await wenlvRoute.request(`/${P_WITH}`, { headers: H });
    const raw = await res.text();
    expect(raw).not.toContain('venuePointId');
    expect(raw).not.toContain('triggerCredential');
    expect(raw).not.toContain(POINT);
    // 点位码是**唯一的到场秘密**：location 投影时误取 code 列（而非 name）是极真实的失手，
    // 且会让公开详情把凭证发给每个游客。这条断言非恒真 —— CODE 与响应里可见的 id 同批生成。
    expect(raw).not.toContain(CODE);
  });
});

// ── 队伍码（P2 §三「码即身份」）────────────────────────────────────────────────
// 判据设计：**必须有一条「同字码」用例**。两族字符集有重叠（点位码 32 个字符、队伍码 31 个），
// 「先查 sessions」这个顺序是 spec 明写的决策；只测「队伍码能命中」的话，把两条分支**调换**
// 也照样全绿（点位表里没有这个码 ⇒ 兜底到 sessions）。同字码那一条才钉住顺序。
describe.skipIf(!process.env.RUN_DB)('wenlv 扫码入口 /enter —— 队伍码', () => {
  const TS = Date.now();
  const PROD = `prod-team-${TS}`;
  const SES = `ses-team-${TS}`;
  const SES_CLOSED = `ses-team-closed-${TS}`;
  const COLL = `pt-team-collide-${TS}`;
  const VENUE = `ven-team-${TS}`;
  const TEAM_CODE = `TM${String(TS).slice(-6)}`;        // 8 位，与真码同形
  const CLOSED_CODE = `TC${String(TS).slice(-6)}`;
  // 补判据用 fixtures：空队 / 两条只差大小写的队 / productId 悬空的队
  const SES_EMPTY = `ses-team-empty-${TS}`;
  const EMPTY_CODE = `TE${String(TS).slice(-6)}`;
  const SES_CASE_A = `ses-team-caseA-${TS}`;
  const SES_CASE_B = `ses-team-caseB-${TS}`;
  // 尾巴带 `${TS}`：硬崩（进程被杀）残留的行 id 是上一轮的 TS、`afterAll` 按本轮 id 删不到，
  // 下次 `beforeAll` 再插同一个码就会撞 `uq_wenlv_sessions_code` ⇒ 整个 describe 起不来。
  // 尾巴只用**数字**（无大小写）⇒ A/B 仍「仅差大小写」。
  const CASE_TAIL = String(TS).slice(-4);
  const CASE_CODE_A = `XXabcd${CASE_TAIL}`;   // 与 B **仅差大小写**；`uq_wenlv_sessions_code` 大小写敏感 ⇒ 两行可共存
  const CASE_CODE_B = `XXABCD${CASE_TAIL}`;
  const SES_ORPHAN = `ses-team-orphan-${TS}`;
  const ORPHAN_CODE = `TO${String(TS).slice(-6)}`;
  const MISSING_PROD = `prod-missing-${TS}`;   // **永不插入**：模拟产品行物理缺失（不是软删/下架）
  const H_JOINED = mkMini('u-team-1');   // 已在队里（有 progress 行）
  const H_NEW = mkMini('u-team-9');      // 不在队里

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '团队剧本', status: 'published' });
    await db.insert(pmsBuiWenlvSessions).values([
      { id: SES, productId: PROD, orderId: randomUUID(), code: TEAM_CODE, seq: 2, name: '第 2 队', status: 'forming' },
      { id: SES_CLOSED, productId: PROD, orderId: randomUUID(), code: CLOSED_CODE, seq: 3, name: '第 3 队', status: 'closed' },
      // 空队：**不**给它插 progress 行 ⇒ memberCount 必须是 0（钉 memberCount **取值**：空队恰为 0）
      { id: SES_EMPTY, productId: PROD, orderId: randomUUID(), code: EMPTY_CODE, seq: 4, name: '空队', status: 'forming' },
      // 仅差大小写的两支队：第三种写法会同时命中两条 ⇒ 必须「不猜」
      { id: SES_CASE_A, productId: PROD, orderId: randomUUID(), code: CASE_CODE_A, seq: 5, name: '近失 A', status: 'forming' },
      { id: SES_CASE_B, productId: PROD, orderId: randomUUID(), code: CASE_CODE_B, seq: 6, name: '近失 B', status: 'forming' },
      // productId 指向**不存在**的产品行（MISSING_PROD 永不插入）⇒ data.product 恰为 null
      { id: SES_ORPHAN, productId: MISSING_PROD, orderId: randomUUID(), code: ORPHAN_CODE, seq: 7, name: '悬空队', status: 'forming' },
    ]);
    // 两名队员（其中一名是 H_JOINED）
    await db.insert(pmsBuiWenlvProgress).values([
      { id: `pg-team-a-${TS}`, productId: PROD, miniUserId: 'u-team-1', sessionId: SES },
      { id: `pg-team-b-${TS}`, productId: PROD, miniUserId: 'u-team-2', sessionId: SES },
    ]);
    // 同字码：一个**点位**用了与 SES 完全相同的码。⚠️ `pms_bui_wenlv_venue_points.code` **有**唯一索引
    //（`uq_wenlv_venue_points_code`，schema `wenlv.ts:483`）—— 造得出来是因为**本表内只有这一行**用它。
    //（原稿此处写「点位表的 code 没有唯一索引 ⇒ 构造得出来」是假机制句；别据此以为能并发造同码点位。）
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '同字码场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: COLL, venueId: VENUE, name: '同字码点位', code: TEAM_CODE, sortOrder: 1 });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(inArray(pmsBuiWenlvProgress.productId, [PROD]));
    await db.delete(pmsBuiWenlvSessions).where(inArray(pmsBuiWenlvSessions.id, [SES, SES_CLOSED, SES_EMPTY, SES_CASE_A, SES_CASE_B, SES_ORPHAN]));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, COLL));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
  });

  it('命中队伍码 ⇒ kind=team 且队名/第几队/人数/joined 都对，且**不带** candidates', async () => {
    const res = await wenlvRoute.request(`/enter?c=${TEAM_CODE}`, { headers: H_JOINED });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.kind).toBe('team');
    expect(body.data.team).toMatchObject({
      sessionId: SES, seq: 2, name: '第 2 队', code: TEAM_CODE, status: 'forming',
      memberCount: 2, joined: true,
    });
    // ⚠️ 计划 Step 5 原文写 `contentProductId`，与本计划 Step 7 的 select（键为 `id`）及计划的 DTO
    //    契约 `EnterTeamProduct { id: string; … }`（「`id` 就是内容产品 id」）冲突 ⇒ 按契约取 `id`。
    expect(body.data.product).toMatchObject({ id: PROD, name: '团队剧本' });
    // 负判据：走了点位通道的话这里会多出 venue/point/candidates
    expect(body.data.candidates).toBeUndefined();
    expect(body.data.point).toBeUndefined();
  });

  it('joined 读的是**他自己那行**（不是「队里有没有人」）', async () => {
    const res = await wenlvRoute.request(`/enter?c=${TEAM_CODE}`, { headers: H_NEW });
    const body: any = await res.json();
    // 人数仍是 2（不是 3，也不是 0）—— 与 joined 来自两个不同的查询
    expect(body.data.team).toMatchObject({ memberCount: 2, joined: false });
  });

  it('小写手输 ⇒ 大小写不敏感兜底命中同一支队，且回传的是库里的大写码', async () => {
    const res = await wenlvRoute.request(`/enter?c=${TEAM_CODE.toLowerCase()}`, { headers: H_NEW });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.team.sessionId).toBe(SES);
    expect(body.data.team.code).toBe(TEAM_CODE);
  });

  it('🔴 同字码：队伍码**优先于**点位码（两条分支的顺序就是这条判据）', async () => {
    const res = await wenlvRoute.request(`/enter?c=${TEAM_CODE}`, { headers: H_NEW });
    const body: any = await res.json();
    expect(body.data.kind, '同字码时走了点位通道 ⇒ /enter 里的分支顺序被调换了').toBe('team');
  });

  it('已封口的队仍能解析（200 且回传 status），由页面决定是否禁用「加入」', async () => {
    const res = await wenlvRoute.request(`/enter?c=${CLOSED_CODE}`, { headers: H_NEW });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.team).toMatchObject({ sessionId: SES_CLOSED, status: 'closed', joined: false });
  });

  // ── 复核补的三条：各钉住实现里的一行 ────────────────────────────────────────

  // 钉 memberCount 的**取值**：空队（没有任何 progress 行）时必须是数字 0，不是 null/undefined。
  // ⚠️ 实测（定向变异）：本行虽是 `Number(cntRow?.c ?? 0)`，但 `count()` 是聚合 ⇒ 零匹配也**恒返回一行**
  //   （drizzle 的 `count()` 自带 `.mapWith(Number)`）⇒ `?.` 与 `?? 0` **都不可达**，删掉 `?? 0`
  //   这条**不会**红。它真正钉的是「值恰为 0」这个观测契约 —— 把 `Number()` 换成 `String()`（得 `'0'`）
  //   这条就红。既有的 SES_CLOSED 那条不断 memberCount，所以这是唯一钉该取值的用例。
  it('空队：memberCount 恰为 0（钉 memberCount 的取值）', async () => {
    const res = await wenlvRoute.request(`/enter?c=${EMPTY_CODE}`, { headers: H_NEW });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.kind).toBe('team');
    // toBe(0) 而不是 toBeFalsy()：null / undefined 都要被判红
    expect(body.data.team.memberCount).toBe(0);
  });

  // 钉 `limit(2)` + `near.length === 1`。库里两条 session **仅差大小写**（唯一索引大小写敏感 ⇒ 可共存），
  // 用第三种写法查：精确匹配两条都不中，`upper` 之后**两条都中** ⇒ 长度 2 ⇒ 必须「不猜」（宁可不命中）。
  // 把 `=== 1` 放宽成 `>= 1`、或把 `limit(2)` 收紧成 `limit(1)`，这条都会命中队伍通道 ⇒ 红。
  it('大小写近失「不猜」：两条 session 仅差大小写 ⇒ 不落队伍通道（钉 `limit(2)` + `near.length === 1`）', async () => {
    const res = await wenlvRoute.request(`/enter?c=xxAbCd${CASE_TAIL}`, { headers: H_NEW });
    // 落到原有的点位/产品解析通道：该码不在点位表里 ⇒ 端点自己的 404（写死期望值，不用「不是队伍通道」这类软判据）
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('这个码无效或已更换，请找现场工作人员');
  });

  // 钉 `prod ?? null`。session.productId 指向**物理不存在**的产品行（不是软删 status='deleted'，
  // 也不是下架 draft/archived —— 那两种行还在，摘要照常回传）⇒ data.product 必须恰为 `null`。
  // 改成 `product: prod` 时该键会从 JSON 里整个**消失**（undefined 被 stringify 丢掉）⇒ 红。
  it('产品行**物理缺失** ⇒ data.product 恰为 null（钉 `prod ?? null`）', async () => {
    const res = await wenlvRoute.request(`/enter?c=${ORPHAN_CODE}`, { headers: H_NEW });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.kind).toBe('team');
    expect(body.data.product).toBeNull();
  });
});
