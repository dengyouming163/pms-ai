import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import route from '../wenlv-asset-gen.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvCollectibles, pmsBuiWenlvDesignAssets, pmsBuiWenlvScenes,
  pmsBuiWenlvChapters, pmsBuiWenlvScriptRooms, pmsBuiWenlvProducts, pmsBuiWenlvRewardTiers, pmsBuiWenlvRewards,
  pmsBuiWenlvVenues,
} from '../../../db/schema/index.js';
import { MAX_ATTEMPT } from '../../../services/wenlv/asset-gen/claim.js';
import { MAX_CANDIDATES } from '../../../services/wenlv/asset-gen/candidates.js';
import { enqueueIteration } from '../../../services/wenlv/asset-gen/enqueue.js';
import { designAssetIdFor, writeCandidate } from '../../../services/wenlv/asset-gen/candidate-store.js';
import { reviewModel } from '../../../services/wenlv/asset-gen/llm-vision.js';
import { acquire, release, _debugResetGuard } from '../../../lib/in-flight-guard.js';
import { reviewAssetJob, setAssetGenPaused } from '../../../services/wenlv-asset-gen-scheduler.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const get = (p: string) => route.request(p, { headers: H });
const post = (p: string, b: unknown) => route.request(p, { method: 'POST', headers: H, body: JSON.stringify(b) });

// 守卫的两个集合是**进程级**状态，vitest 在同一进程里跑完本文件全部用例。不清的话，
// 「上一条用例成功触发留下的 3s 冷却」会被下一条用例当成自己的前置状态 ——
// 2026-09-14 `hold` 上线后本文件 7 条变红，一半就是这条**隐式假设**塌了。
// 这里把「每个用例从干净的守卫开始」变成**显式**前提（不是默认假设）。
beforeEach(() => { _debugResetGuard(); });

