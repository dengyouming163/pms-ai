import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints, pmsBuiWenlvBeacons } from '../../../db/schema/index.js';
import { eq } from 'drizzle-orm';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN };

const V = 'ops-today-venue';
const P1 = 'ops-today-p1';  // 未印
const P2 = 'ops-today-p2';  // 已印
const P3 = 'ops-today-p3';  // 已铺
const P4 = 'ops-today-p4';  // 已验
// 🔴 脏行：有 placedAt、无 printedAt。这是**跳级推进**造出来的
//    （canAdvance('none','placed') 为真，而 patchForAdvance('placed') 只写 placedAt）；
//    `reset` 造不出它 —— clearedByReset('placed') 会保住 printedAt。
//    它是本文件**唯一**能把「unprinted 取 state === 'none'」与「取 SQL 的 printedAt IS NULL」
//    区分开的夹具 —— 但只在**逐项断言** `placed >= 2` 上分得开，见下方说明。
const P5 = 'ops-today-p5';
const B_STOCK = 'ops-today-bs';
const B_FAULTY = 'ops-today-bf';
// 🔴 本文件信标 MAC 的段位是 EE31-EE32 —— `uq_wenlv_beacons_mac` 是全局唯一索引，
//    段位不能与其它信标测试文件重叠。**实测全表**（2026-09-22，可重跑），不是推断：
//      cd pms-server
//      { grep -rnoiE "aa[:-]bb[:-]cc[:-]dd[:-]ee[:-][0-9a-f]{2}" src drizzle
//        grep -rnoiE "aabbccddee[0-9a-f]{2}" src drizzle; }
//      | sed -E 's/^([^:]+):[0-9]+:/\1|/'
//      | awk -F'|' '{v=toupper($2); gsub(/[:-]/,"",v); print $1, v}' | sort -u
//    ⚠️ **必须两种字面形态都扫**：同一段位可能只以**分组小写**出现、也可能只以**紧凑形态**
//       出现。只扫紧凑形态会得出**假的「全仓 0 命中」** —— admin 的 EE11-16 六段恰好
//       **只以分组小写出现**（本仓登记过的前科：一个值的两种字面形式）。
//    ⚠️ **阳性对照 + 判别对照（两条都要过，缺一不可）**：
//       ① 分组那条 grep **必须**命中 `routes/admin/__tests__/wenlv-beacon.test.ts` 的
//          EE11–EE16（≥6 处）；
//       ② 紧凑那条 grep 对**同一文件同一六段**必须 **0 命中**。
//       ②正是 C1 前科的判别点 —— 只跑紧凑会打印出一个假的 0 命中。两条都过才允许相信读数。
//    🔴 **本注释块自身不得出现完整的 32 位 MAC 字面量**（两种形态都不行）。理由：命令是
//       全仓 `grep`，注释里的样本会被它自己捞进去 —— 届时①可能被注释自我满足，上面那张
//       段位表也不再等于命令输出。一律用**裸段位记法**（`EE11–EE16`）或 `<两位>` 占位。
//    段位 → 归属文件：
//      EE01 EE02 EE03 EE04 EE05 EE06 EE11 EE12 EE13 EE14 EE15 EE16
//      EE97 EE98 EE99                     → routes/admin/__tests__/wenlv-beacon.test.ts
//      EE07 EE08 EE09 EE10 EE21 EE22      → routes/mini/__tests__/wenlv-beacon.test.ts
//      EE31 EE32                          → **本文件**
//      EEFF                               → services/wenlv-beacon.ts 的 JSDoc 示例
//                                           + services/__tests__/wenlv-beacon.test.ts
//                                           的纯函数归一化用例，**不落库、不占唯一索引**
//    ⚠️ 另有**两处不落库**的整串值（不占唯一索引）：admin 测试里的非法值负向夹具
//       （`ZZ:AA:BB:CC:DD:EE:…`，断言「库里不留行」）与幂等重入 body（`ff:ff:…`）。
//       按上面那条规矩，这里**也不抄原值** —— 它们的整串形态落在这里会各多出一条假命中。
//    ⚠️ 真表**须自己跑、别抄上面这张** —— 它会随各测试文件增改而漂移。
//    ⚠️ 别凭「admin 只到 EE06」推断空闲段位 —— 实际 admin 还占了 EE97-EE99。

const T = (iso: string) => new Date(iso);

