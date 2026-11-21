import { describe, it, expect, afterAll } from 'vitest';
import wenlvDesignRoute, { assetTypes, assetSchema } from '../wenlv-design.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvDesignTemplates, pmsBuiWenlvDesignAssets, pmsBuiWenlvAssetJobs,
} from '../../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { designAssetIdFor, writeCandidate } from '../../../services/wenlv/asset-gen/candidate-store.js';
// service 的第 2 条写侧（调度器）。它此前**没有导出** —— 生产路径上唯一的调用点是
// `generateNarrationJob`，且那个调用点是无条件的，从外部钉不住「同一个 asset id 写两次
// ⇒ 走 update 支」这条链，故本 Task 给它加了 `export`（只加关键字，函数体未动）。
import { writeAsset } from '../../../services/wenlv-asset-gen-scheduler.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const TPL_ID = 'design-test-' + Date.now();

describe('wenlv 设计系统 admin 端点（守卫）', () => {
  it('无内部 token 返回 403', async () => {
    const res = await wenlvDesignRoute.request('/templates', { headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(403);
  });

  it('POST 缺 name 返回 400（zod 校验）', async () => {
    const res = await wenlvDesignRoute.request('/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ styleTag: 'guochao' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST 非法资产 type 返回 400（zod 枚举）', async () => {
    const res = await wenlvDesignRoute.request('/assets', {
      method: 'POST', headers: H,
      body: JSON.stringify({ type: 'invalid', name: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  // 与上一条是**一对**：上一条钉「清单外的被拒」，这条钉「清单内的被放行」。
  // 少了任何一条，「枚举写空」或「枚举放行一切」这两种错法都至少有一半是绿的。
  it('assetTypes 含 narration（数量契约 14 项）且 z.enum 放行，清单外仍拒', () => {
    const types: readonly string[] = assetTypes;
    expect(types).toContain('narration');
    expect(types).toHaveLength(14);

    // 正方向：`narration` 过一遍 assetSchema 不报错 —— POST /assets 的守卫就是这一步
    // （`wenlv-design.ts` 的 `assetSchema.safeParse`，失败即 400）。
    expect(assetSchema.safeParse({
      type: 'narration', name: '点位旁白', url: 'https://oss.example/node-1.mp3',
    }).success).toBe(true);

    // 反方向对照（否则「枚举放行一切」的错误实现也会绿）：`anchor` 是**真实存在于库里**的类型
    // （调度器 `writeAsset` 直写，绕过本枚举），但**不在**本清单里 ⇒ 今天的行为是被拒。
    // 这条锁的是「清单边界」本身：要收放某个类型，请连同本用例一起改。
    expect(assetSchema.safeParse({ type: 'anchor', name: '锚图' }).success).toBe(false);
  });

  // T17：npc_portrait（NPC 立绘，spec §5.4 S2 stage）于 2026-09-29 补入本清单。
  // 与上一条分工：上一条钉 narration + 数量契约 + 反方向；本条钉 npc_portrait 的正方向
  // （含 z.enum 放行），与上一条 narration 的正方向断言**严格同构**。
  it('npc_portrait is registered in asset type whitelist', () => {
    const types: readonly string[] = assetTypes;
    expect(types).toContain('npc_portrait');

    // 正方向：`npc_portrait` 过一遍 assetSchema 不报错 —— POST /assets 的守卫就是这一步。
    expect(assetSchema.safeParse({
      type: 'npc_portrait', name: 'NPC 立绘', url: 'https://oss.example/npc-1.png',
    }).success).toBe(true);
  });

  // T22：npc_voice（NPC 旁白 TTS，spec §5.4 S3 stage）于 2026-09-29 补入本清单。
  // 与上一条 npc_portrait 同构：钉 npc_voice 的正方向（含 z.enum 放行）。
  it('npc_voice is registered in asset type whitelist', () => {
    const types: readonly string[] = assetTypes;
    expect(types).toContain('npc_voice');

    // 正方向：`npc_voice` 过一遍 assetSchema 不报错 —— POST /assets 的守卫就是这一步。
    expect(assetSchema.safeParse({
      type: 'npc_voice', name: 'NPC 旁白', url: 'https://oss.example/npc-1-line1.mp3',
    }).success).toBe(true);
  });

  it('PATCH 资产 meta 为 null 返回 400（拒绝 null，防 NOT NULL 违反致 500）', async () => {
    const res = await wenlvDesignRoute.request('/assets/any-id', {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ meta: null }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH 模板 tokens 为 null 返回 400（拒绝 null，防 NOT NULL 违反致 500）', async () => {
    const res = await wenlvDesignRoute.request('/templates/any-id', {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ tokens: null }),
    });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!process.env.RUN_DB)('wenlv 设计系统 admin 端点（DB 冒烟）', () => {
  it('建模板返回 isBuiltin=false 默认字段', async () => {
    const res = await wenlvDesignRoute.request('/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: TPL_ID, name: '国潮测试', styleTag: 'guochao', tokens: { radius: 8 } }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.isBuiltin).toBe(false);
    expect(b.data.tokens.radius).toBe(8);
  });

  it('GET /templates 列表返回新模板', async () => {
    const res = await wenlvDesignRoute.request('/templates', { headers: H });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.list.some((t: any) => t.id === TPL_ID)).toBe(true);
  });

  const TPL_ID_2 = 'design-test-2-' + Date.now();
  const BID = 'design-builtin-' + Date.now();

  it('PATCH 修改字段且 isBuiltin 被剥离不被改写', async () => {
    await wenlvDesignRoute.request('/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: TPL_ID_2, name: '原名', styleTag: 'guochao', tokens: {} }),
    });
    const patch = await wenlvDesignRoute.request('/templates/' + TPL_ID_2, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ name: '新名', isBuiltin: true }),
    });
    expect(patch.status).toBe(200);
    const pb = await patch.json();
    expect(pb.data.name).toBe('新名');
    expect(pb.data.isBuiltin).toBe(false); // isBuiltin 被 strip，仍为 false
  });

  it('PATCH 不存在的 id 返回 404', async () => {
    const res = await wenlvDesignRoute.request('/templates/not-exist-' + Date.now(), {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE 内置模板返回 409', async () => {
    await wenlvDesignRoute.request('/templates', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: BID, name: '内置', styleTag: 'guochao', isBuiltin: true }),
    });
    const del = await wenlvDesignRoute.request('/templates/' + BID, { method: 'DELETE', headers: H });
    expect(del.status).toBe(409);
  });

  it('DELETE 不存在的 id 返回 404', async () => {
    const res = await wenlvDesignRoute.request('/templates/not-exist-' + Date.now(), { method: 'DELETE', headers: H });
    expect(res.status).toBe(404);
  });

  const ASSET_ID = 'design-asset-' + Date.now();
  const ASSET_BID = 'design-asset-builtin-' + Date.now();

  it('建资产并可按 type 筛选', async () => {
    const create = await wenlvDesignRoute.request('/assets', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: ASSET_ID, type: 'stamp', styleTag: 'guochao', name: '龙纹印章', meta: { shape: 'circle' } }),
    });
    expect(create.status).toBe(200);
    expect((await create.json()).data.type).toBe('stamp');

    const list = await wenlvDesignRoute.request('/assets?type=stamp', { headers: H });
    const lb = await list.json();
    expect(lb.data.list.some((a: any) => a.id === ASSET_ID)).toBe(true);
  });

  it('PATCH 资产 isBuiltin 被剥离不被改写', async () => {
    const patch = await wenlvDesignRoute.request('/assets/' + ASSET_ID, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ name: '新印章', isBuiltin: true }),
    });
    expect(patch.status).toBe(200);
    const pb = await patch.json();
    expect(pb.data.isBuiltin).toBe(false);
  });

  it('DELETE 内置资产返回 409', async () => {
    await wenlvDesignRoute.request('/assets', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: ASSET_BID, type: 'mascot', name: '内置 IP', isBuiltin: true }),
    });
    const del = await wenlvDesignRoute.request('/assets/' + ASSET_BID, { method: 'DELETE', headers: H });
    expect(del.status).toBe(409);
  });

  // ===== productId 过滤（素材库视图新增，2026-09-14）=====
  // 夹具**故意含两个产品**：只断言「含目标行」的话，过滤整个失效时用例照样绿
  // （那正是本仓「守卫文案与条件不一致」「死断言」同族的失效模式）。
  const PROD_A = 'design-prod-a-' + Date.now();
  const PROD_B = 'design-prod-b-' + Date.now();
  const ASET_A = 'design-aset-a-' + Date.now();
  const ASET_B = 'design-aset-b-' + Date.now();
  const ASET_C = 'design-aset-c-' + Date.now();

  it('productId 过滤只回该产品的行，不含另一个产品的行', async () => {
    const mk = (id: string, pid: string) => wenlvDesignRoute.request('/assets', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id, type: 'background', name: '过滤夹具 ' + id, meta: { productId: pid, iteration: 1 } }),
    });
    expect((await mk(ASET_A, PROD_A)).status).toBe(200);
    expect((await mk(ASET_B, PROD_B)).status).toBe(200);

    const ids = (await (await wenlvDesignRoute.request('/assets?productId=' + PROD_A, { headers: H })).json())
      .data.list.map((a: any) => a.id);
    expect(ids).toContain(ASET_A);
    expect(ids).not.toContain(ASET_B); // 这条才是承重的那条
  });

  it('productId 与 type 组合是 and 语义', async () => {
    const ids = (await (await wenlvDesignRoute.request('/assets?type=background&productId=' + PROD_B, { headers: H })).json())
      .data.list.map((a: any) => a.id);
    expect(ids).toContain(ASET_B);
    expect(ids).not.toContain(ASET_A);
  });

  it('不传 productId 时行为不变：带 meta.productId 的行照常出现', async () => {
    // 与「建资产并可按 type 筛选」那条的分工：那条建的资产恰好**没有** meta.productId，
    // 这条补的是另一面 —— 加了参数之后，老路径不能被悄悄改成「只回有 productId 的行」。
    // ⚠️ productId 的过滤源已于 C6 从 `meta->>'productId'` 切到真列 `product_id`。
    // 本用例钉的是「**不传**参数时不得变成只回有 productId 的行」—— 与过滤源无关，故仍成立；
    // 但它引用的夹具行仍靠 meta 识别，故夹具保留 meta.productId 的双写。
    const ids = (await (await wenlvDesignRoute.request('/assets?type=background', { headers: H })).json())
      .data.list.map((a: any) => a.id);
    expect(ids).toContain(ASET_A);
    expect(ids).toContain(ASET_B);
  });

  // ===== C6：过滤源从 `meta->>'productId'` 切到真列 `product_id`（Task C6）=====
  // 🔴 这两条夹具**必须** `db.insert` **直插库**，且**故意让真列与 meta 不一致**：
  //    C2 之后「列 ← meta.productId」是**服务端派生**的（`POST /assets` 与
  //    `PATCH /assets/:id` 都会重新推一遍）⇒ 经 API 造出来的行两处**恒相等**，
  //    切换前后都绿、用例零判别力（本仓前科：判别力是「被测对象全集」的函数）。
  const ASET_COLUMN_ONLY = 'design-aset-col-' + Date.now();  // 真列=PROD_A，meta.productId=PROD_B
  const ASET_META_ONLY   = 'design-aset-meta-' + Date.now(); // meta.productId=PROD_A，真列=NULL

  it('productId 过滤读的是真列 product_id，不是 meta', async () => {
    // 🔴 本用例钉住切换本身。反例（把查询改回 meta->>'productId'）：
    //    真列与 meta 不一致的行会被错误地纳入 / 漏掉。
    //    故夹具必须造一条**两者不一致**的行 —— 否则两种实现都能通过，用例没有判别力。
    // `id` / `type` / `name` 是**无默认值的 NOT NULL**（`schema/wenlv.ts` 的
    // `pmsBuiWenlvDesignAssets`），少一个就是 23502；`productId` 是 C1 新加的**可空**列。
    await db.insert(pmsBuiWenlvDesignAssets).values([
      { id: ASET_COLUMN_ONLY, type: 'background', name: 'col-only',
        productId: PROD_A, meta: { productId: PROD_B } },
      { id: ASET_META_ONLY, type: 'background', name: 'meta-only',
        productId: null,   meta: { productId: PROD_A } },
    ]);

    const ids = (await (await wenlvDesignRoute.request(`/assets?productId=${PROD_A}`, { headers: H })).json())
      .data.list.map((a: any) => a.id);
    expect(ids).toContain(ASET_COLUMN_ONLY); // 真列=PROD_A，meta.productId=PROD_B
    expect(ids).not.toContain(ASET_META_ONLY); // meta.productId=PROD_A，真列=null
  });

  // 与「productId 过滤」三连的分工：那三条钉**读**侧（过滤源已于 C6 切到真列 `product_id`），
  // 这条钉**写**侧 —— 列与 meta **双写**。C1 建了列、C6 才切查询源，
  // 中间这段窗口里若没人写列，C6 一切过去就是**空列表**（且会被误判成「生成没成功」）。
  it('新建素材把 productId 同时写进真列与 meta（双写，不只 meta）', async () => {
    const res = await wenlvDesignRoute.request('/assets', {
      method: 'POST', headers: H,
      body: JSON.stringify({ id: ASET_C, type: 'background', name: 'C2 写侧夹具', meta: { productId: PROD_A, iteration: 1 } }),
    });
    expect(res.status).toBe(200);

    // 断言打在**数据库行**上，不是响应回显上 —— 回显可能来自内存对象，不等于落了库。
    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, ASET_C)).limit(1);
    expect(row.productId).toBe(PROD_A);                        // ① 真列
    expect((row.meta as any)?.productId).toBe(PROD_A);         // ② meta 那份**没有**被搬家搬掉
  });

  // 与上面那条的分工：上面只走 `POST /assets`（路由），而路由是第三条写侧；
  // service 的两条写侧（`candidate-store.writeCandidate` 的 upsert 支、
  // `scheduler.writeAsset` 的 update 支）它一条也钉不住 —— 现在这两支是靠
  // 「两支共用同一份 `values`」**结构性**排除失效的，**不是测试守住的**。
  // 本条钉 writeCandidate 的**重跑（upsert）支**：若后人把 `productId` 挪进 insert 支、
  // `values` 里漏了它，第二次写就不会更新该列，这里会停在 `PROD_A`。
  const C2B_JOB_ID = 'c2b-rerun-' + Date.now();
  const C2B_ID = designAssetIdFor(C2B_JOB_ID, 0);   // index 0 ⇒ `wa-<jobId>`，与生产同一函数算

  it('writeCandidate 重跑（upsert 支）仍写 product_id 列，不只 insert 支', async () => {
    await writeCandidate({ jobId: C2B_JOB_ID, index: 0, assetType: 'background', name: 'rerun-a',
      url: 'https://oss.test/r0.png', productId: PROD_A, venueId: null, iteration: 1,
      communityStyleTag: null, target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: true });
    await writeCandidate({ jobId: C2B_JOB_ID, index: 0, assetType: 'background', name: 'rerun-b',
      url: 'https://oss.test/r1.png', productId: PROD_B, venueId: null, iteration: 1,
      communityStyleTag: null, target: { targetKind: null, targetId: null },
      extraMeta: {}, isSelected: true });
    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, C2B_ID)).limit(1);
    expect(row.productId).toBe(PROD_B);                  // 挪进 insert 支 ⇒ 停在 PROD_A
    expect((row.meta as any)?.productId).toBe(PROD_B);   // 双写另一半同步
    // ⚠️ 上一行断言失败时本行不会执行 ⇒ 残留行由 afterAll 兜底删（本仓前科：清理漏了会静默堆积）
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, C2B_ID));
  });

  // 与上一条的分工：上一条钉 `writeCandidate`（service 写侧①，**upsert 支**）；
  // 本条钉 `writeAsset`（service 写侧②，**update 支**）—— 计划 Task C2b 原文说的
  // 「两个写侧判别力为 0」的第 2 个，C2b 只收了第 1 个。
  //
  // 手法与上一条**严格同构**：对**同一个 asset id** 连写两次、两次 `productId` 不同。
  //   第一次 `exist` 查不到 ⇒ **insert 支**；第二次同一个 id ⇒ **update 支**
  //   （`set: { ...values, updatedAt }`，见 scheduler.ts 的 writeAsset）。
  // 若后人把 `productId: job.productId,` 从 `values` 挪进 insert 支 ⇒ 第二次**省略**该列
  // ⇒ 真值是「**保留旧值**」⇒ 停在 `PROD_A` ⇒ 本用例红。
  //
  // update 支**可达**，不是纸面路径：`writeAsset` 的 id 只由 `job.id` 决定，
  // 而 `POST /retry` 是**复用同一行**（`set({ status: 'pending', startedAt: null, … })`
  // 打在同一 jobId 上）⇒ 调度器再领到同一个 job id ⇒ 同一条 job 被处理第二次。
  // ⚠️ 不要写成「`reclaimStale` 会重新领取」—— 实测 `services/wenlv/asset-gen/claim.ts`
  //   的 `reclaimStale` 只把超时的 running 行**置为 failed**（`errorMessage: '超时未返回…'`），
  //   **不重新领取**。写成「重新领取」会让后人按错的机制去推导别的结论。
  const C2C_JOB_ID = 'c2c-writeasset-' + Date.now();   // 28 字符 ⇒ 下面那句截断是 no-op
  const C2C_ID = 'wa-' + C2C_JOB_ID;                   // = writeAsset 的 designAssetIdFor(jobId, 0)（index 0 无后缀）
  const C2C_BATCH = 'c2c-batch-' + Date.now();

  it('writeAsset 重跑（update 支）仍写 product_id 列，不只 insert 支', async () => {
    // `job` 参数（生产中叫 `WenlvJobRow` = `pmsBuiWenlvAssetJobs` 的整行类型）**用真行造**，
    // 不硬凑字面量：该表 NOT NULL 且**无默认值**的列只有 id / batch_id / asset_type / name
    // 这 4 列，其余（iteration / status / cost_amount / style_bible_snapshot / created_at …）
    // 都有默认值 ⇒ `.returning()` 回来的行类型与运行期都完整，**不需要 `as any`**。
    //
    // assetType 取 `narration`：生产路径上 `writeAsset` **只有** `generateNarrationJob`
    // 一个调用点（图类走 `writeCandidate`），这是本函数真实在跑的类型。
    const [jobA] = await db.insert(pmsBuiWenlvAssetJobs).values({
      id: C2C_JOB_ID, batchId: C2C_BATCH, assetType: 'narration',
      name: 'C2c 写侧夹具', productId: PROD_A, venueId: null,
    }).returning();

    await writeAsset(jobA, 'https://oss.test/c2c-0.mp3', {});                    // 第一次：insert 支
    // 第二次：**同一个 job、不同的 productId** —— 这一行是本用例的核心手法，
    // 它是「同一条 job 被重跑、且这次拿到的归属与上次不同」的最小复现。
    await writeAsset({ ...jobA, productId: PROD_B }, 'https://oss.test/c2c-1.mp3', {});

    // 断言打在**数据库行**上，不是返回值上 —— 返回值只是 assetId，看不出列有没有被更新。
    const [row] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, C2C_ID)).limit(1);
    expect(row.productId).toBe(PROD_B);                  // 挪进 insert 支 ⇒ 停在 PROD_A
    expect(row.meta.productId).toBe(PROD_B);             // 双写另一半同步（meta 是 notNull 的 jsonb，无需裸化）
    // ⚠️ 上一行断言失败时本行不会执行 ⇒ 夹具行由 afterAll 兜底删（与上一条同一前科）
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, C2C_ID));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.id, C2C_JOB_ID));
  });

  // ===== 「用在」列（Task C5）=====
  // 数据源是 **`design_assets` 自己的 `target_kind` / `target_id` 两列**（迁移 0038）——
  // 「这份素材是**为了谁**生成的」。
  //
  // ⚠️ 0038 之前这里的数据源是 `asset_jobs.targetKind` / `targetId`（由 `GET /assets` 按
  //    `jobId` 批量回查补进结果）。0038 把坐标**下沉到了素材行**，那段补查随之删掉 ⇒
  //    本组断言的语义已从「产出它的 job 的坐标」变成「素材行自身的坐标」。
  //
  // 🔴 本组**必须自带夹具**，不能拿上面的 `ASET_A` 来断：`ASET_A` 由 `POST /assets` 建
  //    （上面的 `mk` 夹具），**请求体里没有 `jobId`**，而 `POST /assets` 的
  //    `db.insert(…).values({…})` 也不写 `jobId` ⇒ 那一行的 `jobId` 恒为 null、
  //    `targetKind` 必然是 `null` 而不是 `'node'`。拿它断会红成「实现没写对」。
  const USAGE_JOB   = 'design-usage-job-' + Date.now();
  const USAGE_BATCH = 'design-usage-batch-' + Date.now();
  const USET_A      = 'design-usage-a-' + Date.now();   // 有 jobId
  const USET_B      = 'design-usage-b-' + Date.now();   // 无 jobId（手建/公共池形态）
  const USAGE_TARGET_ID = 'NODE_X';                     // job 侧的坐标（**故意**与素材行不同）
  const USET_A_TARGET_ID = 'ENDING_X';                  // 素材行侧的坐标，理由见夹具注释

  it('GET /assets 每行带上素材行自身的 targetKind / targetId', async () => {
    // 🔴 「用在」列的数据源。没有它，前端只能靠猜或靠扫列反推 ——
    //    而 targetKind='product'（风格基线/评审，合成行无产物）根本没法反推。
    // ⚠️ 必须先插 job 行再插 asset 行：asset.jobId 是索引键，不依赖外键约束。
    await db.insert(pmsBuiWenlvAssetJobs).values({
      // ⚠️ `batchId` / `assetType` / `name` 是**无默认值的 NOT NULL**
      //    （`schema/wenlv.ts` 的 `pmsBuiWenlvAssetJobs`），少一个就是 23502。
      //    `status` / `productId` 都有默认值或可空 —— 写它们是为了语义（标成功、挂到产品上）。
      id: USAGE_JOB, batchId: USAGE_BATCH, productId: PROD_A,
      assetType: 'background', name: '用在夹具 job',
      targetKind: 'node', targetId: USAGE_TARGET_ID, status: 'succeeded',
    });
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: USET_A, type: 'background', name: '用在夹具', url: 'https://x/u.png',
      jobId: USAGE_JOB, productId: PROD_A, meta: { productId: PROD_A },   // 真列与 meta 双写（C6 起查询源是真列）
      // 🔴 坐标**故意与上面那条 job 不同**（job 是 node/NODE_X，这里是 ending/ENDING_X）：
      //    两者写成一致时，「读素材行自己的列」与「按 jobId 回查 job」这两种实现给出同一个
      //    答案 ⇒ 本用例零点判别力，补查删没删都是绿。分歧夹具是唯一能钉住「坐标来源已换」的手段。
      //    别把这里「修」成与 job 一致 —— 那会把本用例变成永远绿。
      targetKind: 'ending', targetId: USET_A_TARGET_ID,
    });
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: USET_B, type: 'background', name: '公共池夹具', url: 'https://x/v.png',
      productId: PROD_A, meta: { productId: PROD_A },   // 同上：公共池素材**也有** productId，只写 meta 会让真列落 NULL
    });

    const list = (await (await wenlvDesignRoute.request('/assets', { headers: H })).json()).data.list;
    const a = list.find((x: any) => x.id === USET_A);
    // 坐标来自**素材行自身**（`design_assets.target_kind` / `target_id`），与产出它的 job 的
    // `targetKind` / `targetId` **无关** —— 上面夹具故意把两者写成了不同的值。
    expect(a.targetKind).toBe('ending');
    expect(a.targetId).toBe(USET_A_TARGET_ID);
  });

  it('没有 jobId 的素材（内置/公共池）target 两字段为 null，不报错', async () => {
    const list = (await (await wenlvDesignRoute.request('/assets', { headers: H })).json()).data.list;
    const b = list.find((x: any) => x.id === USET_B);
    expect(b.targetKind).toBeNull();
    expect(b.targetId).toBeNull();
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, TPL_ID));
    await db.delete(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, TPL_ID_2));
    await db.delete(pmsBuiWenlvDesignTemplates).where(eq(pmsBuiWenlvDesignTemplates.id, BID));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASSET_ID));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASSET_BID));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASET_A));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASET_B));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASET_C));
    // C6 的两条**不一致**夹具（断言失败时它们仍留在库里；不删会静默堆积）
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASET_COLUMN_ONLY));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, ASET_META_ONLY));
    // C2b 用例失败时它自带的 delete 不会执行 ⇒ 这里兜底（删 0 行是幂等的）
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, C2B_ID));
    // C2c 同上：素材行与 job 夹具行都要兜底（job 行也留在库里就是残留）
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, C2C_ID));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.id, C2C_JOB_ID));
    // C5 的「用在」夹具：先删素材再删 job（与插入时相反的顺序）
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, USET_A));
    await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, USET_B));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.id, USAGE_JOB));
  });
});
