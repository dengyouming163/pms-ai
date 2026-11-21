import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvProducts, pmsBuiWenlvNpcs, pmsBuiWenlvVenues,
} from '../../../db/schema/index.js';
import type { WenlvStyleBible } from '../../../db/schema/wenlv.js';

/**
 * T18「NPC 立绘 admin /portrait 路由」回归（spec §5.4 S2 stage）。
 *
 * ## 锚点
 * POST /npcs/:id/portrait 取 NPC.portrait_prompt，入队一条 npc_portrait job（candidateCount=3），
 * 立刻返回 { batchId, jobId, count }。**不直接 UPDATE portrait_url** —— 回写由 applyWriteback
 * 在候选被采纳时单点承担（spec §5.4「选定后回写 npc.portrait_url」）。
 *
 * ## 为什么打在 DB 行上而不是响应回显
 * 与 wenlv-npcs-generate.test.ts 同理由：响应有字段不等于 job 真的落库。本测试既断响应
 * 形状，也断 `pms_bui_wenlv_asset_jobs` 里真的多了一条 npc_portrait 行，且 target_id = NPC id。
 *
 * ## 不验 scheduler 真出图
 * scheduler 轮询 pending job + 调文生图 API + applyWriteback 是另一层（属 T19+ 集成范围）。
 * 本测试只钉「入队契约」：job 行的 assetType / targetId / targetKind / candidateCount / sourceText。
 */
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const TAG = 'npcportrait-' + Date.now();
const createdProducts: string[] = [];
const createdNpcs: string[] = [];
const createdVenues: string[] = [];

const BIBLE: WenlvStyleBible = { artStyle: '水墨', forbidden: ['现代物件'] };

async function mkProduct(suffix: string, opts: { withBible?: boolean; withVenue?: boolean } = {}): Promise<string> {
  const id = `${TAG}-${suffix}`;
  const venueId = opts.withVenue ? `${TAG}-venue-${suffix}` : null;
  if (venueId) {
    await db.insert(pmsBuiWenlvVenues).values({ id: venueId, name: '测试场地' }).onConflictDoNothing();
    createdVenues.push(venueId);
  }
  await db.insert(pmsBuiWenlvProducts).values({
    id, name: 'NPC 立绘夹具剧本',
    styleBible: opts.withBible === false ? null : BIBLE,
    venueId,
  }).onConflictDoNothing();
  createdProducts.push(id);
  return id;
}

async function mkNpc(productId: string, suffix: string, over: { portraitPrompt?: string | null } = {}): Promise<string> {
  const id = `${TAG}-npc-${suffix}`;
  await db.insert(pmsBuiWenlvNpcs).values({
    id, productId, orderId: 0, name: `NPC ${suffix}`,
    portraitPrompt: over.portraitPrompt === undefined ? '水墨风，青衫，半身像' : over.portraitPrompt,
    // WenlvNpcLine 类型要求 voiceUrl（与 wenlv-npcs-generate.test.ts 同款写法）
    lines: [{ id: 'l1', text: '你好', voiceUrl: null }],
  });
  createdNpcs.push(id);
  return id;
}

const post = (path: string, body?: unknown) =>
  adminWenlvRoute.request(path, { method: 'POST', headers: H, body: body ? JSON.stringify(body) : undefined });

