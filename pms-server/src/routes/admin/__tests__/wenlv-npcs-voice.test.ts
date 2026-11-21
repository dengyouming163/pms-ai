import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvNpcs } from '../../../db/schema/index.js';
import { uploadToOSS } from '../../../services/aliyun/oss.js';
import type { WenlvNpcLine } from '../../../db/schema/wenlv.js';

/**
 * T25「NPC 旁白 TTS admin /voice 路由」回归（spec §5.5 S3 stage）。
 *
 * ## 锚点
 * POST /npcs/:id/voice 调 AI crew 的 run_refine(stage='npc_voice')，S3 返回每条 line 的
 * audio_base64。本路由 decode base64 → 转存 OSS → 把 voiceUrl/duration 回写进该 NPC 行的
 * lines JSONB。?line_id=l1 只回写该条 line（其余原样保留）。
 *
 * ## 为什么打在 DB 行上
 * 与 wenlv-npcs-generate.test.ts 同理由：响应有字段不等于 lines 真的回写。本测试既断响应
 * 形状，也断 `pms_bui_wenlv_npcs.lines` 里 voiceUrl/duration 真的落了。
 *
 * ## fetch 桩 + OSS mock
 * AI crew 的 `/api/wenlv-creation/refine` 同步阻塞调用 —— 用 vi.stubGlobal('fetch', ...) 拦下，
 * 回 S3 形状的 `{status:'DRAFT_READY', output:{npcs:[{npc_id, lines:[...]}]}}`。OSS 转存用
 * vi.mock 把 uploadToOSS 替成桩（测试环境无 ALIYUN 凭据，真转存会抛），范式照抄
 * wenlv-npcs-generate.test.ts 的 fetch 桩骨架。
 */
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const TAG = 'npcvoice-' + Date.now();
const created: string[] = [];

async function mkProd(suffix: string): Promise<string> {
  const id = `${TAG}-${suffix}`;
  await db.insert(pmsBuiWenlvProducts).values({
    id, name: 'NPC 语音夹具剧本',
  }).onConflictDoNothing();
  created.push(id);
  return id;
}

async function mkNpc(
  productId: string, suffix: string,
  over: { lines?: WenlvNpcLine[] } = {},
): Promise<string> {
  const id = `${TAG}-npc-${suffix}`;
  await db.insert(pmsBuiWenlvNpcs).values({
    id, productId, orderId: 0, name: `NPC ${suffix}`,
    lines: over.lines ?? [
      { id: 'l1', text: '你好', voiceUrl: null },
      { id: 'l2', text: '再见', voiceUrl: null },
    ],
  });
  created.push(id);
  return id;
}

/** S3 stage 响应桩 —— 镜像 T24 run_refine(stage='npc_voice') 的返回形状。 */
const s3Response = (npcId: string, lines: Array<Record<string, unknown>>) => ({
  status: 'DRAFT_READY',
  output: { npcs: [{ npc_id: npcId, lines }] },
});

/** 一条 S3 line（snake_case 键，对齐 T24 输出契约）。 */
const s3Line = (over: Record<string, unknown> = {}) => ({
  line_id: 'l1',
  voiceUrl: '',
  duration: 2.5,
  audio_base64: Buffer.from('fake-audio-bytes').toString('base64'),
  voice_hash: 'sha256-fake',
  skipped: false,
  error: null,
  ...over,
});

const post = (path: string, body?: unknown) =>
  adminWenlvRoute.request(path, { method: 'POST', headers: H, body: body ? JSON.stringify(body) : undefined });

// vi.mock 必须在顶层（hoisted）。OSS 模块的 uploadToOSS 替成桩 —— 测试环境无 ALIYUN 凭据，
// 不 mock 会 getOSSConfig() 直接抛（ACCESS_KEY 在模块加载期捕获为 ''）。
vi.mock('../../../services/aliyun/oss.js', () => ({
  uploadToOSS: vi.fn(),
  getOSSBaseUrl: () => 'https://pms-zhisu.oss-cn-beijing.aliyuncs.com',
  getOSSUrl: (f: string) => `https://pms-zhisu.oss-cn-beijing.aliyuncs.com/${f}`,
  OSS_UPLOAD_TIMEOUT_MS: 300000,
}));

// vi.mock 替换后的 uploadToOSS 是 Mock，但导入侧类型仍是真签名。cast 成 any 访问 mock 方法
// （与 wenlv-npcs-generate.test.ts 的 `let baseFetch: any` 同款 —— 该仓 vitest 类型不含 vi.mocked）。
const ossUpload = uploadToOSS as unknown as ReturnType<typeof vi.fn>;

