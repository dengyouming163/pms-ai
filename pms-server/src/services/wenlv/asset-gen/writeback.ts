/**
 * 业务表回写器（子项目①）。
 *
 * **取代**了 `pms-server/src/services/wenlv-asset-gen-scheduler.ts` 里原先的两段硬编码回写：
 *   · `if (isAnchor) { … products.styleAnchorUrl }`
 *   · `if (background) … else if (cover) … else if (collectible) …`（三个分支）
 * 它们已被本 Task 删除，锚图与其余图类现在走同一条查表路径。原先之所以长成 if/else，
 * 是因为每个分支的**目标键不同**（nodeId / productId / collectibleId），
 * 而注册表把「目标键」统一成了 `target_kind` + `target_id` 对，于是这里可以退化成一张查表。
 *（行号不写死：写死的行号正是本次要修的病。要定位请 grep 函数名。）
 *
 * ## 为什么拆成「计划（纯函数）」+「执行（副作用）」两半
 *
 * `buildWritebackPlan` 不碰数据库，所以它的正确性（写哪张表、哪一列、URL 还是 assetId）
 * 可以被**纯函数单测**逐类型钉死 —— 而真 DB 只用来验证 SQL 真的写对了列。
 * 混在一起的话，每条断言都要起一个数据库，等于慢十倍还更容易漏类型。
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvCharacters, pmsBuiWenlvCollectibles,
  pmsBuiWenlvNpcs, pmsBuiWenlvProducts, pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers,
  pmsBuiWenlvScenes,
} from '../../../db/schema/index.js';
import { ASSET_TYPES, type JobAssetType } from './asset-types.js';
import type { WritebackEntity } from './writeback-type.js';

export type WritebackPlan = {
  entity: WritebackEntity;
  id: string;
  column: string;
  jsonKey: string | null;
  /** 实际要写进去的值：URL 或 assetId。 */
  value: string;
};

/**
 * 算出「往哪张表的哪一列写什么值」。**纯函数。**
 *
 * `targetId` 为空时返回 `null` —— 静默跳过是**有意**的：素材已经生成并进了资源库，
 * 只是没找到写回目标，这不构成任务失败。缺键的根因在 planBatch 的展开键，
 * 在那里修，不要在这里抛错把一次已经付费的生成打成 failed。
 */
export function buildWritebackPlan(
  assetType: JobAssetType,
  targetId: string | null | undefined,
  url: string,
  assetId: string,
): WritebackPlan | null {
  const def = ASSET_TYPES[assetType];
  if (!def || def.writeback === null) return null;
  const id = (targetId ?? '').trim();
  if (!id) return null;
  const wb = def.writeback;
  return {
    entity: wb.entity,
    id,
    column: wb.column,
    jsonKey: wb.jsonKey ?? null,
    value: wb.value === 'assetId' ? assetId : url,
  };
}

/**
 * 执行回写。返回是否真的写了（`false` = 无计划，静默跳过）。
 *
 * `jsonKey` 非空时用 `||` **合并** jsonb 子键，而不是整列覆盖 ——
 * `collectibles.stamp_meta` 还有 shape / color / icon / pattern 等键，
 * 整列覆盖会把它们一起抹掉，且**不会报错**。
 *
 * ⚠️ 合并前必须 `COALESCE(…, '{}'::jsonb)`。**这不是多余的防御，是实测过的雷**：
 *    `NULL::jsonb || '{"a":1}'::jsonb` 在 PG 里返回 **NULL**（本地库实测 `is_null = t`）——
 *    jsonb 的 `||` 是**严格**算子，不把 SQL NULL 当空对象。而「写成 NULL」与「补丁没生效」
 *    在库里长得一模一样：`stampAssetId` 永远填不上，且没有任何报错。
 *    今天 `pmsBuiWenlvCollectibles.stampMeta` 恰好是 `NOT NULL DEFAULT '{}'`
 *    （见 `db/schema/wenlv.ts`），所以裸 `||` 也能跑 —— **但那把正确性押在了另一个文件的
 *    一条约束上**：约束哪天被去掉、或有人用裸 SQL 写入 NULL，这里就静默变成 no-op。
 *    COALESCE 之后这里不再依赖那条约束。
 */