describe.skipIf(!process.env.RUN_DB)('wenlv NPC 立绘 admin /portrait 路由（T18 §5.4 S2）', () => {
  beforeEach(async () => {
    // 每条用例前清掉本 TAG 造的 job 行（避免上一条残留干扰 count 断言）。
    if (createdNpcs.length > 0) {
      await db.delete(pmsBuiWenlvAssetJobs).where(inArray(pmsBuiWenlvAssetJobs.targetId, createdNpcs));
    }
  });

  afterAll(async () => {
    // 清掉本 TAG 造的 job 行（按 targetId 或 batchId prefix 双重保险）
    await db.delete(pmsBuiWenlvAssetJobs)
      .where(inArray(pmsBuiWenlvAssetJobs.targetId, createdNpcs.length > 0 ? createdNpcs : ['__none__']));
    if (createdNpcs.length > 0) {
      await db.delete(pmsBuiWenlvNpcs).where(inArray(pmsBuiWenlvNpcs.id, createdNpcs));
    }
    if (createdProducts.length > 0) {
      await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, createdProducts));
    }
    if (createdVenues.length > 0) {
      await db.delete(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, createdVenues));
    }
  });

  // ─── 1. NPC 不存在 ⇒ 404 ──────────────────────────────────────
  it('404 when NPC does not exist —— 不存在的 NPC id 给前端明确信号', async () => {
    const res = await post('/npcs/nonexistent-npc-id/portrait');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('NPC 不存在');
    // 库里没多出 job 行
    const jobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.targetId, 'nonexistent-npc-id'));
    expect(jobs).toHaveLength(0);
  });

  // ─── 2. portrait_prompt 为空 ⇒ 400 ─────────────────────────────
  it('400 when portraitPrompt is empty —— 没有提示词无法生成立绘', async () => {
    const P = await mkProduct('empty');
    const npcId = await mkNpc(P, 'empty', { portraitPrompt: null });
    const res = await post(`/npcs/${npcId}/portrait`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC 没有 portrait_prompt，无法生成立绘');
    // 库里没多出 job 行（校验失败 ⇒ 不入队）
    const jobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.targetId, npcId));
    expect(jobs).toHaveLength(0);
  });

  // ─── 3. portrait_prompt 是纯空白 ⇒ 400（trim 后为空）──────────
  it('400 when portraitPrompt is whitespace-only —— trim 后为空也算没填', async () => {
    const P = await mkProduct('ws');
    const npcId = await mkNpc(P, 'ws', { portraitPrompt: '   \t\n  ' });
    const res = await post(`/npcs/${npcId}/portrait`);
    expect(res.status).toBe(400);
  });

  // ─── 4. 剧本无风格基线 ⇒ 409（与 /batch 同款守卫）──────────────
  it('409 when product has no style bible —— 出图必须有基线（spec §8）', async () => {
    const P = await mkProduct('nobible', { withBible: false });
    const npcId = await mkNpc(P, 'nobible');
    const res = await post(`/npcs/${npcId}/portrait`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('风格基线');
    const jobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.targetId, npcId));
    expect(jobs).toHaveLength(0);
  });

  // ─── 5. 成功：200 + job 行真的落库 ─────────────────────────────
  it('200 + enqueues npc_portrait job with candidateCount=3, target_id=NPC id', async () => {
    const P = await mkProduct('ok');
    const npcId = await mkNpc(P, 'ok', { portraitPrompt: '水墨风，青衫，半身像，构图居中' });
    const res = await post(`/npcs/${npcId}/portrait`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.batchId).toBeTruthy();
    expect(body.data.jobId).toBeTruthy();
    expect(body.data.count).toBe(1);

    // 承重：断 DB 行真的在 —— 不只看响应回显
    const [job] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, body.data.jobId)).limit(1);
    expect(job).toBeTruthy();
    expect(job.assetType).toBe('npc_portrait');
    expect(job.targetId).toBe(npcId);
    expect(job.targetKind).toBe('npc');
    expect(job.productId).toBe(P);
    expect(job.candidateCount).toBe(3);                  // spec §5.4 候选数 3
    expect(job.status).toBe('pending');                 // 入队即 pending，由 scheduler 领
    // sourceText 快照 = portrait_prompt（轮询器从行上读它作画面描述）
    expect(job.sourceText).toBe('水墨风，青衫，半身像，构图居中');
    // 不补锚图（skipAnchorInsert: true）
    const anchorJobs = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.batchId, body.data.batchId));
    expect(anchorJobs.every(j => j.assetType !== 'anchor')).toBe(true);
  });

  // ─── 6. 候选数固定 3，不读 body.candidates ─────────────────────
  it('candidateCount is fixed at 3, body.candidates is ignored —— 与 spec §5.4 逐字对齐', async () => {
    const P = await mkProduct('cand');
    const npcId = await mkNpc(P, 'cand');
    // 传 candidates: 10 —— 应被忽略，仍按 spec §5.4 的 3 张
    const res = await post(`/npcs/${npcId}/portrait`, { candidates: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    const [job] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, body.data.jobId)).limit(1);
    expect(job.candidateCount).toBe(3);
  });
});
