/**
 * 人工评审样本的取数（spec §8.5「人工审核也是评价的一路」）。
 *
 * 运营在评审面板里的正常动作**自动**变成下一次评审的参照样本：
 *   · 人工**采纳**的（`is_selected`）→ 正例集
 *   · 人工**明确淘汰**的（`is_rejected`）→ 负例集
 * 不需要额外的标注工序 —— 这一点是本模块存在的全部理由：把「已经在做的活」
 * 变成「下一次评审的校准数据」，而不是新增一道标注流程（那种流程没人会做）。
 *
 * ── 两条口径（计划 §3，都是产品决策）──────────────────────────────
 *
 * ① **不跨产品**。`products` 之间的风格基线可以完全不同（一个水墨、一个赛博），
 *    跨产品取样本等于拿另一套判据的图来校准这一套 —— 比没有样本更糟。
 * ② **淘汰的载体是 `is_rejected`，不是 `is_selected = false`**。后者还包括
 *    「还没人看过」。把「只是没轮上」的图当成负例喂进去，会把评价器往
 *    「凡是没被选中的都不好」的方向校准 —— 而候选组里本来就**只有一张**会被选中，
 *    那条规则会让评价器对每组的第 2、3 张都判低分。
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvDesignAssets } from '../../../db/schema/index.js';
import { FEW_SHOT_LIMIT, type ReviewExample, type ReviewExamples } from './reviewer.js';

/** 只取渲染要用的列。整行 `select()` 会把这个表的所有 jsonb 拖出来（本表上量后是热路径）。 */
const EXAMPLE_COLUMNS = {
  name: pmsBuiWenlvDesignAssets.name,
  reviewScore: pmsBuiWenlvDesignAssets.reviewScore,
  humanReviewScore: pmsBuiWenlvDesignAssets.humanReviewScore,
  humanReviewDetail: pmsBuiWenlvDesignAssets.humanReviewDetail,
  updatedAt: pmsBuiWenlvDesignAssets.updatedAt,
};

type ExampleRow = {
  name: string;
  reviewScore: string | null;
  humanReviewScore: string | null;
  humanReviewDetail: { comment?: unknown } | null;
};

/**
 * 行 → 渲染用的样本。
 *
 * ⚠️ **分数优先取人工的**：样本之所以是「样本」，是因为有人的判断在里面。
 *    只有人工没打分时（采纳动作只写 `reviewSource`、不给分）才回落到 AI 分 ——
 *    否则样本上的分是评价器自己的旧输出，喂回去就是**自我强化**
 *    （评价器给 3 分 → 当负例 → 教评价器给低分 → 「分不开」被自己造出来）。
 *
 * ⚠️ `humanReviewDetail` 是 jsonb，**形状零校验**（调用方写、字面量拼）。
 *    `comment` 不是字符串就置 `null`（渲染成「无意见」），别把对象灌进模板串 ——
 *    那会渲染成 `[object Object]` 喂给模型，且**不报错**。
 */
function toExample(r: ExampleRow): ReviewExample {
  const comment = r.humanReviewDetail?.comment;
  return {
    name: r.name,
    score: r.humanReviewScore ?? r.reviewScore ?? null,
    comment: typeof comment === 'string' ? comment : null,
  };
}

/**
 * 取一个产品的正反例样本。**已按 `updatedAt` 倒序**（最近的最有代表性），
 * 各取至多 `FEW_SHOT_LIMIT` 条 —— 与 `fewShotBlock` 的渲染截断**共用同一个常量**。
 *
 * ⚠️ `excludeAssetId` 是承重的：待评的这张图自己就是 `is_selected = true`
 *    （首轮只评被采纳的那张），不排除的话它会**把自己的旧分当正例喂给自己** ——
 *    模型看到「这张图上次 7 分」然后给 7 分，看似稳定，实际是自证。
 *
 * ⚠️ 查询条件里 `is_rejected` 那一半**必须带 `is_selected = false` 的排除**（`ne`）：
 *    两个标记理论上互斥，但 DB 层**没有**约束它们互斥（没有 check、没有唯一索引），
 *    一条「先采纳、后淘汰」的记录会两列同时为真 ⇒ 同一张图同时出现在正例与负例里，
 *    模型收到自相矛盾的校准信号且**无任何报错**。
 */
export async function loadReviewExamples(
  productId: string, excludeAssetId: string,
): Promise<ReviewExamples> {
  const [positiveRows, negativeRows] = await Promise.all([
    db.select(EXAMPLE_COLUMNS).from(pmsBuiWenlvDesignAssets)
      .where(and(
        eq(pmsBuiWenlvDesignAssets.productId, productId),
        eq(pmsBuiWenlvDesignAssets.isSelected, true),
        ne(pmsBuiWenlvDesignAssets.id, excludeAssetId),
      ))
      .orderBy(desc(pmsBuiWenlvDesignAssets.updatedAt))
      .limit(FEW_SHOT_LIMIT),
    db.select(EXAMPLE_COLUMNS).from(pmsBuiWenlvDesignAssets)
      .where(and(
        eq(pmsBuiWenlvDesignAssets.productId, productId),
        eq(pmsBuiWenlvDesignAssets.isRejected, true),
        // 见 docstring：两个标记在 DB 层没有互斥约束，这里显式排除重叠。
        ne(pmsBuiWenlvDesignAssets.isSelected, true),
        ne(pmsBuiWenlvDesignAssets.id, excludeAssetId),
      ))
      .orderBy(desc(pmsBuiWenlvDesignAssets.updatedAt))
      .limit(FEW_SHOT_LIMIT),
  ]);
  return { positive: positiveRows.map(toExample), negative: negativeRows.map(toExample) };
}