describe('素材生成端点（守卫，无库）', () => {
  it('无内部 token 返回 403', async () => {
    const res = await route.request('/batch/x', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
  });
});

describe('请求体形状（无库）', () => {
  it('body 不是对象（null / true / "x" / [] / 123）→ 400，不是 500', async () => {
    // ⚠️ 这七个组合里**只有 `null` 有鉴别力**：`JSON.parse('null')` 是**成功**的
    //    （返回 null），所以 `.catch()` 不触发，`body.productId` 会抛 TypeError → 500
    //    —— 它钉的是 readJsonObject 那层对象兜底。
    //    其余几个（true / "x" / [] / 123）**测不到那层兜底**：无论有没有它，下游的
    //    `typeof body.productId === 'string'` 形状校验都会给 400（实测：把对象守卫整段删掉，
    //    只有 null 那一轮变红）。留在这里是为了钉住端点对畸形 body 的整体行为，
    //    不要再声称它们覆盖了 readJsonObject —— 那正是一条没有鉴别力的断言。
    const cases: [string, string][] = [
      ['/batch', 'null'], ['/iterate', 'null'], ['/retry', 'null'],
      ['/batch', 'true'], ['/batch', '"x"'], ['/batch', '[]'], ['/batch', '123'],
    ];
    for (const [path, body] of cases) {
      const res = await route.request(path, { method: 'POST', headers: H, body });
      expect(res.status).toBe(400);
    }
  });

  it('types 全是不认识的值 → 400「未指定要生成的素材类型」（白名单真的在滤）', async () => {
    // 与下面（需库的）ending/reward 那条成对：滤掉 ⇒ types 为空 ⇒ 400；
    // 放行 ⇒ 走到产品查询 ⇒ 404。本条钉的是 400 那一半。
    const res = await post('/batch', { productId: 'no-such-p-shape', types: ['nope'] });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('未指定要生成的素材类型');
  });

  it('candidates 非法值一律 400 —— 既不静默夹紧，也不落成「整批零张却回 200」', async () => {
    // ⛔ 不能裸转成数字：`''` **不是 nullish**，`Number(body.candidates ?? 1)` 会得到 0
    //    ⇒ candidateCount = 0 ⇒ 这一批一张都不生成、HTTP 却回 200（静默失效）；
    //    `'abc'` ⇒ NaN ⇒ 脏值落进 asset_jobs.candidate_count；
    //    `1.5` 会被下游静默 Math.floor 吞掉，而 candidates.ts 明确「入参必须是整数」。
    // 必须配**合法** types：否则先撞上 types 那条 400，根本测不到 candidates 分支。
    // 也必须在**产品查询之前**返回 —— 故本条不需要库（对照的 404 半边见需库的那条）。
    for (const bad of ['', 'abc', 0, -1, 1.5, MAX_CANDIDATES + 1] as const) {
      const res = await post('/batch', { productId: 'no-such-p-shape', types: ['background'], candidates: bad });
      expect(res.status).toBe(400);
    }
  });
});

// `/iterate` 两个新参数的**形状校验**（无库）。
// ⚠️ 这两类校验都发生在**任何 DB 访问之前**（路由里解析层在 job 查找之前，见
//    wenlv-asset-gen.ts 的 `/iterate` —— 先 jobId/guidance，再 editInputUrl/fromIndex，
//    之后才 `db.select`）。所以能进无库块：不带 RUN_DB 时默认 config 连的是 localhost 的
//    桩库，真查到 DB 会抛 ⇒ **500 而不是 400**，那会把「校验位置」这件事测糊 —— 那正是
//    本仓「路由测试的 404 死断言」同族的要求：判据必须真的打在业务分支上。
describe('POST /iterate 的参数形状（无库）', () => {
  it('editInputUrl 非字符串 → 400（不静默当没传）', async () => {
    // 静默吞掉 = 用户画了标注上传、后端收下就扔，出一张没按标注改的图且**无任何信号**。
    const res = await post('/iterate', { jobId: 'shape-x', guidance: 'y', editInputUrl: 123 });
    expect(res.status).toBe(400);
  });

  it('editInputUrl 超长（>500 码点）→ 400，而不是让 PG 22001 冒泡成 500', async () => {
    // ⚠️ 必须用**合法 http 前缀**拼长串：否则 400 可能来自形态闸，这条就测不到长度闸
    //（恒真的假判据）。长度闸承重：`edit_input_url` 是 varchar(500)，而 enqueueIteration
    // 只做 `.trim() || null`、没有任何长度钳制 —— 不设闸时超宽会 500。
    const longUrl = `https://oss.test/${'a'.repeat(500)}`;   // 516 码点
    expect(Array.from(longUrl).length).toBeGreaterThan(500);
    const res = await post('/iterate', { jobId: 'shape-x', guidance: 'y', editInputUrl: longUrl });
    expect(res.status).toBe(400);
  });

  it('fromIndex 非非负整数 → 400', async () => {
    for (const bad of [-1, 1.5, '2'] as const) {
      const res = await post('/iterate', { jobId: 'shape-x', guidance: 'y', fromIndex: bad });
      expect(res.status).toBe(400);
    }
  });
});

const run = !!process.env.RUN_DB;
const B = `ep-test-${Date.now()}`;

// 场地名取 60 码点：**合法数据**（venues.name 是 varchar(100)，routes/admin/wenlv.ts 的 zod 是 max(100)），
// 但超过 community_style_tag 的列宽 50 —— 正是 D1 那条「同一列两套规则」的触发条件。
const VEN = `${B}-ven`;
const VEN_NAME = '场'.repeat(60);
const P_NOVIS = `${B}-p-novis`;      // 无 styleBible、无锚图
const P_VIS = `${B}-p-vis`;          // 有 styleBible.artStyle、无锚图、挂 60 字场地
const P_ANCHORED = `${B}-p-anchored`; // 有 styleBible.artStyle **且有锚图** —— 钉 skipAnchorInsert 的 true 半边
const P_SB_EMPTY = `${B}-p-sb-empty`; // styleBible 为 {}
const P_SB_OK = `${B}-p-sb-ok`;       // styleBible 带 artStyle
const N_NOVIS = `${B}-n-novis`;
const N_VIS = `${B}-n-vis`;
const N_ANCHORED = `${B}-n-anchored`;
/** 图鉴条目（第 6 类素材的展开键）：挂在 P_VIS 上，供白名单用例断言按条目建 job */
const C_VIS = `${B}-c-vis`;
/** 三个新展开键（ending / reward / tier）的夹具。P_ENT **有锚图** ⇒ 不补锚图行，
 *  这样「只建出勾选的那几类」是精确可数的（补锚图会让行数多一条、把断言搅浑）。 */
const P_ENT = `${B}-p-ent`;
const E_ENT = `${B}-e-ent`;
const R_ENT = `${B}-r-ent`;
const T_ENT = `${B}-t-ent`;
/** 用例直接种下的 job 行 id（不在 productId 清理范围内） */
const JOB_IDS: string[] = [];

describe.skipIf(!run)('POST /batch 校验与展开', () => {
  const batchIds: string[] = [];
  const batchOf = (body: any): string => {
    const id = body.data.batchId as string;
    batchIds.push(id);
    return id;
  };

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: VEN, name: VEN_NAME }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvProducts).values([
      { id: P_NOVIS, name: '无基线剧本', styleBible: null, styleAnchorUrl: null },
      { id: P_VIS, name: '有基线剧本', styleBible: { artStyle: 'ink' }, styleAnchorUrl: null, venueId: VEN },
      { id: P_ANCHORED, name: '已有锚图剧本', styleBible: { artStyle: 'ink' }, styleAnchorUrl: 'https://oss.test/anchor.png' },
    ]).onConflictDoNothing();
    // 一房一章：scenes 需 chapterId
    for (const p of [P_NOVIS, P_VIS, P_ANCHORED, P_ENT]) {
      await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${p}`, contentId: p, name: `${p} 房`, mode: 'narrative' }).onConflictDoNothing();
      await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${p}`, scriptRoomId: `room-${p}`, title: '第一章', order: 0 }).onConflictDoNothing();
    }
    await db.insert(pmsBuiWenlvScenes).values([
      { id: N_NOVIS, chapterId: `ch-${P_NOVIS}`, title: '节点一', type: 'narrative', content: '井水很凉。' },
      { id: N_VIS, chapterId: `ch-${P_VIS}`, title: '节点一', type: 'narrative', content: '井水很凉。' },
      { id: N_ANCHORED, chapterId: `ch-${P_ANCHORED}`, title: '节点一', type: 'narrative', content: '井水很凉。' },
    ]).onConflictDoNothing();
    await db.insert(pmsBuiWenlvCollectibles).values({
      id: C_VIS, productId: P_VIS, name: '古井残片', description: '井底捞起的半枚铜钱。',
    }).onConflictDoNothing();
    // 三个新展开键各一条。P_ENT 挂锚图 ⇒ planBatch 不补 anchor 行，展开形状是精确的 3 行。
    await db.insert(pmsBuiWenlvProducts).values({
      id: P_ENT, name: '新实体剧本', styleBible: { artStyle: 'ink' },
      styleAnchorUrl: 'https://oss.test/anchor.png',
    }).onConflictDoNothing();
    // 结局 = scenes type='ending'
    await db.insert(pmsBuiWenlvScenes).values({
      id: E_ENT, chapterId: `ch-${P_ENT}`, title: '结局·井底', type: 'ending',
      triggerCondition: { type: 'all', conditions: [] }, content: '井底有一枚铜钱。',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvRewards).values({
      id: R_ENT, productId: P_ENT, name: '古井铜钱', description: '通关奖励。',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvRewardTiers).values({
      id: T_ENT, productId: P_ENT, name: '集齐三章', description: '集齐三枚章。',
    }).onConflictDoNothing();
  });
  afterAll(async () => {
    const ps = [P_NOVIS, P_VIS, P_ANCHORED, P_ENT];
    const chapterIds = ps.map((p) => `ch-${p}`);
    const roomIds = ps.map((p) => `room-${p}`);
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.productId, ps));
    await db.delete(pmsBuiWenlvCollectibles).where(inArray(pmsBuiWenlvCollectibles.productId, ps));
    await db.delete(pmsBuiWenlvRewards).where(inArray(pmsBuiWenlvRewards.productId, ps));
    await db.delete(pmsBuiWenlvRewardTiers).where(inArray(pmsBuiWenlvRewardTiers.productId, ps));
    await db.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
    await db.delete(pmsBuiWenlvChapters).where(inArray(pmsBuiWenlvChapters.id, chapterIds));
    await db.delete(pmsBuiWenlvScriptRooms).where(inArray(pmsBuiWenlvScriptRooms.id, roomIds));
    await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, ps));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VEN));
  });

  it('无 styleBible 的剧本要出图 → 409', async () => {
    const res = await post('/batch', { productId: P_NOVIS, types: ['background'] });
    expect(res.status).toBe(409);
  });

  it('纯旁白批次不受基线守卫拦（旁白与画风无关）', async () => {
    const res = await post('/batch', { productId: P_NOVIS, types: ['narration'] });
    expect(res.status).toBe(200);
  });

  it('D3：纯旁白 + 无锚图 → 不补锚图行（否则要么白花钱出图、要么留一条永久失败行）', async () => {
    const res = await post('/batch', { productId: P_NOVIS, types: ['narration'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(body)));
    expect(rows.length).toBe(1);
    expect(rows.some(r => r.assetType === 'anchor')).toBe(false);
    expect(rows[0].assetType).toBe('narration');
  });

  it('D4：types 重复项去重（每条 job 都会各记一次费，重复 = 双倍扣费）', async () => {
    const res = await post('/batch', { productId: P_VIS, types: ['background', 'background'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(body)));
    expect(rows.filter(r => r.assetType === 'background').length).toBe(1);
  });

  it('D3b：skipAnchorInsert 视觉支两半都钉住 —— 无锚图 ⇒ 补一条 anchor；已有锚图 ⇒ 不补', async () => {
    // 视觉支此前**零覆盖**：改成 `!product.styleAnchorUrl` 时全量 45 用例仍绿。
    // 真实后果：无锚图的视觉批次不补 anchor → 图类 job 必 failed，而 claimNextJobs
    // 不会自动回收 → 用户看到每个素材一条永久红行。
    const noAnchor = await post('/batch', { productId: P_VIS, types: ['background'] });
    expect(noAnchor.status).toBe(200);
    const rowsNo = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(await noAnchor.json() as any)));
    expect(rowsNo.length).toBe(2);                                        // anchor + background
    expect(rowsNo.filter(r => r.assetType === 'anchor').length).toBe(1);

    // 另一半：产品**已有**锚图时不该再补（补了就是每批白花一次出图钱）。
    const hasAnchor = await post('/batch', { productId: P_ANCHORED, types: ['background'] });
    expect(hasAnchor.status).toBe(200);
    const rowsHa = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(await hasAnchor.json() as any)));
    expect(rowsHa.length).toBe(1);
    expect(rowsHa.some(r => r.assetType === 'anchor')).toBe(false);
  });

  it('D1：场地名 60 字 → 200，且落库的 communityStyleTag 已按码点截到 50 内', async () => {
    const res = await post('/batch', { productId: P_VIS, types: ['background'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(body)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Array.from(String(r.communityStyleTag)).length).toBe(50);
    }
  });

  it('D6：collectible 过 VALID_TYPES 白名单，且按图鉴**条目**建 job（nodeId 恒 null）', async () => {
    // 白名单漏收 `collectible` 是**静默**失效：`body.types.filter(...)` 把它滤掉后
    // `types.length === 0` → 400「未指定要生成的素材类型」（勾了图鉴却拿一个看不懂的错），
    // 混在别的类型里时更糟 —— 命中项静默少一条，不报错。所以判据必须落在
    // 「**真的按条目建出了 job**」上，只断 200 区分不了。
    //
    // 三个断言各自钉一件事：
    //   · 200 + `assetType === 'collectible'` 的**条数** ⇒ 白名单放行（滤掉则 types 为空 → 400）
    //   · `collectibleId === C_VIS` ⇒ 路由确实把图鉴条目查出来传进了 planBatch
    //     （漏传 `collectibles` 时 planBatch 缺省空数组 ⇒ 这条红，且**没有**任何报错）
    //   · `nodeId === null` ⇒ 走的是**条目级**展开，没退回节点级（退回则 N 节点 = N 张白计费）
    const res = await post('/batch', { productId: P_VIS, types: ['collectible'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(body)));
    const cols = rows.filter(r => r.assetType === 'collectible');
    expect(cols.length).toBe(1);
    expect(cols[0].collectibleId).toBe(C_VIS);
    expect(cols[0].nodeId).toBeNull();
  });

  it('D7：**没勾** collectible 时一条图鉴 job 都不建（哪怕该产品有图鉴条目）', async () => {
    // D6 是「勾了 ⇒ ≥1 条」的对照；本条是同一产物上的「没勾 ⇒ 0 条」。
    // 两条必须成对，否则「期望 0」那条恒绿无信号。
    //
    // 为什么单独写：`/batch` 把**整个产品**的图鉴条目一次查出来传给 planBatch，
    // 而 `types` 才是「这一批要哪几类」。少了 planBatch 里的 `types.includes('collectible')`
    // 闸门，勾「插画」也会为全部条目建 job —— 龙门镇 22 条 ⇒ 白出 22 张图、白计 22 次费，
    // 且不报任何错。P_VIS 上就挂着 C_VIS，所以本条真的能红。
    // （D3b 的 `rowsNo.length === 2` 也会因此变红，但那是在数别的形状 —— 红了看不清原因。）
    const res = await post('/batch', { productId: P_VIS, types: ['background'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(body)));
    expect(rows.length).toBeGreaterThan(0);   // ← 对照：本批**确实**建了行，不是空批次
    expect(rows.filter(r => r.assetType === 'collectible').length).toBe(0);
  });

  it('白名单从注册表派生：ending / reward 没被滤掉（⇒ 走到产品查询 404）', async () => {
    // **为什么用「404 vs 400 的差别」而不是断言白名单数组**：后者只证明数组里有个字符串，
    // 前者测的是 HTTP 通路**真的放行了这个类型**。改造前这两个类型不在硬编码白名单里
    // ⇒ 被滤空 ⇒ 400「未指定要生成的素材类型」（本条的对照半边在无库块的 'nope' 那条）。
    //
    // ⚠️ 本条**需要库**：必须让产品查询真的执行完（查无此 id ⇒ 404）才拿得到鉴别力，
    //    所以刻意放在 `skipIf(!run)` 块里 —— 放进「无库」块会让不带 RUN_DB 的裸跑
    //    打到一个不存在的库上（500 而非 404），那不是本仓无库用例的约定。
    expect((await post('/batch', { productId: `${B}-no-such-p`, types: ['ending'] })).status).toBe(404);
    expect((await post('/batch', { productId: `${B}-no-such-p`, types: ['reward'] })).status).toBe(404);
  });

  it('candidates 合法值（缺省 / 1 / MAX_CANDIDATES）不被拦下 —— 对照：证明确实走到了产品查询', async () => {
    // 缺了这半边，「非法 ⇒ 400」在「端点对所有请求都回 400」时照样绿（恒真的假判据）。
    for (const ok of [undefined, 1, MAX_CANDIDATES] as const) {
      const body: any = { productId: `${B}-no-such-p`, types: ['background'] };
      if (ok !== undefined) body.candidates = ok;
      expect((await post('/batch', body)).status).toBe(404);
    }
  });

  it('D5：ending / reward / icon(tier) 三个新展开键真的接上了 —— 按各自实体建 job 行', async () => {
    // 承重的是**job 行**（数量 + 类型 + 回写键），不是 `status === 200`：
    //   · 只改白名单、**没**把 endings/rewards/tiers 传进 planBatch ⇒ planBatch 拿空数组
    //     ⇒ 展开 0 条 ⇒ 400「没有可生成的素材」；
    //   · 而若产品**没有**锚图，还会因为无条件补了一条 anchor 行而照常 200 ——
    //     只断 200 的话那种实现照样绿。P_ENT 有锚图，正是为了把这条缝堵死
    //     （无锚图时「忘了传实体」= 200 + 1 条 anchor，看起来完全正常）。
    const res = await post('/batch', { productId: P_ENT, types: ['ending', 'reward', 'icon'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(body)));
    const byType = (t: string) => rows.filter(r => r.assetType === t);
    expect(byType('ending').length).toBe(1);
    expect(byType('reward').length).toBe(1);
    expect(byType('icon').length).toBe(1);
    // 三张表的查询确实各自接上了：回写键指向**各自实体**（stamp 那种「按标题猜」的错误归键会在这里红）。
    expect(byType('ending')[0].targetId).toBe(E_ENT);
    expect(byType('reward')[0].targetId).toBe(R_ENT);
    expect(byType('icon')[0].targetId).toBe(T_ENT);
    // ⚠️ 这条循环钉的是「**三类行都不带 `nodeId`**」，**不是**「没退回节点级展开」——
    //    在这个夹具上后者根本不可达：P_ENT **一个节点都没有**，真退回节点级只会让这三类各产
    //    **0 行**，先被上面的 `byType(...).length === 1` 和下面的 `rows.length === 3` 拦下，
    //    轮不到这个循环（`rows` 为空时它恒真，无信号）。
    //    它真正防的是 copy-paste 事故：`mk(...)` 的第 4 个形参是 `nodeId`，而这三类要传的是
    //    `targetId`（E_ENT / R_ENT / T_ENT）—— 把实体 id 顺手塞进 `nodeId` 会在这里红。
    //    「退回节点级」这个后果由 D6 钉：它的产品 P_VIS **有**节点（N_VIS），退回则
    //    `cols[0].nodeId` 非空 ⇒ 那条红得有原因。本条的夹具做不到这件事。
    for (const r of rows) expect(r.nodeId).toBeNull();
    // 精确行数：P_ENT 有锚图 ⇒ 不补 anchor；没有节点 ⇒ 无 node 级行。
    expect(rows.length).toBe(3);
  });

  it('candidates 的值真的盖到 asset_jobs.candidate_count —— 不是只做了校验就丢掉', async () => {
    // 承重的是 `candidate_count` **列**本身。把调用点的 `candidateCount: candidates` 删掉、
    // 或被 `enqueue.ts` 末尾那句 `input.candidateCount ?? 1` 兜住、或写死成常量 1 时，
    // 本用例「4」那一半必红 —— 而其余所有用例（不传 candidates，或只断状态码）照样全绿，
    // `pnpm ts-check` 也不报（`candidateCount` 是可选参数）。也就是说这一段
    // 「路由 → 列」此前是**零护栏**的，而它承的是**付费**行为：写死 1 ⇒ 用户要 4 张只拿 1 张；
    // 写死 4 ⇒ 每批 4 倍成本，两种都静默。
    //
    // P_ENT 有锚图 ⇒ `skipAnchorInsert` 生效、不补 anchor 行；`ending` 是 1:1 展开 ⇒ 恰好 1 行。
    const withN = await post('/batch', { productId: P_ENT, types: ['ending'], candidates: MAX_CANDIDATES });
    expect(withN.status).toBe(200);
    const rowsN = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(await withN.json() as any)));
    expect(rowsN.length).toBe(1);
    // `candidate_count` 是 `integer('candidate_count')`（schema/wenlv.ts），drizzle 按
    // **number** 读回（不是 numeric/decimal 的 string mode）⇒ 直接与数字比，不需要 Number()。
    expect(rowsN[0].candidateCount).toBe(MAX_CANDIDATES);   // ← 承重

    // 反向半边：**不传** ⇒ 1。缺了它，「端点对所有请求都盖 4」也能过上面那句（恒真的假判据）。
    //
    // ⚠️ 两次请求之间必须清一次守卫：第一条 200 会经端点成功路径的 `hold` 在
    //    `batch:${P_ENT}` 上留下 3s 冷却（见 lib/in-flight-guard.ts），不清则第二条
    //    `acquire` 恒 false ⇒ 409，本半条会**红在一个与 candidates 无关的原因上**。
    //    这与文件级 `beforeEach(_debugResetGuard)` 的理由同源（进程级状态不得跨请求残留），
    //    只是这里的两个独立请求被合并进了同一条用例。
    _debugResetGuard();
    const dflt = await post('/batch', { productId: P_ENT, types: ['ending'] });
    expect(dflt.status).toBe(200);
    const rowsD = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, batchOf(await dflt.json() as any)));
    expect(rowsD.length).toBe(1);
    expect(rowsD[0].candidateCount).toBe(1);
  });
});

