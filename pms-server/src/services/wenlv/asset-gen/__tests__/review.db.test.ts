import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
// ⚠️ 路径深度：本文件在 `src/services/wenlv/asset-gen/__tests__/`，回到 `src/` 要**四层**
// （__tests__ → asset-gen → wenlv → services → src）。写成三层会解析到
// `src/services/db/index.js` —— **那个目录不存在**，整个文件加载失败（可对照同目录
// 既有的 `claim.db.test.ts:8`）。
import { db } from '../../../../db/index.js';
import {
  pmsBuiWenlvAssetJobs, pmsBuiWenlvProducts, pmsBuiWenlvDesignAssets,
} from '../../../../db/schema/index.js';
// 下面三条**只有三层**是对的 —— 目标是 `src/services/` 下的文件
// （__tests__ → asset-gen → wenlv → services）。
import { reviewAssetJob } from '../../../wenlv-asset-gen-scheduler.js';
import { reviewModel } from '../llm-vision.js';
// 计费期望值一律**引用真实函数**，不手抄常量：手抄的数会随默认价调整而漂移，
// 而漂移后的断言仍然「绿」—— 正是本子项目最怕的静默错。
import { calcPromptCost } from '../pricing.js';

const run = !!process.env.RUN_DB;
const B = `review-test-${Date.now()}`;
const P = `review-prod-${Date.now()}`;
// 锚图与素材图必须是**两个** URL：`reviewAssetJob` 的自过滤会丢掉「与待评素材同 URL」
// 的参照图（防 `/select` 把基准图自身传进来），同名会让参照图被静默丢掉而不自知。
const ANCHOR_URL = 'https://oss.test/review-anchor.png';
const ASSET_URL = 'https://oss.test/review-asset.png';
const BIBLE = { artStyle: '水墨', mustHave: ['古井'] };

/**
 * `reviewAssetJob` 的**直驱**用例 —— 它是本文件唯一的主角。
 *
 * 为什么不跑 `runAssetGenOnce` 端到端：调用点是 fire-and-forget（`.catch(...)`，
 * 不返回 promise），端到端只能靠轮询 ⇒ flaky。`reviewAssetJob` 已被 `export`
 * （正是为这个），直接 `await` 它才能**确定性**地断言两条 DB 语句的写入。
 * 调用点那条线（`shouldReview` 传 `selected.index`）由 `run-once.db.test.ts` 的
 * 负断言单独承重。
 *
 * ⚠️ 本文件的存在理由（Task 14 修复轮 F1）：此前 `run-once.db.test.ts` 的 `echoFetch`
 *    把**请求的 user content 原样回显**，而视觉调用的 user content 是 parts **数组**
 *    ⇒ `dashscope.ts` 的字符串检查抛错 ⇒ 评审每次都在 mock 上失败、被 `.catch` 吞成
 *    一条 warn ⇒ **`reviewAssetJob` 的两条 DB 语句一条都没被执行过**（列名写错、
 *    `review_source` 写字面量、`onConflictDoUpdate` 的 set 写漏，全仓零信号）。
 */
