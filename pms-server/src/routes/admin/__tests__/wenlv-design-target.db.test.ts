import { describe, it, expect, afterAll } from 'vitest';
// ⚠️ `like` **必须留着**：本文件唯一的 `afterAll` 用它按 `'wa-' + TAG` 前缀清理素材行。
//    （本 Task 的计划里给出的 import 清单写成 `{ eq, sql }`、漏了 `like` —— 照抄会 TS2304。）
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvDesignAssets, pmsBuiWenlvProducts,
} from '../../../db/schema/index.js';
import { writeAsset } from '../../../services/wenlv-asset-gen-scheduler.js';
import { writeCandidate, targetFieldsOf, designAssetIdFor } from '../../../services/wenlv/asset-gen/candidate-store.js';
import { isReviewableType } from '../../../services/wenlv/asset-gen/reviewer.js';

// 本文件三类块：
//   ① `targetFieldsOf`（下）              —— 纯函数，不需要库
//   ② `旁白写路径的坐标（DB）`             —— 真落库
//   ③ `坐标一致性（DB）` + `isReviewableType` —— 真落库 + 纯函数
// ⚠️ 这里原先写的是「DB 块在 Task 6 追加到同一个文件」—— **Task 5 就已经追加过一个 DB 块**，
//    那句话当时已成了假陈述。现在按实际内容陈述。
// ⚠️ ②③ 两个 DB 块共用同一个 `skipIf(!run)` 门与同一个 `afterAll`（详见 ③ 块前的说明）。
describe('targetFieldsOf', () => {
  it('原样透出 job 的两个坐标', () => {
    expect(targetFieldsOf({ targetKind: 'node', targetId: 'n1' }))
      .toEqual({ targetKind: 'node', targetId: 'n1' });
  });

  it('undefined 归一成 null（列可空，undefined 会让 drizzle 整个键消失）', () => {
    expect(targetFieldsOf({ targetKind: undefined, targetId: undefined }))
      .toEqual({ targetKind: null, targetId: null });
  });

  it('kind 有而 id 空时**两个都归 null** —— 这一侧 0038 叫「半空」，是脏态，别产出它', () => {
    expect(targetFieldsOf({ targetKind: 'node', targetId: null }))
      .toEqual({ targetKind: null, targetId: null });
  });

  // 上一条只钉住 `!id`：把守卫退化成 `if (!id)`（即删掉 `!kind`）时上一条**仍绿**
  // —— 这一侧原本零判别力。非假想态：0038 的回填谓词（`AND j.target_kind IS NOT NULL`）
  // 专门挡它，0038 的注释把这条叫「**只有 id**」的畸形素材行。
  it('kind 空而 id 有时**两个都归 null**（0038 称「只有 id」）', () => {
    expect(targetFieldsOf({ targetKind: null, targetId: 'n1' }))
      .toEqual({ targetKind: null, targetId: null });
  });
});

const run = !!process.env.RUN_DB;
const TAG = 'wd-target-' + Date.now();
const BATCH = TAG + '-b';
const PROD = TAG + '-p';
const JOB = TAG + '-nar';