describe.skipIf(!run)('POST /retry', () => {
  const R_OK = `${B}-retry-ok`;
  const R_PENDING = `${B}-retry-pending`;
  const R_LIMIT = `${B}-retry-limit`;
  const OLD = new Date('2020-01-01T00:00:00Z');

  beforeAll(async () => {
    JOB_IDS.push(R_OK, R_PENDING, R_LIMIT);
    await db.insert(pmsBuiWenlvAssetJobs).values([
      {
        id: R_OK, batchId: `${B}-rb`, assetType: 'background', name: 'R', status: 'failed',
        attempt: 1, costAmount: '0.14', styleBibleSnapshot: {},
        providerTaskId: 'pt-1', errorMessage: 'boom',
        // prompt 刻意非空：重试**复用同一行、prompt 不变**（与 /iterate 的本质区别是
        // 迭代要重新现算）。prompt 为 null 时「不变」与「被清空」不可区分。
        prompt: '原始提示词',
        startedAt: OLD, finishedAt: OLD, updatedAt: OLD,
      },
      { id: R_PENDING, batchId: `${B}-rb`, assetType: 'background', name: 'P', status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {} },
      { id: R_LIMIT, batchId: `${B}-rb`, assetType: 'background', name: 'L', status: 'failed', attempt: MAX_ATTEMPT, costAmount: '0', styleBibleSnapshot: {} },
    ]);
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, [R_OK, R_PENDING, R_LIMIT]));
  });

  it('failed 行 → 200，回到 pending 且清空在途字段；attempt 不被重置（重置=无限重试）', async () => {
    const res = await post('/retry', { jobId: R_OK });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, R_OK)).limit(1);
    expect(row.status).toBe('pending');
    expect(row.providerTaskId).toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(new Date(row.updatedAt).getTime() > OLD.getTime()).toBe(true);
    // ⚠️ 这条是防回归的关键：claimNextJobs 的 SQL 是 `attempt < MAX_ATTEMPT`，
    //    而 /retry 自己按 `attempt >= MAX_ATTEMPT` 拒绝。**重置 attempt 等于给出无限重试**，
    //    绕过 spec §7.2 的上限 —— 所以必须钉住「重试后 attempt 保持原值」。
    expect(row.attempt).toBe(1);
    // 重试复用同一行、**prompt 不变**（与 /iterate 的本质区别：迭代要重新现算）。
    // 这里断言 prompt 而不是 id —— 行本来就是 `where(eq(id, R_OK))` 查回来的，
    // `expect(row.id).toBe(R_OK)` 结构上不可能失败（那是一条恒真的假断言）。
    expect(row.prompt).toBe('原始提示词');
  });

  it('非 failed 行 → 400', async () => {
    const res = await post('/retry', { jobId: R_PENDING });
    expect(res.status).toBe(400);
  });

  it('attempt >= MAX_ATTEMPT → 400（上限由此拒绝，故上面那条不重置才成立）', async () => {
    const res = await post('/retry', { jobId: R_LIMIT });
    expect(res.status).toBe(400);
  });

  it('不存在的 jobId → 404', async () => {
    const res = await post('/retry', { jobId: `${B}-no-such-job` });
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!run)('POST /iterate', () => {
  const I_OK = `${B}-it-ok`;
  const I_PENDING = `${B}-it-pending`;
  // 两条**已成功**但本轮反馈根本无处可施的素材。它们必须被拒，理由各不相同（见各用例）。
  const I_NARR = `${B}-it-narr`;
  const I_ANCHOR = `${B}-it-anchor`;
  // 自举基线的**合成行**（任务 5 / 块 B3）：`bootstrapStyleBible` 落的那一条账。
  // 它是三类「反馈无处可施」里唯一**没有画面**的一条 —— 放它过去 = 每点一次迭代就
  // 原样再调一次付费 LLM，还会以 pending 建出一条永远不该存在的图类任务。
  const I_SB = `${B}-it-sb`;

  beforeAll(async () => {
    JOB_IDS.push(I_OK, I_PENDING, I_NARR, I_ANCHOR, I_SB);
    await db.insert(pmsBuiWenlvAssetJobs).values([
      {
        id: I_OK, batchId: `${B}-ib`, assetType: 'background', name: 'I', status: 'succeeded',
        // prompt 刻意非空：迭代行必须**重新现算**（落 null 由轮询器算），
        // 若实现改成继承父行 prompt，这条就会红（实测过：父行为 null 时变异不红）。
        attempt: 1, iteration: 1, costAmount: '0.14', styleBibleSnapshot: {}, prompt: '上一版的提示词',
      },
      { id: I_PENDING, batchId: `${B}-ib`, assetType: 'background', name: 'IP', status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {} },
      {
        id: I_NARR, batchId: `${B}-ib`, assetType: 'narration', name: 'N', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0.03', styleBibleSnapshot: {},
        sourceText: '井水很凉。',
      },
      {
        id: I_ANCHOR, batchId: `${B}-ib`, assetType: 'anchor', name: 'A', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0.20', styleBibleSnapshot: {}, prompt: '锚图提示词',
      },
      {
        // 与 `bootstrapStyleBible` 真写出来的那行同形（含 `batchId='stylebible:<pid>'`、
        // `assetType='style_bible'`、`status='succeeded'`）—— 所以这条用例钉的是**真数据形状**，
        // 不是为测试生造的输入。
        id: I_SB, batchId: `stylebible:${B}-it-sb-pid`, assetType: 'style_bible',
        name: '风格基线自举·p', status: 'succeeded', attempt: 0, iteration: 1,
        costAmount: '0.0106', styleBibleSnapshot: {}, prompt: '自举用的 user 消息',
      },
    ]);
  });
  afterAll(async () => {
    // 迭代新建的行 parentJobId 指向 I_OK，按 id 删不干净 → 一并按 parentJobId 删
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.parentJobId, I_OK));
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, [I_OK, I_PENDING, I_NARR, I_ANCHOR]));
  });

  it('不存在的 jobId → 404', async () => {
    const res = await post('/iterate', { jobId: `${B}-no-such-job`, guidance: '再亮一点' });
    expect(res.status).toBe(404);
  });

  it('未成功的行 → 400（只能迭代已成功的素材）', async () => {
    const res = await post('/iterate', { jobId: I_PENDING, guidance: '再亮一点' });
    expect(res.status).toBe(400);
  });

  it('缺反馈 → 400（没有反馈就是重试，不该走迭代）', async () => {
    const res = await post('/iterate', { jobId: I_OK, guidance: '   ' });
    expect(res.status).toBe(400);
  });

  it('succeeded 行 → 200，新行挂上 parentJobId / iteration+1，prompt 重新现算（为 null）', async () => {
    const res = await post('/iterate', { jobId: I_OK, guidance: '再亮一点' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // 响应里是 `newJobId`（新建的那行），**不是** `jobId` —— 后者是请求里传进去的父行。
    // 写错成 `body.data.jobId` 的话这里会 `undefined` ⇒ 查不到行 ⇒ 下面全部红，
    // 所以这条断言顺带钉住了字段名本身。
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, body.data.newJobId)).limit(1);
    expect(row.parentJobId).toBe(I_OK);
    expect(row.iteration).toBe(2);
    expect(row.status).toBe('pending');
    // prompt 必须重新现算：继承上一版的 prompt 会让「改后重出」出一模一样的图
    expect(row.prompt).toBeNull();
    expect(row.guidance).toBe('再亮一点');
  });

  it('冷却：成功后立刻再迭代同一素材 → 409，且**没有**多建一条迭代行（`hold` 是 /iterate 的真防线）', async () => {
    // `/iterate` 只校验父行 `status === 'succeeded'`、**不改父行状态**，所以第二次点击
    // 能走到 `acquire` —— 这与 `/retry`（成功即改状态、第二次在状态校验就 400）**相反**。
    // 正因如此 `/iterate` 必须保留 `hold`：删掉它这条会红（`第二` 会是 200 并再建一行）。
    //
    // Task 17 清单 36(a)：四个付费端点各要有**端点层**判据（grep 到 4 处 `hold` 不构成证据）。
    // 本条是 /iterate 那条；/batch 见「付费端点的进程内 in-flight 守卫」里的 (b)(c)；
    // /bootstrap 见 wenlv-style-bible.test.ts 的最后两条；/retry 是**有意为之的反例**
    // —— 它的冷却已按裁决摘除，第二次拿到的是准确文案的 400。
    //
    // 下面这段子行计数是承重的：只断 409 的话，「第二次也建了行、只是恰好回了 409」
    // 这种实现照样绿，而它正是**双倍付费**。
    const children = async () =>
      (await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
        .where(eq(pmsBuiWenlvAssetJobs.parentJobId, I_OK))).length;
    const before = await children();
    const first = await post('/iterate', { jobId: I_OK, guidance: '再亮一点' });
    expect(first.status).toBe(200);
    const afterFirst = await children();
    // 第一次**真的**建了行 —— 否则下面「没增加」会因为压根没建成而恒真（假绿）。
    expect(afterFirst).toBe(before + 1);
    const second = await post('/iterate', { jobId: I_OK, guidance: '再亮一点' });
    expect(second.status).toBe(409);
    expect((await second.json() as any).error).toBe('该剧本正在生成中，请稍候再试');
    // 硬证据：第二次没有 enqueueIteration ⇒ 没有第二次付费。
    expect(await children()).toBe(afterFirst);
  });

  // 下面两条钉同一个规则：**反馈无处可施的类型不得走迭代**。
  //
  // 变异实证划清了两条断言各自的贡献（别高估第二条）：
  //   · 删掉路由 pre-check → 红在 `status`（服务层守卫抛出 → 落进 catch → 500
  //     「迭代失败，请稍后重试」，用户看不懂这条**确定的**规则）。
  //   · 删掉服务层守卫 → 只有那条直驱断言红；本条的 status / children 全绿
  //     （路由先拦住了）—— 证明两条门确实各自独立在生效。
  // 所以**承重的是 status + 文案**；下面的 children 是一条**廉价的顺序不变量**
  //（拒绝发生在 INSERT 之前），它本身不构成独立咬合力 —— 能同时让「回 400」和
  //「照样建行」成立的实现几乎不存在。留着是因为它把「拒绝 = 没花钱」这层意思
  // 写在了代码里，而不是靠读者自己推。
  for (const [label, parentId, mustMention] of [
    ['旁白', I_NARR, '旁白不支持迭代'],
    ['风格锚图', I_ANCHOR, '锚图不支持迭代'],
    ['风格基线自举', I_SB, '风格基线自举不支持迭代'],
  ] as const) {
    it(`${label}（已成功）→ 400 且**没有**多建迭代行（反馈对它本就不生效，重出=白花钱）`, async () => {
      const children = async () =>
        (await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
          .where(eq(pmsBuiWenlvAssetJobs.parentJobId, parentId))).length;
      const before = await children();
      const res = await post('/iterate', { jobId: parentId, guidance: '再亮一点' });
      expect(res.status).toBe(400);
      // 文案必须点明**为什么**不能迭代 —— 「只回一句不支持」会让用户以为是自己操作错了
      expect((await res.json() as any).error).toContain(mustMention);
      // 硬证据：没建行 ⇒ 没付费，也没覆盖任何既有产物。
      expect(await children()).toBe(before);

      // 服务层自守必须**单独钉住**，不能靠上面那个 400 顺带证明：400 是**路由**的
      // pre-check 给的，它先执行。只断路由的话，`enqueueIteration` 里那句
      // `if (blocked) throw` 就是**无人钉的死代码** —— 而它保护的正是
      // 「别的调用方绕过端点」这条路径（`enqueueIteration` 是导出的，同 `claimNextJobs`
      // 的先例）。直接驱动一次，证明那句真的在生效。
      await expect(enqueueIteration({ parentJobId: parentId, guidance: '再亮一点', batchId: `${B}-ib2` }))
        .rejects.toThrow(mustMention);
      expect(await children()).toBe(before);
    });
  }
});

