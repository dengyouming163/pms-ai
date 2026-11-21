import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvBeacons, pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints } from '../../../db/schema/index.js';
import { eq } from 'drizzle-orm';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const V = 'beacon-test-venue';
const P = 'beacon-test-point';
const B1 = 'beacon-test-b1';
const B2 = 'beacon-test-b2';
const B3 = 'beacon-test-b3';
// 下面两个常量只服务「列表：只回本场地的设备」那一条，夹具自带、不进 beforeAll/afterAll
const V2 = 'beacon-test-venue-2';
const B4 = 'beacon-test-b4';
// 「未归属」夹具。**有意直接插库**，不用 `POST /beacons` 造。
// ⚠️ 2026-09-24 订正：原文写「经 API 造不出 venue_id IS NULL 的行」—— 那只对当时的
//    `POST /venues/:id/beacons` 成立；`POST /beacons`（未归属登记）之后造得出来。
//    仍然直接插库的理由不是「造不出」，而是**夹具与被测面要能各自独立地红**：
//    拿被测端点给别条用例做夹具，会把「那一个端点坏了」放大成本组一片红。
const B_ORPHAN = 'beacon-test-orphan';
const B_FAULTY = 'beacon-test-faulty';

const post = (path: string, body: unknown, h: Record<string, string> = H) =>
  adminWenlvRoute.request(path, { method: 'POST', headers: h, body: JSON.stringify(body) });

const get = (path: string, h: Record<string, string> = H) =>
  adminWenlvRoute.request(path, { method: 'GET', headers: h });

