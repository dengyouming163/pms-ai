import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import route from '../wenlv-asset-gen.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvDesignAssets, pmsBuiWenlvProducts,
} from '../../../db/schema/index.js';
import { designAssetIdFor, selectCandidate } from '../../../services/wenlv/asset-gen/candidate-store.js';
import { reviewAssetJob } from '../../../services/wenlv-asset-gen-scheduler.js';
import { reviewModel } from '../../../services/wenlv/asset-gen/llm-vision.js';

/**
 * §8.5「人工审核也是评价的一路」—— 片④ T13 的四条判据（①a / ①b / ② / ③）。
 *
 * ## 为什么这些用例必须打到 **DB 行**上
 *
 * `/select` 与 `/review` 的响应都只回 `{ assetId }`（不回行）。就算回了行，
 * 断言响应回显也只证明「它的 json 序列化没写错」，证明不了「那一列真的落库了」——
 * 本仓已有前科：加列时漏了一个写入点，响应看着对、库里是 null。
 * 故本文件所有落库断言一律 `db.select()` 回来逐列单点断言（范式照抄
 * `asset-gen/__tests__/review.db.test.ts` 的「写回 design_assets 五列」那条）。
 *
 * ## 为什么判据 1(b) 打在 **fetch 调用次数**上
 *
 * 「写了 `review_source='human'`」这件事**单元测试可以全绿**，而闸的失效发生在
 * **另一次调用**里（fire-and-forget、`.catch` 吞异常、异步时序）。
 * 只有数被桩的 fetch 才问得对那个问题。**不能**打 `reviewedAt` —— 那是「钱的影子」
 * （BK-B5 订正①）：时间戳没变既可能是没评，也可能是评了没写。
 */
const run = !!process.env.RUN_DB;
const B = `humrev-${Date.now()}`;
const P = `humrev-p1-${Date.now()}`;      // ①a/①b/② 的主产品
const P2 = `humrev-p2-${Date.now()}`;     // ② 的「跨产品样本不得混入」对照产品
const P3 = `humrev-p3-${Date.now()}`;     // ③ 的统计产品（与上面隔离，分母可精确断言）
const ANCHOR_URL = 'https://oss.test/humrev-anchor.png';
const ASSET_URL = 'https://oss.test/humrev-asset.png';
const BIBLE = { artStyle: '水墨', mustHave: ['古井'] };

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const get = (p: string) => route.request(p, { headers: H });
const post = (p: string, b: unknown) => route.request(p, { method: 'POST', headers: H, body: JSON.stringify(b) });

/** 合法的评审 JSON + 必备 usage（少了 usage，计费链路的断言会退化成 0 == 0）。 */
const REVIEW_JSON = { score: 7, dimensions: [], issues: [], fix_guidance: '' };