describe.skipIf(!run)('POST /select —— 采纳候选组里的某一张', () => {
  // 两个独立 job：D8 用 3 候选（改选）；D9 用 1 候选（越界零写入对照）。
  const SJ = `${B}-sel-job`;
  const SJX = `${B}-selx-job`;
  const SJ_URLS = [0, 1, 2].map(i => `https://oss.test/${SJ}-${i}.png`);
  // ── 修复轮新增的夹具 ──
  // SA：`anchor` 类型（I-2 —— 补评闸的**可评类型**那半边；锚图 reviewScore 恒 null）。
  // SBC：`background` 类型 —— I-2 的**正向对照**（同一条查询，期望恰好 1 行 review 记账行）。
  // SI1：`background` 类型 —— I-1（把评审打成失败，断言留下含 `assetId=` 的 warn）。
  // SR：`running` 类型状态 —— I-3（状态闸；已有一行 is_selected=true 作零写入对照基线）。
  const SA = `${B}-sel-anchor`;
  const SBC = `${B}-sel-bgctrl`;
  const SI1 = `${B}-sel-i1`;
  const SR = `${B}-sel-running`;

  // 视觉桩：**必须打桩** —— 评审一旦真被发起，运行环境恰好有 `DASHSCOPE_API_KEY` 时
  // 一次真实付费调用就发出去了。回一段**合法**评审 JSON + usage
  // （`parseReview` 对 score 非数 / fix_guidance 非字符串一律抛）。
  //
  // ⚠️ 2026-09-20（T13 §8.5 收口点闸）之后，本文件里 `/select` **不再发起**任何评审
  //    —— 所以这个桩在正常路径上是**零调用**的。它仍然必须留着：判据 1(b) 正是要
  //    用「它有没有被调用」来证明闸拦住了（桩撤掉的话那条判据就变成恒真的空断言）。
  const visionFetch = vi.fn(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ score: 7, dimensions: [], issues: [], fix_guidance: '' }) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 800 },
    }),
  }));

  /** 被桩的**视觉评审**调用次数 —— 按请求体的 `model` 精确计数。
   *  不按「调用总次数」数：本文件的桩对象是共用的，将来若有别的付费链路走到这里，
   *  按总数数会把它的调用算进评审的账上（判据 1(b) 会因此假红/假绿）。 */
  const reviewModelCalls = () => visionFetch.mock.calls.filter((c: any) => {
    try { return JSON.parse(c[1]?.body ?? '{}').model === reviewModel(); } catch { return false; }
  }).length;

  beforeAll(async () => {
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';   // fetch 已打桩，不会真的发出去
    vi.stubGlobal('fetch', visionFetch);
    await db.insert(pmsBuiWenlvAssetJobs).values([
      {
        id: SJ, batchId: `${B}-selb`, assetType: 'background', name: 'S', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {},
      },
      {
        id: SJX, batchId: `${B}-selxb`, assetType: 'background', name: 'SX', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {},
      },
      // SA 的 assetType 必须是 `anchor`（I-2 的可达暴露面）：它也走
      // `generateImageJob` → `writeCandidate`，与图类落在同一张 design_assets 表上。
      {
        id: SA, batchId: `${B}-sela`, assetType: 'anchor', name: 'A', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {},
      },
      {
        id: SBC, batchId: `${B}-selbc`, assetType: 'background', name: 'BC', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {},
      },
      {
        id: SI1, batchId: `${B}-seli1`, assetType: 'background', name: 'I1', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {},
      },
      // status `running`：调度器在收尾时**自己**会调一次 `selectCandidate`，而那次
      // 严格发生在 `succeeded` 之前 ⇒ 这道闸把那个竞争窗口完全闭合。
      {
        id: SR, batchId: `${B}-selr`, assetType: 'background', name: 'R', status: 'running',
        attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {},
      },
    ]);
    // `designAssetIdFor` 用**传入的 jobId** 算 id，writeCandidate 走同一个算式 ⇒ id 可预测。
    for (let i = 0; i < 3; i++) {
      await writeCandidate({
        jobId: SJ, index: i, assetType: 'background', name: 'S', url: SJ_URLS[i],
        productId: null, venueId: null, iteration: 1, communityStyleTag: null,
        target: { targetKind: null, targetId: null },
        extraMeta: {}, isSelected: i === 0,
      });
    }
    await writeCandidate({
      jobId: SJX, index: 0, assetType: 'background', name: 'SX',
      url: `https://oss.test/${SJX}-0.png`,
      productId: null, venueId: null, iteration: 1, communityStyleTag: null,
      target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: true,
    });
    // 修复轮夹具的候选（`reviewScore` 留默认 null —— writeCandidate 不写该列）。
    // SA 放**两张**、且 index 0 **初始未被采纳**：这样「采纳照常成功」这句断言才有
    // 鉴别力（若初始就已 true，则「不补评没有连坐采纳」在任何实现下都恒真）。
    await writeCandidate({
      jobId: SA, index: 0, assetType: 'anchor', name: 'A0', url: `https://oss.test/${SA}-0.png`,
      productId: null, venueId: null, iteration: 1, communityStyleTag: null,
      target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: false,
    });
    await writeCandidate({
      jobId: SA, index: 1, assetType: 'anchor', name: 'A1', url: `https://oss.test/${SA}-1.png`,
      productId: null, venueId: null, iteration: 1, communityStyleTag: null,
      target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: true,
    });
    for (const [id, type] of [[SBC, 'background'], [SI1, 'background']] as const) {
      await writeCandidate({
        jobId: id, index: 0, assetType: type, name: id, url: `https://oss.test/${id}-0.png`,
        productId: null, venueId: null, iteration: 1, communityStyleTag: null,
        target: { targetKind: null, targetId: null },
        extraMeta: {}, isSelected: true,
      });
    }
    // SR：两张候选，index 0 已 true —— I-3 的零写入对照基线。
    await writeCandidate({
      jobId: SR, index: 0, assetType: 'background', name: 'R0', url: `https://oss.test/${SR}-0.png`,
      productId: null, venueId: null, iteration: 1, communityStyleTag: null,
      target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: true,
    });
    await writeCandidate({
      jobId: SR, index: 1, assetType: 'background', name: 'R1', url: `https://oss.test/${SR}-1.png`,
      productId: null, venueId: null, iteration: 1, communityStyleTag: null,
      target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: false,
    });
  });
  afterAll(async () => {
    // 三类残留都要清：job 行（含评审记账行 `review:<assetId>`）、design_assets 候选行。
    // 评审行按**预测 id** 清 —— 只按 jobId 清会漏掉它。
    // ⚠️ 2026-09-20（T13 收口点闸）之后，本文件里**只有** I-2 的对照那条会真的落地一行
    //    （`review:<SJX>`）；其余三个 id 一并列上是**幂等兜底** —— 多删一个不存在的 id 无害，
    //    而少列一个就会在本地库里积孤儿行。别因为「现在不会有行」把它们删掉：
    //    同一条链路的 `/select` 补评一旦因将来改动重新可达，这里就是唯一的兜底。
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, [
      SJ, SJX, SA, SBC, SI1, SR,
      `review:${designAssetIdFor(SJ, 2)}`, `review:${designAssetIdFor(SJX, 0)}`,
      `review:${designAssetIdFor(SBC, 0)}`, `review:${designAssetIdFor(SI1, 0)}`,
    ]));
    await db.delete(pmsBuiWenlvDesignAssets).where(inArray(pmsBuiWenlvDesignAssets.jobId, [SJ, SJX, SA, SBC, SI1, SR]));
    delete process.env.DASHSCOPE_API_KEY;
    vi.unstubAllGlobals();
  });

  it('D8：改选走 HTTP —— 组内恰好一张 isSelected，且是点的那一张', async () => {
    // ⚠️ 必须是**真的 HTTP 请求**（`post('/select', …)`），不是直接调 `selectCandidate`：
    //    后者验证的是 candidate-store 自己的行为，**`/select` 端点可以完全不存在而它照样全绿**。
    const calls0 = reviewModelCalls();     // 视觉评审调用的基线（见下面判据 1(b)）
    const res = await post('/select', { jobId: SJ, index: 2 });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // 形状与 BFF/前端契约对齐：`data.assetId`（**不是**顶层 assetId）。
    // 断错层（写成 body.assetId）今天恰好也能说明「顶层有 assetId」—— 但前端读的是
    // `data.assetId`，这正是本 Task 改形状要修的那条静默 undefined，所以必须钉在 data 上。
    expect(body.data.assetId).toBe(designAssetIdFor(SJ, 2));

    const rows = await db.select({
      id: pmsBuiWenlvDesignAssets.id,
      idx: pmsBuiWenlvDesignAssets.candidateIndex,
      sel: pmsBuiWenlvDesignAssets.isSelected,
    }).from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.jobId, SJ));

    expect(rows).toHaveLength(3);
    // 恰好一张 true
    expect(rows.filter(r => r.sel)).toHaveLength(1);
    // 且是 index=2 那张（只断「有一张 true」不够 —— 选到 index 0 也满足上一句）。
    expect(rows.find(r => r.sel)!.idx).toBe(2);
    // **对照半边**：index 0 必须已被清掉。缺了它，「先设后清」写反 / 压根没清也能过前两句。
    expect(rows.find(r => r.idx === 0)!.sel).toBe(false);

    // ★ 口径①（spec §8.5）：人工采纳要落成 `review_source='human'`。
    //   `/select` 是 **await** `selectCandidate` 的 ⇒ 这一条是确定的，不需要 waitFor。
    const [picked] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, designAssetIdFor(SJ, 2))).limit(1);
    expect(picked.reviewSource).toBe('human');     // ← 写成 'ai' / null 必须红
    expect(picked.humanReviewedAt).toBeTruthy();
    // AI 的四列**一个字都不许碰**（口径②：覆写即算不出 human − ai 的分差）。
    expect(picked.reviewScore).toBeNull();
    expect(picked.reviewDetail).toBeNull();
    expect(picked.reviewedAt).toBeNull();
    expect(picked.reviewModel).toBeNull();

    // ★ 判据 1(b) 的形状：**补评未发起**要打在「被桩的 fetch 调用次数」上（§2.2），
    //   不能打 `reviewedAt` —— 那是「钱的影子」：时间戳没变既可能是没评，也可能是评了没写。
    //   这里用**确定性**的一刀而不是等时间：直接 `await reviewAssetJob`，它正是那条
    //   fire-and-forget 路径会调的东西；闸若没拦住 human，这一句必然发起一次付费视觉调用。
    //   ⛔ 别把它改回 `waitFor(评审记账行不存在)`：fire-and-forget 的落库**晚于**断言，
    //      那样的负断言在「评审真跑了」时也照样通过 —— 恒真的空判据（本条原版就是它）。
    await reviewAssetJob(designAssetIdFor(SJ, 2));
    expect(reviewModelCalls() - calls0).toBe(0);
    const reviewRows = await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, `review:${designAssetIdFor(SJ, 2)}`));
    expect(reviewRows).toHaveLength(0);
  });

  it('D9：index 越界 → 404，且**不改变**任何一行的 isSelected', async () => {
    // 静默回落会让「点了第 3 张却采纳了第 1 张」无声发生。
    // ⚠️ 路径是 `/select`，**不是** `/asset-gen/select` —— 本文件直接驱动 `route` 实例，
    //    没有挂载点前缀（既有断言全是 `post('/batch', …)`）。写成带前缀的路径打进的是
    //    一个**没有路由**的路径 ⇒ 框架默认 404 ⇒ 这条会**两半恒真**（见 Task 15-II 实验 1 的实测）。
    const res = await post('/select', { jobId: SJX, index: 9 });
    expect(res.status).toBe(404);
    // **零写入对照**：越界不得顺手把 index 0 标成 false。
    const [row] = await db.select({ sel: pmsBuiWenlvDesignAssets.isSelected })
      .from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.jobId, SJX));
    expect(row.sel).toBe(true);
  });

  it('I-3：job 还在 running → 400，且**零写入**（原有那行仍是 true、没有新行被置 true）', async () => {
    // 为什么要有这道闸：调度器收尾时会**自己**调一次 `selectCandidate`，而那次严格发生在
    // 它把行改成 `succeeded` **之前** ⇒ 运行中采纳会被那次自选覆盖。断 400 之外还必须断
    // **零写入** —— 只断状态码抓不住「先 selectCandidate 再判状态」的实现（那样原来那行
    // 已被清成 false，是**破坏性**的）。
    const selNow = async () => db.select({
      idx: pmsBuiWenlvDesignAssets.candidateIndex, sel: pmsBuiWenlvDesignAssets.isSelected,
    }).from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.jobId, SR));

    const before = await selNow();
    expect(before).toHaveLength(2);
    expect(before.find(r => r.idx === 0)!.sel).toBe(true);   // 对照基线：改选前 index 0 是 true
    expect(before.find(r => r.idx === 1)!.sel).toBe(false);

    const res = await post('/select', { jobId: SR, index: 1 });
    expect(res.status).toBe(400);
    // 文案与 /iterate 的「只能迭代已成功的素材」**同构但不同字**（两个端点动作不同）。
    expect((await res.json() as any).error).toBe('只能采纳已成功的素材');

    const after = await selNow();
    expect(after.filter(r => r.sel)).toHaveLength(1);            // 组内仍恰好一行 true
    expect(after.find(r => r.idx === 0)!.sel).toBe(true);        // 原来那行**没有**被清
    expect(after.find(r => r.idx === 1)!.sel).toBe(false);       // 也没有新行被置 true
  });

  it('I-2：`/select` 采纳**任何类型都不再**发起补评（收口点闸）—— 锚图与 background 都是 0 次视觉调用', async () => {
    // ⚠️ 本用例 2026-09-20 被**整体重推导**（T13 §2 的扩闸推翻了它的旧前提）。
    //    旧版是「`anchor` 采纳**不**补评（`/select` 里的可评类型闸）+ 一条同形状
    //    background **会**补评的正向对照」。扩闸（`reviewSource === 'human'` 也 return）
    //    之后，`/select` 的采纳**恒**写 human ⇒ `reviewAssetJob` 一律在闸上返回
    //    ⇒ **任何类型都不补评**，那条正向对照在这条路径上**已经不可能存在**了。
    //    （`isReviewableType` 本身没死：它仍是 `shouldReview` 的一半，由
    //      `asset-gen/__tests__/review-enqueue.test.ts` 单测承重。
    //      `/select` 那一半的下场见下面 I-1。）
    //
    //    ⛔ 别再搬回旧注释里那条「参照图就是它自己 / 与自己比风格漂移恒达标」的理由
    //       —— 它是**错的**：`reviewAssetJob` 的 refs 已自过滤掉与待评素材同 URL 的
    //       参照图，根本不会「自己比自己」。措辞与 `reviewer.ts` 的
    //       `isReviewableType`/`shouldReview` 注释同源。
    const calls0 = reviewModelCalls();

    // 锚图：已 succeeded、有 design_assets 行、`reviewScore` 是 null —— 与下面 background
    // 同形状，唯一区别是 assetType。它的暴露面**可达**：锚图也走
    // generateImageJob → writeCandidate，且调度器第 3 步的领取无类型过滤。
    const res = await post('/select', { jobId: SA, index: 0 });
    // 200 是**对照半边**：闸只拦「补评」，**不得**连坐采纳本身。
    expect(res.status).toBe(200);
    const rows = await db.select({
      id: pmsBuiWenlvDesignAssets.id,
      idx: pmsBuiWenlvDesignAssets.candidateIndex,
      sel: pmsBuiWenlvDesignAssets.isSelected,
    }).from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.jobId, SA));
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.sel)).toHaveLength(1);
    expect(rows.find(r => r.sel)!.idx).toBe(0);            // 点的是 index 0，采纳真的生效了
    expect(rows.find(r => r.idx === 1)!.sel).toBe(false);  // 旧的 index 1 被清掉

    // background（旧版这里是「会补评」的正向对照）：同样只断采纳本身成功。
    const ctrlRes = await post('/select', { jobId: SBC, index: 0 });
    expect(ctrlRes.status).toBe(200);

    // ★ 硬判据：两条都**没有**发起付费视觉调用。用确定性的一刀而不是 `waitFor` 等时间：
    //   直接 await `reviewAssetJob`（fire-and-forget 之外的那条确定性路径）。闸若漏了，
    //   这两句必然各发起一次调用。
    //   ⛔ 不能写成 `waitFor(记账行不存在)` —— 异步落库晚于断言，那样的负断言恒真（空判据）。
    await reviewAssetJob(designAssetIdFor(SA, 0));
    await reviewAssetJob(designAssetIdFor(SBC, 0));
    expect(reviewModelCalls() - calls0).toBe(0);

    // ★ 期望 0 的判据**必须**配一条期望 ≥1 的同产物对照（否则「桩压根没接上」「查询写错了
    //   表名」也会让上面两句全绿）。旧版的正向对照靠 `/select` 那条路 —— 它已经被闸关上，
    //   故对照改走**仍然活着**的那条：一张**没有任何人碰过**的同形状素材
    //   （SJX 组：候选由 beforeAll 直接写库，本文件里从没被 `/select` 采纳过）。
    await reviewAssetJob(designAssetIdFor(SJX, 0));
    expect(reviewModelCalls() - calls0).toBe(1);
    const ctrlRow = await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, `review:${designAssetIdFor(SJX, 0)}`));
    expect(ctrlRow).toHaveLength(1);
  });

  it('I-1：`/select` 的补评调用点已**不可达** —— 视觉桩必失败也留不下任何 `assetId=` 的 warn', async () => {
    // ⚠️ 本用例 2026-09-20 被**重推导**（T13 §2 的扩闸推翻了它的旧前提）。
    //    旧版：装一个必失败的视觉桩，断言 `/select` 的补评失败后**留下**一条含 `assetId=`
    //    的 warn（即调用点的 `.catch` 不得写成 `.catch(() => {})`）。
    //    扩闸之后 `/select` **压根不发起**评审 —— `selectCandidate` 刚把这一行写成
    //    `reviewSource='human'`，闸就在收口点返回了 ⇒ 那条 warn **无从产生**。
    //    「评审失败不得完全无声」这个**性质**没死，但它只剩**一个**活着的调用点
    //    （调度器收尾），看守已随之搬到
    //    `asset-gen/__tests__/run-once.db.test.ts` 的「评审失败不得完全无声」那条。
    //    本用例在此改钉**新的真话**：这条调用点连失败面都不存在。
    const assetId = designAssetIdFor(SI1, 0);
    const failing = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    vi.stubGlobal('fetch', failing);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // ★ 对照半边（顺序在采纳**之前**）：此时这一行还没有人工标记 ⇒ 闸放行 ⇒
      //   必失败的桩让 promise 抛错。它证明「桩真的会失败、真的被调到了」
      //   —— 缺了它，下面那句「没有 warn」可能只是因为桩压根没接上（恒真的空判据）。
      await expect(reviewAssetJob(assetId)).rejects.toThrow();

      const res = await post('/select', { jobId: SI1, index: 0 });
      expect(res.status).toBe(200);   // 采纳照常成功（与本改动无关的既有纪律）
      expect((await db.select({ s: pmsBuiWenlvDesignAssets.reviewSource })
        .from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, assetId)))[0].s)
        .toBe('human');

      // ★ 主体：同一支必失败的桩、同一张图，再来一次 —— 闸在收口点返回 ⇒ **连失败都没有**。
      //   直接 await（不经过 fire-and-forget）⇒ 不赌时序。
      await reviewAssetJob(assetId);
      expect(warn.mock.calls.some(args =>
        args.some(a => typeof a === 'string' && a.includes('assetId=')))).toBe(false);
    } finally {
      warn.mockRestore();
      vi.stubGlobal('fetch', visionFetch);
    }
  });
});

