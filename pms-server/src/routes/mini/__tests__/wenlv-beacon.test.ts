// C端 JWT 用独立密钥；测试先注入桩值，避免 parseMiniToken 运行时 requireEnv 崩溃。
// 票券门旁路：仅测试/联调用，生产不设该 env。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
process.env.WENLV_BYPASS_TICKET = '1';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes,
  pmsBuiWenlvProgress,
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints, pmsBuiWenlvBeacons,
  pmsBuiWenlvEvents,
} from '../../../db/schema/index.js';

// ── 0079 统一模型辅助：nodes→scenes ──
async function ensureChapter(db: any, productId: string): Promise<string> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.insert(pmsBuiWenlvScriptRooms).values({ id: rid, contentId: productId, name: `${productId} 房` })
    .onConflictDoNothing({ target: pmsBuiWenlvScriptRooms.id });
  await db.insert(pmsBuiWenlvChapters).values({ id: cid, scriptRoomId: rid, title: '第一章', order: 0 })
    .onConflictDoNothing({ target: pmsBuiWenlvChapters.id });
  return cid;
}
async function insertScene(db: any, productId: string, n: any): Promise<void> {
  const cid = await ensureChapter(db, productId);
  await db.insert(pmsBuiWenlvScenes).values({
    id: n.id, chapterId: cid,
    type: (n.nodeType === 'puzzle' ? 'puzzle' : (n.nodeType === 'npc' ? 'npc' : 'narrative')),
    title: n.title, venuePointId: n.venuePointId ?? null,
    grants: n.grants ?? null, requires: n.requires ?? null,
    order: n.order ?? 0, puzzle: n.puzzle ?? null,
  });
}
async function deleteScene(db: any, sceneId: string): Promise<void> {
  await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, sceneId));
}
async function deleteScenesOfProduct(db: any, productId: string): Promise<void> {
  const rid = `room-${productId}`, cid = `ch-${productId}`;
  await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, cid));
  await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, cid));
  await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.id, rid));
}

const mkMini = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json' };
};