describe.skipIf(!run)('评审任务写回（reviewAssetJob 直驱）', () => {
  let baseFetch: any;

  // 视觉桩：回一段**合法**的评审 JSON + 必备的 usage（计费链路的必要夹具，
  // 缺了它 cost 断言会退化成 0 == 0）。回显策略在这里**不成立**：`parseReview`
  // 对 score 非数 / fix_guidance 非字符串一律抛，且 `null`/`""`/`[]` 会被先验类型拒掉。
  const REVIEW_JSON = { score: 7, dimensions: [], issues: [], fix_guidance: '' };
  const visionFetch = async (_url: string, _init?: any) => {
    const payload = {
      choices: [{ message: { content: JSON.stringify(REVIEW_JSON) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 800 },
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) } as any;
  };

  beforeAll(async () => {
    // 调度器的 `callDashScope` 在读不到 key 时**直接抛**（vitest 不注 .env）。
    // 假 key 即可 —— fetch 已被打桩，不会真的发出去。
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
    baseFetch = vi.fn(visionFetch);
    vi.stubGlobal('fetch', baseFetch);
    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: '评审测试剧本', styleBible: BIBLE, styleAnchorUrl: ANCHOR_URL,
    }).onConflictDoNothing();
  });

  // 每个用例从**干净的行**开始。本文件造的 review 行 batchId 恒为 `review:<productId>`、
  // id 恒为 `review:<assetId>`（`wa-` 前缀）—— 两条清理都要有：只按 id 前缀清会漏掉
  // 未来 id 规则变动后的残留，只按 batchId 清则漏掉「productId 缺失」那一档。
  beforeEach(async () => {
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, `review:${P}`));
    await db.delete(pmsBuiWenlvAssetJobs).where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-%`));
    await db.delete(pmsBuiWenlvDesignAssets).where(like(pmsBuiWenlvDesignAssets.id, `wa-${B}-%`));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
  });

  afterAll(async () => {
    delete process.env.DASHSCOPE_API_KEY;
    vi.unstubAllGlobals();
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, `review:${P}`));
    await db.delete(pmsBuiWenlvAssetJobs).where(like(pmsBuiWenlvAssetJobs.id, `review:wa-${B}-%`));
    await db.delete(pmsBuiWenlvAssetJobs).where(eq(pmsBuiWenlvAssetJobs.batchId, B));
    await db.delete(pmsBuiWenlvDesignAssets).where(like(pmsBuiWenlvDesignAssets.id, `wa-${B}-%`));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });

  /** 种一个 asset_jobs 行 + 它对应的 design_assets 行，返回素材 id。 */
  const seedAsset = async (
    suffix: string, assetName: string, assetUrl = ASSET_URL, assetType = 'background',
  ): Promise<string> => {
    const jobId = `${B}-${suffix}`;
    await db.insert(pmsBuiWenlvAssetJobs).values({
      id: jobId, batchId: B, productId: P, assetType, name: jobId,
      styleBibleSnapshot: BIBLE, status: 'succeeded', attempt: 1, costAmount: '0',
    });
    const assetId = `wa-${jobId}`;
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: assetId, type: 'background', name: assetName, url: assetUrl,
      jobId, candidateIndex: 0, isSelected: true,
    });
    return assetId;
  };

  const rowOfAsset = async (assetId: string) => {
    const [r] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId)).limit(1);
    return r;
  };
  const rowOfReviewJob = async (assetId: string) => {
    const [r] = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, `review:${assetId}`)).limit(1);
    return r;
  };

  it('写回 design_assets 的 **AI 评审**五列，且记一行 review 花费（金额取自真实 calcPromptCost）', async () => {
    const assetId = await seedAsset('r1', '古井·background');
    await reviewAssetJob(assetId);

    // 1) AI 评审的五列全落 —— 每一列都单点断言：漏写任何一列（或 reviewSource 写成
    //    别的字面量）都必须在**这一行**上红，而不是靠别处间接推断。
    //    ⚠️ 标题原为「写回 design_assets 五列」—— **那个说法在迁移 0035 之后不再成立**：
    //       本表此后还有四个人工列族（`human_review_score` / `human_review_detail` /
    //       `human_reviewed_at` / `is_rejected`），它们**刻意不被 AI 路径触碰**（口径②）。
    //       故「五列」既不是全集、也不该是全集 —— 留着旧标题会让下一个人以为
    //       「五列就是全部落库面」，而在新列上漏写就正好落进这个盲区。
    const a = await rowOfAsset(assetId);
    expect(Number(a.reviewScore)).toBe(Number(REVIEW_JSON.score));
    expect(a.reviewDetail).toMatchObject(REVIEW_JSON);
    expect(a.reviewSource).toBe('ai');           // ← 写成 'AI' / 'human' 必须红
    expect(a.reviewedAt).toBeTruthy();
    expect(a.reviewModel).toBe(reviewModel());

    // 2) ★ AI 路径**不得**碰人工列族（0035）。这四条与上面五条同等要紧：人工分被 AI
    //    覆写、或淘汰标记被 AI 顺手清掉，都会让 §8.5 的 `human − ai` 分差失真。
    //    ⚠️ 断言的是**这一条路径**（全新素材直驱 `reviewAssetJob`）的结果，不是不变量：
    //       人工评审过的行由开头的去重闸挡在门外，走不到这里。
    expect(a.humanReviewScore).toBeNull();
    expect(a.humanReviewDetail).toBeNull();
    expect(a.humanReviewedAt).toBeNull();
    expect(a.isRejected).toBe(false);            // notNull default false ⇒ 不是 null

    // 3) 记账行：asset_type / status / 花费。
    const r = await rowOfReviewJob(assetId);
    expect(r).toBeTruthy();
    expect(r.assetType).toBe('review');
    expect(r.status).toBe('succeeded');
    // ⚠️ 金额列是 decimal **string mode**（numeric(10,4) 读回来带 4 位小数），
    //    所以两边都过 `Number()` —— 直接比 `String(calcPromptCost(...))` 会因
    //    '0.352' vs '0.3520' 恒红，与实现无关。
    expect(Number(r.costAmount)).toBe(Number(calcPromptCost(1200, 800)));
  });

  it('幂等：并发窗口内两条评审只落一行（onConflictDoUpdate 的 target 是 id）', async () => {
    const assetId = await seedAsset('r2', '重评素材·background');
    await reviewAssetJob(assetId);

    // ⚠️ 本用例的**存在理由**（2026-09-20 改）：`reviewAssetJob` 加了
    //    `reviewScore !== null → return` 的去重闸之后，**普通的连调两次
    //    已经走不到 INSERT 了**（第二次在读库后就返回）。若照旧写「连调两次」，
    //    它仍会绿，但测的已是别的东西 —— 覆盖静默消失、标题变成假话。
    //    故这里手工把 `reviewScore` 复位成 null，**精确模拟**那条仍存在的竞态：
    //    「两个调用都在对方写入前读到 null」。此时第二次才会真的走到 INSERT，
    //    `onConflictDoUpdate` 才是这条用例真正在钉的东西。
    await db.update(pmsBuiWenlvDesignAssets)
      .set({ reviewScore: null })
      .where(eq(pmsBuiWenlvDesignAssets.id, assetId));

    await reviewAssetJob(assetId);
    const rows = await db.select().from(pmsBuiWenlvAssetJobs)
      .where(eq(pmsBuiWenlvAssetJobs.id, `review:${assetId}`));
    expect(rows.length).toBe(1);
  });

  it('已评过的素材再次调用 → 不再付费（本次修复）', async () => {
    const assetId = await seedAsset('dup', '重复评审素材·background');

    baseFetch.mockClear();               // 只数本用例的付费调用
    await reviewAssetJob(assetId);
    expect(baseFetch).toHaveBeenCalledTimes(1);   // 第一次：真调了视觉模型
    const first = await rowOfAsset(assetId);
    expect(first.reviewScore).not.toBeNull();

    await reviewAssetJob(assetId);       // 第二次：竞态窗口里 `/select` 会做的那一下

    // ★ 直接判据：**钱**没再花 —— 付费调用次数不得增加
    expect(baseFetch).toHaveBeenCalledTimes(1);
    // ★ 代理判据：评审时间戳未变（写回也没发生）
    const second = await rowOfAsset(assetId);
    expect(second.reviewedAt!.getTime()).toBe(first.reviewedAt!.getTime());
  });

  it('★ D-2 回归网：100 码点含 emoji 的素材名不顶穿 review 行的 varchar(100)', async () => {
    // 链（已逐跳实测）：节点标题上限 200 码点 → fitName 凑到**恰好 100 码点** →
    // writeCandidate 按码点写 design_assets.name（可达 100）→ 评审行再拼 `评审·`（3 码点）
    // ⇒ 103 > varchar(100) ⇒ INSERT 撞 SQLSTATE 22001。
    // 失败形态：design_assets 的 UPDATE 在 INSERT **之前** ⇒ **分数不丢、只有记账行丢**，
    // 且异常经 fire-and-forget 的 `.catch` 只打一条 warn —— 本子项目最怕的静默少算。
    // 本用例**直接 await**，所以红/绿都是确定的。
    const name = `${'甲'.repeat(99)}🎨`;   // 100 码点 / UTF-16 长度 101
    const assetId = await seedAsset('emoji', name);
    await reviewAssetJob(assetId);

    // 素材行仍在（UPDATE 已执行，分没丢）—— 防止「整条函数提前 return」式的假绿。
    const a = await rowOfAsset(assetId);
    expect(a).toBeTruthy();
    expect(a.name).toBe(name);

    // 记账行必须落得下，且名字被截进列宽、没有切碎代理对。
    const r = await rowOfReviewJob(assetId);
    expect(r).toBeTruthy();
    expect(Array.from(r.name).length <= 100).toBe(true);
    expect(r.name.startsWith('评审·')).toBe(true);         // 前缀是这行的身份信号，必须保留
    expect(r.name).not.toContain('�');                // 代理对未被从中间切开
    expect(Array.from(r.name).join('')).toBe(r.name);      // Array.from 往返无损
  });

  it('参照图自过滤：待评素材本身是锚图时不把同一 URL 发两遍（F4-2）', async () => {
    // `refs` 取自 `products.styleAnchorUrl`；锚图的 writeback 正是把 styleAnchorUrl 写成
    // **刚生成的锚图 URL** ⇒ 不做自过滤时视觉请求是 [a.url, a.url]。这里让素材 URL 恰等于
    // 锚图 URL，断言发出去的 image_url parts 里**没有重复**。
    const assetId = await seedAsset('selfref', '锚图自身', ANCHOR_URL, 'anchor');
    // 只在本用例的调用区间里找 —— `baseFetch` 跨用例累积，`find` 会命中前面用例的调用
    //（那些素材的 URL 与锚图不同，必然有 2 张图），于是这条断言会恒红。
    const before = baseFetch.mock.calls.length;
    await reviewAssetJob(assetId);
    expect((await rowOfReviewJob(assetId))).toBeTruthy();

    const call = baseFetch.mock.calls.slice(before).find(
      (c: any) => JSON.parse(c[1]?.body ?? '{}')?.model === reviewModel(),
    );
    expect(call).toBeTruthy();
    const parts = JSON.parse(call[1].body).messages.find((m: any) => m.role === 'user').content;
    const urls = parts.filter((p: any) => p.type === 'image_url').map((p: any) => p.image_url.url);
    expect(urls.length).toBe(1);
    expect(new Set(urls).size).toBe(urls.length);          // 无重复
  });
});