describe.skipIf(!run)('POST /iterate —— editInputUrl / fromIndex', () => {
  const IE = `${B}-edit-iter`;
  const DOODLE = 'https://oss.test/doodle.png';
  /** 组内 3 张候选的 url（index 0/1/2）。fromIndex 必须解析成**对应那一条**。 */
  const BASE_URLS = [0, 1, 2].map(i => `https://oss.test/${IE}-base-${i}.png`);

  beforeAll(async () => {
    JOB_IDS.push(IE);
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: IE, batchId: `${B}-editb`, assetType: 'background', name: 'E', status: 'succeeded',
      attempt: 1, iteration: 1, costAmount: '0', styleBibleSnapshot: {}, prompt: '上一版的提示词',
    });
    for (let i = 0; i < 3; i++) {
      await writeCandidate({
        jobId: IE, index: i, assetType: 'background', name: 'E', url: BASE_URLS[i],
        productId: null, venueId: null, iteration: 1, communityStyleTag: null,
        target: { targetKind: null, targetId: null },
        extraMeta: {}, isSelected: i === 0,
      });
    }
  });
  afterAll(async () => {
    // 迭代新建的行 parentJobId 指向 IE，按 id 删不干净 → 一并按 parentJobId 删。
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.parentJobId, IE));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.jobId, IE));
  });

  /** 取本次迭代新建的那一行。 */
  const newRow = async (res: any) => {
    const body = await res.json() as any;
    const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, body.data.newJobId)).limit(1);
    return row;
  };

  it('传 editInputUrl ⇒ 新行 editInputUrl 等于它（HTTP → 列的通路真的接上了）', async () => {
    // 承重点：这一跳此前是**死的** —— 前端把涂鸦图传上来，后端收下就扔，
    // 出来一张没按标注改的图，而**没有任何测试会红**。
    const res = await post('/iterate', { jobId: IE, guidance: '按涂鸦改', editInputUrl: DOODLE });
    expect(res.status).toBe(200);
    expect((await newRow(res)).editInputUrl).toBe(DOODLE);
  });

  it("editInputUrl 空串 ⇒ 新行是 null（不是 '' 这种对读侧隐形的脏值）", async () => {
    const res = await post('/iterate', { jobId: IE, guidance: '再亮一点', editInputUrl: '' });
    expect(res.status).toBe(200);
    expect((await newRow(res)).editInputUrl).toBeNull();
  });

  it('fromIndex ⇒ 解析成组内那一张的 url 并送进新行 editInputUrl', async () => {
    // 这是**唯一**能把「组内第 N 张」送进新 job 参考图的路：enqueueIteration 既不接受
    // `fromIndex`、也没有 `referenceUrls` 形参（后者是 generateImageJob 的运行期字段）。
    const res = await post('/iterate', { jobId: IE, guidance: '拿第 3 张当底图', fromIndex: 2 });
    expect(res.status).toBe(200);
    expect((await newRow(res)).editInputUrl).toBe(BASE_URLS[2]);
  });

  it('优先级：editInputUrl 与 fromIndex 同时给 ⇒ 用户当场画的那张说了算', async () => {
    const res = await post('/iterate', {
      jobId: IE, guidance: '两个都给', fromIndex: 2, editInputUrl: DOODLE,
    });
    expect(res.status).toBe(200);
    expect((await newRow(res)).editInputUrl).toBe(DOODLE);
  });

  it('fromIndex 越界 ⇒ 404（不是静默忽略 —— 忽略会让用户以为底图换上了）', async () => {
    const res = await post('/iterate', { jobId: IE, guidance: '越界', fromIndex: 9 });
    expect(res.status).toBe(404);
  });

  it('缺省回归：两个参数都不传 ⇒ 新行 editInputUrl 是 null（刻意不实现「不传则用被采纳那张」）', async () => {
    // 这条钉的是**缺省行为逐字节不变**：若有人把「不传则用被采纳的那张」实现出来，
    // 每一次**既有**迭代都会多带一张参考图（edit_input_url 由 null 变有值、refs 变长、
    // 成本与「参考图 + 生成图 ≤ 15」的硬约束都动）—— 那是产品决策，不是本 Task 的实现细节。
    const res = await post('/iterate', { jobId: IE, guidance: '什么都不传' });
    expect(res.status).toBe(200);
    expect((await newRow(res)).editInputUrl).toBeNull();
  });
});