// 门控说明：同目录 wenlv.test.ts 的 DB 用例同样不加 skipIf，无库时整文件本就红。
// 为保持文件基调一致，本文件不加 skipIf。
describe('wenlv mini 信标触发（DB）', () => {
  const PRODUCT = 'mini-beacon-product';
  const MINI = 'mini-beacon-user';
  const VENUE = 'mini-beacon-venue';
  const PT = 'mini-beacon-pt';
  const PT_NOCODE = 'mini-beacon-pt-nocode';
  const NODE = 'mini-beacon-node';
  const BEACON = 'mini-beacon-dev1';
  const UUID_LOWER = 'fda50693-a4e2-4fb1-afcf-c6eb07647825';
  // 第二台「别家的」设备，**故意放在第二个场地 VENUE2**：
  //   · 它绑的是 PT2，而本文件所有「期望命中」的节点都绑 PT ⇒ 跨点位隔离用例
  //     （见文末「★ 跨点位隔离」）压的正是 beaconMatchesPoint 里 `eq(pointId, pointId)` 那一行。
  //   · 之所以不放进 VENUE：后续 Task 9 的 `/:id/beacon-uuids` 端点断言 `uuids` **恰好等于**
  //     `[UUID_LOWER]`（按剧本所属场地过滤）。放进 VENUE 会让那个断言变成两个元素，而
  //     `selectDistinct` 没有 ORDER BY（顺序无保证）⇒ Task 9 的测试会变得不确定。
  //     放 VENUE2 既不打扰那个断言，又**完全等效**地压到 point_id 那行 —— 因为
  //     beaconMatchesPoint 的查询**根本不按场地过滤**，跨场地与跨点位压的是同一行。
  const VENUE2 = 'mini-beacon-venue2';
  const PT2 = 'mini-beacon-pt2';
  const BEACON_OTHER = 'mini-beacon-dev2';
  const UUID_OTHER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const MAJOR_OTHER = 20002;
  const MINOR_OTHER = 30003;
  // 自净夹具的 id 提到模块级：beforeAll/afterAll 要能 delete 掉它们（进程被强杀时 finally 没跑，
  // 残留行下次运行会撞主键；与 BEACON_OTHER 同款）。新增探针 mac 取 EE08-EE10。
  const PROBE = 'mini-beacon-dev7-nulluuid';            // ★ uuid 为 NULL 的设备（既有，本轮把 id 上提）
  const UPPER_DEV = 'mini-beacon-dev-upper';            // ★ 列侧 lower（大写直写）
  const DEDUP1 = 'mini-beacon-dev-dedup1';              // ★ 去重
  const DEDUP2 = 'mini-beacon-dev-dedup2';              // ★ 去重
  const DRAFT_PRODUCT = 'mini-beacon-draft-product';    // ★ 未发布 404
  const NOVENUE_PRODUCT = 'mini-beacon-novenue-product'; // ★ 未绑场地 200+[]
  // ===== Task 1（`?nodeId=` 节点模式）新增夹具 =====
  // ⚠️ mac 取值纪律：占用表**以当场跑出的读数为准**（命令与两条对照见下面 beforeAll 里那段）——
  //    本注释只记一次**快照**（2026-09-27 实测）：本文件 `EE07-EE10`/`EE21-EE22`（皆既有）、
  //    `EE41-EE44`（本片 Task 1/2 新增，占用前两形态各扫一条核过为空闲）；
  //    `routes/admin/__tests__/wenlv-beacon.test.ts` 另占 `EE01-EE06 / EE11-EE16 / EE21-EE26 / EE97-EE99`；
  //    `routes/admin/__tests__/wenlv-ops-today.test.ts` 占 `EE31-EE32`。🔴 `EE21-EE22` 是**真实重叠**。
  const HALF_DEV = 'mini-beacon-dev-halfframe';          // ★ 有 uuid、无 major/minor
  const CROSS_DEV = 'mini-beacon-dev-crossvenue';        // ★ 别场地、绑本点位
  const UPPER_DUP = 'mini-beacon-dev-upperdup';          // ★ 大写 uuid 与小写行同帧
  const NODE_NOPOINT = 'mini-beacon-node-nopoint';       // ★ venuePointId 为 null
  const NODE_OTHER = 'mini-beacon-node-otherproduct';    // ★ 属于别的产品
  const PRODUCT_OTHER = 'mini-beacon-product-other';     // ★ 发布态、别的产品
  const UUID_HALF = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
  const UUID_CROSS = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
  // 「帧已给出但没命中」的专属消息。与「凭证不匹配」**必须不同**，否则下面那 5 条
  // 「被拒 403」在本 Task 实现之前就是绿的（没有信标通路时它们照样 403）——
  // 分组用例判别力为零，TDD 的「先红」对本组失效。断言消息才让它真的红。
  const FRAME_MISS = '信标帧未命中该点位绑定的在役设备';
  const CRED_MISS = '触发凭证不匹配';
  const H = mkMini(MINI);
  const post = (path: string, body: unknown) =>
    wenlvRoute.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });

  beforeAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT_NOCODE));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BEACON_OTHER));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE2));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, PROBE));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DEV));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP1));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP2));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, DRAFT_PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, NOVENUE_PRODUCT));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, HALF_DEV));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, CROSS_DEV));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DUP));
    await deleteScene(db, NODE_NOPOINT);
    await deleteScene(db, NODE_OTHER);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_OTHER));

    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE, name: '信标触发测试场地' });
    await db.insert(pmsBuiWenlvVenues).values({ id: VENUE2, name: '信标触发测试场地（另一家）' });
    // PT 无码：新模型下点位不再需要 beacon 专用的 code —— `admin/wenlv.ts` 的 POST/PATCH
    // 两处都强制「triggerType==='beacon' ⇒ code 非空」，所以真正走信标路径的点位**不可能**
    // code 为空。这里给 null，判据是「帧路不依赖码路」（code=null 确实走不到码路）。
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT, venueId: VENUE, name: '信标点位', code: null });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT_NOCODE, venueId: VENUE, name: '空点位', code: null });
    // 另一家的点位与设备：帧参数三件套齐全且在役，唯一「不匹配」的是它绑在 PT2 上。
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PT2, venueId: VENUE2, name: '另一家点位', code: null });
    // ⚠️ mac 前缀约定：**别只信本注释的枚举** —— 改 mac 前用下面那条命令当场复核。占用表的口径是
    //  「会写进 `pms_bui_wenlv_beacons.mac` 的字面量域」；下面是 **2026-09-27 实测快照**：
    //      本文件                                            `EE07-EE10`/`EE21-EE22`（皆既有）、`EE41-EE44`（本片）
    //      `routes/admin/__tests__/wenlv-beacon.test.ts`     `EE01-EE06 / EE11-EE16 / EE21-EE26 / EE97-EE99`
    //      `routes/admin/__tests__/wenlv-ops-today.test.ts`  `EE31-EE32`
    //  🔴 前两者在 `EE21-EE22` 上**真实重叠**（旧文写「互不撞」是错的）：`uq_wenlv_beacons_mac` 是
    //  **全局**唯一索引（`db/schema/wenlv.ts:520`），而两文件各自只按 id 清自己的行 ⇒ 一方被强杀
    //  留下残行时，另一方再插同名 mac 会撞 23505 而**假红**。正常路径下不炸：两文件都有自清，
    //  且 DB 用例走 `vitest.local.config.ts`（它把 `fileParallelism` 显式关掉，才串行）。
    //  历史教训（保留 —— 它正是本段存在的理由）：**只扫一种字面形态会漏掉一半**：分组小写多出现在
    //  请求体、紧凑大写多出现在断言。2026-09-22 那轮只扫紧凑形态，于是漏掉 admin 真实占用的六段，
    //  还删掉了本来正确的 `EE01-06`/`EE11-16`。所以要**两种形态各扫一条**才算扫过。
    //  复核命令（在 `pms-server` 下跑，两条都扫）：
    //    { grep -rnoiE "aa[:-]bb[:-]cc[:-]dd[:-]ee[:-][0-9a-f]{2}" src drizzle
    //      grep -rnoiE "aabbccddee[0-9a-f]{2}" src drizzle; }
    //    | sed -E 's/^([^:]+):[0-9]+:/\1|/'
    //    | awk -F'|' '{v=toupper($2); gsub(/[:-]/,"",v); print $1, v}' | sort -u
    //  ⚠️ **阳性对照 + 判别对照（两条都要过）**：① 分组那条 grep **必须**命中
    //     `routes/admin/__tests__/wenlv-beacon.test.ts` 的 EE11–EE16（2026-09-27 读数 **6** 处）；
    //     ② 紧凑那条对**同一文件同一六段**必须 **0 命中**（同日读数 **0**）。②正是上述前科的判别点；
    //     两条都过才允许相信读数。
    //  🔴 **本注释块自身不得出现完整的 MAC 字面量**（两种形态都不行）—— 命令是全仓 `grep`，
    //     注释里的样本会被它自己捞进去，届时对照可能被注释自我满足。一律用**裸段位记法**
    //     （`EE11–EE16`）或 `<两位>` 占位。
    //  （上表是**快照**、不是完备声明：判「有没有撞」仍以上面的命令为准。）
    await db.insert(pmsBuiWenlvBeacons).values({
      id: BEACON, venueId: VENUE, pointId: PT, name: 'E5-01',
      mac: 'AABBCCDDEE21', uuid: UUID_LOWER, major: 10001, minor: 19641, status: 'active',
    });
    await db.insert(pmsBuiWenlvBeacons).values({
      id: BEACON_OTHER, venueId: VENUE2, pointId: PT2, name: 'E5-02（另一家）',
      mac: 'AABBCCDDEE22', uuid: UUID_OTHER, major: MAJOR_OTHER, minor: MINOR_OTHER, status: 'active',
    });
    await db.insert(pmsBuiWenlvProducts).values({
      id: PRODUCT, name: '信标测试剧本', status: 'published', mode: 'narrative', venueId: VENUE,
    });
    await insertScene(db, PRODUCT, {
      id: NODE, nodeType: 'scene', title: '信标打卡点',
      order: 1, venuePointId: PT,
      grants: [],
    });
    // 开局：直接落一条 progress，避免依赖 /start 的完整链路。
    // state 形状取自 schema 的 WenlvState（`wenlv.ts:69`），**不要自己编字段名**：
    // 是 visited/collected/completed 三个布尔表，不是 flags/counters/collectibles。
    await db.insert(pmsBuiWenlvProgress).values({
      id: 'mini-beacon-progress', productId: PRODUCT, miniUserId: MINI,
      state: { visited: {}, collected: {}, completed: {} },
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, PRODUCT));
    await deleteScenesOfProduct(db, PRODUCT);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT_NOCODE));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BEACON_OTHER));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE2));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VENUE));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, PROBE));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DEV));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP1));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP2));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, DRAFT_PRODUCT));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, NOVENUE_PRODUCT));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, HALF_DEV));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, CROSS_DEV));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DUP));
    await deleteScene(db, NODE_NOPOINT);
    await deleteScene(db, NODE_OTHER);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_OTHER));
  });

  it('★ 大小写：用全大写 UUID 触发也能命中，库里存的是小写', async () => {
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE,
      beacon: { uuid: UUID_LOWER.toUpperCase(), major: 10001, minor: 19641 },
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    const [p] = await db.select().from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress')).limit(1);
    expect((p.state as any).visited[NODE]).toBe(true);  // 断言打在 DB 行上
  });

  it('用全小写 UUID 触发也命中', async () => {
    // 先清 visited 再试，保证这一条真的在验大小写而不是验幂等
    await db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
      .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE,
      beacon: { uuid: UUID_LOWER, major: 10001, minor: 19641 },
    });
    expect(res.status).toBe(200);
  });

  it('★ 列侧 lower：绕过 admin 直写的大写行也能被小写帧命中', async () => {
    // 守护 `beaconMatchesPoint` 里 `lower(uuid列) = 归一化小写` 那一行：admin 登记接口会把 uuid
    // 归一化成小写，但**绕过 admin 直写**（旧数据/脚本导入）的行可能落成大写。去掉列侧 lower()，
    // 本条必红（大写行 vs 小写帧精确比对不命中）。自净、不进 beforeAll：常驻一台带 uuid 的在役
    // 设备会打红 beacon-uuids 的 toEqual([UUID_LOWER])。
    const UPPER_UUID = '9C1B4A2E-D3F5-4A7B-8C9D-0E1F2A3B4C5D';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DEV));
    try {
      await db.insert(pmsBuiWenlvBeacons).values({
        id: UPPER_DEV, venueId: VENUE, pointId: PT, name: 'E5-大写直写',
        mac: 'AABBCCDDEE08', uuid: UPPER_UUID, major: 10003, minor: 19643, status: 'active',
      });
      await db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
        .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
      const res = await post('/trigger', {
        productId: PRODUCT, nodeId: NODE,
        beacon: { uuid: UPPER_UUID.toLowerCase(), major: 10003, minor: 19643 },
      });
      expect(res.status).toBe(200);
      const [p] = await db.select().from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress')).limit(1);
      expect((p.state as any).visited[NODE]).toBe(true);   // 断言打在 DB 行上
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DEV));
    }
  });

  it('帧不匹配（major 差 1）被拒 403', async () => {
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE,
      beacon: { uuid: UUID_LOWER, major: 10002, minor: 19641 },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(FRAME_MISS);
  });

  // 与上一条成对：上条压 major 那一行，这条压 `eq(minor, frame.minor)` 那一行。
  // major 有对照、minor 没有 ⇒ 删掉 minor 条件时 9 条全绿（复核已实测）。
  it('帧不匹配（minor 差 1）被拒 403', async () => {
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE,
      beacon: { uuid: UUID_LOWER, major: 10001, minor: 19642 },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(FRAME_MISS);
  });

  it('帧不匹配（uuid 不同）被拒 403', async () => {
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE,
      beacon: { uuid: '00000000-0000-0000-0000-000000000000', major: 10001, minor: 19641 },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(FRAME_MISS);
  });

  it('帧三件套不全（只有 uuid）被拒 403，且不误判成 via-code', async () => {
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE, beacon: { uuid: UUID_LOWER },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(FRAME_MISS);
  });

  it('设备被标记 faulty ⇒ 不再给游客记账（404/403，且 DB 里 visited 未被置位）', async () => {
    await db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
      .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
    await db.update(pmsBuiWenlvBeacons).set({ status: 'faulty' }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    // try/finally：若实现漏了 status 过滤，本条断言先抛 ⇒ 没有 finally 的话还原行不执行，
    // BEACON 停在 faulty。⚠️ 但别写成「后面那条用例就派生一条假红」—— 紧邻的 retired 用例
    // 开头就把 status 覆写成 'retired'，残留的 faulty 活不到它；真正会滞留并污染的是 retired
    // 用例自己的 finally 没跑留下的 'retired'，而受害的是**两条**（实测：把 retired 用例 finally
    // 的还原值从 'active' 改成 'retired' ⇒ `2 failed | 18 passed (20)`）：
    //   · `★ 双通路…` —— 该点位挂着 BEACON，而信标路在 retired 下被 403 挡住、期望 200；
    //   · `★ 返回本场地的在役 UUID（登录态）` —— beacon-uuids 同样把 retired 排除在外，
    //     `uuids` 从 `[UUID_LOWER]` 掉成 `[]`。**别只记住前一条**。
    try {
      const res = await post('/trigger', {
        productId: PRODUCT, nodeId: NODE,
        beacon: { uuid: UUID_LOWER, major: 10001, minor: 19641 },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(FRAME_MISS);
      const [p] = await db.select().from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress')).limit(1);
      expect((p.state as any).visited[NODE] ?? false).toBe(false);
    } finally {
      await db.update(pmsBuiWenlvBeacons).set({ status: 'active' }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    }
  });

  it('设备被标记 retired ⇒ 同样不记账', async () => {
    await db.update(pmsBuiWenlvBeacons).set({ status: 'retired' }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    // 同上：还原必须在 finally 里，否则设备停在 retired 会污染后续用例。
    try {
      const res = await post('/trigger', {
        productId: PRODUCT, nodeId: NODE,
        beacon: { uuid: UUID_LOWER, major: 10001, minor: 19641 },
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(FRAME_MISS);
    } finally {
      await db.update(pmsBuiWenlvBeacons).set({ status: 'active' }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    }
  });

  it('★ 既有码通路未受影响：点位无码 + 无信标帧 ⇒ 仍 403', async () => {
    const NODE2 = 'mini-beacon-node2';
    await deleteScene(db, NODE2);
    await insertScene(db, PRODUCT, {
      id: NODE2, nodeType: 'scene', title: '空点位节点',
      order: 2, venuePointId: PT_NOCODE,
      grants: [],
    });
    const res = await post('/trigger', { productId: PRODUCT, nodeId: NODE2, credential: 'ANYTHING' });
    expect(res.status).toBe(403);
    // 这条**没给信标帧** ⇒ 必须是老消息。它是「两条 403 真的被分开了」的对照组：
    // 若实现里把两者写成同一条，这条与上面那 5 条里必有一组红。
    expect((await res.json()).error).toBe(CRED_MISS);
    await deleteScene(db, NODE2);
  });

  it('★ 双通路：点位同时有码与信标，两条路都能过（互不排斥）', async () => {
    // Step 5 的实现里 `byCode` 命中时**短路**、不再调 beaconMatchesPoint —— 于是
    // 「一个点位可以同时有二维码和信标」这个被注释明文声明的行为，若没有这条用例
    // 就一条断言都没有。
    //
    // ⚠️ **不能复用 PT**：PT 的 code 是 null（见 beforeAll 里那句注释 —— 它的职责是证明
    //    「帧路不依赖码路」），因而它**证明不了**码路还活着。要验「两条路互不排斥」必须有
    //    一个既有 code 又能被帧命中的点位，所以这里自建夹具。
    //    夹具用 try/finally 就地建删，不进 beforeAll/afterAll，避免影响本文件既有用例。
    //
    // 两道会误红的门**已实测排除**，别再怀疑一次：
    //   · `evalCondition(node.unlockCondition, state)` —— 新节点不给 unlockCondition，
    //     而 `src/services/wenlv-engine.ts:5` 是 `if (!cond) return true;`。
    //   · `rallyStampOnSiteErr(productId, node)` —— 新节点挂了点位，而
    //     `src/routes/mini/wenlv.ts:324` 是 `if (node.venuePointId) return null;`。
    const PT_BOTH = 'mini-beacon-pt-both';
    const NODE_BOTH = 'mini-beacon-node-both';
    try {
      await db.insert(pmsBuiWenlvVenuePoints).values({
        id: PT_BOTH, venueId: VENUE, name: '双通路点位', code: 'BOTHCODE',
      });
      await db.update(pmsBuiWenlvBeacons).set({ pointId: PT_BOTH }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
      await insertScene(db, PRODUCT, {
        id: NODE_BOTH, nodeType: 'scene', title: '双通路节点',
        order: 3, venuePointId: PT_BOTH,
        grants: [],
      });

      // ① 扫码通路：送 credential = 点位码。此时 byCode 命中、信标根本不会被查 ——
      //    这条证明「有点位码的点位照样能扫码」，是既有通路未被信标逻辑挤掉。
      await db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
        .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
      const byCode = await post('/trigger', { productId: PRODUCT, nodeId: NODE_BOTH, credential: 'BOTHCODE' });
      expect(byCode.status).toBe(200);

      // ② 信标通路：同一个点位、**不送 credential**、只送帧。
      //    必须先清 visited：否则这条可能只是在验幂等，而不是在验信标路。
      //    这条是「互不排斥」的真正判据 —— 若实现把两条路写成排他（比如
      //    「有 code 的点位一律走码路」），这里会红。
      await db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
        .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
      const byBeacon = await post('/trigger', {
        productId: PRODUCT, nodeId: NODE_BOTH,
        beacon: { uuid: UUID_LOWER, major: 10001, minor: 19641 },
      });
      expect(byBeacon.status).toBe(200);
    } finally {
      await deleteScene(db, NODE_BOTH);
      await db.update(pmsBuiWenlvBeacons).set({ pointId: PT }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT_BOTH));
    }
  });

  it('★ 跨点位隔离：别的点位绑定的在役设备不能触发本点位', async () => {
    // 本文件**唯一**压 `beaconMatchesPoint` 里 `eq(pointId, pointId)` 那一行的用例。
    // 帧三件套（uuid/major/minor）全部命中 BEACON_OTHER 自己，且它在役、场地也存在 ——
    // 唯一的「不匹配」是它绑 PT2 而 NODE 绑 PT。有 point_id 条件 ⇒ 403；
    // 删掉那行 ⇒ 会命中并推进剧情（200，「走到 A 点能触发 B 点剧情」）。
    // 夹具必须放在 VENUE2 的完整理由见上面常量区注释（Task 9 的 uuids 断言 + 无序 selectDistinct）。
    //
    // 先清 visited：让下面的 DB 断言只读这一次调用的增量（本文件既有风格），
    // 不依赖前面用例把 visited[NODE] 留成什么值。
    await db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
      .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
    const res = await post('/trigger', {
      productId: PRODUCT, nodeId: NODE,
      beacon: { uuid: UUID_OTHER, major: MAJOR_OTHER, minor: MINOR_OTHER },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(FRAME_MISS);
    // 与既有用例同样的「断言打在 DB 行上」：被拒就必须没记账。
    const [p] = await db.select().from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress')).limit(1);
    expect((p.state as any).visited[NODE] ?? false).toBe(false);
  });

  it('★ 返回本场地的在役 UUID（登录态）', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
      headers: { Authorization: H.Authorization },
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.uuids).toEqual([UUID_LOWER]);   // 本场地只有 BEACON 一台在役设备
  });

  it('★ 去重：同场地多台共用 UUID 的设备只回一个 UUID', async () => {
    // 守护 beacon-uuids 的 `selectDistinct`：10 台共用 1 个 UUID 是预期配置（schema/wenlv.ts 明写）。
    // 把它换成 `select`，本条必红（BEACON + 两台共用 UUID 的设备 = 3 个 UUID_LOWER）。自净、不进
    // beforeAll：常驻两台带 uuid 的在役设备会打红**下方**「faulty 的设备不进 uuids 列表」
    // 那条的 `toEqual([])`。⚠️ 别按「上面那条 faulty」去找 —— 上方 `设备被标记 faulty ⇒ 不再给
    // 游客记账` 只断 403 + visited，**没有**这个断言；带 `toEqual([])` 的 faulty 用例在下面。
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP1));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP2));
    try {
      await db.insert(pmsBuiWenlvBeacons).values({
        id: DEDUP1, venueId: VENUE, name: '共用 UUID 1', mac: 'AABBCCDDEE09',
        uuid: UUID_LOWER, major: 10005, minor: 19645, status: 'active',
      });
      await db.insert(pmsBuiWenlvBeacons).values({
        id: DEDUP2, venueId: VENUE, name: '共用 UUID 2', mac: 'AABBCCDDEE10',
        uuid: UUID_LOWER, major: 10006, minor: 19646, status: 'active',
      });
      const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      expect(res.status).toBe(200);
      const b = await res.json();
      // BEACON + DEDUP1 + DEDUP2 三台共用 UUID_LOWER ⇒ selectDistinct 归并成 1 个；无去重则 3 个。
      expect(b.data.uuids).toEqual([UUID_LOWER]);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP1));
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DEDUP2));
    }
  });

  it('★ 未发布（draft）的剧本不返回信标列表 ⇒ 404', async () => {
    // 守护 beacon-uuids 里 `eq(status, 'published')`：删掉它，本条必红（draft 剧本也返回 uuids）。
    // 与端点「不存在或未发布 ⇒ 404」的契约一致。自净。
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, DRAFT_PRODUCT));
    try {
      await db.insert(pmsBuiWenlvProducts).values({
        id: DRAFT_PRODUCT, name: '草稿剧本', status: 'draft', mode: 'narrative', venueId: VENUE,
      });
      const res = await wenlvRoute.request(`/${DRAFT_PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      expect(res.status).toBe(404);
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, DRAFT_PRODUCT));
    }
  });

  it('★ 未绑场地的剧本返回空信标列表（200 + []，不是错误）', async () => {
    // 守护 beacon-uuids 里 `if (!product.venueId) return 200 + []`：把它改成 404/500 或删掉，
    // 本条必红（未绑场地是正常状态，不是错误）。自净。
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, NOVENUE_PRODUCT));
    try {
      await db.insert(pmsBuiWenlvProducts).values({
        id: NOVENUE_PRODUCT, name: '未绑场地剧本', status: 'published', mode: 'narrative', venueId: null,
      });
      const res = await wenlvRoute.request(`/${NOVENUE_PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.data.uuids).toEqual([]);
    } finally {
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, NOVENUE_PRODUCT));
    }
  });

  it('faulty 的设备不进 uuids 列表', async () => {
    await db.update(pmsBuiWenlvBeacons).set({ status: 'faulty' }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    // try/finally：本文件另有 8 处同款 —— `rg -n '^\s*\} finally \{'` 除本条外为
    //    「★ 列侧 lower…」「设备被标记 faulty…」「设备被标记 retired…」「★ 双通路…」
    //    「★ 去重…」「★ 未发布（draft）…」「★ 未绑场地…」「★ uuid 为 NULL 的设备…」
    //    （按该命令的输出顺序；Task 10 新增的 4 条各自也带 try/finally，故由 4 处变 8 处）。
    // ⚠️ 别把本条当「本文件防住了级联」的先例 —— 滞留 faulty 在这里会**真的多红一条**：
    //    本条之后共有三条，其中 `★ uuid 为 NULL 的设备…` 断言 uuids 恰为 `[UUID_LOWER]`，
    //    而 UUID_LOWER 就是 BEACON 的 uuid ⇒ BEACON 一走 faulty，uuids 变 `[]`，那条就红。
    //    （实测：把下面 finally 的还原从 active 改成 faulty ⇒ `1 failed | 19 passed`，
    //    红的正是那条 —— 真因在本条，失败却指向它。）前两条不读该设备：「未登录返 401」
    //    在 `parseMiniToken` 就短路（早于任何 db 调用），「路由可达性」只断状态码。
    // 所以本条的 finally 是**承重**的：beacon 行是跨用例共享的夹具，滞留值会以
    //    「实现错了」的样子落到后面的用例上 —— 本文件已经有一条会读到它。
    // 附：「断言先抛 ⇒ 设备停在 faulty」在这条**不成立** —— `expect` 写在 try 内，
    //    抛出时 finally 照样执行、把 status 还原成 active。⚠️ 会滞留 faulty 的也不是
    //    「开头那次 update 自己失败」—— 语句失败**不落库**（那条 UPDATE 整体回滚，status 仍是
    //    active）。真正会滞留的是「update 成功之后进程被中断」或「finally 自己的还原失败」，
    //    恰是这条 try/finally 存在的理由。
    try {
      const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      const b = await res.json();
      expect(b.data.uuids).toEqual([]);
    } finally {
      await db.update(pmsBuiWenlvBeacons).set({ status: 'active' }).where(eq(pmsBuiWenlvBeacons.id, BEACON));
    }
  });

  it('未登录返 401', async () => {
    const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`);
    expect(res.status).toBe(401);
  });

  it('★ 路由可达性：这个 200 不是框架默认 404 装出来的', async () => {
    // 本仓有前科：端点没写时框架默认 404 与业务 404 同码。
    // 故这里只断两个状态码（存在的产品 200、不存在的 404）—— 不做 body 结构断言。
    const ok = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
      headers: { Authorization: H.Authorization },
    });
    expect(ok.status).toBe(200);
    const missing = await wenlvRoute.request('/no-such-product/beacon-uuids', {
      headers: { Authorization: H.Authorization },
    });
    expect(missing.status).toBe(404);
  });

  it('★ uuid 为 NULL 的设备（现场先入账、还没读参数）不进 uuids', async () => {
    // 🔴 2026-09-26 订正：本条现在守护的是三句 `isNotNull` 的**合取**，不再是单守
    //    `isNotNull(uuid)`。**断言与读数一字未变**，变的是判据的**归属**：同日实测
    //    （`?nodeId=` 那次改动之后）只删 `isNotNull(uuid)`，本条**仍绿** —— 本用例的 PROBE
    //    三件套全为 NULL，被 `isNotNull(major)`/`isNotNull(minor)` 挡在后面。
    //    ⇒ 单独删任何一句都不可观测，本条只证明「三者至少有一句在场」。
    //    下文提到的 `.filter((u): u is string => !!u)` 是它的前身（那个 filter 在场时，
    //    本条确实单守它）。
    // 它**当时**守护 `wenlv.ts` 里 `.filter((u): u is string => !!u)`，是**承重**守卫、不是装饰（下面用现在时写的，都是**那个 filter 在场时**的道理）：
    //   · `db/schema/wenlv.ts` 明写 uuid 可空 ——「可空 = 还没读过参数（现场先入账是
    //     真实顺序），不回填」；
    //   · status 的默认值 'stock' **能过** notInArray(['faulty','retired'])。
    // ⇒ 这类行**必然**流到那个 filter。删掉它，下发的 uuids 里会多一个 `null`（不是
    //   「少一个 UUID」），而本端点自己的注释就把「uuid 为 NULL 的行…滤掉」当契约。
    //
    // ⚠️ 承重的是**请求发出的时刻**，不是断言的位置：响应是请求那一刻的快照，探针
    //    事后被删**不会**回改已捕获的数组。实测两组对照（两组都把实现侧 `.filter` 去掉；
    //    下面两行的 passed 计数取自本文件 **16 条用例**的版本 —— Task 10 新增 4 条后总数为 20，
    //    本轮**没有**在新总数上重跑这两个实验，要复现这两个数字须重跑，别照抄）：
    //      · 请求留在 try 内、只把断言挪到 finally 之后 ⇒ **仍红**（`1 failed | 15 passed`）；
    //      · 把**请求本身**挪到探针删除之后 ⇒ `16 passed`，这才恒真、零判别力。
    // 探针自净、**不**进 beforeAll：常驻一台**带 uuid 且在役**的设备会打红上面 faulty
    //    那条的 `toEqual([])`，给出「改了 A 却红了 B」的假象。⚠️ 但**本探针**常驻则不会：
    //    它 uuid 为 NULL，恰被它自己守护的那个 filter 吸收（实测常驻进 beforeAll 仍是
    //    `16 passed`，同为 16 条用例时代的读数）—— 别把这条理由套到本探针头上。
    try {
      await db.insert(pmsBuiWenlvBeacons).values({
        id: PROBE, mac: 'AABBCCDDEE07', name: '探针（未读参数）',
        venueId: VENUE, status: 'stock',   // uuid/major/minor 留空 = 还没读参数
      });
      const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      expect(res.status).toBe(200);
      const b = await res.json();
      // 有 filter ⇒ null 被滤掉、恰 1 个元素；无 filter ⇒ 多一个 null、长度变 2。
      expect(b.data.uuids).toEqual([UUID_LOWER]);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, PROBE));
    }
  });

  // ========================================================================
  // Task 1：`?nodeId=` 节点模式（J1–J4 / J6）；J5 = 上方的场地模式用例保持绿。
  // 每条的「判别力」都写在注释里 —— 改实现前先看它压的是哪一行。
  // ========================================================================

  it('J1 节点模式：只回该点位绑定的在役**齐全**帧（uuids 与 frames 逐字）', async () => {
    // 判别力：实现前 `?nodeId=` 被忽略 ⇒ 走场地模式 ⇒ `data.frames` 是 `undefined` ⇒ 红；
    //   收窄条件整个删掉 ⇒ BEACON_OTHER（绑 PT2）混进 frames ⇒ 红。即：本条压的是
    //   「节点模式存在」+「存在某种收窄」。
    //   ⚠️ 本条**压不动**「收窄用的是 pointId 而不是 venueId」：夹具里唯一能撞它的
    //   BEACON_OTHER 落在 **VENUE2** ⇒ 两种收窄都排除它、本条同样绿。
    //   2026-09-26 实测：把实现改成 `eq(venueId, product.venueId)` ⇒ 本条**绿**，
    //   全文件唯一变红的是 **J2**（`1 failed | 25 passed`）。⇒「不加场地过滤」这条主张
    //   归 **J2**，别记到本条头上。
    const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=${NODE}`, {
      headers: { Authorization: H.Authorization },
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.uuids).toEqual([UUID_LOWER]);
    expect(b.data.frames).toEqual([{ uuid: UUID_LOWER, major: 10001, minor: 19641 }]);
  });

  it('J1b 半帧设备（有 uuid、没 major/minor）两种模式都不下发 —— 这也是本轮修的**真缺陷**', async () => {
    // 判别力：**两句一起**删掉 `aliveComplete` 里的 `isNotNull(major)` 与 `isNotNull(minor)`
    //   ⇒ `frames` 里多一条 major/minor 为 null 的行、场地模式的 `uuids` 也多一个元素 ⇒ 红。
    //   ⚠️ **单独**删其中任一句 ⇒ 本条**仍绿**（HALF_DEV 的 major 与 minor 都是 null，被
    //   另一句挡着）—— 与本文件 `★ uuid 为 NULL…` 那条**同构**：两句一起删才是本条的判据。
    //   2026-09-26 逐条实测（`vitest.local.config.ts` 跑本文件，每跑完还原并核哈希）：
    //   单删 `major` ⇒ `26 passed`（零红）；单删 `minor` ⇒ `26 passed`（零红）；
    //   **两句一起删** ⇒ `1 failed | 25 passed`，唯一红的就是本条。
    //   ⚠️ 删 `isNotNull(uuid)` 同样**不会**让本条红（同样 `26 passed`）—— HALF_DEV 的 uuid
    //   非空，本条看不见那一句；那句今天**没有任何用例看得见**，它是纵深防御、不是被判据
    //   守着的约束（详见下方 `★ uuid 为 NULL 的设备…` 那条的注释）。
    // 为什么这条是「真缺陷」而不是顺手加严：`beaconMatchesPoint` 对 major/minor 是**严格相等**，
    //   半帧设备扫得到、服务端**永远判不过** ⇒ 现场表现是「一直提示靠近、点了就失败」。
    //   不下发它，现场看到的是「没有靠近提示 + 扫码按钮还在」，那才是可诊断的失败。
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, HALF_DEV));
    try {
      await db.insert(pmsBuiWenlvBeacons).values({
        id: HALF_DEV, venueId: VENUE, pointId: PT, name: '半帧设备',
        mac: 'AABBCCDDEE41', uuid: UUID_HALF, major: null, minor: null, status: 'active',
      });
      const nodeRes = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=${NODE}`, {
        headers: { Authorization: H.Authorization },
      });
      expect(nodeRes.status).toBe(200);
      expect((await nodeRes.json()).data.frames).toEqual([
        { uuid: UUID_LOWER, major: 10001, minor: 19641 },
      ]);
      const venueRes = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      expect((await venueRes.json()).data.uuids).toEqual([UUID_LOWER]);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, HALF_DEV));
    }
  });

  it('J2 节点模式**刻意不带**场地过滤：节点绑的别场地点位，其设备照样下发', async () => {
    // 判據出处：触发端 `beaconMatchesPoint` 的谓词只有 `pointId + 帧 + status`，**没有场地条件**
    //   ⇒ 下发谓词必须与判定谓词同形，否则「节点绑了别场地点位」这种脏数据会造出
    //   「客户端扫不到、服务端其实能判过」的分叉。
    // 判别力：给节点模式补一层 `eq(venueId, product.venueId)` ⇒ 本条第一条断言必红。
    //   反过来说，这条也是那种脏数据**唯一**的可诊断信号。
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, CROSS_DEV));
    try {
      await db.insert(pmsBuiWenlvBeacons).values({
        id: CROSS_DEV, venueId: VENUE2, pointId: PT, name: '跨场地绑定',
        mac: 'AABBCCDDEE42', uuid: UUID_CROSS, major: 10007, minor: 19647, status: 'active',
      });
      const nodeRes = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=${NODE}`, {
        headers: { Authorization: H.Authorization },
      });
      expect(nodeRes.status).toBe(200);
      // ⚠️ `db.select` 没有 ORDER BY ⇒ 顺序无保证，比较前先排序。
      expect((await nodeRes.json()).data.frames.map((f: any) => f.uuid).sort())
        .toEqual([UUID_CROSS, UUID_LOWER].sort());
      // 场地模式反过来**必须**看不到它（它不在 PRODUCT 的场地上）—— 这条压的是场地过滤仍在。
      const venueRes = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids`, {
        headers: { Authorization: H.Authorization },
      });
      expect((await venueRes.json()).data.uuids).toEqual([UUID_LOWER]);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, CROSS_DEV));
    }
  });

  it('J3 nodeId 指向别的产品的节点 / 不存在的节点 → 404', async () => {
    // `nodeId` 是**新的外部输入** ⇒ 不存在 / 不属于该产品都必须显式 404，不能静默当空处理。
    // 判别力：删掉实现里那句按产品过滤节点的逻辑 ⇒ 第一条断言拿到别产品的
    //   节点（它绑 PT2）并 200 ⇒ 红。
    await deleteScene(db, NODE_OTHER);
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_OTHER));
    try {
      await db.insert(pmsBuiWenlvProducts).values({
        id: PRODUCT_OTHER, name: '别的剧本', status: 'published', mode: 'narrative', venueId: VENUE2,
      });
      await insertScene(db, PRODUCT_OTHER, {
        id: NODE_OTHER, nodeType: 'scene', title: '别家节点',
        order: 1, venuePointId: PT2,
        grants: [],
      });
      const cross = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=${NODE_OTHER}`, {
        headers: { Authorization: H.Authorization },
      });
      expect(cross.status).toBe(404);
      const missing = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=no-such-node`, {
        headers: { Authorization: H.Authorization },
      });
      expect(missing.status).toBe(404);
    } finally {
      await deleteScene(db, NODE_OTHER);
      await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PRODUCT_OTHER));
    }
  });

  it('J4 节点未绑点位 → 200 + 两个空数组（不是错误）', async () => {
    // 守护的是**对外口径**（空计划，200 而非 404/500），与既有「未绑场地 → 200 + []」同款。
    // ⚠️ **判别力声明：本条不判别那个 `if (!node.venuePointId)` 分支本身。** 去掉它，
    //    `eq(pointId, null)` 在 SQL 三值逻辑下匹配不到任何行 ⇒ `buildScanPlan([])` 同样给出
    //    两个空数组，本条照样绿。它防的是「有人把空计划改成 404/500」这类口径漂移。
    //    别把它当成那个 `return` 的存在性判据 —— 那是构造上做不到的。
    await deleteScene(db, NODE_NOPOINT);
    try {
      await insertScene(db, PRODUCT, {
        id: NODE_NOPOINT, nodeType: 'scene', title: '未绑点位节点',
        order: 2, venuePointId: null,
        grants: [],
      });
      const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=${NODE_NOPOINT}`, {
        headers: { Authorization: H.Authorization },
      });
      expect(res.status).toBe(200);
      const b = await res.json();
      expect(b.data.uuids).toEqual([]);
      expect(b.data.frames).toEqual([]);
    } finally {
      await deleteScene(db, NODE_NOPOINT);
    }
  });

  it('J6 节点模式：大写 uuid 行被小写化，并与小写行**去重成一个** uuids 元素', async () => {
    // 判别力：删掉实现里 `buildScanPlan` 的 `.toLowerCase()` ⇒ `uuids` 变两个元素
    //   （`[UUID_LOWER, UUID_LOWER.toUpperCase()]`）⇒ 第一条断言必红。
    // 为什么这种行真的存在：绕过 admin 登记接口直写的旧数据会落成大写 ——
    //   同文件 `★ 列侧 lower` 那条用例压的就是它。
    // 夹具两行 uuid 只差大小写、major/minor 相同：列上唯一索引 `uq_wenlv_beacons_frame`
    //   是 `(uuid, major, minor)` 的**字符串**比较 ⇒ 大小写不同即不相等 ⇒ 不撞索引。
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DUP));
    try {
      await db.insert(pmsBuiWenlvBeacons).values({
        id: UPPER_DUP, venueId: VENUE, pointId: PT, name: '大写重复帧',
        mac: 'AABBCCDDEE43', uuid: UUID_LOWER.toUpperCase(), major: 10001, minor: 19641, status: 'active',
      });
      const res = await wenlvRoute.request(`/${PRODUCT}/beacon-uuids?nodeId=${NODE}`, {
        headers: { Authorization: H.Authorization },
      });
      const b = await res.json();
      expect(b.data.uuids).toEqual([UUID_LOWER]);        // 去重后恰好一个，且是小写
      expect(b.data.frames).toHaveLength(2);             // frames 是原始行：不去重、不改大小写
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, UPPER_DUP));
    }
  });

  it('J7 记账行 payload.source：信标帧 → beacon、点位码 → qrcode、免凭证 → none', async () => {
    // 判别力：不写 `payload` ⇒ 读到的 `payload` 是建表默认值 `{}` ⇒ `source` 为 undefined ⇒ 红。
    // 这条的**必要性**：用户拍「信标优先」，现场验收必须能证明信标那一路真被用过，而
    //   `eventType:'checkin'` 无从区分两条通路。
    const PT_CODE = 'mini-beacon-pt-code';
    const NODE_CODE = 'mini-beacon-node-code';
    const DUAL_DEV = 'mini-beacon-dev7-dual';
    // 清掉本产品的记账行，让「恰好一条」这个断言能归属到本次调用
    const eventsOf = () => db.select().from(pmsBuiWenlvEvents)
      .where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
    const resetVisited = () =>
      db.update(pmsBuiWenlvProgress).set({ state: { visited: {}, collected: {}, completed: {} } })
        .where(eq(pmsBuiWenlvProgress.id, 'mini-beacon-progress'));
    await deleteScene(db, NODE_NOPOINT);
    await deleteScene(db, NODE_CODE);
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT_CODE));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DUAL_DEV));
    try {
      // ① 免凭证节点：`nodeRequiresCredential` 为假 ⇒ 'none'
      //    （venuePointId 为 null 且 triggerType 为 'manual' ⇒ `!!null || false` = false）
      await insertScene(db, PRODUCT, {
        id: NODE_NOPOINT, nodeType: 'scene', title: '免凭证节点',
        order: 2, venuePointId: null,
        grants: [],
      });
      // ② 有码点位 + 节点：走码路
      await db.insert(pmsBuiWenlvVenuePoints).values({
        id: PT_CODE, venueId: VENUE, name: '有码点位（来源标记用）', code: 'SRCCODE',
      });
      await insertScene(db, PRODUCT, {
        id: NODE_CODE, nodeType: 'scene', title: '码路节点',
        order: 4, venuePointId: PT_CODE,
        grants: [],
      });
      // ④ 要的是**真·双模点位**：`PT_CODE` 既有码、又绑一台在役设备。缺了这台设备，
      //   ④ 送的那帧对该点位**不匹配**，「码命中也照样记帧命中」这一路变异就压不动
      //   （2026-09-26 实测：无此设备时该变异下 J7 全绿）。
      //   ⚠️ 帧取 `(UUID_LOWER, 10008, 19648)` 而非 `(UUID_LOWER, 10001, 19641)`：
      //   后者与夹具 `BEACON` 的帧**逐字相同**，而 `uq_wenlv_beacons_frame` 是
      //   `(uuid, major, minor)` 上的**普通唯一索引**（无部分谓词）⇒ 插入即 23505。
      //   `BEACON` 绑在 `PT`、本帧绑在 `PT_CODE`，唯一索引不含 `point_id`，撞得上。
      await db.insert(pmsBuiWenlvBeacons).values({
        id: DUAL_DEV, venueId: VENUE, pointId: PT_CODE, name: 'E5-双模（码+帧）',
        mac: 'AABBCCDDEE44', uuid: UUID_LOWER, major: 10008, minor: 19648, status: 'active',
      });

      // ① 信标帧
      await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
      await resetVisited();
      const byBeacon = await post('/trigger', {
        productId: PRODUCT, nodeId: NODE,
        beacon: { uuid: UUID_LOWER, major: 10001, minor: 19641 },
      });
      expect(byBeacon.status).toBe(200);
      let rows = await eventsOf();
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as any).source).toBe('beacon');

      // ② 点位码（不带信标帧）
      await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
      await resetVisited();
      const byCode = await post('/trigger', { productId: PRODUCT, nodeId: NODE_CODE, credential: 'SRCCODE' });
      expect(byCode.status).toBe(200);
      rows = await eventsOf();
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as any).source).toBe('qrcode');

      // ③ 免凭证节点（既没帧也没码）
      await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
      await resetVisited();
      const none = await post('/trigger', { productId: PRODUCT, nodeId: NODE_NOPOINT });
      expect(none.status).toBe(200);
      rows = await eventsOf();
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as any).source).toBe('none');

      // ④ **码路优先**：`PT_CODE` 是双模点位（既有码 `'SRCCODE'`，又绑了在役设备 `DUAL_DEV`），
      //    这里把码与一帧**同样命中该点位**的帧一起送上去 ⇒ 必须记 'qrcode'。
      //    锁的是实现里「`byCode` 命中就短路、不再查信标」：少了这个短路、让 `viaBeacon`
      //    改按「帧是否命中」置位，本条就会读到 'beacon' 而红。
      await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, PRODUCT));
      await resetVisited();
      const both = await post('/trigger', {
        productId: PRODUCT, nodeId: NODE_CODE, credential: 'SRCCODE',
        beacon: { uuid: UUID_LOWER, major: 10008, minor: 19648 },
      });
      expect(both.status).toBe(200);
      rows = await eventsOf();
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as any).source).toBe('qrcode');
    } finally {
      await deleteScene(db, NODE_CODE);
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PT_CODE));
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, DUAL_DEV));
      await deleteScene(db, NODE_NOPOINT);
    }
  });
});
