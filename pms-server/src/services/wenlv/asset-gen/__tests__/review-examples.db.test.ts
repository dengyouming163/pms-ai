/**
 * `loadReviewExamples` 的**归属过滤源**用例（Task C6）。
 *
 * 🔴 为什么单独立一条：`loadReviewExamples` 是 AI 评审的正/反例样本源，按 `productId`
 *    过滤。Task C6 把该过滤从 `meta->>'productId'` 切到真列 `product_id`，而此前
 *    **没有任何用例钉住「按哪一列过滤」**——`__tests__/wenlv-human-review.db.test.ts`
 *    的「② 正反例累积」组确实断言到了它**取出的样本**（该组自己不调用本函数，走的是
 *    `reviewAssetJob` ⇒ 断言打在由返回值拼出的 prompt 的「正例/反例」条数上），
 *    但那些夹具两边取值一致 ⇒ 切源照样全绿。
 *    切错的表现是「评审标准悄悄变了」，**全程无报错**。
 *
 * 🔴 夹具**必须** `db.insert` **直插库**，且**故意让真列与 meta 不一致**：
 *    C2 之后「列 ← `meta.productId`」是**服务端派生**的（`POST /assets` 与
 *    `PATCH /assets/:id` 都会重新推一遍）⇒ 经 API 造出来的行两处**恒相等**，
 *    两种实现都能通过、用例零判别力（本仓前科：判别力是「被测对象全集」的函数）。
 *
 * 断言**正负两侧都打**：该函数里有**两条**独立查询（正例集 / 负例集，条件分别是
 * `isSelected` 与 `isRejected`），只钉一侧的话另一侧切没切都照样绿。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
// ⚠️ 路径深度：本文件在 `src/services/wenlv/asset-gen/__tests__/`，回到 `src/` 要**四层**
//    （__tests__ → asset-gen → wenlv → services → src）。写成三层会解析到
//    `src/services/db/index.js` —— **那个目录不存在**，整个文件加载失败
//    （可对照同目录既有的 `claim.db.test.ts` / `review.db.test.ts`）。
import { db } from '../../../../db/index.js';
import { pmsBuiWenlvDesignAssets } from '../../../../db/schema/index.js';
import { loadReviewExamples } from '../review-examples.js';

const run = !!process.env.RUN_DB;
const STAMP = Date.now();
/** 被测产品（= 真列该有的取值）。用唯一值，保证只命中本文件的夹具。 */
const P = `rex-prod-${STAMP}`;
/** 只出现在 `meta.productId` 里的另一个产品 —— 「真列与 meta 不一致」靠它造。 */
const Q = `rex-prod-other-${STAMP}`;
/** 待评素材自身（调用方总会排除它）。此处不存在，只为传参。 */
const EXCLUDE = `rex-exclude-${STAMP}`;

// 四条夹具，两两成对：
//   · COL_POS / COL_NEG  ：**真列 = P**，`meta.productId` = Q ⇒ 只有「读真列」的实现才选中
//   · META_POS / META_NEG：真列 = NULL，`meta.productId` = P ⇒ 只有「读 meta」的实现才选中
const COL_POS = `rex-col-pos-${STAMP}`;
const META_POS = `rex-meta-pos-${STAMP}`;
const COL_NEG = `rex-col-neg-${STAMP}`;
const META_NEG = `rex-meta-neg-${STAMP}`;
const FIXTURE_IDS = [COL_POS, META_POS, COL_NEG, META_NEG];

describe.skipIf(!run)('loadReviewExamples 按真列 product_id 取样本（Task C6）', () => {
  afterAll(async () => {
    // 断言失败时本用例自带的清理不会执行 ⇒ 一律在 afterAll 兜底删（删 0 行是幂等的）。
    for (const id of FIXTURE_IDS) {
      await db.delete(pmsBuiWenlvDesignAssets).where(eq(pmsBuiWenlvDesignAssets.id, id));
    }
  });

  it('正例/负例两侧都按真列选，不吃 meta 那份', async () => {
    await db.insert(pmsBuiWenlvDesignAssets).values([
      // `id` / `type` / `name` 是**无默认值的 NOT NULL**（`schema/wenlv.ts` 的
      // `pmsBuiWenlvDesignAssets`），少一个就是 23502；`productId` 是 C1 新加的**可空**列。
      { id: COL_POS, type: 'background', name: COL_POS,
        productId: P, meta: { productId: Q }, isSelected: true },
      { id: META_POS, type: 'background', name: META_POS,
        productId: null, meta: { productId: P }, isSelected: true },
      { id: COL_NEG, type: 'background', name: COL_NEG,
        productId: P, meta: { productId: Q }, isRejected: true },
      { id: META_NEG, type: 'background', name: META_NEG,
        productId: null, meta: { productId: P }, isRejected: true },
    ]);

    const { positive, negative } = await loadReviewExamples(P, EXCLUDE);
    const pNames = positive.map((e) => e.name);
    const nNames = negative.map((e) => e.name);

    // 正例集（该函数里的**第一条**查询，条件 `isSelected`）
    expect(pNames).toContain(COL_POS);      // 真列 = P ⇒ 选中
    expect(pNames).not.toContain(META_POS); // 真列 = NULL ⇒ 不得靠 meta 混进来
    // 负例集（该函数里的**第二条**查询，条件 `isRejected` —— 别只钉第一条）
    expect(nNames).toContain(COL_NEG);
    expect(nNames).not.toContain(META_NEG);
  });
});