describe.skipIf(!run)('旁白写路径的坐标（DB）', () => {
  // ⚠️ 这个钩子**必须留在 `describe` 回调内**：`describe.skipIf` 跳过的是**用例**，不是钩子。
  //    放在模块作用域（= 本文件此前的写法）时，RUN_DB 未设也会用 `vitest.config.ts` 的桩库
  //    跑这三条 DELETE ⇒ 整个文件报 FAILED，而真正的 DB 块一个字都没跑。
  //    6 个同类 `.db.test.ts` 全是这个形状（claim / review / run-once / writeback /
  //    review-examples / wenlv-human-review），别再挪出去。
  afterAll(async () => {
    // 按**夹具控制的 id** 删（house style，cf. asset-gen 侧 review.db.test.ts）。
    // 原先按 `product_id` 删是锚在**被测代码自己写出来的列**上：写入一旦有 bug，
    // 行会静默残留而清理报「已清干净」。
    await db.delete(pmsBuiWenlvDesignAssets).where(like(pmsBuiWenlvDesignAssets.id, 'wa-' + TAG + '%'));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, BATCH));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, PROD));
  });

  it('writeAsset 必须写 job_id —— 0038 之前它恒为 NULL，是「用在」列恒显 — 的根因', async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: PROD, name: '坐标夹具剧本' });
    const [job] = await db.insert(pmsBuiWenlvAssetJobs).values({
      id: JOB, batchId: BATCH, assetType: 'narration', name: '旁白夹具',
      productId: PROD, targetKind: 'node', targetId: 'node-x',
    }).returning();

    const assetId = await writeAsset(job, 'https://oss.test/nar.mp3', {});

    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
    expect(row.jobId).toBe(JOB);              // ← 本片之前这里恒为 null
    expect(row.targetKind).toBe('node');
    expect(row.targetId).toBe('node-x');
    // index 0 的 id 规则与图类**同一个函数**产出（见 Task 5 对 id 规则的统一）
    // ⚠️ 这条断言用的是**字面**拼接，与 `designAssetIdFor(JOB, 0)` 并非恒等 —— 分叉与否
    //    **与长度无关**，只取决于 id 的**前 47 个码点内有没有非 BMP 字符**：
    //    `designAssetIdFor` 按**码点**截到 47（`Array.from`），而旧的 `('wa-'+id).slice(0, 50)`
    //    按 **UTF-16 码元**截 —— 只有当那个非 BMP 字符落在前 47 个码点内，旧式才会从代理对
    //    中间切开、吐出一个孤立高位代理项，两边才算出不同的 id。
    //    实测：ascii 46/47/48/50/60、36 位 UUID、46 字符 `review:` 前缀行、47×'a'+emoji 全部等价；
    //    唯一不等价的是 `'a'.repeat(46) + '😀'`。
    //    本文件 `JOB = TAG + '-nar'`，`TAG` 含 13 位时间戳 ⇒ 27 个 ASCII 字符，两边一致。
    //    **若你将来给 TAG/JOB 加了非 ASCII，请把期望改成 `designAssetIdFor(JOB, 0)`** ——
    //    否则这里会因截断而红成「id 规则没统一」，指向错的对象。
    expect(assetId).toBe('wa-' + JOB);
  });
});

