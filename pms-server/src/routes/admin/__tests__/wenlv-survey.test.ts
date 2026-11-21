import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints, pmsBuiWenlvCultureMaterials,
  pmsBuiWenlvProducts, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes,
} from '../../../db/schema/index.js';
import { eq } from 'drizzle-orm';

// ── 0079 统一模型辅助 ──
async function ensureChapter(db: any, productId: string): Promise<string> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.insert(pmsBuiWenlvScriptRooms).values({ id: rid, contentId: productId, name: `${productId} 房` })
    .onConflictDoNothing({ target: pmsBuiWenlvScriptRooms.id });
  await db.insert(pmsBuiWenlvChapters).values({ id: cid, scriptRoomId: rid, title: '第一章', order: 0 })
    .onConflictDoNothing({ target: pmsBuiWenlvChapters.id });
  return cid;
}

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const get = (p: string) => adminWenlvRoute.request(p, { headers: H });
const post = (p: string, body: unknown) => adminWenlvRoute.request(p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const patch = (p: string, body: unknown) => adminWenlvRoute.request(p, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
const del = (p: string) => adminWenlvRoute.request(p, { method: 'DELETE', headers: H });

describe('wenlv 文化素材端点（守卫，无库）', () => {
  it('无内部 token 返回 403', async () => {
    const res = await adminWenlvRoute.request('/venues/v1/materials', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 文化素材 CRUD', () => {
  const U = Date.now();
  const V = `mat-venue-${U}`;
  const V2 = `mat-venue2-${U}`;
  const PT = `mat-point-${U}`;
  let m1 = '';
  let mPointed = '';

  beforeAll(async () => {
    // 先子后父清残留，保证崩溃/重跑幂等
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V2));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V2));
    await db.insert(pmsBuiWenlvVenues).values([{ id: V, name: '素材测试场地' }, { id: V2, name: '另一场地' }]);
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT, venueId: V, name: '素材测试点位' });
  });

  it('GET 不存在场地的素材 → 404（不是 200 + []）', async () => {
    const res = await get('/venues/no-such-venue-xyz/materials');
    expect(res.status).toBe(404);
    expect((await res.json()).success).toBe(false);
  });

  it('POST 缺 title 返回 400（zod）', async () => {
    const res = await post(`/venues/${V}/materials`, { type: 'history', content: '内容' });
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });

  it('POST 非法 type 返回 400（枚举）', async () => {
    const res = await post(`/venues/${V}/materials`, { type: 'not-a-type', title: 'x', content: 'y' });
    expect(res.status).toBe(400);
  });

  it('POST 场地级素材成功，venuePointId 为 null', async () => {
    const res = await post(`/venues/${V}/materials`, {
      type: 'history', title: '古井由来', content: '相传开凿于明末。', source: '村志',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.type).toBe('history');
    expect(b.data.venueId).toBe(V);
    expect(b.data.venuePointId).toBeNull();
    m1 = b.data.id;
  });

  it('POST 绑点位的素材成功，venuePointId 落库', async () => {
    const res = await post(`/venues/${V}/materials`, {
      type: 'legend', title: '井神传说', content: '夜里能听见井中有歌声。', venuePointId: PT,
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.venuePointId).toBe(PT);
    mPointed = b.data.id;
  });

  it("POST venuePointId='' 归一为 SQL NULL（Radix Select 哨兵形态）", async () => {
    const res = await post(`/venues/${V}/materials`, {
      type: 'other', title: '空串点位', content: 'x', venuePointId: '',
    });
    expect(res.status).toBe(200);
    const id = (await res.json()).data.id;
    const [row] = await db.select().from(pmsBuiWenlvCultureMaterials)
      .where(eq(pmsBuiWenlvCultureMaterials.id, id)).limit(1);
    // 响应 JSON 里 null 与 '' 看不出差别，必须打在 DB 行上
    expect(row.venuePointId).toBeNull();
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.id, id));
  });

  it('POST 绑不属于本场地的点位 → 400（不留跨场地脏引用）', async () => {
    const res = await post(`/venues/${V2}/materials`, {
      type: 'history', title: '跨场地', content: 'x', venuePointId: PT,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('点位');
  });

  it('GET 列表按 sortOrder 升序，且只回本场地的', async () => {
    await post(`/venues/${V}/materials`, { type: 'craft', title: '排序大', content: 'x', sortOrder: 20 });
    await post(`/venues/${V}/materials`, { type: 'craft', title: '排序小', content: 'x', sortOrder: 10 });
    const res = await get(`/venues/${V}/materials`);
    expect(res.status).toBe(200);
    const list = (await res.json()).data as any[];
    expect(list.every((m) => m.venueId === V)).toBe(true);
    const iSmall = list.findIndex((m) => m.title === '排序小');
    const iBig = list.findIndex((m) => m.title === '排序大');
    // 布尔断言而非 toBeLessThan：本文件既有写法。
    // ⚠️ 2026-09-19 更正：原注释给的理由（「桩未声明该匹配器」）已不成立 ——
    //    toBeLessThan 自 d5a65359 起已在桩内。是否可用以 src/types/vitest.d.ts 为准。
    expect(iSmall >= 0 && iBig >= 0 && iSmall < iBig).toBe(true);
  });

  it('PATCH 就地改 title/content，且未传的字段不被重置', async () => {
    const res = await patch(`/materials/${m1}`, { title: '古井由来（订正）' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.title).toBe('古井由来（订正）');
    expect(b.data.content).toBe('相传开凿于明末。'); // 未传就不动
    expect(b.data.type).toBe('history');
  });

  it('PATCH 传 venuePointId=null 把点位素材降级为场地级', async () => {
    const res = await patch(`/materials/${mPointed}`, { venuePointId: null });
    expect(res.status).toBe(200);
    expect((await res.json()).data.venuePointId).toBeNull();
    await patch(`/materials/${mPointed}`, { venuePointId: PT }); // 复原，供后面删点位的用例使用
  });

  it('PATCH 不存在 → 404', async () => {
    const res = await patch('/materials/no-such-material', { title: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE 后行真的消失', async () => {
    const mk = await post(`/venues/${V}/materials`, { type: 'other', title: '待删', content: 'x' });
    const id = (await mk.json()).data.id;
    const res = await del(`/materials/${id}`);
    expect(res.status).toBe(200);
    const rows = await db.select().from(pmsBuiWenlvCultureMaterials)
      .where(eq(pmsBuiWenlvCultureMaterials.id, id));
    expect(rows.length).toBe(0);
  });

  it('DELETE 不存在 → 404', async () => {
    const res = await del('/materials/no-such-material');
    expect(res.status).toBe(404);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V2));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V2));
  });
});