/** ⚠️ 本文件断言的是**全局**计数，而库里还有别的测试留下的行。
 *  所以每条判据都写成「**至少**含本夹具的贡献」，绝不写 `toBe(1)` ——
 *  那样会在任何并发/残留数据下随机变红，属于环境性假红。 */
describe.skipIf(!process.env.RUN_DB)('wenlv 工作台今日计数（DB）', () => {
  beforeAll(async () => {
    for (const id of [P1, P2, P3, P4, P5]) {
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id));
    }
    for (const id of [B_STOCK, B_FAULTY]) {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, id));
    }
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
    await db.insert(pmsBuiWenlvVenues).values({ id: V, name: '今日计数测试场地', status: 'surveying' });

    // 四态各一 + 一条脏行。`code` 有全局唯一索引，取值要够独特。
    await db.insert(pmsBuiWenlvVenuePoints).values({ id: P1, venueId: V, name: '未印', code: 'WLP-OPSTODAY01' });
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: P2, venueId: V, name: '已印', code: 'WLP-OPSTODAY02', printedAt: T('2026-09-01T00:00:00Z'),
    });
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: P3, venueId: V, name: '已铺', code: 'WLP-OPSTODAY03',
      printedAt: T('2026-09-01T00:00:00Z'), placedAt: T('2026-09-02T00:00:00Z'),
    });
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: P4, venueId: V, name: '已验', code: 'WLP-OPSTODAY04',
      printedAt: T('2026-09-01T00:00:00Z'), placedAt: T('2026-09-02T00:00:00Z'), verifiedAt: T('2026-09-03T00:00:00Z'),
    });
    // 🔴 脏行：**有 placedAt、无 printedAt**（**跳级推进**造出，`reset` 造不出 —— 见文件头说明）。
    // 它必须归 `placed`。
    // ⚠️ 它的判别力**只在逐项断言 `placed >= 2` 那一层**：若只把分桶链里的**第一个条件**
    //    换成 `printedAt == null`，链的互斥结构仍在 ⇒ 每行仍恰落一桶 ⇒ 合计不变量照样绿。
    //    只有当实现**放弃互斥结构**（改成四个各自独立的 `if`，即「在 SQL 里重写」最自然的形态）
    //    时，这一行才会被数两遍、合计变红。
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: P5, venueId: V, name: '铺了无印', code: 'WLP-OPSTODAY05',
      placedAt: T('2026-09-02T00:00:00Z'),
    });

    await db.insert(pmsBuiWenlvBeacons).values({
      id: B_STOCK, venueId: V, name: '在库', mac: 'AABBCCDDEE31', status: 'stock',
    });
    await db.insert(pmsBuiWenlvBeacons).values({
      id: B_FAULTY, venueId: V, name: '故障', mac: 'AABBCCDDEE32', status: 'faulty',
    });
  });

  afterAll(async () => {
    for (const id of [P1, P2, P3, P4, P5]) {
      await db.delete(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, id));
    }
    for (const id of [B_STOCK, B_FAULTY]) {
      await db.delete(pmsBuiWenlvBeacons).where(eq(pmsBuiWenlvBeacons.id, id));
    }
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, V));
  });

  it('四态计数互斥，且合计等于点位总数', async () => {
    const res = await adminWenlvRoute.request('/ops/today', { method: 'GET', headers: H });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const p = data.points;
    // 不变量：四个数互斥且穷尽。
    // ⚠️ **它的判别力比看上去小**：本实现的分桶是 `if / else-if` 链 + 兜底 `else`，
    //    每行**按构造**恰落一桶 ⇒ 这条和对**链内任何条件写法都恒真**（把第一个条件换成
    //    `printedAt == null` 也一样绿）。它真正守的是**结构退化** —— 后人把链拆成
    //    四个各自独立的 `if`（「在 SQL 里重写」的形态）时，脏行 P5 会被数两遍、这条当场变红。
    //    ⇒ 它是**结构回归闸**，口径正确性由下一条用例的逐项断言守。
    //    ⚠️ 别删 P5，也别删这条 —— 两者合起来才是那个结构闸。
    expect(p.unprinted + p.printed + p.placed + p.verified).toBe(p.total);
  });

  it('四态各一 + 脏行：本夹具的五条点位各自落进正确的桶', async () => {
    const res = await adminWenlvRoute.request('/ops/today', { method: 'GET', headers: H });
    const { data } = await res.json();
    // 全局口径，故用 >= 夹具贡献数（全局库里有别的行）
    expect(data.points.unprinted).toBeGreaterThanOrEqual(1);  // P1
    expect(data.points.printed).toBeGreaterThanOrEqual(1);    // P2
    // 🔴 **≥2 而不是 ≥1**：除 P3 外还有脏行 P5（有 placedAt 无 printedAt）。
    //    P5 归 placed 正是「unprinted 取 state === 'none'」与「取 SQL 的 printedAt IS NULL」的分水岭 ——
    //    后者会把 P5 塞进 unprinted，于是 placed 只剩 P3 一条 ⇒ **这条断言当场变红**。
    //    （注意：变红的是**这条逐项断言**，不是上一条合计不变量 —— 合计在链结构下恒真。）
    expect(data.points.placed).toBeGreaterThanOrEqual(2);     // P3 + P5
    expect(data.points.verified).toBeGreaterThanOrEqual(1);   // P4
  });

  it('设备四态分桶，且合计等于设备总数', async () => {
    const res = await adminWenlvRoute.request('/ops/today', { method: 'GET', headers: H });
    const { data } = await res.json();
    const b = data.beacons;
    expect(b.stock + b.active + b.faulty + b.retired).toBe(b.total);
    expect(b.stock).toBeGreaterThanOrEqual(1);
    expect(b.faulty).toBeGreaterThanOrEqual(1);
  });

  it('场地：surveying 含 lead 与 surveying 两态', async () => {
    const res = await adminWenlvRoute.request('/ops/today', { method: 'GET', headers: H });
    const { data } = await res.json();
    expect(data.venues.surveying).toBeGreaterThanOrEqual(1);  // 夹具是 surveying
    // 手写反向：`toBeLessThanOrEqual` 不在本仓 vitest 类型桩里（可用成员以
    // src/types/vitest.d.ts 为准），而 `total >= surveying` 与它等价（同为整数比较）。
    // 不为一条断言的写法去改桩（那会动到本 Task 点名文件之外的文件）。
    expect(data.venues.total).toBeGreaterThanOrEqual(data.venues.surveying);
  });

  it('冒烟：端点返回 200，且设备五个计数都是数字', async () => {
    // ⚠️ 这条**不**钉住「未知 status 被静默丢弃」—— 本文件没有未知 status 夹具，
    //    准确的说法是**加不了夹具而不削弱那条合计不变量**：设备分桶链**没有兜底 `else`**
    //    （与点位链不同），未知 status 的行会进 `total` 却不进任何桶 ⇒ 上一条
    //    「合计 === total」当场变红。
    //    ⚠️ 那**不是环境性**假红：夹具是本文件自己在 beforeAll 里插的、同一进程内
    //    **确定性**生效，与「库里别的测试留下的行」无关。而且正因为没有兜底 `else`，
    //    那条合计不变量在**信标侧是有判别力的**（不是同义反复）—— 点位侧才有兜底 `else`，
    //    才退化成「只守结构退化」的结构回归闸。两处不可互推。
    //    ⇒ 该行为**当前未被钉住**，属已知缺口，不是「忘了处理」
    //    （status 有 zod 白名单，脏值只可能来自直接写库）。
    //    空着比假绿好：原用例名声称守它、函数体却只断言 200，对声称的事不可能失败。
    //
    //    ⚠️ 下面那 5 个 `typeof` 断言**不是**「有价值的下限」，判别力为 0：
    //       它们被上一条用例的合计不变量**完全覆盖** —— 任一桶键缺失 ⇒
    //       `b.stock + b.active + b.faulty + b.retired` 里出现 `undefined`/`NaN`，
    //       与 `b.total` 不等 ⇒ 上一条红；某个计数被写成字符串 ⇒ 拼接结果 ≠ 数字
    //       ⇒ 上一条也红（`total` 键本身缺失同理：合计 `NaN` ≠ `undefined`）。
    //       ⇒ 保留它只为把响应形状写进用例、读起来直观，**别再当成一层守卫**。
    const res = await adminWenlvRoute.request('/ops/today', { method: 'GET', headers: H });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    for (const k of ['total', 'stock', 'active', 'faulty', 'retired'] as const) {
      expect(typeof data.beacons[k]).toBe('number');
    }
  });
});