// 🔴 **本 describe 必须有自己的一份清理** —— 这是对计划 ⑤「不要再加一个 afterAll」的**订正**，
//    依据是**实测**而不是推理：上面那个 `afterAll` 挂在 `describe('旁白写路径的坐标（DB）')`
//    **内部**，而 `afterAll` 的生效范围就是**它所在的那个 describe** —— 它在**本 describe 的
//    第一条用例跑之前**就执行完了。
//    证据（跑完一遍后直查本机库）：
//      · 图类夹具 `wa-wd-target-*-img` 与它的 job **仍在** ⇒ 没人清，静默漏一行；
//      · 旁白夹具 `wa-wd-target-*-nar` 与它的 job **已不在** ⇒ 它在本块跑之前就被删了，
//        这正是「去读上面 describe 的夹具」那条用例恒查到 `undefined` 的根因。
//    ⇒ 计划 ⑤ 的前提「清理仍覆盖本 Task 插入的行」**是假的**（两个 describe 同 gate 只保证
//      同跑同跳，**不**保证清理的作用域跨 describe）。
//    ⚠️ 也**不要**把上面那个挪到模块作用域去「统一」—— `describe.skipIf` 跳过的是**用例**、
//       **不跳过 hook**，挪出去会让默认配置（`pnpm test`）下整个文件 FAILED。
describe.skipIf(!run)('坐标一致性（DB）', () => {
  // 按**夹具控制的 id / batchId** 删（house style），与上面那个 afterAll 同谓词、同前缀。
  afterAll(async () => {
    await db.delete(pmsBuiWenlvDesignAssets).where(like(pmsBuiWenlvDesignAssets.id, 'wa-' + TAG + '%'));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, BATCH));
  });

  it('图类 writeCandidate 也写坐标', async () => {
    const [job] = await db.insert(pmsBuiWenlvAssetJobs).values({
      id: TAG + '-img', batchId: BATCH, assetType: 'background', name: '图夹具',
      productId: PROD, targetKind: 'node', targetId: 'node-y',
    }).returning();
    const id = await writeCandidate({
      jobId: job.id, index: 0, assetType: job.assetType, name: job.name,
      // ⚠️ `PROD` 那一行**此刻已经不在库里**了 —— 它由上面那个 describe 造、又被那个 describe
      //    的 `afterAll` 删掉。**没有外键**（本域惯例：product_id 是软引用，见 schema 里
      //    `pms_bui_wenlv_client_reports` 上方的注释），所以这里只是往一个 varchar 列里写个值、
      //    不影响任何断言。写 `PROD` 而不是 `null` 只为贴近真实行形状。
      //    ⇒ 别把这里读成「本块依赖上面那个 describe 的产品行」：那是**同一类跨块耦合**，
      //      只是这一处的后果是静默无害的（上面那条用例的后果不是）。
      url: 'https://oss.test/img-0.png', productId: PROD, venueId: null,
      iteration: 1, communityStyleTag: null, extraMeta: {},
      isSelected: false, target: targetFieldsOf(job),
    });
    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, id)).limit(1);
    expect(row.targetKind).toBe('node');
    expect(row.targetId).toBe('node-y');
    expect(row.jobId).toBe(job.id);
  });

  it('不变量：凡 job_id 非空且**当前仍有归属**的行，坐标必须与其 job 逐行相等', async () => {
    // 这条是设计文档 §7 风险表要的那条真断言（写在测试里，不写在注释里）。
    // 漂移今天不可达（job 的 target 入队后不可变），但那是**靠约定不是靠约束** ——
    // 这条断言就是把它从约定变成约束。
    //
    // 🔴 **为什么谓词不是裸的「逐行相等」**：Task 11 的**有意解绑**会造出
    //    「素材两列为 NULL、而它那条 job 仍有 target」的行 —— 那是决策 2 的**正常终态**。
    //    裸谓词会把它算成「不一致」⇒ 断言变红，而**红的是一个正确行为**
    //    （前科：假缺陷把对的计划改坏 —— 而下面那条 ⚠️ 还会教人「不要改绿」，那就更糟）。
    //    放宽成「当前仍有归属的行才比」之后判别力不减：① 漂移仍红（素材绑着 X、job 说是 Y）；
    //    ② **半空**（kind 有、id 空）仍红 —— 那是写路径漏写一列的典型形状。
    //    被排除的只有 `(NULL, NULL)` 这一种状态，且它是**唯一**被设计允许的「不一致」。
    //
    // ⚠️ 若它红了：**先报数、先看是哪些行**，那是发现（可能是没跑迁移的回填，
    //    也可能是新引入的漂移），**不要**用「限定到本夹具」把它改绿 ——
    //    那样这条断言就退化成一句装饰（本仓前科：复核比执行窄）。
    //    （区分一下：把**已解绑的行**排除**不属于**「限定到本夹具」——
    //      那是按设计语义收窄，上面 🔴 已说明它不损失判别力。）
    //
    // ⚠️ `db.execute` 的返回形状在本仓**没有统一**：有带 `.rows` 的、也有裸数组的
    //    （见 `services/wenlv/asset-gen/claim.ts`、`routes/inventory.ts`、
    //    `db/__tests__/wenlv-asset-gen-schema.db.test.ts` —— 三处都写成防御式）。
    //    照抄这个惯例，**别写 `r.rows[0]`**：形状不对时那是 TypeError，
    //    会伪装成「断言失败」，把人指向被测对象而不是量具。

    // ✅ **阳性对照：先证明这条断言真的在测东西，再断言它是 0。**
    // ⚠️ 对照必须与断言**同谓词框**（前科：复核比执行宽或窄，读出的数都会误导）——
    //    所以它数的是「**落在断言射程内**的行」：素材已绑定 + job 有真 target。
    // 本机全库能 join 上 job 的素材行只有 2 条，且**那两条 job 的 target 都是 NULL**、
    // 素材行也是空的 ⇒ 它们在断言射程内**一条都不算**：「不一致 = 0」在**没有任何夹具时是白送的**
    //（实现写对了读 0，实现**完全不写坐标**也读 0）。
    // 🔴 **让下面那个 0 有意义的只有一条行：本 describe 第一条用例造的那张图类行**
    //    —— 初版这里写的是「两个夹具（旁白行、图类行）」，**是错的**：旁白行在它自己那个
    //    describe 的 `afterAll` 里已经被清掉了（见上方 🔴），本用例跑的时刻它**不在库里**。
    //    「阳性对照数出来的正是断言要数的行」这个要求没变，变的只是**实际有几条**。
    // 本仓前科：「单实例夹具让 AND 条件全部零判别力」「判据会无信号地失效」。
    const ctl: any = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM pms_bui_wenlv_design_assets a
        JOIN pms_bui_wenlv_asset_jobs j ON a.job_id = j.id
       WHERE j.target_id IS NOT NULL
         AND NOT (a.target_kind IS NULL AND a.target_id IS NULL)`);
    expect(((ctl.rows ?? ctl)[0] as { n: number }).n).toBeGreaterThanOrEqual(1);

    const r: any = await db.execute(sql`
      SELECT count(*)::int AS n
        FROM pms_bui_wenlv_design_assets a
        JOIN pms_bui_wenlv_asset_jobs j ON a.job_id = j.id
       WHERE NOT (a.target_kind IS NULL AND a.target_id IS NULL)
         AND (a.target_kind, a.target_id) IS DISTINCT FROM (j.target_kind, j.target_id)`);
    expect(((r.rows ?? r)[0] as { n: number }).n).toBe(0);
  });

  it('writeAsset 不写评审列（弱断言：只钉住写侧不越权）', async () => {
    // ⚠️ **这条是终态断言、天生弱**：本用例根本没调评审器，这两列为 null 是白送的。
    //    别把它当成「旁白不会被评」的证据 —— 那个证据在下面那个纯函数块里。
    // 🔴 **本用例自带夹具**：初版写的是「去读上面那个 describe 的 `designAssetIdFor(JOB, 0)`」，
    //    而那行在它所属 describe 结束时就被其 `afterAll` 清掉了 ⇒ 这里**恒查不到行**。
    //    实测报错是 `expected undefined to be truthy`（下面那行 `toBeTruthy()` 就是为让它
    //    可读才加的；去掉它会是 `TypeError: Cannot read properties of undefined`，
    //    一个指向量具而不指向被测对象的报错）。
    // ⚠️ 这里**故意**用 `designAssetIdFor(JOB2, 0)` 而不是 `writeAsset` 的返回值去定位行：
    //    「id 规则本身」由上面那条 `expect(assetId).toBe('wa-' + JOB)` 单独钉住，这里不必重复。
    const JOB2 = TAG + '-review';
    const [job2] = await db.insert(pmsBuiWenlvAssetJobs).values({
      id: JOB2, batchId: BATCH, assetType: 'narration', name: '评审列夹具', productId: PROD,
    }).returning();
    await writeAsset(job2, 'https://oss.test/nar2.mp3', {});
    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, designAssetIdFor(JOB2, 0))).limit(1);
    expect(row).toBeTruthy();
    expect(row.reviewScore).toBeNull();
    expect(row.reviewSource).toBeNull();
  });
});

// ── 纯函数块：不花钱、不需要库，但**真的有咬合力** ────────────────────────────
// 这是本片唯一承重的那个类型闸。为什么必须在这里补看守：
//   给旁白行补 `job_id` 之后，`reviewAssetJob` 开头那句 `if (!a?.jobId) return`
//   （`wenlv-asset-gen-scheduler.ts` 里）的**巧合性护栏**就不再挡旁白了 ——
//   而它自己上方的注释明说「这两条是巧合，不是设计」。真正拦住付费视觉调用的是
//   `POST /asset-gen/select` 的 `isReviewableType(job.assetType)`。
//   谁若把 'narration' 从排除表里删掉，`/select` 就会对一条 .mp3 发起一次视觉评审
//   —— 白花钱，且分数无参照语义。这正是「拆掉一个闸会暴露被它遮住的缺陷」的形状。
describe('isReviewableType：旁白必须不可评', () => {
  it('narration 不可评', () => {
    expect(isReviewableType('narration')).toBe(false);
  });

  it('anchor 不可评（同表的另一条，防有人整表重写时只补一半）', () => {
    expect(isReviewableType('anchor')).toBe(false);
  });

  it('图类仍**可**评 —— 阳性对照，证明上面两条不是因为函数恒返 false', () => {
    // 没有这一条，把 isReviewableType 改成 `return false` 也能让上面两条全绿。
    expect(isReviewableType('background')).toBe(true);
  });
});
