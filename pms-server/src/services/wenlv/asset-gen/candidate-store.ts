/**
 * 候选落库（子项目①）。
 *
 * 方舟一次调用返回 N 张图、**一次计费**。所以 N 张落在 `design_assets` 的 N 行上，
 * `job_id` 就是候选组本身 —— **不是** N 个 job 行。摊成 N 个 job 行的代价是
 * 「一次计费」在账面上变成「N 次计费」，而成本是本子项目的交付判据。
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvDesignAssets } from '../../../db/schema/index.js';
import { PUBLIC_POOL_TYPES } from './asset-types.js';
import { fitTag, type JobAssetType } from './enqueue.js';

/**
 * 候选在 design_assets 里的 id。
 *
 * **index 0 必须保持 `wa-<jobId>`** —— 那是迁移 0033 之前 `writeAsset` 的既有命名，
 * 既有素材行用的就是它。改成别的会让历史行变成孤儿（新行插入、旧行残留），
 * 表现为素材库里同一张图出现两份。
 *
 * 截断按**码点**（`Array.from`），不能用 `.slice()` —— 后者按 UTF-16 码元切，
 * 从代理对中间切开会产生孤立代理项，落库时被编码成 U+FFFD：无报错、无日志的脏值。
 *
 * ⚠️ **先给后缀留位、再截 jobId**（而不是「先拼后整体截」）：后者在 jobId 很长时会把
 *    `-N` 截掉，于是 index 0 与 index N **算成同一个 id** —— 第二次 `writeCandidate`
 *    会**更新**第一行，两张候选**静默塌成一行**。今天不可达（job id 全是 36 字符 UUID，
 *    `3+36+2 = 41 ≤ 50`），但函数本身没有断言，换个 id 来源就静默损坏。
 *    对一切现存数据**逐字节不变**：36 字符 UUID 下 index 0 → `wa-<36>`、index N → `wa-<36>-N`。
 */
export function designAssetIdFor(jobId: string, index: number): string {
  const suffix = index === 0 ? '' : `-${index}`;
  const room = 50 - 3 - suffix.length;              // 'wa-' + jobId + suffix
  return `wa-${Array.from(jobId).slice(0, room).join('')}${suffix}`;
}

/** 素材行服务的要素坐标。两个字段**同生同死**（见 `targetFieldsOf`）。 */
export type ArtifactTarget = {
  targetKind: string | null;
  targetId: string | null;
};

/**
 * 从 job 行取坐标。**两条写路径共用这一份**
 *（`writeCandidate` 图类 / `writeAsset` 旁白，后者在
 * `services/wenlv-asset-gen-scheduler.ts`，从本文件 import）。
 *
 * 做成一个具名函数的唯一理由：这两处曾经**各写一份字段集**，于是 `job_id` 只加在了
 * 图类那一条上，旁白行的 `job_id` 恒为 NULL 且完全无声（设计文档 §2.3）。抽出来之后，
 * 「加一列要改两处」这件事至少有了一个具名的地方可以 grep。
 *
 * ⚠️ **本函数产出的两个字段同生同死**：给了 kind 却给不出 id 是半个坐标，别只留一个。
 *    守卫里的 `!id` 与 `!kind` 各挡一侧，两条用例分别钉住（少一条那一侧就零判别力）。
 *    适用范围**仅限本函数产出的值**，**不是**这两列的全局不变量：
 *    ① 迁移 0038 的回填**反方向没有谓词** —— job 是 `kind` 有、`id` 空时它照抄出一条
 *       `(kind, NULL)`。0038 把这一侧叫「**半空**」；「只有 id」是另一侧，**别混用**。
 *    ② 删要素时的**有意解绑**写 `(NULL, NULL)` —— 那是设计允许的终态（决策 2）。
 *    半空行是脏态，且**今天就有判据会红**：`wenlv-design-target.db.test.ts` 的「不变量」
 *    全表断言把 `(kind, NULL)` 算作不一致（写路径漏写一列的典型形状）—— 不靠「将来某天」。
 *    ⚠️ 至于「全景页把这种行当成指向空的孤儿来报」：读侧 `GET /assets` 已经把这两列原样
 *       透出（不再按 `jobId` 回查 job），但**全景页本身属另一份计划（切片②）**，尚未实现
 *       ⇒ 它是**将来态**，别当既有消费者引用。
 */