describe.skipIf(!run)('人工评审（§8.5）', () => {
  let baseFetch: any;

  const visionFetch = async (_url: string, _init?: any) => {
    const payload = {
      choices: [{ message: { content: JSON.stringify(REVIEW_JSON) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 800 },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as any;
  };

  beforeAll(async () => {
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
    baseFetch = vi.fn(visionFetch);
    vi.stubGlobal('fetch', baseFetch);
    for (const id of [P, P2, P3]) {
      await db.insert(pmsBuiWenlvProducts).values({
        id, name: `人工评审测试剧本${id}`, styleBible: BIBLE, styleAnchorUrl: ANCHOR_URL,
      }).onConflictDoNothing();
    }
  });

  beforeEach(async () => {
    // 顺序：先删 design_assets，再删 job 行。反过来的话 reviewAssetJob 中途落到
    // 半张表上会留下孤儿行，下一条用例的前置就带上上一条的残留（表现为随机红）。
    await db.delete(pmsBuiWenlvDesignAssets).where(like(pmsBuiWenlvDesignAssets.id, `wa-${B}-%`));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    await db.delete(pmsBuiWenlvAssetJobs).where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-%`));
    for (const p of [P, P2, P3]) {
      await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, `review:${p}`));
    }
    baseFetch.mockClear();
  });

  afterAll(async () => {
    delete process.env.DASHSCOPE_API_KEY;
    vi.unstubAllGlobals();
    await db.delete(pmsBuiWenlvDesignAssets).where(like(pmsBuiWenlvDesignAssets.id, `wa-${B}-%`));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    await db.delete(pmsBuiWenlvAssetJobs).where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-%`));
    for (const p of [P, P2, P3]) {
      await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, `review:${p}`));
    }
    await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, [P, P2, P3]));
  });

  /** 种一条 asset_jobs 行（候选组的载体）。返回 jobId。 */
  const seedJob = async (
    suffix: string, productId = P, assetType = 'background', status = 'succeeded',
  ): Promise<string> => {
    const jobId = `${B}-${suffix}`;
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: jobId, batchId: B, productId, assetType, name: jobId,
      styleBibleSnapshot: BIBLE, status, attempt: 1, costAmount: '0',
    });
    return jobId;
  };

  /** 种一条 design_assets 候选行。`over` 里的每个键都只在该键出现时才写 ——
   *  **不能**用 `?? null` 兜底：那会把「例子里没提这一列」变成「显式写 null」，
   *  于是「闸读到的 reviewScore」与用例作者以为的夹具形状不是一回事。 */
  const seedAsset = async (
    jobId: string, index: number,
    over: {
      name?: string; url?: string; isSelected?: boolean; isRejected?: boolean;
      productId?: string; reviewScore?: string; reviewSource?: string;
      reviewedAt?: Date; reviewModel?: string; humanReviewScore?: string;
      humanReviewDetail?: { comment: string };
    } = {},
  ): Promise<string> => {
    const id = designAssetIdFor(jobId, index);
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id,
      type: 'background',
      name: over.name ?? id,
      url: over.url ?? ASSET_URL,
      jobId,
      candidateIndex: index,
      // 🔴 真列与 `meta.productId` **双写同一个值**（Task C6 起查询源是**真列**）。
      //    本夹具原先把 productId 只塞进 `meta`（C2 之前的世界），C6 把读侧切到真列后，
      //    真列落 NULL ⇒ 这个文件里按 productId 过滤的两条读侧（`GET /review-stats` 的
      //    分母、`loadReviewExamples` 的正反例）在这些行上全都查不到，用例会红成
      //    「实现没写对」。生产侧的四个写入点（`POST /assets`、`PATCH /assets/:id`、
      //    `writeCandidate`、`writeAsset`）都已双写，这里补的是夹具那一半。
      productId: over.productId ?? P,
      isSelected: over.isSelected ?? false,
      isRejected: over.isRejected ?? false,
      reviewScore: over.reviewScore ?? null,
      reviewSource: over.reviewSource ?? null,
      reviewedAt: over.reviewedAt ?? null,
      reviewModel: over.reviewModel ?? null,
      humanReviewScore: over.humanReviewScore ?? null,
      humanReviewDetail: over.humanReviewDetail ?? null,
      meta: { jobId, productId: over.productId ?? P, iteration: 1 },
      isBuiltin: false,
    });
    return id;
  };

  const rowOfAsset = async (assetId: string) => {
    const [r] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
    return r;
  };

  /** 第 `i` 次视觉调用发出去的 **user prompt 原文**（parts[0] 是文本块）。 */
  const promptOf = (i = 0): string => {
    const init = baseFetch.mock.calls[i][1];
    const body = JSON.parse(String(init.body));
    return String(body.messages[1].content[0].text);
  };
  const countIn = (p: string, marker: string) => (p.match(new RegExp(marker, 'g')) ?? []).length;

  // ════════════════════════════════════════════════════════════════════
  // 判据 1：①a —— `/select` 写 review_source='human'，且 AI 补评**未发起**
  // ════════════════════════════════════════════════════════════════════
  describe('①a `/select` 的人工标记', () => {
    it('(a) 落库 reviewSource===\'human\'（打 DB 行，不打响应回显）', async () => {
      const jobId = await seedJob('a1');
      await seedAsset(jobId, 0, { name: '候选0' });
      const id1 = await seedAsset(jobId, 1, { name: '候选1' });

      const res = await post('/select', { jobId, index: 1 });
      expect(res.status).toBe(200);
      expect((await res.json() as any).success).toBe(true);

      const a = await rowOfAsset(id1);
      // 逐列单点：漏写 reviewSource（只写 isSelected）必须在**这一行**上红，
      // 而不是靠别处间接推断 —— 与 review.db.test.ts 那条「五列」的写法同形。
      expect(a.isSelected).toBe(true);
      expect(a.reviewSource).toBe('human');    // ← 写成 'ai' / null 必须红
      expect(a.humanReviewedAt).toBeTruthy();
      // ⚠️ AI 的四列**一个字都不许碰**（口径②：覆写即算不出 human − ai）。
      expect(a.reviewScore).toBeNull();
      expect(a.reviewDetail).toBeNull();
      expect(a.reviewedAt).toBeNull();
      expect(a.reviewModel).toBeNull();
    });

    it('(b) 补评**未发起** —— 被桩的 fetch 调用次数为 0', async () => {
      const jobId = await seedJob('b1');
      const id0 = await seedAsset(jobId, 0, { name: '候选0' });
      const id1 = await seedAsset(jobId, 1, { name: '候选1' });

      const res = await post('/select', { jobId, index: 1 });
      expect(res.status).toBe(200);
      // 路由里的补评是 fire-and-forget（`.catch` 吞异常）⇒ 响应返回 ≠ 它已结束。
      // 这一小段等待是**为了让它有机会**发起（它要先做 2 次 DB 查询才到闸）；
      // 真发起了的话 fetch 计数会变，这里就会红。
      await new Promise((r) => setTimeout(r, 400));
      expect(baseFetch).toHaveBeenCalledTimes(0);

      // ★ 更硬的一刀：**直接 await** `reviewAssetJob`——这正是调度器收尾那条路径
      //   （另一个调用点）会做的事。它若没被闸拦住，这一句必然发起一次付费调用。
      await reviewAssetJob(id1);
      expect(baseFetch).toHaveBeenCalledTimes(0);

      // 顺带把「闸拦的是 human 那一半而不是别的」钉住：未被采纳的 index 0
      // 也走同一个函数、同样的空 reviewScore，它**照常**发起调用（下面 (c)）。
      const a1 = await rowOfAsset(id1);
      expect(a1.reviewScore).toBeNull();       // 闸拦下 ⇒ 连分数都没写
      expect(a1.reviewSource).toBe('human');   // 也没被改回 'ai'
      expect(id0).toBeTruthy();
    });

    it('(c) 对照：没有 human 标记的同一形状素材 → 补评**照常发起**（1 次）', async () => {
      // ⚠️ 判据 (b) 期望 0，**必须**配这条同产物的「期望 ≥1」对照 ——
      //    否则「fetch 计数为 0」可能是因为桩压根没接上（整个 (b) 变成恒真的空断言）。
      const jobId = await seedJob('c1');
      const id0 = await seedAsset(jobId, 0, { name: '对照组候选0' });

      await reviewAssetJob(id0);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const a = await rowOfAsset(id0);
      expect(a.reviewSource).toBe('ai');
      expect(a.reviewScore).not.toBeNull();
    });

    it('人工标记**粘性**：先采纳、再点同一张，仍不被 AI 补评覆盖', async () => {
      // 这条钉的是「不是靠时序侥幸」：闸读的是**行上的列**，与调用顺序无关。
      const jobId = await seedJob('d1');
      await seedAsset(jobId, 0, { name: '候选0' });
      await post('/select', { jobId, index: 0 });
      const id = designAssetIdFor(jobId, 0);
      await reviewAssetJob(id);                // 调度器那条路径
      await reviewAssetJob(id);                // 再来一次
      expect(baseFetch).toHaveBeenCalledTimes(0);
      const a = await rowOfAsset(id);
      expect(a.reviewSource).toBe('human');
      expect(a.reviewScore).toBeNull();
    });

    it('①a 反向：**机器**自选不得写人工列族（否则首轮自动评会被闸整个拦掉）', async () => {
      // ⚠️ 这是本 Task 自测抓到的**真 bug** 的回归网（2026-09-20）。
      // 最初我把 `reviewSource: 'human'` **无条件**写进 `selectCandidate` —— 而它有
      // **两个**调用者：`/select`（人点的）与调度器收尾的**机器自选**
      // （`landed.find(l => l.index === 0) ?? landed[0]`，`wenlv-asset-gen-scheduler.ts`）。
      // 机器自选也被标成 human 之后，同一函数末尾那次 `shouldReview → reviewAssetJob`
      // 必被收口点闸拦下 ⇒ **每一张刚生成的图的首轮评审从此不再发生**，而且完全静默
      // （只是从此不再有分数、也不再有记账行）。
      // 这套用例全绿地放过了它 —— 因为它们只走 `/select` 一个调用者；
      // 抓到它的是 `asset-gen/__tests__/run-once.db.test.ts`
      // 「图类 job 带锚图作参考图，生成成功并记账」。修法：给 `selectCandidate` 加
      // **显式**的 `source` 入参（`'human' | 'machine'`，不做默认值兜底）。
      const jobId = await seedJob('m1');
      const id0 = await seedAsset(jobId, 0, { name: '机器自选候选' });

      await selectCandidate(jobId, 0, 'machine');
      const a = await rowOfAsset(id0);
      expect(a.isSelected).toBe(true);        // 采纳本身照常生效
      expect(a.reviewSource).toBeNull();      // ← 写成 'human' 必须红
      expect(a.humanReviewedAt).toBeNull();

      // 反向半边：机器自选过的图**照常**被首轮自动评（收口点闸不该拦它）。
      await reviewAssetJob(id0);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      const after = await rowOfAsset(id0);
      expect(after.reviewSource).toBe('ai');
      expect(after.reviewScore).not.toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 判据 2：①b —— 人工给意见写 'human'，**不覆写 AI 分**，human 分落到新列
  // ════════════════════════════════════════════════════════════════════
  describe('①b `POST /review` 人工给意见', () => {
    it('AI 分与 reviewModel / reviewedAt 全部原样保留，human 分落在新列', async () => {
      const jobId = await seedJob('e1');
      const reviewedAt = new Date('2026-01-02T03:04:05Z');
      const id = await seedAsset(jobId, 0, {
        name: '已评过 AI 的素材',
        reviewScore: '7.00', reviewSource: 'ai', reviewedAt, reviewModel: reviewModel(),
      });

      const res = await post('/review', { assetId: id, score: 9, comment: '  构图很好  ' });
      expect(res.status).toBe(200);
      expect((await res.json() as any).success).toBe(true);

      const a = await rowOfAsset(id);
      // ── 人工列：全部落库（逐列单点）──
      expect(a.humanReviewScore).toBe('9.00');       // numeric(4,2) string mode
      expect(a.humanReviewDetail).toMatchObject({ comment: '构图很好' });  // 已 trim
      expect(a.humanReviewedAt).toBeTruthy();
      expect(a.reviewSource).toBe('human');
      expect(a.isRejected).toBe(false);
      // ── AI 列：一个字都没变（★ 口径②的承重断言）──
      expect(a.reviewScore).toBe('7.00');            // ← 被覆写成 '9.00' 必须红
      expect(a.reviewModel).toBe(reviewModel());
      expect(a.reviewedAt!.getTime()).toBe(reviewedAt.getTime());
    });

    it('人工给意见后 AI 补评**不再发起**（fetch 计数为 0）', async () => {
      const jobId = await seedJob('e2');
      const id = await seedAsset(jobId, 0, { name: '有意见无 AI 分' });

      const res = await post('/review', { assetId: id, comment: '主体糊了' });
      expect(res.status).toBe(200);
      await reviewAssetJob(id);
      expect(baseFetch).toHaveBeenCalledTimes(0);
      const a = await rowOfAsset(id);
      expect(a.reviewSource).toBe('human');
      expect(a.humanReviewScore).toBeNull();     // 没给分就是 null，不伪造 0
    });

    it('`isRejected` 是**显式**淘汰标记，且与 is_selected 是两回事', async () => {
      const jobId = await seedJob('e3');
      const id = await seedAsset(jobId, 0, { name: '被淘汰的图', isSelected: false });
      const res = await post('/review', { assetId: id, isRejected: true });
      expect(res.status).toBe(200);
      const a = await rowOfAsset(id);
      expect(a.isRejected).toBe(true);
      expect(a.isSelected).toBe(false);   // 淘汰 != 被采纳；两列独立
    });

    it('三项全空 → 400，且**不**盖上 human 印记（否则「看过」与「评过」不可分）', async () => {
      const jobId = await seedJob('e4');
      const id = await seedAsset(jobId, 0, { name: '空动作' });
      const res = await post('/review', { assetId: id });
      expect(res.status).toBe(400);
      const a = await rowOfAsset(id);
      expect(a.reviewSource).toBeNull();
      expect(a.humanReviewedAt).toBeNull();
    });

    it('不存在的 assetId → 404（不是静默成功的 0 行 UPDATE）', async () => {
      const res = await post('/review', { assetId: `wa-${B}-不存在`, comment: 'x' });
      expect(res.status).toBe(404);
    });

    it('分数越界 → 400 且不落库（不夹紧、不伪装成一次极端评分）', async () => {
      const jobId = await seedJob('e5');
      const id = await seedAsset(jobId, 0, { name: '越界分' });
      for (const bad of [-1, 11, 'abc', true]) {
        const res = await post('/review', { assetId: id, score: bad });
        expect(res.status).toBe(400);
      }
      const a = await rowOfAsset(id);
      expect(a.humanReviewScore).toBeNull();
      expect(a.reviewSource).toBeNull();
    });

    it('三态：只传 comment 时**不动**已有人工分（缺 = 不动这一项，不是清空）', async () => {
      const jobId = await seedJob('e6');
      const id = await seedAsset(jobId, 0, { name: '三态', humanReviewScore: '6.00' });
      const res = await post('/review', { assetId: id, comment: '再补一句' });
      expect(res.status).toBe(200);
      const a = await rowOfAsset(id);
      expect(a.humanReviewScore).toBe('6.00');   // ← 被当「没传 ⇒ 清空」必须红
      expect(a.humanReviewDetail).toMatchObject({ comment: '再补一句' });
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 判据 3：② 正反例自动累积进评审 prompt
  // ════════════════════════════════════════════════════════════════════
  describe('② 正反例累积', () => {
    it('prompt 里恰好 3 条正例 + 3 条反例（== 3，不写 >=）', async () => {
      const jobId = await seedJob('f-target');
      const target = await seedAsset(jobId, 0, { name: '待评目标图' });
      // 4 条正例 / 4 条反例：比上限多 1，才能同时钉住「有取」与「取满就停」。
      for (let i = 0; i < 4; i++) {
        const jp = await seedJob(`f-pos${i}`);
        await seedAsset(jp, 0, {
          name: `正例图${i}`, isSelected: true, humanReviewScore: '8.00',
          humanReviewDetail: { comment: '很好' },
        });
        const jn = await seedJob(`f-neg${i}`);
        await seedAsset(jn, 0, {
          name: `反例图${i}`, isRejected: true, humanReviewScore: '2.00',
          humanReviewDetail: { comment: '糊了' },
        });
      }

      await reviewAssetJob(target);
      expect(baseFetch).toHaveBeenCalledTimes(1);

      const prompt = promptOf(0);
      expect(countIn(prompt, '【正例】')).toBe(3);
      expect(countIn(prompt, '【反例】')).toBe(3);
    });

    it('**不跨产品**：另一个产品的样本不进 prompt（配同产品样本「进」的对照）', async () => {
      const jobId = await seedJob('g-target');
      const target = await seedAsset(jobId, 0, { name: '待评目标图' });
      const jp = await seedJob('g-pos');
      await seedAsset(jp, 0, { name: '本产品正例', isSelected: true });
      // 同样是 is_selected=true，只是 productId 不同 —— 唯一的变量就是产品。
      const jx = await seedJob('g-x', P2);
      await seedAsset(jx, 0, { name: '别的产品正例', isSelected: true, productId: P2 });

      await reviewAssetJob(target);
      const prompt = promptOf(0);
      expect(prompt).toContain('本产品正例');       // ← 期望 ≥1 的对照
      expect(prompt).not.toContain('别的产品正例'); // ← 期望 0 的这一半才有区分力
    });

    it('待评的这张**自己**不做自己的正例（它本身就是 is_selected ⇒ 会被自己选中）', async () => {
      const jobId = await seedJob('h-target');
      const target = await seedAsset(jobId, 0, { name: '自我参照目标', isSelected: true });
      await reviewAssetJob(target);
      const prompt = promptOf(0);
      expect(prompt).not.toContain('《自我参照目标》');
    });

    it('没有任何人工样本 → prompt 里不出现参照块（生产现状路径不受影响）', async () => {
      const jobId = await seedJob('i-target');
      const target = await seedAsset(jobId, 0, { name: '无样本目标' });
      await reviewAssetJob(target);
      expect(countIn(promptOf(0), '【正例】')).toBe(0);
      expect(countIn(promptOf(0), '参照样本')).toBe(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 判据 4：③ 分差的分母口径
  // ════════════════════════════════════════════════════════════════════
  describe('③ `GET /review-stats` 的分母', () => {
    const stats = async (): Promise<any> => {
      const res = await get(`/review-stats?productId=${encodeURIComponent(P3)}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.success).toBe(true);
      return body.data;
    };

    it('只有 human 或只有 ai 的图**不进**分母；两者都有的**进**分母', async () => {
      const before = await stats();
      expect(before.compared).toBe(0);   // 本用例的产品在 beforeEach 里已被清空

      // ① 只有 human（人工评了、AI 没跑）—— 不进分母。
      const j1 = await seedJob('j1', P3);
      await seedAsset(j1, 0, { name: '只有人工', productId: P3, humanReviewScore: '9.00' });
      const onlyHuman = await stats();
      expect(onlyHuman.compared).toBe(0);         // ← 被算进分母必须红
      expect(onlyHuman.humanOnly).toBe(1);

      // ② 只有 ai（评价器跑了、还没人看）—— 同样不进分母。
      const j2 = await seedJob('j2', P3);
      await seedAsset(j2, 0, { name: '只有AI', productId: P3, reviewScore: '4.00', reviewSource: 'ai' });
      const onlyAi = await stats();
      expect(onlyAi.compared).toBe(0);
      expect(onlyAi.humanOnly).toBe(1);
      expect(onlyAi.aiOnly).toBe(1);

      // ③ ★ 正例对照：两者都有 ⇒ **进**分母，且分差按 `human − ai` 算。
      const j3 = await seedJob('j3', P3);
      await seedAsset(j3, 0, {
        name: '双评', productId: P3, reviewScore: '4.00', reviewSource: 'ai', humanReviewScore: '9.00',
      });
      const both = await stats();
      expect(both.compared).toBe(1);
      expect(both.avgAiScore).toBe(4);
      expect(both.avgHumanScore).toBe(9);
      expect(both.avgDelta).toBe(5);              // 人工比评价器松 5 分
      expect(both.humanOnly).toBe(1);             // 前面两条仍然落在分母外
      expect(both.aiOnly).toBe(1);
    });

    it('productId 缺省 → 不按产品过滤（同一条数据在两种口径下都被计入）', async () => {
      // ⚠️ 不断言「全库 compared == 1」—— 库里可能有别的用例的数据，那会是一条
      //    随别人而红的假判据。改判**增量**：同一条新行在两种口径下各让 compared 涨 1。
      //    （增量口径不写 `>=`：本仓明令禁止用 `>=` 写数量型契约。）
      const globalStats = async (): Promise<any> => {
        const res = await get('/review-stats');
        expect(res.status).toBe(200);
        return (await res.json() as any).data;
      };
      const g0 = await globalStats();
      const s0 = await stats();
      expect(g0.productId).toBeNull();

      const j = await seedJob('k1', P3);
      await seedAsset(j, 0, { name: '全库口径', productId: P3, reviewScore: '5.00', humanReviewScore: '5.00' });

      const g1 = await globalStats();
      const s1 = await stats();
      expect(g1.compared - g0.compared).toBe(1);   // 全库口径把它算进去了
      expect(s1.compared - s0.compared).toBe(1);   // 同一条在产品口径下也在
    });
  });
});