describe.skipIf(!run)('GET /style-bible/:productId', () => {
  // 自给自足：**本块自己种**，不依赖别的 describe 的 beforeAll ——
  // 上面那些块的 afterAll 会把它们种的剧本删掉，跨块共享种子会让本块变成「按块序才通过」的脆弱用例。
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values([
      { id: P_SB_EMPTY, name: '空基线剧本', styleBible: {} },
      { id: P_SB_OK, name: '基线就绪剧本', styleBible: { artStyle: 'ink' } },
    ]).onConflictDoNothing();
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, [P_SB_EMPTY, P_SB_OK]));
  });

  it('不存在的产品 → 404', async () => {
    const res = await get(`/style-bible/${B}-no-such-product`);
    expect(res.status).toBe(404);
  });

  it('styleBible 为 {} → ready 为 false', async () => {
    const res = await get(`/style-bible/${P_SB_EMPTY}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.ready).toBe(false);
  });

  it('带 artStyle → ready 为 true，且 anchorReady 反映 style_anchor_url', async () => {
    const res = await get(`/style-bible/${P_SB_OK}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.ready).toBe(true);
    expect(body.data.anchorReady).toBe(false);
    expect(body.data.styleAnchorUrl).toBeNull();
  });
});

describe.skipIf(!run)('GET /jobs/:jobId/versions', () => {
  const V1 = `${B}-ver-1`;
  const V2 = `${B}-ver-2`;

  beforeAll(async () => {
    JOB_IDS.push(V1, V2);
    await db.insert(pmsBuiWenlvAssetJobs).values([
      {
        id: V1, batchId: `${B}-vb`, assetType: 'background', name: 'V', status: 'succeeded',
        attempt: 1, iteration: 1, costAmount: '0.14', styleBibleSnapshot: {}, createdAt: new Date('2024-01-01T00:00:00Z'),
      },
      {
        id: V2, batchId: `${B}-vb`, assetType: 'background', name: 'V', status: 'succeeded',
        attempt: 1, iteration: 2, parentJobId: V1, costAmount: '0.14', styleBibleSnapshot: {}, createdAt: new Date('2024-01-02T00:00:00Z'),
      },
    ]);
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, [V1, V2]));
  });

  it('不存在的 jobId → 404（与 /retry、/iterate、/style-bible 一致）', async () => {
    const res = await get(`/jobs/${B}-no-such-job/versions`);
    expect(res.status).toBe(404);
  });

  it('两代链 → 长度 2 且从旧到新（钉住 reverse）', async () => {
    const res = await get(`/jobs/${V2}/versions`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.versions.length).toBe(2);
    expect(body.data.versions[0].id).toBe(V1);
    expect(body.data.versions[1].id).toBe(V2);
    expect(body.data.versions[0].iteration < body.data.versions[1].iteration).toBe(true);
    // 链自然到头（不是被 20 层上界截断）—— 反向半边：把 truncated 写死成 true 会红。
    expect(body.data.truncated).toBe(false);
  });
});

describe.skipIf(!run)('GET /jobs/:jobId/versions —— 20 层上界不得静默（Task 17 清单 B-10）', () => {
  // 25 层链：比上界多 5。修复前这条链返回 20 条且**没有任何字段**说明被截断，
  // 而 `versions[0].iteration === 6` —— 前端把数组第一个当「首版」，读起来就是
  // 「这个素材的首版是第 6 版」。属误导，不是「短了一截」。
  const CHAIN = Array.from({ length: 25 }, (_, i) => `${B}-chain-${i + 1}`);

  beforeAll(async () => {
    JOB_IDS.push(...CHAIN);
    await db.insert(pmsBuiWenlvAssetJobs).values(CHAIN.map((id, i) => ({
      id, batchId: `${B}-chainb`, assetType: 'background', name: 'chain', status: 'succeeded',
      attempt: 1, iteration: i + 1, parentJobId: i === 0 ? null : CHAIN[i - 1],
      costAmount: '0', styleBibleSnapshot: {}, createdAt: new Date('2024-01-01T00:00:00Z'),
    })));
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, CHAIN));
  });

  it('25 层链 → 20 条 + truncated:true（把「我只走了一段」说出来）', async () => {
    const res = await get(`/jobs/${CHAIN[24]}/versions`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.versions.length).toBe(20);
    // ★ 本条是 B-10 的全部要点：没有它，上面那条长度断言对「静默」与「明说」一视同仁。
    expect(body.data.truncated).toBe(true);
    // 从新到旧走完 20 条后停下来 ⇒ 数组（已 reverse，旧→新）的第一条是第 6 版。
    // 把这个事实**钉在测试里**：正因为数组看起来像从首版开始，才必须靠 truncated 区分。
    expect(body.data.versions[0].iteration).toBe(6);
    expect(body.data.versions[19].iteration).toBe(25);
  });
});

describe.skipIf(!run)('批次进度查询（GROUP BY 派生）', () => {
  beforeAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    // createdAt 显式给值：三条同一条 INSERT 时 `DEFAULT now()` 会完全相同，顺序不可测。
    //
    // ⚠️ 这里刻意让**三种顺序两两不同**（Task 17 清单 D-16 加固）：
    //      期望（= createdAt 升序）  A, B, C
    //      物理插入序（= 无 ORDER BY 时的堆序，也约等于同键 btree 的返回序）  C, A, B
    //      **主键 id 序**            B, C, A
    //    为什么要把 id 序也错开：只错开插入序是不够的 —— **id 序此前恰好等于期望序**
    //    （id 是 `${B}-1/2/3` 而 createdAt 也按 1/2/3 递增），于是只要 PG 换个计划走
    //    **主键索引扫描**，删掉端点里的 orderBy 也会返回 A,B,C ⇒ M5 变异**悄悄不红**。
    //    三种顺序两两不同后，无论走顺序扫描还是主键索引，都不可能无意中撞上期望序。
    //    （id 只在下面这条 INSERT 里出现，全局无其它引用，故可自由错开。）
    await db.insert(pmsBuiWenlvAssetJobs).values([
      { id: `${B}-2`, batchId: B, assetType: 'background', name: 'C', status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {}, createdAt: new Date('2024-01-03T00:00:00Z') },
      { id: `${B}-3`, batchId: B, assetType: 'background', name: 'A', status: 'succeeded', attempt: 1, costAmount: '0.1', styleBibleSnapshot: {}, createdAt: new Date('2024-01-01T00:00:00Z') },
      { id: `${B}-1`, batchId: B, assetType: 'background', name: 'B', status: 'failed', attempt: 1, costAmount: '0.2', styleBibleSnapshot: {}, createdAt: new Date('2024-01-02T00:00:00Z') },
    ]);
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
  });

  it('进度与总额由明细派生，没有批次表', async () => {
    const res = await get(`/batch/${B}`);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.data.counts.succeeded).toBe(1);
    expect(body.data.counts.failed).toBe(1);
    expect(body.data.counts.pending).toBe(1);
    // 金额刻意选 0.1 + 0.2 + 0：IEEE754 下累加得 0.30000000000000004，**只有**经过
    // 端点的 `Math.round(totalCost * 10000) / 10000` 才会等于精确的 0.3。
    //（改回 0.14+0.14 就退化成「不四舍五入也相等」—— 那条断言曾被实测证明测不到 Math.round。）
    // 不用 toBeCloseTo / toHaveLength：保持本文件既有写法。
    // ⚠️ 2026-09-19 更正：toBeCloseTo 确实仍不在桩内，但 **toHaveLength 早已在**
    //    （该半句在 d5a65359 之前就是错的）。是否可用以 src/types/vitest.d.ts 为准。
    expect(body.data.totalCost).toBe(0.3);
    expect(body.data.jobs.length).toBe(3);
    // 明细按 createdAt 升序 ⇒ 钉住 orderBy（删掉它这条会红）
    expect(body.data.jobs.map((j: any) => j.name)).toEqual(['A', 'B', 'C']);
    // 逐条投影：costAmount 必须是 **number**（钉住 Number() 转换；直接透传会是 '0.1' 字符串），
    // assetType/attempt 是真值（防 db.execute 那类「静默 undefined」）。
    const a = body.data.jobs[0];
    expect(a.assetType).toBe('background');
    expect(a.attempt).toBe(1);
    expect(typeof a.costAmount).toBe('number');
    expect(a.costAmount).toBe(0.1);
    expect(body.data.jobs[1].costAmount).toBe(0.2);
    // 停摆信号的**负向半边**：本批合计花费 0.3、上限默认 20、待领行 attempt 0 < MAX_ATTEMPT
    // ⇒ 三条停摆条件一条都不成立。缺了这条，「stalled 恒 true」的实现照样能让下面的
    // 正向用例全绿（恒真的假判据）—— 期望 0 的判据必须先在这份**正确状态**上验一遍。
    expect(body.data.stalled).toBe(false);
    expect(body.data.stalledReason).toBe(null);
  });
});