// 调研落地来源（`research_id`）：素材/点位由「场地网络调研」一键落地时带上来源 id。
// 独立 describe + 独立夹具：不借用相邻 describe 的场地/点位，避免一处 beforeAll 失败
// 连带把不相关的用例判红。
describe.skipIf(!process.env.RUN_DB)('wenlv 素材/点位的调研落地来源 researchId', () => {
  const U = Date.now();
  const V = `res-venue-${U}`;

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, V));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '调研落地测试场地' });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, V));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });

  it('POST 素材带 researchId ⇒ 落库，且**回读路径**也带得出来', async () => {
    const res = await post(`/venues/${V}/materials`, {
      type: 'legend', title: '调研来的传说', content: '正文', researchId: 'res-abc',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.researchId).toBe('res-abc');
    // 回读走 GET（`db.select()` 全列）⇒ 新列自动带出。这条断言是那个前提的回归闸：
    // 哪天有人把 GET 改成显式列清单，这里会红，而不是静默变 undefined。
    const list = await (await get(`/venues/${V}/materials`)).json();
    const hit = (list.data as any[]).find((m) => m.id === b.data.id);
    expect(hit.researchId).toBe('res-abc');
  });

  it('POST 素材不带 researchId ⇒ 落成 null（人工创建，不是「调研来的」）', async () => {
    const res = await post(`/venues/${V}/materials`, { type: 'other', title: '人工素材', content: '正文' });
    expect(res.status).toBe(200);
    const b = await res.json();
    // null 而不是 undefined：undefined 在 JSON 里会被整个丢掉，客户端就分不出
    // 「这一列不存在」与「这条不是调研来的」。
    expect(b.data.researchId).toBeNull();
  });

  it('POST 点位带 researchId 且 code: null ⇒ 落库；无码是**合法**形态', async () => {
    const res = await post(`/venues/${V}/points`, { name: '调研点位', code: null, researchId: 'res-abc' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.researchId).toBe('res-abc');
    // 前提核验（不靠注释推断）：`pointCodeSchema` 若把 null 归一成别的东西，这条会红。
    // 调研来的点位**还没到现场**，不该因为它自动生成一个可印出去的码。
    expect(b.data.code).toBeNull();
    const back = await (await get(`/venues/${V}/points`)).json();
    const row = (back.data as any[]).find((p) => p.name === '调研点位');
    expect(row.researchId).toBe('res-abc');
  });

  it('POST 点位不带 researchId ⇒ 落成 null', async () => {
    const res = await post(`/venues/${V}/points`, { name: '人工点位' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.researchId).toBeNull();
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 点位照片与删点位素材降级', () => {
  const U = Date.now();
  const V = `photo-venue-${U}`;
  const PT = `photo-point-${U}`;
  const PROD = `photo-prod-${U}`;
  const NODE = `photo-node-${U}`;

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, NODE));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '照片测试场地' });
  });

  it('POST 建点位带 photos，回读等值', async () => {
    const photos = ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'];
    const res = await post(`/venues/${V}/points`, { id: PT, name: '带照片点位', photos });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.photos).toEqual(photos);
    const back = await get(`/venues/${V}/points`);
    const row = ((await back.json()).data as any[]).find((p) => p.id === PT);
    expect(row.photos).toEqual(photos);
  });

  it('PATCH 只改 name 不会清空 photos', async () => {
    const res = await patch(`/points/${PT}`, { name: '带照片点位（改名）' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.name).toBe('带照片点位（改名）');
    expect(b.data.photos.length).toBe(2);
  });

  it('PATCH photos=[] 落成空数组（撤下全部照片是合法动作）', async () => {
    const res = await patch(`/points/${PT}`, { photos: [] });
    expect(res.status).toBe(200);
    expect((await res.json()).data.photos).toEqual([]);
  });

  it('删除被节点引用的点位仍返回 409（既有守卫不被本轮改动破坏）', async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '占位剧本' }).onConflictDoNothing();
    const ch = await ensureChapter(db, PROD);
    await db.insert(pmsBuiWenlvScenes).values({
      id: NODE, chapterId: ch, type: 'narrative', title: '引用点位的节点', venuePointId: PT,
    }).onConflictDoNothing();
    const res = await del(`/points/${PT}`);
    expect(res.status).toBe(409);
  });

  it('删除点位时，绑该点位的素材降级为场地级（venuePointId 置 NULL），素材本身不删', async () => {
    const mk = await post(`/venues/${V}/materials`, {
      type: 'legend', title: '要降级的素材', content: 'x', venuePointId: PT,
    });
    expect(mk.status).toBe(200);
    const mid = (await mk.json()).data.id;

    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, NODE)); // 解掉节点引用才能删点位
    const res = await del(`/points/${PT}`);
    expect(res.status).toBe(200);

    // 空断言警戒：光断言「点位没了」测不出降级。必须同时断两件事：
    const [row] = await db.select().from(pmsBuiWenlvCultureMaterials)
      .where(eq(pmsBuiWenlvCultureMaterials.id, mid)).limit(1);
    expect(row).toBeTruthy();          // ① 素材还在（不是被级联删掉）
    expect(row.venuePointId).toBeNull(); // ② 引用被降级成场地级

    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.id, mid));
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, NODE));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