export function targetFieldsOf(job: {
  targetKind?: string | null;
  targetId?: string | null;
}): ArtifactTarget {
  const id = job.targetId ?? null;
  const kind = job.targetKind ?? null;
  if (!id || !kind) return { targetKind: null, targetId: null };
  return { targetKind: kind, targetId: id };
}

export type ArtifactInput = {
  jobId: string;
  index: number;
  assetType: string;
  name: string;
  url: string;
  productId: string | null;
  venueId: string | null;
  iteration: number;
  communityStyleTag: string | null;
  extraMeta: Record<string, unknown>;
  /** 这一行服务的要素（坐标系）。**必填** —— 有默认值就会让漏传的调用点静默走老路径
   *  （本仓前科：有默认值的开关让新分支零覆盖，见 memory
   *  `new-branch-unreachable-via-default`）。取用 `targetFieldsOf(job)`。 */
  target: ArtifactTarget;
  /** 组内被采纳的那一张。 */
  isSelected: boolean;
};

/**
 * 落一行候选。**幂等**（同 id 存在则更新）—— 重试路径要能安全重入。
 *
 * ⚠️ 必须是**单条原子 upsert**，不能写成「先 select 再 insert/update」：后者在并发下
 *    两个调用者都查不到、都 insert ⇒ 主键冲突。今天同 job 的 N 次写是顺序 for，看似安全，
 *    **但多副本下这条链是可达的**：副本 A 在途超过 `STALE_MINUTES` → 副本 B 的
 *    `reclaimStale` 把它判 failed → 运维 `/retry` → 第三个副本与 A 并发跑同一 job。
 *    Task 7 的租约原语正是为多副本做的前置，所以这里不能留下这个缝。
 *    语义与「存在则 update、否则 insert」**等价**，且少一次往返。
 */
export async function writeCandidate(a: ArtifactInput): Promise<string> {
  const id = designAssetIdFor(a.jobId, a.index);
  const values = {
    type: a.assetType,
    name: Array.from(String(a.name)).slice(0, 100).join(''),
    url: a.url,
    styleTag: fitTag(a.communityStyleTag ?? ''),
    // 公共池判定**复用注册表那一份清单** —— 在轮询器里再手写一遍是两处规格，
    // 日后加一个公共池类型时这里会悄悄把它的 venue_id 写成私有。
    venueId: PUBLIC_POOL_TYPES.has(a.assetType as JobAssetType) ? null : a.venueId,
    // 剧本级归属真列（迁移 0036 加列 + 从 meta 回填）。与下面 `meta.productId` **双写**，
    // **不是搬家**：C6 才把查询源切到本列，在那之前读侧仍读 meta，删掉 meta 那份会让
    // 素材列表静默变空。同源的还有调度器 `writeAsset`。
    productId: a.productId,
    // 坐标系（迁移 0038）。⚠️ 与 `writeAsset` 那份是同一个函数的返回值 —— 别在这里
    // 内联展开成 `targetKind: a.target.targetKind`，那又是「两处各写一份」。
    ...a.target,
    jobId: a.jobId,
    candidateIndex: a.index,
    isSelected: a.isSelected,
    meta: { jobId: a.jobId, productId: a.productId, iteration: a.iteration, ...a.extraMeta },
    isBuiltin: false,
  };
  await db.insert(pmsBuiWenlvDesignAssets)
    .values({ id, ...values })
    .onConflictDoUpdate({
      target: pmsBuiWenlvDesignAssets.id,
      set: { ...values, updatedAt: new Date() },
    });
  return id;
}

