import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import wenlvDesignRoute from '../wenlv-design.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvDesignAssets, pmsBuiWenlvProducts,
  pmsBuiWenlvCollectibles, pmsBuiWenlvVenues, pmsBuiWenlvScenes,
  pmsBuiWenlvChapters, pmsBuiWenlvScriptRooms,
} from '../../../db/schema/index.js';

const run = !!process.env.RUN_DB;
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const TAG = 'manual-' + Date.now();
const VENUE = TAG + '-v';
const PROD = TAG + '-p';
const COLL = TAG + '-c';
// 第二条坐标路径：`node` 上同时挂 `background`（插画）与 `narration`（配音）两种槽位 ——
// 它既是 `productIdOfTarget` 的第二个 switch 分支，也是「ensure 的键含 `type`」的唯一探针。
const NODE = TAG + '-n';
const ROOM = TAG + '-room';
const CH = TAG + '-ch';

const post = (body: unknown) =>
  wenlvDesignRoute.request('/assets/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('POST /assets/manual（无库）', () => {
  it('缺内部令牌 → 403', async () => {
    const r = await wenlvDesignRoute.request('/assets/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'collectible', name: 'x', url: 'https://oss.test/x.png', targetKind: 'collectible', targetId: 'c1' }),
    });
    expect(r.status).toBe(403);
    // ⚠️ 这条**只**证明「令牌守卫覆盖该路径」。`route.use('*')` 是 catch-all ⇒ 任意
    //    **不存在**的路径无令牌同样回 403，所以本断言对「`/assets/manual` 是否注册」
    //    零判别力（[[route-test-404-default-masks]] 同族）。存在性证据来自同组
    //    valid-token 的那两条（400 / 200），它们现在正是红的。
    //    断错误体是为了钉住「403 是守卫发的」而不是别的东西发出的：
    expect((await r.json()).error).toContain('内部服务');
  });

  it('槽位与坐标不自洽 → 400（cover 不能挂在 collectible 上）', async () => {
    const r = await post({ type: 'cover', name: 'x', url: 'https://oss.test/x.png', targetKind: 'collectible', targetId: 'c1' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('product');
  });
});