// 采集人归属（迁移 0026）：BFF 从已验签 JWT 取出 userId 放进 X-Platform-User-Id 透传过来。
// 断言必须打在 **DB 行**上——响应回显只能证明「解析出的对象里有这个字段」，
// 证明不了它真的落进了 created_by 列（schema 里声明了列名但 insert 漏写，响应照样正确）。
describe.skipIf(!process.env.RUN_DB)('wenlv 采集人归属 created_by', () => {
  const U = Date.now();
  const V = `attr-venue-${U}`;
  const PT = `attr-point-${U}`;
  const H_ATTR = { ...H, 'X-Platform-User-Id': 'pu-123' };
  const postAs = (p: string, body: unknown, h: Record<string, string>) =>
    adminWenlvRoute.request(p, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const patchAs = (p: string, body: unknown, h: Record<string, string>) =>
    adminWenlvRoute.request(p, { method: 'PATCH', headers: h, body: JSON.stringify(body) });

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '归属测试场地' });
  });

  it('建点位时把请求头里的采集人落进 created_by 列', async () => {
    const res = await postAs(`/venues/${V}/points`, { id: PT, name: '归属点位' }, H_ATTR);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, PT)).limit(1);
    expect(row.createdBy).toBe('pu-123');
  });

  it('不带请求头时 created_by 为 NULL（内部服务直连 / 历史行的语义）', async () => {
    const other = `${PT}-anon`;
    const res = await post(`/venues/${V}/points`, { id: other, name: '无采集人点位' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, other)).limit(1);
    // 空串与 NULL 是两种语义，但这里必须落 NULL —— 空串会变成「一个叫 '' 的采集人」，
    // 对任何按 created_by 分组的统计都是一个幽灵分组。
    expect(row.createdBy).toBeNull();
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, other));
  });

  it('PATCH 点位**改不动** created_by（归属是既成事实）', async () => {
    // 换一个「采集人」来改：若能改成功，说明 update 白名单里混进了 createdBy
    const res = await patchAs(`/points/${PT}`, { name: '归属点位（改名）', createdBy: 'pu-hacker' }, H_ATTR);
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('归属点位（改名）');
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, PT)).limit(1);
    expect(row.createdBy).toBe('pu-123'); // 仍是原采集人，不是 pu-hacker
  });

  it('建文化素材时同样落 created_by', async () => {
    const res = await postAs(`/venues/${V}/materials`,
      { type: 'legend', title: '归属素材', content: 'x' }, H_ATTR);
    expect(res.status).toBe(200);
    const mid = (await res.json()).data.id;
    const [row] = await db.select().from(pmsBuiWenlvCultureMaterials)
      .where(eq(pmsBuiWenlvCultureMaterials.id, mid)).limit(1);
    expect(row.createdBy).toBe('pu-123');
  });

  it('PATCH 素材**改不动** created_by', async () => {
    const mk = await postAs(`/venues/${V}/materials`,
      { type: 'legend', title: '待改素材', content: 'x' }, H_ATTR);
    const mid = (await mk.json()).data.id;
    const res = await patchAs(`/materials/${mid}`, { title: '待改素材（改名）', createdBy: 'pu-hacker' }, H_ATTR);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvCultureMaterials)
      .where(eq(pmsBuiWenlvCultureMaterials.id, mid)).limit(1);
    expect(row.createdBy).toBe('pu-123');
  });

  it('幂等重入（同 id 再 POST）不覆盖原采集人', async () => {
    // 现场 H5 断网重发是常态，重入必须保留第一次的采集人
    const res = await postAs(`/venues/${V}/points`,
      { id: PT, name: '归属点位（重入）' }, { ...H, 'X-Platform-User-Id': 'pu-other' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, PT)).limit(1);
    expect(row.createdBy).toBe('pu-123');
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvCultureMaterials).where(eq(pmsBuiWenlvCultureMaterials.venueId, V));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, V));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 产品 ai_input 输入快照', () => {
  const U = Date.now();
  const P = `aiinput-prod-${U}`;
  const V = `aiinput-venue-${U}`;

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '快照测试场地' }).onConflictDoNothing();
  });

  const SAMPLE = {
    venue: {
      id: V, name: '龙门古镇', address: '贵州省黔南州', city: '黔南',
      culture: [{ type: 'history', title: '古井由来', content: '相传开凿于明末。', source: '村志' }],
    },
    points: [
      { id: 'p-1', name: '村口老槐树', address: '村东', remark: '树下有石碑', geo: { lat: 26.1, lng: 107.2 }, photos: ['https://cdn.example.com/x.jpg'] },
    ],
  };

  it('POST /products 带 aiInput 落库并原样回读', async () => {
    const res = await post('/products', { id: P, name: '带快照剧本', aiInput: SAMPLE, venueId: V });
    expect(res.status).toBe(200);
    expect((await res.json()).data.aiInput).toEqual(SAMPLE);
    // 打在 DB 行上：响应体可能只是把请求原样回显，只有真列值能证明落库
    const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(row.aiInput).toEqual(SAMPLE);
  });

  it('POST /products 不带 aiInput 时为 null（不是 {}）', async () => {
    const id = `aiinput-none-${U}`;
    try {
      const res = await post('/products', { id, name: '无快照剧本', venueId: V });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id)).limit(1);
      // {} 会被读成「选了场地但没有素材」，null 才是「非 AI 出稿」——两者语义不同
      expect(row.aiInput).toBeNull();
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, id));
    }
  });

  it('PATCH 不传 aiInput 不会把它清空（partial 不注入）', async () => {
    const res = await patch(`/products/${P}`, { name: '带快照剧本（改名）' });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P)).limit(1);
    expect(row.aiInput).toEqual(SAMPLE);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });
});