describe.skipIf(!run)('GET /batch/:batchId —— 停摆信号（budget / attempt_exhausted）', () => {
  // 三个**互不相同**的 batchId：每条用例自己种、自己查，用例之间零顺序依赖
  //（复用同一个 batchId 会让「谁先跑」决定结果 —— 那是脆弱用例的典型形状）。
  const SB = `${B}-stall-budget`;
  const SA = `${B}-stall-attempt`;
  const SR = `${B}-stall-running`;
  const ALL = [SB, SA, SR];

  afterAll(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.batchId, ALL));
  });

  const batchOf = async (batchId: string) =>
    (await (await get(`/batch/${batchId}`)).json() as any);

  it('预算熔断：待领行因超预算领不走 → stalled=true / reason=budget', async () => {
    // 上限压到 0.1，本批已花 0.2 ⇒ SUM >= 上限 ⇒ 领取 SQL 的 budgetFilter 挡住全部待领行。
    // 此前这一批里那条 pending 行永远停在 pending（状态域没有「被熔断」这一态），
    // 前端 `some(status === 'pending')` 恒真 ⇒ 每 5s 永久空转。
    const prev = process.env.WENLV_BATCH_BUDGET_YUAN;
    process.env.WENLV_BATCH_BUDGET_YUAN = '0.1';
    try {
      await db.insert(pmsBuiWenlvAssetJobs).values([
        { id: `${SB}-s`, batchId: SB, assetType: 'background', name: 'S', status: 'succeeded', attempt: 1, costAmount: '0.2', styleBibleSnapshot: {} },
        // attempt 1 < MAX_ATTEMPT ⇒ 被挡的**只可能**是预算那一条（把两条原因区分开）
        { id: `${SB}-p`, batchId: SB, assetType: 'background', name: 'P', status: 'pending', attempt: 1, costAmount: '0', styleBibleSnapshot: {} },
      ]);
      const body = await batchOf(SB);
      // 先钉住 env 真的生效了：limit 不是默认的 20，否则本条可能因为别的原因红/绿
      expect(body.data.budget.limit).toBe(0.1);
      expect(body.data.counts.pending).toBe(1);   // 对照：确实有一行领不走，不是空批
      expect(body.data.stalled).toBe(true);
      expect(body.data.stalledReason).toBe('budget');
    } finally {
      // ⚠️ 必须还原：env 会泄漏给同 worker 的其它测试文件（与 wachat-pay 那套 withAmountFen 同纪律）
      if (prev === undefined) delete process.env.WENLV_BATCH_BUDGET_YUAN;
      else process.env.WENLV_BATCH_BUDGET_YUAN = prev;
    }
  });

  it('重试耗尽：待领行 attempt 已达上限 → stalled=true / reason=attempt_exhausted', async () => {
    // 种：一行 pending attempt = MAX_ATTEMPT  + 一行 succeeded。
    // 用 MAX_ATTEMPT 常量而**不是**手抄字面量 3 —— 上限改了这里要跟着改，否则静默失效。
    await db.insert(pmsBuiWenlvAssetJobs).values([
      { id: `${SA}-s`, batchId: SA, assetType: 'background', name: 'S', status: 'succeeded', attempt: 1, costAmount: '0.05', styleBibleSnapshot: {} },
      { id: `${SA}-p`, batchId: SA, assetType: 'background', name: 'P', status: 'pending', attempt: MAX_ATTEMPT, costAmount: '0', styleBibleSnapshot: {} },
    ]);
    const body = await batchOf(SA);
    expect(body.data.counts.pending).toBe(1);
    expect(body.data.stalled).toBe(true);
    expect(body.data.stalledReason).toBe('attempt_exhausted');
  });

  it('对照：仍有 running 行时 stalled 仍为 false（服务端的 stalled 只判 pending）', async () => {
    // 种：一行 running + 一行 pending attempt 0 ⇒ 不该被判停摆（前端才负责 running 优先）。
    // ⚠️ 本条同时是**上一条 env 还原的探针**：succeeded 花 0.2，若 WENLV_BATCH_BUDGET_YUAN
    //    泄漏成 '0.1'，budgetStopped 会变 true ⇒ 这里会红。也就是说 try/finally 被删掉时
    //    本条真的会咬人，而不是「还原不还原都绿」。
    await db.insert(pmsBuiWenlvAssetJobs).values([
      { id: `${SR}-r`, batchId: SR, assetType: 'background', name: 'R', status: 'running', attempt: 1, costAmount: '0.2', styleBibleSnapshot: {} },
      { id: `${SR}-p`, batchId: SR, assetType: 'background', name: 'P', status: 'pending', attempt: 0, costAmount: '0', styleBibleSnapshot: {} },
    ]);
    const body = await batchOf(SR);
    expect(body.data.budget.limit).toBe(20);      // 默认上限 ⇒ 证明确实没被上一条的 env 污染
    expect(body.data.stalled).toBe(false);
    expect(body.data.stalledReason).toBe(null);
  });
});

afterAll(async () => {
  if (JOB_IDS.length > 0) {
    await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.id, JOB_IDS));
  }
});

// ===== 进程内 in-flight 守卫（S3 加固，2026-09-14 拍板）=====
//
// 为什么要这些用例：守卫的唯一作用是「不让双击变成双倍付费」，而它**检查一次、释放一次**，
// 两个动作都可能被后来者误删 —— 删了检查就是白挂，删了释放就是永久锁死。
// 除 (c) 的「冷却到期」必须**真等** 3.1s 外，其余每条都确定性（手动 acquire 等价于
// 「另一个请求正在飞」，不靠 sleep 抢时间窗）。
//
// ⚠️ 模块级 Set/Map 是**进程级**共享的：每条用例都必须自己 `release`（用 try/finally），
//    漏一条会让后面所有用例莫名全红。文件级 beforeEach 的 `_debugResetGuard()` 只保证
//    「用例开始时干净」，不替用例收拾自己的占位。
describe.skipIf(!run)('付费端点的进程内 in-flight 守卫', () => {
  const PG = `${B}-guard-p`;       // 有基线 + 有锚图 + 一个节点 → /batch 走得通
  const NG = `${B}-guard-n`;
  const RG_1 = `${B}-guard-r1`;    // 供「占位 → 409 且行不变」用
  const RG_2 = `${B}-guard-r2`;    // 供「释放后可用」用（与 RG_1 分开，避免用例间顺序依赖）
  const IG = `${B}-guard-i1`;      // succeeded，供 /iterate 用
  const countJobs = async () =>
    (await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.productId, PG))).length;

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({
      id: PG, name: '守卫剧本', styleBible: { artStyle: 'ink' },
      styleAnchorUrl: 'https://oss.test/anchor.png',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${PG}`, contentId: PG, name: '守卫房', mode: 'narrative' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${PG}`, scriptRoomId: `room-${PG}`, title: '第一章', order: 0 }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScenes)
      .values({ id: NG, chapterId: `ch-${PG}`, title: '节点一', type: 'narrative', content: '井水很凉。' })
      .onConflictDoNothing();
    JOB_IDS.push(RG_1, RG_2, IG);
    await db.insert(pmsBuiWenlvAssetJobs).values([
      { id: RG_1, batchId: `${B}-guard-rb`, productId: PG, assetType: 'background', name: 'R1', status: 'failed', attempt: 1, costAmount: '0.14', styleBibleSnapshot: {} },
      { id: RG_2, batchId: `${B}-guard-rb`, productId: PG, assetType: 'background', name: 'R2', status: 'failed', attempt: 1, costAmount: '0.14', styleBibleSnapshot: {} },
      { id: IG, batchId: `${B}-guard-ib`, productId: PG, assetType: 'background', name: 'I1', status: 'succeeded', attempt: 1, costAmount: '0.14', styleBibleSnapshot: {} },
    ]);
  });
  afterAll(async () => {
    // /iterate 会新建行（parentJobId 指向 IG），按 productId 一并清干净
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.productId, PG));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, `ch-${PG}`));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, `room-${PG}`));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PG));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PG));
  });

  it('(a) /batch：key 已在飞 → 409，且**一条 job 都没建**（检查在唯一副作用之前）', async () => {
    const before = await countJobs();
    expect(acquire(`batch:${PG}`)).toBe(true);
    try {
      const res = await post('/batch', { productId: PG, types: ['background'] });
      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.success).toBe(false);
      expect(body.error).toBe('该剧本正在生成中，请稍候再试');
      // 「上游没有被调用」在 /batch 的可观测面就是**没有 INSERT**：整条付费链路被挡在锁外。
      expect(await countJobs()).toBe(before);
    } finally {
      release(`batch:${PG}`);
    }
  });

  // ⚠️ (d) **必须**排在 (b)(c) 之前：那两条会走成功路径、在 `batch:${PG}` 上留下 3s 冷却，
  //    排到后面的话 (d) 里的 `acquire(batch:PG)` 会被冷却误挡成 false。
  //    （本仓 vitest 配置 fileParallelism: false 且无 shuffle ⇒ 同一 describe 内的声明顺序
  //      就是执行顺序；这是可靠前提，但改动本块顺序时务必保持 (d) 在前。）
  it('(d) /batch：key 被占住时，非法请求仍拿 400/404 而不是 409（证明获取在后置位置）', async () => {
    // 400：同一 productId、但没给 types
    expect(acquire(`batch:${PG}`)).toBe(true);
    try {
      expect((await post('/batch', { productId: PG })).status).toBe(400);
    } finally {
      release(`batch:${PG}`);
    }
    // 404：占位用的 key **就是**那个不存在的 productId —— 守卫若在读产品之前，这里会变 409
    const missing = `${B}-guard-no-such-product`;
    expect(acquire(`batch:${missing}`)).toBe(true);
    try {
      expect((await post('/batch', { productId: missing, types: ['background'] })).status).toBe(404);
    } finally {
      release(`batch:${missing}`);
    }
  });

  it('(b) /batch：成功后**立刻**再触发 → 409，且没有多建一条 job（双击不双倍付费）', async () => {
    // 2026-09-14：`hold` 上线前这里断言的是「跑完后 key 回到空」。加了成功后冷却之后，
    // 那个断言本身**就是**缺陷（它把「冷却必须存在」判成失败）。改成钉住**新契约**：
    const before = await countJobs();
    expect((await post('/batch', { productId: PG, types: ['background'] })).status).toBe(200);
    const afterFirst = await countJobs();
    // 第一批**真的建了** —— 否则「没增加」会因为根本没建成而恒真（假绿）。
    expect(afterFirst > before).toBe(true);
    // 立刻再触发（模拟双击第二下）：冷却必须挡住它。
    expect((await post('/batch', { productId: PG, types: ['background'] })).status).toBe(409);
    // 硬证据：第二次没有 enqueue —— 没有双倍付费。
    expect(await countJobs()).toBe(afterFirst);
  });

  it('(c) /batch：冷却到期后放行（不是「第二次永远 409」的永久死锁）', async () => {
    expect((await post('/batch', { productId: PG, types: ['background'] })).status).toBe(200);
    expect((await post('/batch', { productId: PG, types: ['background'] })).status).toBe(409);
    // **真等**，不用 fake timers：本用例真读写 PG，mock Date 风险大。
    // 等待本身也是「端点确实 release 了 key」的证据 —— 若 finally 里的 release 被删掉，
    // 在飞集合会永久占着 `batch:${PG}`，冷却到期后 acquire 仍是 false ⇒ 这里必然不是 200。
    await new Promise(r => setTimeout(r, 3100));
    expect((await post('/batch', { productId: PG, types: ['background'] })).status).toBe(200);
  });

  it('/retry：key 已在飞 → 409，且行**没有**被改回 pending（副作用未发生）', async () => {
    expect(acquire(`retry:${RG_1}`)).toBe(true);
    try {
      const res = await post('/retry', { jobId: RG_1 });
      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.error).toBe('该任务正在重试中，请稍后重试');
      const [row] = await db.select().from(pmsBuiWenlvAssetJobs)
        .where(eq(pmsBuiWenlvAssetJobs.id, RG_1)).limit(1);
      expect(row.status).toBe('failed');
    } finally {
      release(`retry:${RG_1}`);
    }
  });

  it('/retry：占位释放后同一请求 → 200，且端点自己也把 key 还回来', async () => {
    expect(acquire(`retry:${RG_2}`)).toBe(true);
    expect((await post('/retry', { jobId: RG_2 })).status).toBe(409);
    release(`retry:${RG_2}`);   // 模拟「第一个请求已经跑完」
    expect((await post('/retry', { jobId: RG_2 })).status).toBe(200);
    expect(acquire(`retry:${RG_2}`)).toBe(true);   // 端点也释放了
    release(`retry:${RG_2}`);
    // 成功后再点一次（双击的第二下）：必须拿到**准确的 400**「只有失败的任务可以重试」，
    // 而不是 409「该任务正在重试中」—— 后者此刻是假话（没有任何请求在飞）。
    // 这条钉的正是「把 `hold` 从 /retry 摘掉」这个裁决：状态校验已先一步挡住第二次，
    // 冷却在这里挡不住任何付费，只会在「任务又失败」时给出文案不实的 409。
    const dup = await post('/retry', { jobId: RG_2 });
    expect(dup.status).toBe(400);
    expect((await dup.json() as any).error).toBe('只有失败的任务可以重试');
  });

  it('/iterate：key 是在飞 → 409，且**没有**新建迭代行（自然键取父行 productId）', async () => {
    const children = async () =>
      (await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
        .where(eq(pmsBuiWenlvAssetJobs.parentJobId, IG))).length;
    const before = await children();
    expect(acquire(`iterate:${PG}`)).toBe(true);
    try {
      const res = await post('/iterate', { jobId: IG, guidance: '再亮一点' });
      expect(res.status).toBe(409);
      expect(await children()).toBe(before);
    } finally {
      release(`iterate:${PG}`);
    }
  });
});

