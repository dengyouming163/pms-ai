import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvNpcs, pmsBuiWenlvCharacters, pmsBuiWenlvAssetJobs } from '../../../db/schema/index.js';
import { eq, inArray } from 'drizzle-orm';
import type { WenlvStyleBible } from '../../../db/schema/wenlv.js';

/**
 * T15「NPC writeback gap」回归 —— admin /products/:id/npcs/generate 必须把 AI crew refine
 * 产出的 NPC upsert 到 `pms_bui_wenlv_npcs` 表（spec §5.5「每个 stage 完成即写表」）。
 *
 * ## 为什么打在 DB 行上而不是响应回显
 * 旧实现把 AI 响应裸透给前端（`return c.json({ success: true, data })`），PC 的 `load()`
 * 读不到新生成的 NPC —— 这是本 Task 修的洞。断言只看响应会漏掉「响应有字段、库里没行」
 * 这类回归（本仓前科：加列时漏写一个写入点，响应看着对、库里是 null）。故每条用例
 * 一律 `db.select()` 回来逐列单点断言，范式照抄 `wenlv-npcs.test.ts`。
 *
 * ## fetch 桩
 * AI crew 的 `/api/wenlv-creation/refine` 是同步阻塞调用 —— 用 `vi.stubGlobal('fetch', ...)`
 * 拦下来，回 `{status:'DRAFT_READY', output:{npcs:{schema_version, npcs:[...]}}}`（与
 * `wenlv_creation_crew.py` 的 `run_refine` 返回形状逐字对齐）。范式照抄
 * `wenlv-human-review.db.test.ts` 的 fetch 桩骨架。
 */
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const TAG = 'npcgen-' + Date.now();
const created: string[] = [];

const BIBLE: WenlvStyleBible = { artStyle: '水墨', forbidden: ['现代物件'] };

async function mkProd(suffix: string, opts: { bible?: WenlvStyleBible | null } = {}): Promise<string> {
  const id = `${TAG}-${suffix}`;
  await db.insert(pmsBuiWenlvProducts).values({
    id, name: 'NPC 生成夹具剧本',
    styleBible: opts.bible === undefined ? null : opts.bible,
  }).onConflictDoNothing();
  created.push(id);
  return id;
}

/** AI crew refine 响应桩 —— 镜像 `wenlv_creation_crew.py:run_refine` 的返回形状。 */
const refineResponse = (npcs: unknown[]) => ({
  status: 'DRAFT_READY',
  output: { npcs: { schema_version: 'w2.3.5', npcs } },
});

/** 一条合法的 AI 产 NPC（snake_case 键，对齐 WenlvNpc schema）。 */
const aiNpc = (over: Record<string, unknown> = {}) => ({
  id: 'NPC_test',
  name: '沈墨秋',
  role: 'npc',
  description: '神秘剑客',
  portrait_prompt: '水墨风，青衫',
  voice_id: 'male_young',
  character_id: null,
  lines: [{ id: 'l1', text: '你好' }],
  ...over,
});

const post = (path: string, body?: unknown) =>
  adminWenlvRoute.request(path, { method: 'POST', headers: H, body: body ? JSON.stringify(body) : undefined });

