import { describe, it, expect } from 'vitest';
import { shouldReview } from '../reviewer.js';
import { GENERATABLE_TYPES } from '../asset-types.js';

describe('哪些素材要评审', () => {
  it('首轮只评**被采纳的那一张**（候选全评的成本是 N 倍，而只有一张进业务表）', () => {
    expect(shouldReview({ candidateIndex: 0, isSelected: true })).toBe(true);
    expect(shouldReview({ candidateIndex: 1, isSelected: false })).toBe(false);
  });

  // ⚠️ 上面那条的非零 index 恒为 `isSelected: false`，被 `!isSelected` **先短路** ——
  //    删掉 `candidateIndex !== 0` 那句，上面整组仍全绿（已实测）。本条的 `isSelected: true`
  //    才让 index 子句**单独承重**：被采纳的是第 3 张（第 1 张转存失败的回退路径）时不评。
  it('被采纳、但 index !== 0 的那张不评（首轮只评 index 0）', () => {
    expect(shouldReview({ candidateIndex: 2, isSelected: true })).toBe(false);
  });

  it('旁白不评（不是图，视觉评价器无从下手）', () => {
    expect(shouldReview({ candidateIndex: 0, isSelected: true, assetType: 'narration' })).toBe(false);
  });

  // 锚图是**风格基准本身**，评它是**范畴错误**。
  // ⛔ 旧注释写的是「参照图就是它自己 ⇒ 与自己比风格漂移恒达标」——**那条理由是错的**：
  //    `reviewAssetJob`（`wenlv-asset-gen-scheduler.ts`）的 refs **已自过滤**掉与待评素材
  //    同 URL 的参照图，锚图不会「自己比自己」。
  //    真正的理由：自过滤后参照集只剩风格图集（可能为空）⇒ 分数**无参照语义**，
  //    却仍是一次白花的付费视觉调用。措辞与 `reviewer.ts` 的 `isReviewableType`/`shouldReview` 注释同源。
  it('锚图不评（它是风格基准本身，评它是范畴错误 —— 自过滤后无参照语义）', () => {
    expect(shouldReview({ candidateIndex: 0, isSelected: true, assetType: 'anchor' })).toBe(false);
  });

  it('评审任务自身不再被评审（防无限递归）', () => {
    expect(shouldReview({ candidateIndex: 0, isSelected: true, assetType: 'review' })).toBe(false);
    expect(shouldReview({ candidateIndex: 0, isSelected: true, assetType: 'style_bible' })).toBe(false);
  });
});

// ⛔ 守卫：`review` 是合成行，**没有产物**。它一旦混进 `GENERATABLE_TYPES`，
//    调用方（Task 15 的 `VALID_TYPES = GENERATABLE_TYPES`）就能把 `types: ['review']`
//    当成一次合法批次请求，`planBatch` 会给这条合成行排一个**真实的付费出图 job**。
//    `GENERATABLE_TYPES` 上的 `(t): t is GeneratableType` 是**类型断言**，TS 拦不住。
describe('review 不进可生成类型', () => {
  it('GENERATABLE_TYPES 不含 review', () => {
    // ⚠️ 不能写 `expect(GENERATABLE_TYPES).not.toContain('review')` —— `'review'` 不在
    //    `GeneratableType` 联合里，那样写**编译不过**；断言本身反而成了类型级证据。
    expect([...GENERATABLE_TYPES] as string[]).not.toContain('review');
  });
});
