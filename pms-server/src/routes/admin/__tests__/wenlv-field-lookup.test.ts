/**
 * `GET /venues/:id/points/lookup` —— 走场验码（块 D Task 4）。
 *
 * ## 这个端点在链里的位置
 * 现场人员拿手机核对「这个码是不是这个场地的这个点位」。它是**断言式**端点，不是过滤式：
 * 码属于**别的**场地时要**说出来**（`data.otherVenue`），而不是回一个空结果。
 * 理由：过滤式会把「贴错场地」和「码不存在」压成同一个 `[]`，而这两件事的现场处置
 * 完全不同（前者去撕码重贴 / 后者去查码有没有发出去）——压缩就等于让现场人员无从分辨。
 * 用例 2 与用例 3 因此**必须**给出两个可区分的响应，这由断言直接钉住。
 *
 * ## 测试装置的来源与陷阱
 * 装置照抄 `wenlv.test.ts` / `wenlv-simulate-route.test.ts`：拿 app 用
 * `adminWenlvRoute.request`、内部 token 走 `X-Internal-Service-Token`、
 * DB 用例用 `describe.skipIf(!process.env.RUN_DB)` 门控（本地真跑
 * `--config vitest.local.config.ts`，该配置自带 `assertLoopback` 硬闸）。
 *
 * ⚠️ **Hono 对未注册路径默认回 404 + `text/plain` 的 `404 Not Found`**（本文件编写前
 * 已实测：带 token 请求未实现的本端点 ⇒ `404` / `content-type: text/plain` / body
 * `"404 Not Found"`）。因此「断言 404」和「断言 400」在没有实现时**都不天然有区分力**：
 * 区别只在 body —— 默认 404 的 body 不是 JSON，`res.json()` 会抛 `SyntaxError`。
 * 用例 6 因此断言的是**文案**而不只是状态码。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { buildOtherVenue } from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints } from '../../../db/schema/index.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

// 全部带时间戳后缀：本地库是**大家共用的开发库**，绝不与别人的残留撞 pkey / 撞全局唯一 code。
const T = Date.now();
const V_A = `lk-venue-a-${T}`;
const V_B = `lk-venue-b-${T}`;
const V_MISSING = `lk-venue-missing-${T}`;   // 故意不落库
const P_A = `lk-point-a-${T}`;
const P_B = `lk-point-b-${T}`;
/** A 场地点位的码。**它同时是用例 4「防漂移锁」的重复插入目标**。 */
const CODE_A = `LK-A-${T}`;
const CODE_B = `LK-B-${T}`;
/** 谁都不命中的码。 */
const CODE_NONE = `LK-NONE-${T}`;
const VENUE_A_NAME = '走场验码场地A';
const VENUE_B_NAME = '走场验码场地B';
const POINT_B_NAME = 'B 点位·古井旁';
/** A 点位**已印**，B 点位三列全空 —— 两侧都要有，否则「投影恒回 null 的实现」测不出来。 */
const PRINTED_AT = new Date('2026-09-01T02:03:04.000Z');

const lookup = (venueId: string, query = '') =>
  adminWenlvRoute.request(`/venues/${venueId}/points/lookup${query}`, { headers: H });