/**
 * 改选：把组内某一张设为被采纳，其余置否。
 *
 * ⚠️ **顺序要紧**：必须先清后设。反过来的话，DB 上的不变量索引
 * `uq_wenlv_design_assets_selected`（一个 job 至多一张 true）会在
 * 「新的已设 true、旧的还没清」的瞬间拒绝写入 —— 表现为改选偶发失败，
 * 且有并发时更频繁，非常难查。
 *
 * ## `source` 为什么必须是**显式入参**（不是默认值）
 *
 * 本函数有**两个调用者**，而它们对「谁采纳的」这件事的答案**不同**：
 *   · `routes/admin/wenlv-asset-gen.ts` 的 `POST /select` —— **人**点的；
 *   · `wenlv-asset-gen-scheduler.ts` 的收尾自选（`selected = landed.find(index===0) ?? landed[0]`）
 *     —— **机器**挑的，全程没有人参与。
 * 只有前者算「人工审核也是评价的一路」（spec §8.5）。把 `reviewSource: 'human'`
 * 无条件写在函数里，机器自选也会被标成人工，后果**两条都很静默**：
 *   1. 收尾自选**严格早于**同函数末尾那次自动评（`scheduler.ts` 是
 *      `selectCandidate` → `applyWriteback` → 改 `succeeded` → `shouldReview` → `reviewAssetJob`），
 *      于是去重闸会**把每一张刚生成的图的首轮评审整个拦掉** —— 自动评功能整体失效，
 *      而表面上一切正常（只是从此再也没有分数、也没有记账行）；
 *   2. 「人工采纳」这个信号被污染：`review-examples.ts` 的正例集
 *      （`is_selected = true`）会把**没有任何人看过**的图当成人工正例喂回 prompt。
 * `run-once.db.test.ts`「图类 job 带锚图作参考图」正是 (1) 的看守用例（它红了）。
 * ⛔ 故**不做默认值**：`?? 'machine'` 之类的兜底会让漏传的调用点静默走老路径
 *    （本仓前科：有默认值的开关让新分支零覆盖）。宁可让编译期拦下。
 */
export async function selectCandidate(
  jobId: string, index: number, source: 'human' | 'machine',
): Promise<string> {
  await db.update(pmsBuiWenlvDesignAssets)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvDesignAssets.jobId, jobId));
  const id = designAssetIdFor(jobId, index);
  await db.update(pmsBuiWenlvDesignAssets)
    .set({
      isSelected: true,
      // ── 人工采纳也是评价的一路（spec §8.5）──────────────────────────
      // 只写**人工列族**：`reviewScore` / `reviewDetail` / `reviewedAt` / `reviewModel`
      // 四个 AI 列**一个字都不许碰**（口径②：覆写即无法算 `human - ai` 的分差）。
      // `reviewSource: 'human'` 是承重的 —— `reviewAssetJob` 的去重闸读它来决定
      // 要不要发起 AI 补评。不写它，紧接着的补评就会把这一列的 'human' 改回 'ai'：
      // 人工标签**永远存不下来**，而这是完全静默的（响应里看不出来，只有 DB 行知道）。
      // ⛔ 也**不能**改成「在 `/select` 调用点另加一道守卫」：调用点有两个
      //    （调度器收尾的自动评 + `/select` 的补评），加在任一个上另一条依旧漏
      //    —— 见 `reviewAssetJob` 开头那段去重闸注释。
      // ⚠️ 只在**人**采纳时写（见函数头 `source` 那段的第 1/2 条后果）：
      //    机器自选写这一列会连带把首轮自动评整个拦掉。
      ...(source === 'human'
        ? { reviewSource: 'human' as const, humanReviewedAt: new Date() }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(pmsBuiWenlvDesignAssets.id, id), eq(pmsBuiWenlvDesignAssets.jobId, jobId)));
  return id;
}