describe.skipIf(!process.env.RUN_DB)('wenlv NPC 旁白 admin /voice 路由（T25 §5.5 S3）', () => {
  let baseFetch: any;
  let fetchImpl: any;

  beforeAll(() => {
    // fetch 桩默认 reject —— 防「忘配桩却 200」的假绿（与 wenlv-npcs-generate.test.ts 同款）。
    fetchImpl = async () => { throw new Error('fetch 桩未配置'); };
    baseFetch = vi.fn((url: string, init?: any) => fetchImpl(url, init));
    vi.stubGlobal('fetch', baseFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (created.length) {
      await db.delete(pmsBuiWenlvNpcs).where(inArray(pmsBuiWenlvNpcs.productId, created));
      await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, created));
    }
  });

  beforeEach(() => {
    baseFetch.mockClear();
    fetchImpl = async () => { throw new Error('fetch 桩未配置'); };
    ossUpload.mockReset();
  });

  // ─── 1. 全量合成：两条 line 都拿到音频 → voiceUrl/duration 全回写 ──────
  it('voice writes voiceUrl/duration for all lines —— 全量合成后 DB 行真的回写', async () => {
    const P = await mkProd('full');
    const npcId = await mkNpc(P, 'full');
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => s3Response(npcId, [
        s3Line({ line_id: 'l1', duration: 2.5 }),
        s3Line({ line_id: 'l2', duration: 1.8, audio_base64: Buffer.from('l2-audio').toString('base64') }),
      ]),
      text: async () => '',
    });
    ossUpload.mockImplementation(async () => `https://oss.example.com/${Date.now()}.mp3`);
    const res = await post(`/npcs/${npcId}/voice`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.lines).toHaveLength(2);
    // 承重：DB 行的 lines 真的回写了 voiceUrl/duration
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
    const byId = new Map(row.lines.map((l) => [l.id, l]));
    expect(byId.get('l1')!.voiceUrl).toMatch(/^https:\/\/oss\.example\.com\//);
    expect(byId.get('l1')!.duration).toBe(2.5);
    expect(byId.get('l2')!.voiceUrl).toMatch(/^https:\/\/oss\.example\.com\//);
    expect(byId.get('l2')!.duration).toBe(1.8);
    // uploadToOSS 被调了两次（每条 line 一次）
    expect(ossUpload).toHaveBeenCalledTimes(2);
  });

  // ─── 2. 单条重生成 ?line_id=l1：只回写 l1，l2 不被误伤 ─────────────────
  it('voice ?line_id=l1 only updates that line —— l2 的既有 voiceUrl 不被擦除', async () => {
    const P = await mkProd('single');
    const npcId = await mkNpc(P, 'single', {
      lines: [
        { id: 'l1', text: '你好', voiceUrl: null },
        // l2 已有 S3 产物 —— 不应被本次单条重生成触碰
        { id: 'l2', text: '再见', voiceUrl: 'https://keep.example.com/l2.mp3', duration: 1.8 },
      ],
    });
    fetchImpl = async () => ({
      ok: true, status: 200,
      // S3 仍全量返回两条 line，但本路由只回写 ?line_id 命中的 l1
      json: async () => s3Response(npcId, [
        s3Line({ line_id: 'l1', duration: 3.0 }),
        s3Line({ line_id: 'l2', duration: 9.9, audio_base64: Buffer.from('l2-new').toString('base64') }),
      ]),
      text: async () => '',
    });
    ossUpload.mockResolvedValue('https://oss.example.com/l1-new.mp3');
    const res = await post(`/npcs/${npcId}/voice?line_id=l1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lineId).toBe('l1');
    expect(body.data.lines).toHaveLength(1); // 响应只含被处理的 line
    expect(body.data.lines[0].lineId).toBe('l1');
    // 承重：l1 回写了新值，l2 保持原样（voiceUrl/duration 未动）
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
    const byId = new Map(row.lines.map((l) => [l.id, l]));
    expect(byId.get('l1')!.voiceUrl).toBe('https://oss.example.com/l1-new.mp3');
    expect(byId.get('l1')!.duration).toBe(3.0);
    expect(byId.get('l2')!.voiceUrl).toBe('https://keep.example.com/l2.mp3');
    expect(byId.get('l2')!.duration).toBe(1.8);
    // 只转存了 l1 一条（l2 即便 S3 返回了音频也不转存）
    expect(ossUpload).toHaveBeenCalledTimes(1);
  });

  // ─── 3. S3 失败容忍：某 line audio_base64 为空 → 不清空既有 voiceUrl ────
  it('voice tolerates S3 failure —— 失败的 line 保留既有 voiceUrl，整批仍 200', async () => {
    const P = await mkProd('fail');
    const npcId = await mkNpc(P, 'fail', {
      lines: [
        // l1 还没合成过
        { id: 'l1', text: '你好', voiceUrl: null },
        // l2 已经合成过（既有产物不应被 S3 失败擦除）
        { id: 'l2', text: '再见', voiceUrl: 'https://keep.example.com/l2.mp3', duration: 1.8 },
      ],
    });
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => s3Response(npcId, [
        s3Line({ line_id: 'l1', duration: 2.5 }), // 正常
        // l2 失败：空音频 + error
        s3Line({ line_id: 'l2', duration: 0, audio_base64: '', error: 'TTS 合成失败', skipped: false }),
      ]),
      text: async () => '',
    });
    ossUpload.mockResolvedValue('https://oss.example.com/l1.mp3');
    const res = await post(`/npcs/${npcId}/voice`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lines).toHaveLength(2);
    const l2Result = body.data.lines.find((r: any) => r.lineId === 'l2');
    expect(l2Result.error).toContain('TTS 合成失败');
    // 承重：l1 拿到新 voiceUrl；l2 既有 voiceUrl/duration 原样保留（未被失败擦除）
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
    const byId = new Map(row.lines.map((l) => [l.id, l]));
    expect(byId.get('l1')!.voiceUrl).toBe('https://oss.example.com/l1.mp3');
    expect(byId.get('l1')!.duration).toBe(2.5);
    expect(byId.get('l2')!.voiceUrl).toBe('https://keep.example.com/l2.mp3');
    expect(byId.get('l2')!.duration).toBe(1.8);
    // 只转存了 l1（l2 无音频不转存）
    expect(ossUpload).toHaveBeenCalledTimes(1);
  });

  // ─── 4. hash 缓存命中：S3 跳过合成但带已有 voiceUrl → 复用、不重传 OSS ─
  it('voice reuses cached voiceUrl when S3 skipped with existing url —— 不重传 OSS', async () => {
    const P = await mkProd('cache');
    const npcId = await mkNpc(P, 'cache');
    fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => s3Response(npcId, [
        s3Line({ line_id: 'l1', duration: 2.5, audio_base64: '', voiceUrl: 'https://cache.example.com/l1.mp3', skipped: true }),
        s3Line({ line_id: 'l2', duration: 1.8, audio_base64: '', voiceUrl: 'https://cache.example.com/l2.mp3', skipped: true }),
      ]),
      text: async () => '',
    });
    const res = await post(`/npcs/${npcId}/voice`);
    expect(res.status).toBe(200);
    // 复用 S3 给的 voiceUrl，不调 uploadToOSS
    expect(ossUpload).not.toHaveBeenCalled();
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
    const byId = new Map(row.lines.map((l) => [l.id, l]));
    expect(byId.get('l1')!.voiceUrl).toBe('https://cache.example.com/l1.mp3');
    expect(byId.get('l1')!.duration).toBe(2.5);
    expect(byId.get('l2')!.voiceUrl).toBe('https://cache.example.com/l2.mp3');
  });

  // ─── 5. NPC 不存在 ⇒ 404 ──────────────────────────────────────
  it('404 when NPC does not exist —— 不存在的 NPC 给前端明确信号', async () => {
    const res = await post('/npcs/nonexistent-voice-id/voice');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('NPC 不存在');
  });

  // ─── 6. AI crew 不可达 ⇒ 502 ──────────────────────────────────
  it('502 when AI crew fetch fails —— AI crew 不可达时给前端明确信号', async () => {
    const P = await mkProd('down');
    const npcId = await mkNpc(P, 'down');
    fetchImpl = async () => { const e = new Error('ECONNREFUSED'); (e as any).code = 'ECONNREFUSED'; throw e; };
    const res = await post(`/npcs/${npcId}/voice`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('AI crew 不可达');
    // 失败时 DB 行不被误写（lines 保持原样）
    const [row] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
    expect(row.lines.every((l) => l.voiceUrl === null)).toBe(true);
  });
});