// 门禁用例不需要 DB，放在 skipIf 之外。
// ⚠️ 与 simulate 那组同理：中间件 `route.use('*')` 对**未匹配**路径同样生效，
// 所以本用例在端点尚未实现时也会是 403/绿。它证明「门禁挂着」，**不能**证明端点存在。
describe('走场验码 lookup 门禁', () => {
  it('未带内部 token 返回 403（不是裸端点）', async () => {
    const res = await adminWenlvRoute.request(`/venues/${V_A}/points/lookup?c=${CODE_A}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });
});

// ⚠️ **必须另起一个顶层 describe，不能塞进下面的 DB describe。**
// 塞进去有两个后果，两种都不是想要的：
//   · 不传 `RUN_DB` 时被 `skipIf` **静默跳过** —— 「全绿」而实际零执行；
//   · 传了 `RUN_DB` 时**白跑一次 DB 装置**（还占着大家共用的开发库）。
// 本组是**纯函数**用例、本来就不碰 DB，所以**不得**加 `skipIf`。
//
// 用例 1 / 2 有**判别力**：把 `pointNames` 写成跨全部其他场地收集（改前的实现），
// 用例 1 会得到 `['b1','c1']`、用例 2 会得到 `['b1','b2','c1']`，都红。
// 用例 2 还额外证明「同一场地多行全取」不是「只取第一条」蒙对的。
// 用例 3 是对照组：证明前两条不是恒真。
describe('buildOtherVenue（纯函数，无 DB）', () => {
  it('pointNames 只含该场地自己的点位名（判别力：跨场地收集实现会红）', () => {
    const out = buildOtherVenue(
      [{ venueId: 'B', name: 'b1' }, { venueId: 'C', name: 'c1' }],
      new Map([['B', '乙场地'], ['C', '丙场地']]),
    );
    expect(out).toEqual({ id: 'B', name: '乙场地', pointNames: ['b1'] });
  });

  it('同一场地多行时全取它自己的（证明不是「只取第一条」蒙对的）', () => {
    const out = buildOtherVenue(
      [{ venueId: 'B', name: 'b1' }, { venueId: 'B', name: 'b2' }, { venueId: 'C', name: 'c1' }],
      new Map(),
    );
    expect(out!.pointNames).toEqual(['b1', 'b2']);
    expect(out!.name).toBe('B');            // 查不到名字时回落到 id
  });

  it('others 为空 → null（对照：证明上面不是恒真）', () => {
    expect(buildOtherVenue([], new Map())).toBeNull();
  });
});   // ← describe('buildOtherVenue（纯函数，无 DB）') 到此闭合

describe.skipIf(!process.env.RUN_DB)('GET /venues/:id/points/lookup（DB）', () => {
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvVenues).values([
      { id: V_A, name: VENUE_A_NAME },
      { id: V_B, name: VENUE_B_NAME },
    ]).onConflictDoNothing();
    await db.insert(pmsBuiWenlvVenuePoints).values([
      // A 点位带上 printedAt（其余两列留空）：证明投影真的透出了**行里的值**，
      // 而不是一个写死的 null —— 只断言「键存在」的实现挡不住 `printedAt: null`。
      { id: P_A, venueId: V_A, name: 'A 点位', code: CODE_A, printedAt: PRINTED_AT },
      { id: P_B, venueId: V_B, name: POINT_B_NAME, code: CODE_B },
    ]);
  });

  afterAll(async () => {
    // 按 venueId 删（而不是按 id 清单）：用例 4 若**意外插进去**了重复行，也一并清掉。
    await db.delete(pmsBuiWenlvVenuePoints)
      .where(inArray(pmsBuiWenlvVenuePoints.venueId, [V_A, V_B]));
    await db.delete(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, [V_A, V_B]));
  });

  it('c 命中本场地点位 ⇒ 200 / matches 长度 1 / scope=venue', async () => {
    const res = await lookup(V_A, `?c=${CODE_A}`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.scope).toBe('venue');
    expect(b.data.code).toBe(CODE_A);
    expect(b.data.matches.length).toBe(1);
    expect(b.data.matches[0].id).toBe(P_A);
    expect(b.data.matches[0].name).toBe('A 点位');
    expect(b.data.matches[0].code).toBe(CODE_A);
    expect(b.data.matches[0].venueId).toBe(V_A);
    expect(b.data.otherVenue).toBeNull();

    // ★ 键集**必须逐字等于这 7 个键**（不是 `>= 4`、不是 `toContain`）：
    //   `matches` 是**点位形状**，与 `/points/qrcodes` 的 `printable.map` 同形状。
    //   这份清单同时钉住「数量」与「名字」——漏掉任一列会红；多出未预期的列也会红
    //   （多列意味着端点契约被单方面加宽，消费方会读到他们没谈过的东西）。
    expect(Object.keys(b.data.matches[0]).sort()).toEqual(
      ['code', 'id', 'name', 'placedAt', 'printedAt', 'venueId', 'verifiedAt'],
    );
    // 值也要真的透出来：夹具里 A 点位**已印**，故这一列是行里的时间戳而非 null。
    // 三列的其余两列此点位为空 ⇒ 必须是**显式的 null**而不是缺键（缺键时上面那行已经红了，
    // 这里再单独钉一次值，两条断言各自独立、不互相顶替）。
    expect(b.data.matches[0].printedAt).toBe(PRINTED_AT.toISOString());
    expect(b.data.matches[0].placedAt).toBeNull();
    expect(b.data.matches[0].verifiedAt).toBeNull();
  });

  // ★ E3：命中**别的**场地必须说出来。
  // 这条是本端点相对「过滤式查询」的全部增量价值 —— 它证明「贴错场地」与「码不存在」
  // 在响应上真的可区分，不是靠注释声明的。
  it('c 命中另一个场地的点位 ⇒ 200 / matches 为空 / otherVenue 显式报出（双向）', async () => {
    const res = await lookup(V_A, `?c=${CODE_B}`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.scope).toBe('otherVenue');
    expect(b.data.matches).toEqual([]);
    expect(b.data.otherVenue).not.toBeNull();
    expect(b.data.otherVenue.id).toBe(V_B);
    expect(b.data.otherVenue.name).toBe(VENUE_B_NAME);
    expect(b.data.otherVenue.pointNames).toContain(POINT_B_NAME);

    // 反向再来一次：把方向搞反（判 `===` 写成 `!==`）的实现只会在其中一个方向上露馅。
    const res2 = await lookup(V_B, `?c=${CODE_A}`);
    expect(res2.status).toBe(200);
    const b2 = await res2.json();
    expect(b2.data.scope).toBe('otherVenue');
    expect(b2.data.matches).toEqual([]);
    expect(b2.data.otherVenue.id).toBe(V_A);
  });

  it('c 谁都不命中 ⇒ 200 / matches 空 / otherVenue 为 null（与「命中别场地」可区分）', async () => {
    const res = await lookup(V_A, `?c=${CODE_NONE}`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.scope).toBe('none');
    expect(b.data.matches).toEqual([]);
    expect(b.data.otherVenue).toBeNull();
  });

  // ★ 防漂移锁：`venue_points.code` **全局**唯一（`uq_wenlv_venue_points_code`）。
  // 本端点返回**数组**且不依赖「至多 1 条」，所以这条锁钉的不是端点行为，而是那个**前提**：
  // 插第二条同 code 必须被库拒绝。若有人日后去掉唯一索引，本用例变红 ⇒ 回溯到这里时
  // 会读到本注释并重新审视走场页的歧义分支。
  //
  // ⚠️ **「全局」两个字要两条插入才锁得住**（2026-09-17 只读复核指出，原稿只有第一条）：
  //   - ① **同场地**重复（A 场地插入第二条 CODE_A）—— 只能抓「索引被整条删掉」。
  //     若有人把索引从 `(code)` 改成**按场地复合** `(venue_id, code)`，同场地重复**仍被拒**
  //     ⇒ 只有①的话，本用例**依然绿**，而注释自称的「全局」已经不成立了。
  //   - ② **跨场地**重复（B 场地插入 A 场地的 CODE_A）—— 这条才是「全局」的判据：
  //     复合索引下它会**成功**（B 场地里没有 CODE_A）⇒ 本用例变红。
  // 两条合起来才与注释自称的范围相等。⚠️ 本项目已四次记录「断言自称的范围 > 它实际
  // 证明的范围」，读到「这条锁住了 X」都要问一句「它是怎么锁的」。下面两条 `expect` 各自
  // 独立断言，**不许**合并成一次插入或一处 expect（合并后复合索引下仍可能整体绿）。
  //
  // ⚠️ 断言要落在 `(e?.cause ?? e)?.code` 上：drizzle 把 pg 错误包了一层，
  // 外层 `e.code` 恒 `undefined`（本文件编写前实测：外层 `DrizzleQueryError.code === undefined`，
  // `cause` 才是 `DatabaseError`，其 `.code === '23505'`、`.constraint === 'uq_wenlv_venue_points_code'`）。
  // 只断言外层一定会**恒绿**（套用 memory `drizzle-wraps-pg-errors`）。
  it('🔒 同场地、跨场地两类重复插入都被库拒绝（唯一索引是全局的）', async () => {
    // ① 同场地：A 场地第二条 CODE_A。抓「索引被整条删掉」。
    let caught: any = null;
    try {
      await db.insert(pmsBuiWenlvVenuePoints)
        .values({ id: `${P_A}-dup`, venueId: V_A, name: '重复码', code: CODE_A });
    } catch (e) {
      caught = e;
    }
    // 没抛 = 唯一索引不在了 ⇒ 红（且这是「停下来报告」的信号，不是改测试迁就实现的信号）。
    expect(caught).not.toBeNull();
    const pgErr = caught?.cause ?? caught;
    expect(pgErr?.code).toBe('23505');
    expect(pgErr?.constraint).toBe('uq_wenlv_venue_points_code');
    // 顺便锁住「这条锁真的锁在 code 列上」：详情里点名了重复的值。
    expect(String(pgErr?.detail ?? '')).toContain(CODE_A);

    // ② 跨场地：B 场地插入 **A 场地**的 CODE_A。抓「索引被改窄成 (venue_id, code)」——
    //    那种索引下 B 场地里没有 CODE_A ⇒ 这次插入会**成功** ⇒ `caught2` 保持 null ⇒ 红。
    //    ⚠️ 必须与 ① 分开断言：合并成一处 expect 后，复合索引下 ① 仍红、整体仍「有红」，
    //    但这条锁就退化回「只抓整条删除」了。
    let caught2: any = null;
    try {
      await db.insert(pmsBuiWenlvVenuePoints)
        .values({ id: `${P_B}-dup`, venueId: V_B, name: '跨场地重复码', code: CODE_A });
    } catch (e) {
      caught2 = e;
    }
    expect(caught2).not.toBeNull();
    const pgErr2 = caught2?.cause ?? caught2;
    expect(pgErr2?.code).toBe('23505');
    expect(pgErr2?.constraint).toBe('uq_wenlv_venue_points_code');
  });

  // 断言式端点：没有码可查 ≠ 查全部。返回全部是个**语义完全不同**的过滤端点。
  it('c 缺失 / 为空 / 纯空白 ⇒ 400（不是「返回全部」）', async () => {
    for (const q of ['', '?c=', '?c=%20%20']) {
      const res = await lookup(V_A, q);
      expect(res.status).toBe(400);
      const b = await res.json();
      expect(b.success).toBe(false);
      expect(b.error).toContain('c');
    }
  });

  it('场地不存在 ⇒ 404 且文案为「场地不存在」', async () => {
    const res = await lookup(V_MISSING, `?c=${CODE_A}`);
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.error).toBe('场地不存在');
  });
});