describe.skipIf(!process.env.RUN_DB)('wenlv NPC AI 生成写库（T15 fix §5.5）', () => {
  let baseFetch: any;
  let fetchImpl: any;

  beforeAll(() => {
    // fetch 桩默认 reject —— 用例必须显式 setResponse / setReject，防「忘配桩却 200」的假绿。
    fetchImpl = async () => { throw new Error('fetch 桩未配置'); };
    baseFetch = vi.fn((url: string, init?: any) => fetchImpl(url, init));
    vi.stubGlobal('fetch', baseFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (created.length) {
      // S2 入队的 asset_jobs 也要清掉 —— 按 productId 索引（asset_jobs.productId 有值）
      await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.productId, created));
      await db.delete(pmsBuiWenlvNpcs).where(inArray(pmsBuiWenlvNpcs.productId, created));
      await db.delete(pmsBuiWenlvCharacters).where(inArray(pmsBuiWenlvCharacters.productId, created));
      await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, created));
    }
  });

  beforeEach(() => { baseFetch.mockClear(); fetchImpl = async () => { throw new Error('fetch 桩未配置'); }; });

  // ─── 1. upsert 把 AI 产 NPC 写进 DB ───────────────────────────
  it('generate upserts NPCs to DB —— AI 返回的 NPC 经 /generate 落库，GET 能读到', async () => {
    const P = await mkProd('gen');
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({ id: `${TAG}-g1`, name: '沈墨秋' })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.generated).toBe(1);
    expect(body.data.inserted).toBe(1);
    expect(body.data.updated).toBe(0);
    // 承重：响应里有 NPC 不够 —— 必须断 DB 行真的在
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, `${TAG}-g1`)).limit(1);
    expect(row).toBeTruthy();
    expect(row.name).toBe('沈墨秋');
    expect(row.role).toBe('npc');
    expect(row.voiceId).toBe('male_young');
    // S1 不写 portraitUrl（S2 的活）—— 此处应为 null
    expect(row.portraitUrl).toBeNull();
    // lines 只含 id/text，S3 的 voiceUrl/duration 未填（normalizeNpcLines 落 null/undefined）
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0].id).toBe('l1');
    expect(row.lines[0].text).toBe('你好');
    expect(row.lines[0].voiceUrl).toBeNull();
  });

  // ─── 2. 相同 id 走 UPDATE：name 被改、orderId 不动 ───────────────
  it('generate UPDATEs existing NPC by id —— name 被改写、orderId 保留人工值', async () => {
    const P = await mkProd('upd');
    const id = `${TAG}-upd`;
    // 种子：人工 POST 一个 NPC（orderId=7，name='旧名'）。⚠️ 必须带 lines（R-N4：≥1 条），
    // 否则 POST 返 400、种子没落、下面 before 取不到行。
    await post(`/products/${P}/npcs`, {
      id, name: '旧名', order: 7, voiceId: 'v1',
      lines: [{ id: 'seed', text: '种子台词' }],
    });
    const [before] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(before.name).toBe('旧名');
    expect(before.orderId).toBe(7);
    // AI 返回相同 id、新 name
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({ id, name: '新名' })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.updated).toBe(1);
    expect(body.data.inserted).toBe(0);
    // 承重：name 被改写、orderId **不被 AI 重排**（spec §5.5：orderId 是人工管的）
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.name).toBe('新名');
    expect(after.orderId).toBe(7);
  });

  // ─── 3. 不删 AI 未提及的 NPC（spec §5.3）─────────────────────────
  it('generate does NOT delete NPCs absent from AI list —— 人工 NPC 不被静默丢弃', async () => {
    const P = await mkProd('keep');
    const xId = `${TAG}-keep-x`;
    const yId = `${TAG}-keep-y`;
    // 种子：两个 NPC。⚠️ 必须带 lines（R-N4：≥1 条），否则 POST 返 400、种子没落。
    const seedLine = { id: 'seed', text: '种子台词' };
    await post(`/products/${P}/npcs`, { id: xId, name: '保留X', voiceId: 'v1', lines: [seedLine] });
    await post(`/products/${P}/npcs`, { id: yId, name: '人工Y', voiceId: 'v1', lines: [seedLine] });
    // AI 只返回 X —— Y 是人工编辑过的、不得被静默丢弃（spec §5.3）
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({ id: xId, name: 'X 精修后' })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    // 承重：Y 仍在库（不被 AI 未提及就删）
    const [yRow] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, yId)).limit(1);
    expect(yRow).toBeTruthy();
    expect(yRow.name).toBe('人工Y');
    // X 被精修（name 改）
    const [xRow] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, xId)).limit(1);
    expect(xRow.name).toBe('X 精修后');
  });

  // ─── 4. R-N4：lines 为空 ⇒ 400 且一行都不落 ─────────────────────
  it('generate 400 on R-N4 violation (empty lines) —— 校验失败时杜绝半成品落库', async () => {
    const P = await mkProd('rN4');
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({ id: `${TAG}-rN4`, lines: [] })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC 至少要有 1 条台词');
    // 承重：校验失败 ⇒ 一行都不落（两段式：先全量校验、再统一 upsert）
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  // ─── 5. AI 返回空 NPC 列表 ⇒ 502 ────────────────────────────────
  it('generate 502 when AI returns empty npc list —— 无 NPC 可写时明确报错', async () => {
    const P = await mkProd('empty');
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ status: 'DRAFT_READY', output: { npcs: { npcs: [] } } }),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('AI 未返回 NPC 数据');
    // 库里没东西
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  // ─── 6. AI fetch 抛错 ⇒ 502 ─────────────────────────────────────
  it('generate 502 when AI fetch fails —— AI crew 不可达时给前端明确信号', async () => {
    const P = await mkProd('down');
    fetchImpl = async () => { const e = new Error('ECONNREFUSED'); (e as any).code = 'ECONNREFUSED'; throw e; };
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(502);
    const err = (await res.json()).error;
    expect(err).toContain('AI crew 不可达');
  });

  // ─── 7. lines merge：S1 重跑时保留旧 lines 的 voiceUrl/duration（spec §5.5 累积语义）
  //     仅当 line.id 相同且 text 未变时保留；text 变了 ⇒ 丢弃（TTS 过时）
  it('generate UPDATE preserves voiceUrl/duration for unchanged lines (spec §5.5 累积语义)', async () => {
    const P = await mkProd('merge');
    const id = `${TAG}-merge`;
    // 种子：人工 POST 一个 NPC（带 lines），再模拟 S3 已跑过（手动 PATCH voiceUrl/duration）
    await post(`/products/${P}/npcs`, {
      id, name: 'T3 种子', voiceId: 'v1',
      lines: [{ id: 'l1', text: '你好', voiceUrl: null }],
    });
    // 模拟 S3 已跑：手动 PATCH 把 voiceUrl/duration 写进 lines
    await db.update(pmsBuiWenlvNpcs).set({
      lines: [
        { id: 'l1', text: '你好', voiceUrl: 'https://example.com/l1.mp3', duration: 2.5 },
        { id: 'l2', text: '再见', voiceUrl: 'https://example.com/l2.mp3', duration: 1.8 },
      ],
    }).where(eq(pmsBuiWenlvNpcs.id, id));
    // AI S1 重跑：返回相同 id，lines 只含 id/text（S1 不产 voiceUrl/duration）
    // l1 text 不变、l2 text 变了、l3 是新 line
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({
        id,
        name: 'S1 重跑',
        lines: [
          { id: 'l1', text: '你好' },          // text 不变 ⇒ 保留 voiceUrl/duration
          { id: 'l2', text: '再见改了' },       // text 变了 ⇒ 丢弃 voiceUrl/duration
          { id: 'l3', text: '新台词' },         // 新 line ⇒ 无 TTS
        ],
      })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(row.lines).toHaveLength(3);
    // l1：text 不变，voiceUrl/duration 保留
    expect(row.lines[0].id).toBe('l1');
    expect(row.lines[0].text).toBe('你好');
    expect(row.lines[0].voiceUrl).toBe('https://example.com/l1.mp3');
    expect(row.lines[0].duration).toBe(2.5);
    // l2：text 变了，voiceUrl 被丢弃
    expect(row.lines[1].id).toBe('l2');
    expect(row.lines[1].text).toBe('再见改了');
    expect(row.lines[1].voiceUrl).toBeNull();
    // l3：新 line，无 TTS
    expect(row.lines[2].id).toBe('l3');
    expect(row.lines[2].text).toBe('新台词');
    expect(row.lines[2].voiceUrl).toBeNull();
  });

  // ─── 8. 跨产品 id 冲突：AI 给 B 生成已存在于 A 的 id ⇒ 400（非 500）
  it('generate 400 on cross-product id collision —— 全局 PK 冲突给前端可读错误', async () => {
    const PA = await mkProd('collA');
    const PB = await mkProd('collB');
    const collId = `${TAG}-collide`;
    // 在 PA 先种一个 NPC（用 collId）
    await post(`/products/${PA}/npcs`, {
      id: collId, name: '属于 A', voiceId: 'v1',
      lines: [{ id: 'seed', text: '种子' }],
    });
    // AI 给 PB 生成相同 id
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({ id: collId, name: '想插 B' })]),
      text: async () => '',
    });
    const res = await post(`/products/${PB}/npcs/generate`);
    expect(res.status).toBe(400);
    const err = (await res.json()).error;
    expect(err).toContain('冲突');
    // 承重：PB 没落下任何 NPC（半成品杜绝）
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, PB));
    expect(rows).toHaveLength(0);
    // PA 的 NPC 不受影响
    const [aRow] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, collId)).limit(1);
    expect(aRow.productId).toBe(PA);
  });

  // ─── 9. S2 立绘入队（T19 spec §5.4/§5.5）：generate 后 asset_jobs 多出 pending 行 ──
  // S1 upsert 之后，/generate 应当为每个有 portrait_prompt 的 NPC 调用 enqueueNpcPortrait，
  // 落一条 npc_portrait job（candidateCount=3, target_id=NPC id, sourceText=portrait_prompt）。
  // 承重：不只看响应回显的 portraitJobs，还断 DB 行真的在 pms_bui_wenlv_asset_jobs。
  it('generate enqueues npc_portrait jobs after upsert (S1→S2 flow, spec §5.4)', async () => {
    const P = await mkProd('s2ok', { bible: BIBLE });
    const npcId = `${TAG}-s2ok`;
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({
        id: npcId, name: '立绘测',
        portrait_prompt: '水墨风，青衫，半身像',
      })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(1);
    expect(body.data.portraitJobs).toHaveLength(1);
    expect(body.data.portraitJobs[0].npcId).toBe(npcId);
    expect(body.data.portraitJobs[0].batchId).toBeTruthy();
    expect(body.data.portraitJobs[0].jobId).toBeTruthy();
    // 承重：DB 行真的在
    const [job] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, body.data.portraitJobs[0].jobId)).limit(1);
    expect(job).toBeTruthy();
    expect(job.assetType).toBe('npc_portrait');
    expect(job.targetId).toBe(npcId);
    expect(job.targetKind).toBe('npc');
    expect(job.productId).toBe(P);
    expect(job.candidateCount).toBe(3);                    // spec §5.4
    expect(job.status).toBe('pending');                   // 入队即 pending
    expect(job.sourceText).toBe('水墨风，青衫，半身像');   // portrait_prompt 快照
  });

  // ─── 10. 多 NPC 批量入队：每个有 portrait_prompt 的 NPC 都入一条 job ──────
  it('generate enqueues portrait jobs for multiple NPCs in one batch', async () => {
    const P = await mkProd('s2batch', { bible: BIBLE });
    const idA = `${TAG}-s2batch-a`;
    const idB = `${TAG}-s2batch-b`;
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([
        aiNpc({ id: idA, name: '甲', portrait_prompt: '甲的立绘' }),
        aiNpc({ id: idB, name: '乙', portrait_prompt: '乙的立绘' }),
      ]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(2);
    expect(body.data.portraitJobs).toHaveLength(2);
    const ids = body.data.portraitJobs.map((j: any) => j.npcId).sort();
    expect(ids).toEqual([idA, idB].sort());
    // 两条 job 都在 DB（且分属不同 batchId —— 每个 NPC 独立 batch）
    const jobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(inArray(pmsBuiWenlvAssetJobs.targetId, [idA, idB]));
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map(j => j.batchId)).size).toBe(2); // 独立 batch
  });

  // ─── 11. S2 失败不阻断 S1（spec §5.5「每个 stage 完成即写表」） ──────────
  // 没风格基线 ⇒ loadNpcPortraitContext 返回 no_bible ⇒ S2 整批跳过。
  // S1 应当照常落库并 200 返回，portraitJobs 为空数组。
  it('generate returns 200 with S1 results when S2 skipped (no style bible, spec §5.5)', async () => {
    const P = await mkProd('s2fail'); // 不带 bible
    const npcId = `${TAG}-s2fail`;
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([aiNpc({
        id: npcId, name: '没基线',
        portrait_prompt: '水墨风，青衫',
      })]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(1);
    expect(body.data.portraitJobs).toEqual([]);
    // S1 落库了
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
    expect(row).toBeTruthy();
    expect(row.name).toBe('没基线');
    // 没有 asset job 行（S2 跳过）
    const jobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.targetId, npcId));
    expect(jobs).toHaveLength(0);
  });

  // ─── 12. NPC 没 portrait_prompt ⇒ 该 NPC 不入队（与 /portrait 同款守卫） ──
  it('generate skips portrait enqueue for NPCs without portrait_prompt', async () => {
    const P = await mkProd('s2noprompt', { bible: BIBLE });
    const withP = `${TAG}-s2noprompt-y`;
    const withoutP = `${TAG}-s2noprompt-n`;
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => refineResponse([
        aiNpc({ id: withP, name: '有 prompt', portrait_prompt: '水墨风' }),
        aiNpc({ id: withoutP, name: '无 prompt', portrait_prompt: null }),
      ]),
      text: async () => '',
    });
    const res = await post(`/products/${P}/npcs/generate`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(2);
    expect(body.data.portraitJobs).toHaveLength(1);
    expect(body.data.portraitJobs[0].npcId).toBe(withP);
    // 无 prompt 的 NPC 没有 job 行
    const jobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.targetId, withoutP));
    expect(jobs).toHaveLength(0);
  });
});