describe.skipIf(!process.env.RUN_DB)('wenlv 信标设备台账（DB）', () => {
  beforeAll(async () => {
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B1));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B2));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B3));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B_ORPHAN));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B_FAULTY));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '信标测试场地' });
    // ⚠️ `points.code` 有**全局**唯一索引 uq_wenlv_venue_points_code（不是场内唯一）。
    // 若本地库里已有行占用了 'WLP-BEACON01'，这里会直接报 23505 而不是业务错误 ——
    // 那是环境撞码、不是缺陷。换一个更独特的码即可，**不要**为此去改实现。
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: P, venueId: V, name: '测试点位', code: 'WLP-BEACON01' });
    // 未归属设备：直接插库，绕过登记端点（那个端点绑不了空场地）
    await db.insert(pmsBuiWenlvBeacons).values({
      id: B_ORPHAN, venueId: null, name: '孤儿设备', mac: 'AABBCCDDEE99', status: 'stock',
    });
    await db.insert(pmsBuiWenlvBeacons).values({
      id: B_FAULTY, venueId: V, name: '故障设备', mac: 'AABBCCDDEE98', status: 'faulty',
    });
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B1));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B2));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B3));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B_ORPHAN));
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B_FAULTY));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });

  it('登记：MAC 被归一化成大写去分隔符', async () => {
    const res = await post(`/venues/${V}/beacons`, {
      id: B1, name: 'E5-01', mac: 'aa:bb:cc:dd:ee:01',
      uuid: 'FDA50693-A4E2-4FB1-AFCF-C6EB07647825', major: 10001, minor: 19641,
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.mac).toBe('AABBCCDDEE01');            // 归一化：大写、去冒号
    expect(b.data.uuid).toBe('fda50693-a4e2-4fb1-afcf-c6eb07647825'); // 归一化：小写
    expect(b.data.status).toBe('stock');                // 默认在库
    expect(b.data.pointId).toBeNull();                  // 未绑定
  });

  it('登记：非法 MAC 返 400，且库里不留行', async () => {
    const res = await post(`/venues/${V}/beacons`, { id: B3, name: '坏设备', mac: 'ZZ:AA:BB:CC:DD:EE:FF' });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B3)).limit(1);
    expect(row).toBeUndefined();   // 断言打在 DB 行上，不信响应自述
  });

  it('登记：帧三件套半填被拒 400', async () => {
    // 有 uuid 没 major —— 库里无法比对，是「登记到一半」的典型形态
    const res = await post(`/venues/${V}/beacons`, {
      id: B3, name: '半帧', mac: 'aa:bb:cc:dd:ee:03', uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825',
    });
    expect(res.status).toBe(400);
  });

  it('登记：帧三件套填两件（uuid+major 无 minor）同样被拒 400', async () => {
    // 与上一条走同一个 `filled !== 0 && filled !== 3` 谓词，但**计数不同** ⇒ 对
    // 「把谓词写窄成只拒 filled===1」这类变异有判别力，上一条抓不到。
    const res = await post(`/venues/${V}/beacons`, {
      id: B3, name: '两件套', mac: 'aa:bb:cc:dd:ee:03',
      uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825', major: 10001,
    });
    expect(res.status).toBe(400);
  });

  it('登记：MAC 重复返 409（不是 500）', async () => {
    const res = await post(`/venues/${V}/beacons`, { id: B3, name: '撞 MAC', mac: 'aa:bb:cc:dd:ee:01' });
    expect(res.status).toBe(409);
    const b = await res.json();
    // ⚠️ 原稿写的是 `toContain('已登记')` —— **实测该断言恒假**：实现回的串是
    //    `这台设备（MAC）已经登记过了`，其中是「**已经**登记」（已·经·登·记），
    //    而 `'已登记'` 要求「已·登·记」三字**连续** ⇒ `includes()` 为 false。
    //    本文件另外三条 toContain 已逐条核过是成立的，只有这一条错位。
    expect(b.error).toContain('已经登记');
  });

  it('登记：同 UUID 不同帧可登记（10 台共用 UUID 时的唯一可行形态），帧完全相同才 409', async () => {
    // 第 2 台用同一 UUID，但 major/minor 不同 ⇒ 应当成功
    const ok = await post(`/venues/${V}/beacons`, {
      id: B2, name: 'E5-02', mac: 'aa:bb:cc:dd:ee:02',
      uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825', major: 10001, minor: 19642,
    });
    expect(ok.status).toBe(200);
    // 第 3 台用**完全相同**的帧 ⇒ 撞 uq_wenlv_beacons_frame
    const dup = await post(`/venues/${V}/beacons`, {
      id: B3, name: 'E5-03', mac: 'aa:bb:cc:dd:ee:03',
      uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825', major: 10001, minor: 19642,
    });
    expect(dup.status).toBe(409);
    const b = await dup.json();
    expect(b.error).toContain('广播参数');
  });

  it('幂等重入：同 id 再 POST 返回既有行，不覆盖', async () => {
    const res = await post(`/venues/${V}/beacons`, { id: B1, name: '改了名字', mac: 'ff:ff:ff:ff:ff:ff' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.name).toBe('E5-01');            // 仍是原值
    expect(b.data.mac).toBe('AABBCCDDEE01');      // 仍是原值
  });

  it('登记：采集人取自请求头，且 body 传的同名字段被忽略', async () => {
    // ⚠️ 断言打在 **DB 行**上，不信响应自述。
    //    实现（`pms-server/src/routes/admin/wenlv.ts` 登记分支的 `createdBy:` 那行）
    //    把「取自请求头而非 body、schema 非 strict 也不接 body 字段」当**设计决策**写在
    //    注释里了 —— 但在此之前**没有任何断言守它**：把 `createdBy: platformUserIdFrom(c),`
    //    整行删掉，8 条用例照样全绿。设计决策写在注释里而无人守，就是这个缺口。
    const B5 = 'beacon-test-b5';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B5));
    try {
      const res = await post(`/venues/${V}/beacons`,
        { id: B5, name: '归属测试', mac: 'aa:bb:cc:dd:ee:05', createdBy: '伪造者' },
        { ...H, 'X-Platform-User-Id': 'pu-beacon-tester' });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvBeacons)
        .where(eq(pmsBuiWenlvBeacons.id, B5)).limit(1);
      // 头赢：body 里那个 '伪造者' 不落库
      expect(row?.createdBy).toBe('pu-beacon-tester');
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B5));
    }
  });

  it('登记：场地不存在返 404（不是 200）', async () => {
    // 判别力：`getVenueOr404`（连同 `if (venue instanceof Response) return venue;`）一旦被删掉，
    // 本条即红。⚠️ 但**红的形态是 200，不是 500** —— `pms_bui_wenlv_beacons.venue_id` 可空
    // 且**无外键**（`schema/wenlv.ts` 的 pmsBuiWenlvBeacons 定义里 venueId 无 `.references`；
    // `drizzle/0037_wenlv_beacons.sql` 建表亦无 REFERENCES；本机库 information_schema 实测该表
    // 只有 id 主键）⇒ 缺校验的插入会成功、返回 200。
    // （原稿此处断言「撞外键 ⇒ 23503 冒泡成 500」，该外键不存在；实测订正。）
    const res = await post('/venues/no-such-venue-xyz/beacons',
      { name: 'x', mac: 'aa:bb:cc:dd:ee:06' });
    expect(res.status).toBe(404);
  });

  // ===== 未归属登记 `POST /beacons`（2026-09-24 新增）=====
  // 为什么有它：现场的真实顺序常是「一批设备到货先录台账」，此刻**还不知道**装哪个场地；
  // 此前只有 `POST /venues/:id/beacons`（必须给场地）⇒ 要么随便编个场地上账、要么不入账。
  // ⚠️ 本组用例**都自带设备**（照本文件后半段的写法，用完即删），不加深已有的顺序依赖。

  it('未归属登记：落 venue_id = null，且出现在「未归属」这个视角里', async () => {
    const BX = 'beacon-test-unassigned';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const res = await post('/beacons', { id: BX, name: '到货待装', mac: 'aa:bb:cc:dd:ee:21' });
      expect(res.status).toBe(200);
      // 断言打在 **DB 行**上，不信响应自述
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row.venueId).toBeNull();
      expect(row.mac).toBe('AABBCCDDEE21');   // 归一化照旧 —— 与已归属那条路径**同一份实现**
      expect(row.status).toBe('stock');
      // 与列表端点对得上：`?venueId=` 空串 = 只查未归属（该端点的三态语义）
      const ids = (await (await get('/beacons?venueId=')).json()).data.list.map((x: any) => x.id);
      expect(ids).toContain(BX);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('未归属登记：body 里塞 venueId 被静默剥离（不会「以为指定了场地」）', async () => {
    // `beaconSchema` 非 strict，未知键被静默剥离 ⇒ 若哪天真把 venueId 加进 schema，
    // 「未归属端点」就能被调用方指定场地，而「未归属」这个视角会开始漏掉设备。
    const BX = 'beacon-test-unassigned-vid';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const res = await post('/beacons', {
        id: BX, name: '想指定场地', mac: 'aa:bb:cc:dd:ee:25', venueId: V,
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row.venueId).toBeNull();   // 关键命题：body 的 venueId 不落库
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('未归属登记：采集人同样取自请求头（共用实现，不是另写一份漏了这行）', async () => {
    // 判别力：把新端点**内联重写**一遍（不从 registerBeacon 共用）且漏掉 `createdBy:` 那行
    // ⇒ 本条红，而已归属那条路径的同名用例仍然绿 —— 这正是「两条路各写一份」的走形方式。
    const BX = 'beacon-test-unassigned-owner';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const res = await post('/beacons',
        { id: BX, name: '归属测试', mac: 'aa:bb:cc:dd:ee:26', createdBy: '伪造者' },
        { ...H, 'X-Platform-User-Id': 'pu-beacon-unassigned' });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row.createdBy).toBe('pu-beacon-unassigned');   // 头赢，body 里的不落库
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('未归属登记：MAC 重复同样 409（不是 500），且库里不留第二行', async () => {
    const BX = 'beacon-test-unassigned-mac';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const first = await post('/beacons', { id: BX, name: '先登记', mac: 'aa:bb:cc:dd:ee:22' });
      expect(first.status).toBe(200);
      // 第二条不给 id（走 randomUUID），只撞 MAC
      const dup = await post('/beacons', { name: '再来一台', mac: 'aa:bb:cc:dd:ee:22' });
      expect(dup.status).toBe(409);
      expect((await dup.json()).error).toContain('已经登记');
      // 断言打在 DB 行上：第二行**没有**落库（409 只回错、不写）
      const rows = await db.select().from(pmsBuiWenlvBeacons)
        .where(eq(pmsBuiWenlvBeacons.mac, 'AABBCCDDEE22'));
      expect(rows).toHaveLength(1);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('未归属登记：帧三件套半填同样 400（共用同一份判据）', async () => {
    const res = await post('/beacons', {
      name: '半帧', mac: 'aa:bb:cc:dd:ee:23', uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('要么全填');
  });

  it('未归属登记：非法 MAC 同样 400', async () => {
    const res = await post('/beacons', { name: '坏设备', mac: 'ZZ:AA:BB:CC:DD:EE:FF' });
    expect(res.status).toBe(400);
  });

  it('未归属登记：同 id 再 POST 幂等重入，返回既有行且不覆盖', async () => {
    const BX = 'beacon-test-unassigned-idem';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const first = await post('/beacons', { id: BX, name: '原名', mac: 'aa:bb:cc:dd:ee:24' });
      expect(first.status).toBe(200);
      const again = await post('/beacons', { id: BX, name: '改了名字', mac: 'ff:ff:ff:ff:ff:ff' });
      expect(again.status).toBe(200);
      const b = await again.json();
      expect(b.data.name).toBe('原名');            // 仍是原值
      expect(b.data.mac).toBe('AABBCCDDEE24');    // 仍是原值
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  // ⚠️ 下面两条测的是 **Task 4 的列表端点**，放在这个文件里是因为文件在 Task 5 才建。
  //    **这两条不是同一回事**（实测，不是推断）：末条（场地不存在返 404）本来就绿；
  //    本条**本来就红** —— 它断言列表含 B1/B2，而这两行是上面**登记**用例写进去的，
  //    登记端点还没实现 ⇒ 前两条插不进去 ⇒ 拿到 `expected [] to include 'beacon-test-b1'`。
  //    ⇒ 本条是登记端点的**下游**，Step 2 的「全红」判据只能排除末条那一条。
  it('列表：只回本场地的设备（跨场地过滤不能漏）', async () => {
    // 夹具自带、不进 beforeAll/afterAll：另建一个场地 + 一台属于它的设备。
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B4));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V2));
    await db.insert(pmsBuiWenlvVenues).values({ id: V2, name: '另一个场地' });
    // 裸插入只给 id/venueId/name/mac：status 有默认 'stock'，createdAt/updatedAt 有
    // defaultNow（schema 实测 :469/:476/:477）。mac 必须避开 B1/B2/B3 ——
    // uq_wenlv_beacons_mac 是**全局**唯一索引，撞了会报 23505 而不是业务错误。
    await db.insert(pmsBuiWenlvBeacons).values({ id: B4, venueId: V2, name: '别家的设备', mac: 'AABBCCDDEE04' });
    try {
      const res = await adminWenlvRoute.request(`/venues/${V}/beacons`, { headers: H });
      expect(res.status).toBe(200);
      const ids = (await res.json()).data.map((r: any) => r.id);
      expect(ids).toContain(B1);
      expect(ids).toContain(B2);
      // 🔴 **判别力全在这一条上**：若 where 漏了 venueId（或写错列），列表会把别的
      //    场地的设备一起带出来 —— 而只断言「有自己的」时，那种实现**照样全绿**。
      expect(ids).not.toContain(B4);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B4));
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V2));
    }
  });

  it('列表：场地不存在返 404（不是 200 + 空数组）', async () => {
    // Task 4 的提交消息与 docstring 都把「不存在的场地返 404 而非 200+[]」当**设计决策**
    // 写下了，但此前没有任何断言会因它变红 —— 空数组会被读成「这个场地没有设备」。
    const res = await adminWenlvRoute.request('/venues/no-such-venue-xyz/beacons', { headers: H });
    expect(res.status).toBe(404);
  });

  // ⚠️ 本组用例（Task 6）都建在 `B1`/`B2`/`B3` 上，而它们**不在 beforeAll 里** ——
  //    是本文件上面第一条登记用例（「MAC 被归一化成大写去分隔符」）写进去的。
  //    ⇒ **禁止用 `-t` 单跑本组的任一条**：B1 不存在时 PATCH 一个不存在的设备 ⇒ 404，
  //    那是**假红**，会把它误判成实现有错。排错时要么整文件跑，要么把上面的登记用例一并纳入 `-t` 的模式。
  it('绑定：把设备绑到同场地点位', async () => {
    const res = await adminWenlvRoute.request(`/beacons/${B1}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ pointId: P, status: 'active' }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.pointId).toBe(P);
    expect(b.data.status).toBe('active');
  });

  it('解绑：pointId 传 null', async () => {
    const res = await adminWenlvRoute.request(`/beacons/${B1}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ pointId: null }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.pointId).toBeNull();
    // 重新绑回，供后面的触发用例使用
    await adminWenlvRoute.request(`/beacons/${B1}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ pointId: P, status: 'active' }),
    });
  });

  it('跨场地绑定被拒 400', async () => {
    const OTHER_V = 'beacon-test-other-venue';
    const OTHER_P = 'beacon-test-other-point';
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, OTHER_P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, OTHER_V));
    await db.insert(pmsBuiWenlvVenues).values({ id: OTHER_V, name: '别处' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: OTHER_P, venueId: OTHER_V, name: '别处点位', code: 'WLP-OTHER01' });
    const res = await adminWenlvRoute.request(`/beacons/${B1}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ pointId: OTHER_P }),
    });
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error).toContain('同一场地');
    // 断言打在 DB 行上：绑定没有真的发生
    const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B1)).limit(1);
    // 要表达的命题是「绑定**没有真的发生**」⇒ 断言「没被改成 OTHER_P」。
    // 原来写的是 `toBe(P)`，那依赖**前一条用例**（`解绑`）末尾那次**无断言**的 re-bind 成功；
    // 那条 re-bind 若失败，这里会以 `expected null to be 'beacon-test-point'` 红、指错地方。
    // 换成 not.toBe(OTHER_P) 后判别力不变：守卫被删时 pointId 会变成 OTHER_P，照样红。
    expect(row.pointId).not.toBe(OTHER_P);
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, OTHER_P));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, OTHER_V));
  });

  it('改帧：只改 uuid ⇒ 三件套仍齐全 ⇒ 200', async () => {
    const res = await adminWenlvRoute.request(`/beacons/${B2}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647899' }),
    });
    // B2 原本三件套齐全，改 uuid 后仍齐全 ⇒ 应当成功
    expect(res.status).toBe(200);
    const b = await res.json();
    // 只断 status 的话，「把 uuid 丢弃不写」或「归一化写错」照样全绿 ⇒ 把「改动真的
    // 发生」钉住。实测 `resp.data.uuid` 是**归一化后的小写**新值（本次传入本就小写，原样回）。
    expect(b.data.uuid).toBe('fda50693-a4e2-4fb1-afcf-c6eb07647899');
    // 本次 PATCH 没传 major/minor ⇒ 不该被动过（合并取源写错时这里会红）
    expect(b.data.major).toBe(10001);
    expect(b.data.minor).toBe(19642);
  });

  it('改帧：把 major 置 null 会破坏三件套 ⇒ 400', async () => {
    const res = await adminWenlvRoute.request(`/beacons/${B2}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ major: null }),
    });
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.error).toContain('要么全填');
  });

  it('改：不存在的设备 404', async () => {
    const res = await adminWenlvRoute.request('/beacons/no-such-beacon', {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('删：删除设备', async () => {
    await post(`/venues/${V}/beacons`, { id: B3, name: '待删', mac: 'aa:bb:cc:dd:ee:03' });
    const res = await adminWenlvRoute.request(`/beacons/${B3}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B3)).limit(1);
    expect(row).toBeUndefined();
  });

  it('删：不存在的设备 404（不是 200）', async () => {
    // 判别力（**实测**）：删掉 `route.delete('/beacons/:id')` 里那行
    // `if (!exist) return c.json({ success: false, error: '设备不存在' }, 404);` ⇒
    // `db.delete(...).where(eq(id, id))` 删 0 行，紧接的 `return c.json({ success: true, data: { id } })`
    // 会把**不存在的设备**报成 200「删除成功」⇒ 本条变红（那时是静默假成功，正是本层最忌讳的）。
    // ⚠️ 与 `route-test-404-default-masks` 的区别：端点**已实现**，删守卫后返回的是 **200**（不是 404），
    //    所以 `toBe(404)` 有真判别力，不是「端点未写时框架默认 404」那种同码假绿。
    const res = await adminWenlvRoute.request('/beacons/beacon-test-does-not-exist',
      { method: 'DELETE', headers: H });
    expect(res.status).toBe(404);
  });

  it('改：把 MAC 改成已登记设备的 MAC ⇒ 409（不是 500）', async () => {
    // 守 PATCH 的 catch 读的是 `cause` 而不是 `e.code`。若有人把它改成 `(e as any)?.code`，
    // 这条会从 409 静默变成 500 —— 而在此之前全文件没有一条断言守 PATCH 的 409。
    const res = await adminWenlvRoute.request(`/beacons/${B2}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ mac: 'aa:bb:cc:dd:ee:01' }),
    });
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b.error).toContain('已经登记');
    // 断言打在 DB 行上：改没有真的发生
    const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B2)).limit(1);
    expect(row.mac).toBe('AABBCCDDEE02');
  });

  it('改：把帧改成已被占用的一组 ⇒ 409（不是 500）', async () => {
    // 撞 B1 的帧 —— Task 5 第一条登记用例写进去的那组（uuid/major/minor 见该用例）。
    const res = await adminWenlvRoute.request(`/beacons/${B2}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        uuid: 'fda50693-a4e2-4fb1-afcf-c6eb07647825', major: 10001, minor: 19641,
      }),
    });
    expect(res.status).toBe(409);
    const b = await res.json();
    expect(b.error).toContain('已被另一台设备占用');
  });

  // ===== 以下 6 条为 Task 6 收口补的用例 =====
  // 设备一律**用例自己建**（照 `删：删除设备` 那条的写法），用完即删 ——
  // 本文件已有顺序依赖（B1/B2/B3 由上面第一条登记用例写入），新用例不再加深它。

  it('改帧：无帧设备补录三件套 ⇒ 200，且三列落库', async () => {
    // 「现场先扫 MAC 入账（设备还没拆封、还没读过参数），后来才补上帧」是**真实顺序**
    // （见 drizzle/0037_wenlv_beacons.sql 的注释）⇒ 这是生产上最主要的 PATCH 场景，
    // 而在补本条之前它**没有任何用例**：本文件原有两条 PATCH 帧用例只走过
    // 「合并后 = 2 / = 3」，**filled === 0 一次都没走过**。
    // 判别力（**实测**，两条变异各跑一遍，不是推断）：
    //  · `const nextUuid = exist.uuid;`（合并时忽略 patch）⇒ **本条变红**
    //    （exist 三列全 null ⇒ filled=0 ⇒ 400）。本条的判别力就在这里。
    //  · ⚠️ 但只把 `nextMinor` 的取源误写成 `exist.uuid` ⇒ **26/26 全绿，本条抓不到**：
    //    本条 PATCH 里传了 minor ⇒ `patch.minor !== undefined` ⇒ 走不到被变异的那个取源分支；
    //    而真走那个分支时（不传 minor），exist.minor 与 exist.uuid 的 null/非 null 必然同向
    //    （半帧被登记闸拒在库外）⇒ 计数不变、判决不变。**别把本条当成对它的守卫。**
    const BX = 'beacon-test-fill';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const created = await post(`/venues/${V}/beacons`, { id: BX, name: '先入账', mac: 'aa:bb:cc:dd:ee:11' });
      expect(created.status).toBe(200);
      // 前置：起初确实无帧（否则本条退化成「三件套齐全改帧」，就不是它要测的形态了）
      const [before] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(before.uuid).toBeNull();
      expect(before.major).toBeNull();
      expect(before.minor).toBeNull();

      const res = await adminWenlvRoute.request(`/beacons/${BX}`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeee00000001', major: 20001, minor: 29001 }),
      });
      expect(res.status).toBe(200);
      // 断言打在 DB 行上，不信响应自述
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeee00000001');
      expect(row.major).toBe(20001);
      expect(row.minor).toBe(29001);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('改帧：三件套齐全的设备显式清空三列 ⇒ 200，且三列落成 null', async () => {
    // 合并后 filled = 0，走的是 PATCH 那行 `if (filled !== 0 && filled !== 3)` 的**另一半**。
    // 实测判别力：把该谓词写窄成 `if (filled !== 3)`（丢掉 `filled !== 0`）⇒
    // **本条变红（400）**，而上面 9 条 PATCH 相关用例全绿 —— 因为 PATCH 侧此前
    // 没有一条用例落在 filled === 0 上。（POST 那份不会被同样的变异漏掉，缺口只在 PATCH 这份。）
    const BX = 'beacon-test-clear';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const created = await post(`/venues/${V}/beacons`, {
        id: BX, name: '待清帧', mac: 'aa:bb:cc:dd:ee:12',
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeee00000002', major: 20002, minor: 29002,
      });
      expect(created.status).toBe(200);
      // 前置：起初三件套**确实齐全**（镜像上面「补录」那条的 `before.* === null`）。
      // 没有这三条时，POST 侧的帧写入若将来静默坏掉，本条会因「本来就是 null」而**空过** ——
      // 它通过的理由会退化成「清空没发生」，不再是「清空真的发生了」。
      const [before] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(before.uuid).not.toBeNull();
      expect(before.major).not.toBeNull();
      expect(before.minor).not.toBeNull();
      const res = await adminWenlvRoute.request(`/beacons/${BX}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ uuid: null, major: null, minor: null }),
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row.uuid).toBeNull();
      expect(row.major).toBeNull();
      expect(row.minor).toBeNull();
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('改：pointId 指向不存在的点位 ⇒ 400（点位不存在）', async () => {
    // `point_id` **没有外键**（schema/wenlv.ts 的 pmsBuiWenlvBeacons 无 `.references`；
    // drizzle/0037_wenlv_beacons.sql 建表无 REFERENCES）⇒ 这一行是**唯一**守卫：
    // 删掉它就会在下一行 `pt.venueId` 抛 TypeError ⇒ 500，而全套仍绿。
    // ⚠️ 文案串 `'点位不存在'` 已按实现实测（`wenlv.ts` 该分支的字符串字面量），
    //    不是从别处抄的 —— 本文件有过 `'已登记'` 对 `'已经登记过了'` 恒假的前科。
    const BX = 'beacon-test-badpoint';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const created = await post(`/venues/${V}/beacons`, { id: BX, name: '坏点位', mac: 'aa:bb:cc:dd:ee:13' });
      expect(created.status).toBe(200);
      const res = await adminWenlvRoute.request(`/beacons/${BX}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ pointId: 'no-such-point-xyz' }),
      });
      expect(res.status).toBe(400);
      const b = await res.json();
      expect(b.error).toContain('点位不存在');
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('删：设备已绑定点位也照删（有意不拦）⇒ 200', async () => {
    // `route.delete('/beacons/:id')` 上方的注释把「**有意不拦「已绑定」**」写成设计决策，
    // 但原有的 `删：删除设备` 用的是**未绑定**的 B3 ⇒ 将来有人加
    // `if (exist.pointId) return 409`，这个决策会静默失效而无人变红。
    const BX = 'beacon-test-delbound';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const created = await post(`/venues/${V}/beacons`, { id: BX, name: '待删已绑', mac: 'aa:bb:cc:dd:ee:14' });
      expect(created.status).toBe(200);
      // 前置：先真的绑上，否则本条退化成「删未绑定设备」
      const bind = await adminWenlvRoute.request(`/beacons/${BX}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ pointId: P, status: 'active' }),
      });
      expect(bind.status).toBe(200);
      expect((await bind.json()).data.pointId).toBe(P);
      const [bound] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(bound.pointId).toBe(P);

      const res = await adminWenlvRoute.request(`/beacons/${BX}`, { method: 'DELETE', headers: H });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row).toBeUndefined();
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('改：body 里塞 createdBy/venueId 被静默剥离，库里归属与场地不变', async () => {
    // `createdBy` / `venueId` 只是**恰好**不在 beaconUpdateSchema 里（zod 非 strict 对象
    // 静默剥离未知键）。谁把它们加进 schema 就会静默改写归属/场地，而此前没有一条断言守。
    // 与本文件自己的标准一致：「设计决策写在注释里而无人守，就是这个缺口」。
    const BX = 'beacon-test-ownership';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      // 本设备由**本用例**经 post() 建（未带 X-Platform-User-Id 头）⇒ 登记时 createdBy 落 null
      const created = await post(`/venues/${V}/beacons`, { id: BX, name: '归属守卫', mac: 'aa:bb:cc:dd:ee:15' });
      expect(created.status).toBe(200);
      expect((await created.json()).data.createdBy).toBeNull();

      const res = await adminWenlvRoute.request(`/beacons/${BX}`, {
        method: 'PATCH', headers: H,
        body: JSON.stringify({ createdBy: '伪造者', venueId: '别处场地' }),
      });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
      expect(row.venueId).toBe(V);                 // 仍是原场地，没被改成 '别处场地'
      expect(row.createdBy).not.toBe('伪造者');     // 关键命题：body 的字段不落库
      expect(row.createdBy).toBeNull();            // 更强：原值就是 null（本用例未带归属头）
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  it('改：畸形 JSON ⇒ 400（不是静默 200 success）；空体与空白体是无业务字段变更 ⇒ 200', async () => {
    // ⚠️ 本条是**行为改动**（I-3）的红转绿用例，改前为红。
    //    `const body = await c.req.json().catch(() => ({}));` 把解析失败折成 `{}`，
    //    而 beaconUpdateSchema **全字段可选** ⇒ `{}` 恰好合法 ⇒ 200 `{success:true}`。
    //    后果：请求体被截断（代理/客户端 bug）时前端显示「已保存」而实际什么都没改。
    //    POST 对同形写法免疫（`name`/`mac` 必填 ⇒ 400），所以这是 PATCH 独有的静默假成功。
    const BX = 'beacon-test-badjson';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    try {
      const created = await post(`/venues/${V}/beacons`, { id: BX, name: '畸形体', mac: 'aa:bb:cc:dd:ee:16' });
      expect(created.status).toBe(200);

      const bad = await adminWenlvRoute.request(`/beacons/${BX}`, {
        method: 'PATCH', headers: H, body: '{oops',
      });
      expect(bad.status).toBe(400);
      const b = await bad.json();
      expect(b.success).toBe(false);
      // 用户可见文案必须有断言锁住（实测）：把实现里那个串改成 'BODY_PARSE_FAILED' ⇒ 本条变红。
      // 本文件其它用户可见文案都有 toContain 钉住，此前只有这一条漏了。
      expect(b.error).toContain('合法 JSON');

      // 空体与**纯空白体**都是**无业务字段变更**，必须仍是 200 ——
      // 别把「合法空改」和「畸形体」一起收掉。
      // ⚠️ 措辞是「无业务字段变更」而不是「no-op」（2026-09-21 实测）：这几种形态都会刷新
      //    `updatedAt`（`patch` 初值就带 `updatedAt: new Date()`），只是业务字段没动。
      //    **本用例只钉「业务字段不变」** —— `updatedAt` 推不推进是 `patch` 初值的实现细节，
      //    刻意不写成断言（为一句措辞冻一个实现细节，会养出一条挡重构的用例）。
      const bizFields = <T extends { updatedAt: unknown }>(row: T) => {
        const { updatedAt, ...rest } = row;
        void updatedAt;   // 只为把 updatedAt 从比对里剔除，不比对它的值
        return rest;
      };
      // 五种形态与 `wenlv.ts` 那句「实测五种形态都回 200」逐项对齐（去掉枚举即两边都可能漂）。
      for (const blank of [undefined, '', '   ', '\n', '\t\r\n  '] as const) {
        const [before] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
        const req = blank === undefined
          ? { method: 'PATCH', headers: H }
          : { method: 'PATCH', headers: H, body: blank };
        const r = await adminWenlvRoute.request(`/beacons/${BX}`, req);
        expect(r.status, `空白体 ${JSON.stringify(blank)} 应回 200`).toBe(200);
        expect((await r.json()).success).toBe(true);
        const [after] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX)).limit(1);
        // 标题里那句「无业务字段变更」此前**无人守**（本次改前实测：本文件里 grep `updatedAt`
        // 只有 3 行、**全是注释**、零条断言）：
        // 将来给 schema 加 `$onUpdate`、或把 `patch` 初值改成 `{}`，标题会静默变假而全套照绿。
        // 这里逐列比对钉住它 —— 断言打在 **DB 行**上，不信响应自述。
        expect(bizFields(after), `空白体 ${JSON.stringify(blank)} 不该改动任何业务字段`)
          .toEqual(bizFields(before));
      }
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BX));
    }
  });

  // ===== 以下为 Task 7：全量设备台账 `GET /beacons` =====
  // ⚠️ 本组与 B1 有顺序依赖（B1 由上面第一条登记用例写入，且**已被绑到点位 P** ——
  //    见「绑定」用例）⇒ 禁止用 `-t` 单跑本组任一条。

  it('全量台账：不带参数时跨场地返回，且带出场地点名', async () => {
    const res = await get('/beacons');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Array.isArray(b.data.list)).toBe(true);
    const ids = b.data.list.map((x: any) => x.id);
    expect(ids).toContain(B1);                      // 属于场地 V
    expect(ids).toContain(B_ORPHAN);                // 未归属
    expect(b.data.total).toBe(b.data.list.length);  // total 与 list 必须自洽
    const b1 = b.data.list.find((x: any) => x.id === B1);
    expect(b1.venueName).toBe('信标测试场地');        // 跨场地可用性的**全部意义**就在这个字段
    // ⚠️ 原稿此处断言 `b1.pointName` 为 null（注释写「未绑点位」）—— **实测不成立**：
    //    B1 在本文件前面已被「绑定」用例绑到点位 P（「解绑」用例末尾又绑了回去），
    //    到本组运行时它的 pointId 就是 P ⇒ pointName 是 '测试点位'（实测，不是推断）。
    expect(b1.pointName).toBe('测试点位');
    // 「未绑点位/未归属 ⇒ 响应里是**显式 null**（键存在），而不是 undefined（键被
    // JSON.stringify 丢掉）」这一态挂在**确实未绑**的 B_ORPHAN 上。
    // 本条守的是「未绑那行的输出**恰为 null**」。
    // ⚠️ 它**无法分辨**是三元还是 `?? null` 在起作用 —— 删其中任一个都仍然绿
    //    （Map 里从来没有 null 键 ⇒ get 回 undefined ⇒ 被 `?? null` 兜成 null）。
    // ⚠️ 反过来也别低估它：`toBeNull()` 对**任何非 null 产出**都红，
    //    例如 else 支写成 `: undefined` 或 `: ''` 都会被它打红。
    //    所以它红 ≠「三元与 `?? null` 一起消失」这一种成因：
    //    原注释写「只有「两者一起消失」才红」是把判别面写窄了的**过强完备性断言**，此处订正。
    // ⚠️ `?? null` 守的**悬挂引用**支（pointId 有值但点位行已删、本表**零外键**）：
    //    2026-10（批 6 Task 20）起 DELETE /points/:id 会同步把绑该点位的信标 pointId 置 NULL
    //    （见本文件「删除点位：信标解绑」用例），新数据不再产生悬挂；这里兜底的是历史脏行。
    //    「未绑点位」这一态守不住它（未绑时三元直接短路，根本走不到 `?? null`）。
    const orphan = b.data.list.find((x: any) => x.id === B_ORPHAN);
    expect(orphan.pointName).toBeNull();            // 未绑点位
    expect(orphan.venueName).toBeNull();            // 且未归属 ⇒ 也没有场地名
  });

  it('全量台账：?venueId= 空串只回未归属（与「不过滤」必须可区分）', async () => {
    const res = await get('/beacons?venueId=');
    expect(res.status).toBe(200);
    const b = await res.json();
    const ids = b.data.list.map((x: any) => x.id);
    expect(ids).toContain(B_ORPHAN);
    expect(ids).not.toContain(B1);
    // 正向对照：不传参数时必须**能**看到 B1 —— 否则「空串过滤掉了 B1」这一条
    // 在「两个查询都返回空」时也成立，判据会失去判别力。（对照即本组第一条用例。）
  });

  it('全量台账：?venueId=<有值> 只回该场地', async () => {
    const res = await get(`/beacons?venueId=${V}`);
    const b = await res.json();
    const ids = b.data.list.map((x: any) => x.id);
    expect(ids).toContain(B1);
    expect(ids).not.toContain(B_ORPHAN);
  });

  it('全量台账：?status=faulty 只回故障，且不返回未归属的 stock 行', async () => {
    const res = await get('/beacons?status=faulty');
    const b = await res.json();
    const ids = b.data.list.map((x: any) => x.id);
    expect(ids).toContain(B_FAULTY);
    expect(ids).not.toContain(B_ORPHAN);
    expect(b.data.list.every((x: any) => x.status === 'faulty')).toBe(true);
  });

  it('全量台账：venueId 与 status 同时生效（组合过滤）', async () => {
    // 此前 6 条本组用例**每条最多只带 1 个条件**（`venueId` 或 `status` 之一），
    // 而单条件时 `and(c) ≡ c` ⇒ 把 `and(...conds)` 写成「只取某一个条件」时 6 条全绿。
    // 后果：`?venueId=X&status=faulty` 会回「场地 X 的**全部四态**」（或「**全场地**的故障
    // 设备」），故障一览里混进在役/在库设备，而没有任何用例会红。本条补上这个组合。
    //
    // ⚠️ 期望值不能只靠现成夹具（实测订正原稿假设）：本端点 `conds` 的推入顺序是
    //    **status 在前、venueId 在后**（见 `wenlv.ts` 该端点里的两个 if）⇒ 「只取 conds[0]」
    //    = 只认 status=faulty，而 V 场地下恰只有 B_FAULTY 一台 faulty ⇒ 收到的 ids 与本条
    //    期望**逐字相同**、变异**不被检出**。故本条**自带**一台**别的场地**的故障设备
    //    （V3 / B_FAULTY_ELSEWHERE），让两个方向都红：
    //      · 只认 status ⇒ 多出 B_FAULTY_ELSEWHERE ⇒ 红
    //      · 只认 venueId ⇒ 多出 B1（active）、B2（stock） ⇒ 红
    //    这样判别力不再依赖「哪个条件被 push 在前面」这一实现细节。
    //
    // 断言必须用 `toEqual([B_FAULTY])`（**恰好**），不能写成 `toContain(B_FAULTY)` ——
    // 后者对上面两种变异**都恒绿**，那样这条用例等于没写。
    // （本文件对**全局**计数一贯避免 `toBe(1)`，但这里是对**指定场地**的过滤查询、
    //   不是全局计数，精确断言正是它要表达的东西。）
    const V3 = 'beacon-test-venue-3';
    const B_FAULTY_ELSEWHERE = 'beacon-test-faulty-elsewhere';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B_FAULTY_ELSEWHERE));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V3));
    // 两次 insert 都收进 `try`：若 `db.insert(beacons)` 抛错（例如撞 uq_wenlv_beacons_mac
    // **全局**唯一索引），写在 try 之外会让 `finally` 不执行 ⇒ V3 场地行泄漏到下一轮。
    // 泄漏有界且自愈（本用例开头自带 `delete venue V3`），但收进 try 是零成本消掉这个窗口。
    try {
      await db.insert(pmsBuiWenlvVenues).values({ id: V3, name: '第三场地' });
      // mac 必须避开 B1/B2/B3/B4/B_ORPHAN/B_FAULTY —— uq_wenlv_beacons_mac 是**全局**唯一索引
      // （同「列表：只回本场地的设备」那条的注释），撞了会报 23505 而不是业务错误。
      await db.insert(pmsBuiWenlvBeacons).values({
        id: B_FAULTY_ELSEWHERE, venueId: V3, name: '别家的故障设备', mac: 'AABBCCDDEE97', status: 'faulty',
      });

      // 前置：V 场地**确实**还有**非 faulty** 的设备（B1 active / B2 stock）。
      // 它们是下面「只取 venueId」那一支会**多收进来**、从而打红的靶标 —— 少了它们，
      // venueId 方向的判别力会**静默归零**，而 `toEqual([B_FAULTY])` 仍然全绿
      // （那时它只证明了 status 过滤）。故这条前提必须在位断言，不能只靠夹具现状。
      const inV = await get(`/beacons?venueId=${V}`);
      const inVIds = (await inV.json()).data.list.map((x: any) => x.id);
      expect(inVIds).toContain(B1);
      expect(inVIds).toContain(B2);
      expect(inVIds).not.toContain(B_FAULTY_ELSEWHERE);   // 别的场地的不该混进来

      const res = await get(`/beacons?venueId=${V}&status=faulty`);
      expect(res.status).toBe(200);
      const ids = (await res.json()).data.list.map((x: any) => x.id);
      expect(ids).toEqual([B_FAULTY]);
      // 正向对照：**不带参数**时两台故障设备都应看得到 —— 否则「只回来一条」在
      // 「夹具压根没插进去 / 过滤把两台都筛掉了」时也成立，判据会失去判别力。
      const all = (await (await get('/beacons')).json()).data.list.map((x: any) => x.id);
      expect(all).toContain(B_FAULTY);
      expect(all).toContain(B_FAULTY_ELSEWHERE);
    } finally {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, B_FAULTY_ELSEWHERE));
      await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V3));
    }
  });

  it('全量台账：非法 status 返 400', async () => {
    const res = await get('/beacons?status=nope');
    expect(res.status).toBe(400);
  });

  it('全量台账：?status= 空串按不过滤（不是 400）', async () => {
    const res = await get('/beacons?status=');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.list.map((x: any) => x.id)).toContain(B1);
  });

  // 删点位解绑信标（批 6 Task 20）：beacons.point_id 零外键，删点位时不主动解绑就会留下
  // 指向空气的绑定（前端绑定下拉与触发匹配都会踩空）。夹具自带、测试内自清，不动 beforeAll 的 P。
  it('删除点位：绑在该点位的信标 pointId 置 NULL，设备行保留', async () => {
    const VD = 'beacon-test-venue-unbind';
    const PD = 'beacon-test-point-unbind';
    const BD = 'beacon-test-b-unbind';
    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BD));
    await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PD));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VD));
    await db.insert(pmsBuiWenlvVenues).values({ id: VD, name: '解绑测试场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: PD, venueId: VD, name: '待删点位', code: 'WLP-BEACONUB1' });
    await db.insert(pmsBuiWenlvBeacons).values({
      id: BD, venueId: VD, pointId: PD, name: '待解绑设备', mac: 'AABBCCDDEE0A', status: 'active',
    });

    const del = await adminWenlvRoute.request(`/points/${PD}`, { method: 'DELETE', headers: H });
    expect(del.status).toBe(200);

    const [row] = await db.select().from(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BD)).limit(1);
    expect(row).toBeTruthy();                 // 设备本身保留
    expect(row!.pointId).toBeNull();         // 绑定被解除
    const [pt] = await db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, PD)).limit(1);
    expect(pt).toBeFalsy();                  // 点位确已删除

    await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, BD));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VD));
  });
});