// ===== 总闸端点（Task 2）=====
//
// 放在**文件末尾**：它自己种产品/节点（不复用上面各块的夹具），且各块的 afterAll
// 会把各自的种子删掉 —— 共享夹具会让本块变成「按块序才通过」的脆弱用例。
describe.skipIf(!run)('停闸端点（pause / resume / pause-state）', () => {
  const PP = `${B}-pause-p`;
  const NP = `${B}-pause-n`;
  const PJ_RETRY = `${B}-pause-retry`;   // failed 行，供 /retry
  const PJ_ITER = `${B}-pause-iter`;     // succeeded 行，供 /iterate

  // LLM 探针：`/style-bible/bootstrap` 是四个花钱端点里**唯一同步打 LLM** 的
  //（另外三个只建行/改行，钱由调度器事后花）。而 `callLlm` 在读不到
  // DASHSCOPE_API_KEY 时**直接抛、连 fetch 都不发** —— 不设假 key + 不打桩 fetch，
  // 「闸在 LLM 之前还是之后」这件事根本观测不到（闸挪到后面也测不出来）。
  const llmFetch = vi.fn(async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ artStyle: '水墨', mustHave: ['古井'] }) } }],
    }),
  }));

  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({
      id: PP, name: '停闸剧本', styleBible: { artStyle: 'ink' },
      // 已有锚图 ⇒ `skipAnchorInsert` 视觉支为 true ⇒ /batch 只建 1 行（不补锚图）。
      // 精确行数才能把「恢复后真的建了行」与「恢复后也是空转」区分开。
      styleAnchorUrl: 'https://oss.test/anchor.png',
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${PP}`, contentId: PP, name: '停闸房', mode: 'narrative' }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${PP}`, scriptRoomId: `room-${PP}`, title: '第一章', order: 0 }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvScenes)
      .values({ id: NP, chapterId: `ch-${PP}`, title: '节点一', type: 'narrative', content: '井水很凉。' })
      .onConflictDoNothing();
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';   // fetch 已打桩，不会真的发出去
  });
  afterAll(async () => {
    delete process.env.DASHSCOPE_API_KEY;
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.productId, PP));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, `ch-${PP}`));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, `room-${PP}`));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PP));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PP));
  });
  // ⚠️ 内存开关是**进程级**状态：不清会串到本文件**同进程内**的后面的用例（vitest 每文件
  //    独立进程，故不会跨文件 —— 别写成「跨文件守卫」）。
  //    同时按 productId 清 job 行 —— 不清理的话「不建任何 job 行」那条会因为
  //    上一条用例的遗留而恒红/恒绿。
  beforeEach(async () => {
    setAssetGenPaused(false);
    delete process.env.WENLV_ASSET_GEN_PAUSED;
    llmFetch.mockClear();
    vi.stubGlobal('fetch', llmFetch);
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.productId, PP));
  });
  afterEach(() => {
    setAssetGenPaused(false);
    delete process.env.WENLV_ASSET_GEN_PAUSED;
    vi.unstubAllGlobals();
  });

  const jobCount = async () =>
    (await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.productId, PP))).length;
  /** /iterate 新建的行按 parentJobId 挂 —— 只数这一条链条，不受其它行干扰。 */
  const childCount = async () =>
    (await db.select({ id: pmsBuiWenlvAssetJobs.id }).from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.parentJobId, PJ_ITER))).length;
  const rowOf = async (id: string) => {
    const [r] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, id)).limit(1);
    return r;
  };

  it('POST /pause 后 GET /pause-state 为 true', async () => {
    // 先立**初态为 false**：少了它，「pause 后为 true」在「pause-state 恒返 true」的
    // 实现下照样绿 —— 一条恒真的假断言。
    const res0 = await get('/pause-state');
    expect(res0.status).toBe(200);
    expect((await res0.json() as any).data.paused).toBe(false);

    const res = await post('/pause', {});
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.paused).toBe(true);
    expect((await (await get('/pause-state')).json() as any).data.paused).toBe(true);
  });

  it('POST /resume 后 GET /pause-state 为 false', async () => {
    await post('/pause', {});
    expect((await (await get('/pause-state')).json() as any).data.paused).toBe(true);   // 前置确实生效
    const res = await post('/resume', {});
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.paused).toBe(false);
    expect((await (await get('/pause-state')).json() as any).data.paused).toBe(false);
  });

  it('env=1 时 /resume 停不掉暂停，且响应体**如实**回 paused:true（不撒谎）', async () => {
    // 行为本身是对的：env 是第二把闸，进程内开关清不掉它。错的只可能是响应体 ——
    // 「出不了图 → 敲 /resume → 拿到『已恢复』→ 不再管它」是运维唯一会做的动作。
    // 硬编码 `{ paused: false }` 时本条红在第一个 data.paused 断言上。
    process.env.WENLV_ASSET_GEN_PAUSED = '1';
    const res = await post('/resume', {});
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.paused).toBe(true);
    expect((await (await get('/pause-state')).json() as any).data.paused).toBe(true);
  });

  it('暂停时非法请求仍拿各自的 400/404，不被闸改判成 409（闸在全部前置校验之后）', async () => {
    // 这条钉的是**闸的位阶**（文件头纪律第 4 条）。闸若写在函数体第一行，
    // 下面四个请求会全部变成 409「资产生成已暂停」—— 调用方拿到的诊断与真实原因无关。
    await post('/pause', {});
    expect((await post('/batch', {})).status).toBe(400);                                          // 缺 productId
    expect((await post('/batch', { productId: `${B}-no-such-p`, types: ['background'] })).status)
      .toBe(404);                                                                                  // 产品不存在
    expect((await post('/retry', { jobId: `${B}-pause-no-such` })).status).toBe(404);
    expect((await post('/iterate', { jobId: `${B}-pause-no-such`, guidance: 'x' })).status).toBe(404);
  });

  it('暂停时 POST /batch 返 409 且**不建任何 job 行**', async () => {
    // 「不建行」是本条的重点：只断 409 的话，把 409 写在建行之后仍然绿。
    const before = await jobCount();
    expect(before).toBe(0);   // 地基：不成立就说明上面的清理没生效，本条的计数断言毫无意义
    await post('/pause', {});
    const res = await post('/batch', { productId: PP, types: ['background'] });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('资产生成已暂停');
    expect(await jobCount()).toBe(before);
  });

  it('恢复后 POST /batch 正常返回（证明闸可逆，不是单向死锁）', async () => {
    const before = await jobCount();
    await post('/pause', {});
    expect((await post('/batch', { productId: PP, types: ['background'] })).status).toBe(409);
    await post('/resume', {});
    const res = await post('/batch', { productId: PP, types: ['background'] });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // 1 个节点 × 1 类型 + 0（已有锚图不补）= 1 行
    expect(body.data.total).toBe(1);
    expect(await jobCount()).toBe(before + 1);
  });

  it('暂停时 POST /retry 返 409，且行**仍是 failed**（没被改回 pending）', async () => {
    // 只断 409 的话，把闸写在 UPDATE 之后仍然绿 —— 而那一版正是「界面看着在跑、
    // 调度器不动、行永远 pending」的原样复现（attempt 不涨，看不出异常）。
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: PJ_RETRY, batchId: `${B}-pause-rb`, productId: PP, assetType: 'background',
      name: '暂停期重试', status: 'failed', attempt: 1, costAmount: '0', styleBibleSnapshot: {},
    });
    await post('/pause', {});
    const res = await post('/retry', { jobId: PJ_RETRY });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('资产生成已暂停');
    const r = await rowOf(PJ_RETRY);
    expect(r.status).toBe('failed');       // 承重断言
    expect(r.startedAt).toBeNull();
  });

  it('暂停时 POST /iterate 返 409，且**没有**多建迭代行', async () => {
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: PJ_ITER, batchId: `${B}-pause-ib`, productId: PP, assetType: 'background',
      name: '暂停期迭代', status: 'succeeded', attempt: 1, iteration: 1,
      costAmount: '0', styleBibleSnapshot: {}, prompt: '上一版的画面描述',
    });
    const before = await childCount();
    expect(before).toBe(0);   // 地基：清理没生效的话，下面的「没增加」毫无意义
    await post('/pause', {});
    const res = await post('/iterate', { jobId: PJ_ITER, guidance: '再亮一点' });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('资产生成已暂停');
    expect(await childCount()).toBe(before);   // 承重断言：没有 enqueueIteration
  });

  it('暂停时 POST /style-bible/bootstrap 返 409，且**没打 LLM**', async () => {
    // 必须 `force: true`：不带 force 且已有基线时，端点在闸**之前**走 `reused` 捷径
    // 回 200 reused（纯读、零花费、不打 LLM）—— 那处例外是**有意**保留的，见文件头纪律第 4 条。
    await post('/pause', {});
    const res = await post('/style-bible/bootstrap', { productId: PP, force: true });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe('资产生成已暂停');
    // 承重断言：闸若挪到 bootstrapStyleBible 之后，这次调用真的会发生 → 本条红。
    expect(llmFetch.mock.calls.length).toBe(0);

    // ★ 反证探针**活着**：恢复后打同一个请求，LLM 必须被调用一次。
    //   缺了这半边，上面的 `=== 0` 在「key 没设 / 桩没生效 / 这条路压根打不到 LLM」时
    //   同样为 0 —— 一条恒真的假断言（本仓栽过的形状）。
    await post('/resume', {});
    expect((await post('/style-bible/bootstrap', { productId: PP, force: true })).status).toBe(200);
    expect(llmFetch.mock.calls.length).toBe(1);
  });
});