describe.skipIf(!run)('POST /assets/manual（DB）', () => {
  // 🔴 2026-09-23 订正：清理**不再**挂在这里（模块作用域）—— `describe.skipIf` 跳过的是**用例**、
  //    不跳过 hook ⇒ 挂模块作用域会让默认配置下本文件判 FAILED（机制与 6/6 仓内惯例见 Task 5 Step 2
  //    同款订正）。它已移入下面 `describe.skipIf(!run)('POST /assets/manual（DB）')` 的**内部**。
  //
  // ⚠️ 夹具的**插入**放在 `beforeAll`、不放在第一条用例体内（与计划原文的唯一差异）：
  //    四条用例都依赖这三行夹具，而「夹具插入」与「被测的落库」同处一条断言序列时，
  //    单跑第 2/3/4 条（`-t` 过滤 / 只重跑失败项）会因夹具缺席而红 —— 且**红得指向实现**。
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '坐标场地' });
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '坐标剧本', venueId: VENUE });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM, contentId: PROD, name: '坐标房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: CH, scriptRoomId: ROOM, title: '第一章', order: 0 });
    await db.insert(pmsBuiWenlvCollectibles).values({ id: COLL, productId: PROD, name: '线索一' });
    await db.insert(pmsBuiWenlvScenes).values({ id: NODE, chapterId: CH, title: '古井旁', type: 'narrative' });
  });

  afterAll(async () => {
    // 键用夹具可控的 `targetId`（本文件每次请求送的都是 `COLL` / `NODE`），**不用**被测代码
    // 推导的 `productId` —— 后者写错就静默漏删。也**不用** `like('ma-%')`：那会把本地开发库
    // 里别人手工传的素材一并扫掉，而本文件写的每一行坐标都恰好落在这两个 id 上。
    // ⚠️ 新增坐标就**必须**加进这个 inArray —— 漏了会留下看不见的脏行（本行是完备性声明）。
    await db.delete(pmsBuiWenlvDesignAssets)
      .where(inArray(pmsBuiWenlvDesignAssets.targetId, [COLL, NODE]));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, PROD));
    await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, PROD));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
  });

  it('落一行 design_assets：有坐标、job_id 为 NULL、venueId 从剧本推导（不是公共池）', async () => {
    const r = await post({ type: 'collectible', name: '手工图鉴图', url: 'https://oss.test/manual-1.png', targetKind: 'collectible', targetId: COLL });
    expect(r.status).toBe(200);
    const { data } = await r.json();
    expect(data.targetKind).toBe('collectible');
    expect(data.targetId).toBe(COLL);
    expect(data.jobId).toBeNull();
    // venue_id 的 NULL 语义是**公共池**，不是「没填」⇒ 这条必须是场地的 id
    expect(data.venueId).toBe(VENUE);
    expect(data.productId).toBe(PROD);
    expect(data.isBuiltin).toBe(false);

    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, data.id)).limit(1);
    expect(row.targetId).toBe(COLL);
  });

  it('ensure：同坐标同 URL 再调一次不新增行，返回同一 id', async () => {
    const first = await (await post({ type: 'collectible', name: '手工图鉴图', url: 'https://oss.test/manual-1.png', targetKind: 'collectible', targetId: COLL })).json();
    const again = await (await post({ type: 'collectible', name: '手工图鉴图', url: 'https://oss.test/manual-1.png', targetKind: 'collectible', targetId: COLL })).json();
    expect(again.data.id).toBe(first.data.id);
    const rows = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(and(eq(pmsBuiWenlvDesignAssets.targetId, COLL), eq(pmsBuiWenlvDesignAssets.url, 'https://oss.test/manual-1.png')));
    expect(rows.length).toBe(1);
  });

  it('换一张 URL 是**另一条**素材（ensure 的判据含 url）', async () => {
    const r = await (await post({ type: 'collectible', name: '手工图鉴图二', url: 'https://oss.test/manual-2.png', targetKind: 'collectible', targetId: COLL })).json();
    expect(r.data.url).toBe('https://oss.test/manual-2.png');
    const rows = await db.select().from(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.targetId, COLL));
    expect(rows.length).toBe(2);
  });

  it('同一个节点的同一张图、两个槽位（插画 / 配音）是**两条**素材：ensure 的键含 type', async () => {
    // `node` 是唯一一个会同时挂两种槽位的实体（`background`→插画、`narration`→配音，
    // 两者 `expectedKindOf` 都是 'node'）⇒ 它是「键里到底有没有 type」的**唯一**探针：
    // 键若只有 (targetKind, targetId, url)，第二条会被误判成「已有」而返回第一条的 id。
    const shared = 'https://oss.test/shared.png';
    const ra = await post({ type: 'background', name: '古井旁插画', url: shared, targetKind: 'node', targetId: NODE });
    const rb = await post({ type: 'narration', name: '古井旁旁白', url: shared, targetKind: 'node', targetId: NODE });
    // 🔴 这两句是**承重**的：失败响应体是 `{success:false,error}`、**没有 `data`** ⇒
    //    少了它们，两次请求都失败时下面那句会读到 `undefined !== 'ma-…'` 而**假绿**。
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const a = await ra.json(); const b = await rb.json();
    expect(a.data.id).not.toBe(b.data.id);
    // 顺带盖住 `productIdOfTarget` 的 `node` 分支与它的 venueId 推导（其余 4 个 switch
    // 分支在本文件里没有夹具 —— 未被覆盖不等于不成立，只是没有正面证据）。
    expect(a.data.targetKind).toBe('node');
    expect(a.data.productId).toBe(PROD);
    expect(a.data.venueId).toBe(VENUE);
    const rows = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(and(eq(pmsBuiWenlvDesignAssets.targetId, NODE), eq(pmsBuiWenlvDesignAssets.url, shared)));
    expect(rows.length).toBe(2);
  });

  it('目标要素不存在 → 404（不留指向死 id 的孤儿）', async () => {
    const r = await post({ type: 'collectible', name: 'x', url: 'https://oss.test/x.png', targetKind: 'collectible', targetId: 'no-such-collectible' });
    expect(r.status).toBe(404);
    // 🔴 只断状态码是**死的**：路由没注册时框架默认 404 与业务 404 同码（实测：实现前
    //    这条就是绿的）。框架默认 404 的 body 是纯文本 `404 Not Found` ⇒ 下面这句
    //    `.json()` 会抛，正好把「框架答的」与「业务答的」分开。断的是**体**。
    expect((await r.json()).error).toContain('目标要素不存在');
  });
});