export async function applyWriteback(plan: WritebackPlan | null): Promise<boolean> {
  if (!plan) return false;
  const now = new Date();

  if (plan.jsonKey) {
    const patch = JSON.stringify({ [plan.jsonKey]: plan.value });
    switch (plan.entity) {
      case 'collectible':
        // COALESCE 的理由见本函数文档注释：`NULL::jsonb || x` = NULL（本地库实测），
        // 而那会让「写成了 NULL」与「补丁没生效」完全同形。
        await db.update(pmsBuiWenlvCollectibles)
          .set({
            stampMeta: sql`COALESCE(${pmsBuiWenlvCollectibles.stampMeta}, '{}'::jsonb) || ${patch}::jsonb`,
            updatedAt: now,
          })
          .where(eq(pmsBuiWenlvCollectibles.id, plan.id));
        return true;
      default:
        // 目前只有 stamp 走 jsonb 分支。新增 jsonb 目标时在这里加 case ——
        // 落到这里说明注册表声明了 jsonKey 但执行器还没支持，**必须出声**。
        throw new Error(`回写器尚不支持 jsonb 目标：entity=${plan.entity} jsonKey=${plan.jsonKey}`);
    }
  }

  // ⚠️ **只有 `product` 分支读 `plan.column`，其余分支都硬编码列名。** 它们今天各只写一列，
  //    （`collectible` 这个 entity 有**两个**回写目标 —— `image` 与 `stampMeta` —— 但
  //     `stampMeta` 在函数开头就走 `jsonKey` 分支 return 了，**进不到这个 switch**，所以
  //     它在这里仍只占一列。别被「只有一列」误导成「collectible 只有一个目标」。）
  //    所以没有死字段；但这是与 `narration` 同族的隐患 —— 一旦某个 entity 长出第二列
  //    （例如 `ending` 想同时存插画与分享图），这里会**静默写错列**，而意图表
  //    （`writeback.test.ts` 的手写表）守得住 `buildWritebackPlan` 的 column、
  //    守不住这个 switch 的硬编码。到那时请照 `product` 分支改成按 column 分派 + 末支抛错。
  switch (plan.entity) {
    case 'node':
      // 0079 统一模型：节点即 scenes。节点有两个回写列：`image`（背景插画）与 `arAssetUrl`（AR 灵体视频）。
      // **按 column 分派**，与 `product`/`npc`/`character` 分支同款 —— 当前背景图只有
      // 一个回写列（image），但 AR 视频要写 `ar_asset_url`，硬编码会静默写错列。
      // 末分支抛错：将来加第三个节点级列时，兜底写法会把它静默写进背景图。
      if (plan.column === 'image') {
        await db.update(pmsBuiWenlvScenes)
          .set({ image: plan.value, updatedAt: now }).where(eq(pmsBuiWenlvScenes.id, plan.id));
      } else if (plan.column === 'arAssetUrl') {
        await db.update(pmsBuiWenlvScenes)
          .set({ arAssetUrl: plan.value, updatedAt: now }).where(eq(pmsBuiWenlvScenes.id, plan.id));
      } else {
        throw new Error(`回写器不支持的节点列：${plan.column}`);
      }
      return true;
    case 'product':
      // 两个产品级列：coverImage 与 styleAnchorUrl。**按 column 分派**，不是按类型硬编码。
      // 末分支抛错而不是兜到 coverImage：将来加第三个产品级列时，
      // 兜底写法会把它**静默写进封面图**（与 narration 那把枪同族）。宁可出声。
      if (plan.column === 'styleAnchorUrl') {
        await db.update(pmsBuiWenlvProducts)
          .set({ styleAnchorUrl: plan.value, updatedAt: now })
          .where(eq(pmsBuiWenlvProducts.id, plan.id));
      } else if (plan.column === 'coverImage') {
        await db.update(pmsBuiWenlvProducts)
          .set({ coverImage: plan.value, updatedAt: now })
          .where(eq(pmsBuiWenlvProducts.id, plan.id));
      } else {
        throw new Error(`回写器不支持的产品列：${plan.column}`);
      }
      return true;
    case 'collectible':
      await db.update(pmsBuiWenlvCollectibles)
        .set({ image: plan.value, updatedAt: now }).where(eq(pmsBuiWenlvCollectibles.id, plan.id));
      return true;
    case 'ending':
      // 0079 统一模型：结局即 scenes（type='ending'）。scenes 表有 updatedAt，写入。
      await db.update(pmsBuiWenlvScenes)
        .set({ image: plan.value, updatedAt: now }).where(eq(pmsBuiWenlvScenes.id, plan.id));
      return true;
    case 'reward':
      // ⚠️ 本表**没有** updated_at 列（见 db/schema/wenlv.ts 的 pmsBuiWenlvRewards）—— 别顺手补 updatedAt。
      await db.update(pmsBuiWenlvRewards)
        .set({ image: plan.value }).where(eq(pmsBuiWenlvRewards.id, plan.id));
      return true;
    case 'tier':
      await db.update(pmsBuiWenlvRewardTiers)
        .set({ icon: plan.value, updatedAt: now }).where(eq(pmsBuiWenlvRewardTiers.id, plan.id));
      return true;
    case 'npc':
      // T18（spec §5.4 S2）：NPC 立绘回写。`plan.id` 是 NPC id，写 `npcs.portrait_url`。
      // **按 column 分派**，与 `product` 分支同款 —— 当前 NPC 只有一个回写列（portraitUrl），
      // 但保持与 product 一致的形状，将来若加 `npcs.icon_url` 等第二列时不至于静默写错列。
      if (plan.column === 'portraitUrl') {
        await db.update(pmsBuiWenlvNpcs)
          .set({ portraitUrl: plan.value, updatedAt: now })
          .where(eq(pmsBuiWenlvNpcs.id, plan.id));
      } else {
        throw new Error(`回写器不支持的 NPC 列：${plan.column}`);
      }
      return true;
    case 'character':
      // T11（spec §11）：角色头像回写。`plan.id` 是角色 id，写 `characters.avatar_url`。
      // **按 column 分派**，与 `npc` 分支同款 —— 当前角色只有一个回写列（avatarUrl），
      // 但保持同族形状，将来若加第二列时不至于静默写错列。
      // `characters` 表**有** `updatedAt`（见 db/schema/wenlv.ts 的 pmsBuiWenlvCharacters），
      // 与 node/collectible 同款写上。
      if (plan.column === 'avatarUrl') {
        await db.update(pmsBuiWenlvCharacters)
          .set({ avatarUrl: plan.value, updatedAt: now })
          .where(eq(pmsBuiWenlvCharacters.id, plan.id));
      } else {
        throw new Error(`回写器不支持的角色列：${plan.column}`);
      }
      return true;
    default: {
      // ⚠️ 这个 `default` **不是**防御性冗余，是必须的：
      //   ① 没有它，函数在 `WritebackEntity` 新增成员时会**编译通过**并静默 `return undefined`
      //      —— 声明的是 `Promise<boolean>`，调用方 `if (await applyWriteback(...))` 会把它
      //      当 false 走「没写」分支，而库里的行根本没被写。**静默失效**。
      //   ② `WritebackEntity` 加了成员而这里没加 case，说明注册表声明了一个没有任何执行器
      //      支持的目标 —— 必须出声，不能装作写成功。
      //   `never` 断言让「将来有人加了 entity 却漏了这个 switch」在 **ts-check 阶段**就红。
      const _exhaustive: never = plan.entity;
      throw new Error(`回写器不支持的目标实体：${String(_exhaustive)}`);
    }
  }
}

/**
 * 旁白专用：目标列由调用方显式给出（`nodes.narrationUrl`），不走注册表。
 *
 * ⚠️ **不是**因为「注册表不管旁白」—— 注册表里 `narration.writeback` 已显式置 `null`
 *（见 `asset-types.ts` 的 narration 条），`buildWritebackPlan('narration', …)` 返回 `null`，
 * `applyWriteback` 永不进 `node` 分支。这里再单点一份，是因为 `applyWriteback` 的
 * `node` 分支**只看 entity、不看 column**：真喂进去会把旁白 URL 写进 `nodes.image`
 *（覆盖背景图），**静默写错列**。旁白不是图类，没有候选、没有评审 —— 它从一开始
 * 就不该拥有一个「图类形状」的回写声明。
 */
export async function writeNarrationUrl(nodeId: string, url: string): Promise<void> {
  // 0079 统一模型：旁白 URL 写 scenes.narrationUrl。
  await db.update(pmsBuiWenlvScenes)
    .set({ narrationUrl: url, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvScenes.id, nodeId));
}
