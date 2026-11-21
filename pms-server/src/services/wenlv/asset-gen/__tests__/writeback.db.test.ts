import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../../../db/index.js';
import {
  pmsBuiWenlvCharacters, pmsBuiWenlvCollectibles, pmsBuiWenlvScenes, pmsBuiWenlvChapters,
  pmsBuiWenlvScriptRooms, pmsBuiWenlvNpcs,
  pmsBuiWenlvRewards, pmsBuiWenlvRewardTiers, pmsBuiWenlvProducts,
} from '../../../../db/schema/index.js';
import { applyWriteback, buildWritebackPlan } from '../writeback.js';

// ⚠️ 用 vitest.local.config.ts（带 assertLoopback 硬闸，指本地 aipms）。
//    **绝不**用 vitest.db.config.ts —— 那个文件硬编码生产库。
const RUN = !!process.env.RUN_DB;
const P = `wbt-${randomUUID().slice(0, 8)}`;
const ROOM_ID = `room-${P}`;
const CH_ID = `ch-${P}`;

describe.skipIf(!RUN)('回写器 · 真 DB', () => {
  beforeAll(async () => {
    await db.insert(pmsBuiWenlvProducts).values({ id: P, name: '回写测试产品' });
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: ROOM_ID, contentId: P, name: '回写房', mode: 'narrative' });
    await db.insert(pmsBuiWenlvChapters).values({ id: CH_ID, scriptRoomId: ROOM_ID, title: '第一章', order: 0 });
  });
  afterAll(async () => {
    // 只删自己造的，按 productId 精确删
    await db.delete(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, P));
    await db.delete(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, P));
    await db.delete(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, P));
    // NPC（T18）：products 的子表，先删。
    await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    // 角色（T11）：products 的子表，先删。
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    // 场景→章节→房间→产品（外键依赖顺序）
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, CH_ID));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.scriptRoomId, ROOM_ID));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });

  it('ending → scenes.image（结局场景回写，真行断言）', async () => {
    const id = `wbte-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvScenes).values({
      id, chapterId: CH_ID, title: '结局', type: 'ending',
      triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'wb-c1' } },
    });
    await applyWriteback(buildWritebackPlan('ending', id, 'https://oss/e.jpg', 'a-e'));
    const [row] = await db.select({ image: pmsBuiWenlvScenes.image })
      .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, id));
    expect(row.image).toBe('https://oss/e.jpg');
  });

  it('reward → rewards.image', async () => {
    const id = `wbtr-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvRewards).values({ id, productId: P, name: '奖励' });
    await applyWriteback(buildWritebackPlan('reward', id, 'https://oss/r.jpg', 'a-r'));
    const [row] = await db.select({ image: pmsBuiWenlvRewards.image })
      .from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, id));
    expect(row.image).toBe('https://oss/r.jpg');
  });

  it('icon → reward_tiers.icon', async () => {
    const id = `wbtt-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvRewardTiers).values({ id, productId: P, name: '档位' });
    await applyWriteback(buildWritebackPlan('icon', id, 'https://oss/t.png', 'a-t'));
    const [row] = await db.select({ icon: pmsBuiWenlvRewardTiers.icon })
      .from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.id, id));
    expect(row.icon).toBe('https://oss/t.png');
  });

  it('stamp → stamp_meta.stampAssetId，且**不抹掉**既有子键', async () => {
    const id = `wbtc-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvCollectibles).values({
      id, productId: P, name: '证物',
      stampMeta: { shape: '圆', color: '#a00' },     // 既有子键
    });
    await applyWriteback(buildWritebackPlan('stamp', id, 'https://oss/s.png', 'a-stamp'));
    const [row] = await db.select({ m: pmsBuiWenlvCollectibles.stampMeta })
      .from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, id));
    expect(row.m.stampAssetId).toBe('a-stamp');   // 写入的是 **asset id**，不是 URL
    expect(row.m.shape).toBe('圆');                // 合并而非覆盖 —— 这条是本用例的重点
    expect(row.m.color).toBe('#a00');
  });

  it('background → scenes.image（节点背景回写）', async () => {
    const id = `wbtn-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvScenes).values({ id, chapterId: CH_ID, title: '节点', type: 'narrative' });
    await applyWriteback(buildWritebackPlan('background', id, 'https://oss/n.jpg', 'a-n'));
    const [row] = await db.select({ image: pmsBuiWenlvScenes.image })
      .from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, id));
    expect(row.image).toBe('https://oss/n.jpg');
  });

  it('cover → products.coverImage', async () => {
    await applyWriteback(buildWritebackPlan('cover', P, 'https://oss/c.jpg', 'a-c'));
    const [row] = await db.select({ coverImage: pmsBuiWenlvProducts.coverImage })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    expect(row.coverImage).toBe('https://oss/c.jpg');
  });

  // ⚠️ cover 与 anchor 都是 entity:'product'，用的是**同一行 P** ——
  //    两条用例分别断言不同的列，正好验证「按 column 分派」而不是「按 entity 一刀切」。
  it('anchor → products.styleAnchorUrl，且**不碰 coverImage**', async () => {
    // 「期望 ≥1」对照：先证明 coverImage 此刻**真的有值**（上面 cover 用例刚写的）。
    // 没有这一条，万一 coverImage 恒为 null，下面的「未被改动」就会在**任何**实现下
    // 都成立 —— 那条断言静默失去区分度，而它照样是绿的。
    const [before] = await db.select({ coverImage: pmsBuiWenlvProducts.coverImage })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    expect(before.coverImage).toBe('https://oss/c.jpg');

    await applyWriteback(buildWritebackPlan('anchor', P, 'https://oss/sa.jpg', 'a-sa'));
    const [row] = await db.select({
      styleAnchorUrl: pmsBuiWenlvProducts.styleAnchorUrl,
      coverImage: pmsBuiWenlvProducts.coverImage,
    }).from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
    expect(row.styleAnchorUrl).toBe('https://oss/sa.jpg');
    // 锚图回写**只动 styleAnchorUrl**。只断言 styleAnchorUrl 的话，「product 分支一次写两列」
    // 这类 bug 抓不到：styleAnchorUrl 照样对，而 coverImage 被锚图 URL 顶掉 ——
    // 游客端主题 Banner 读的正是 coverImage，症状是「封面偷偷换了」，且没有任何报错。
    expect(row.coverImage).toBe(before.coverImage);
  });

  it('collectible → collectibles.image', async () => {
    const id = `wbtcol-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvCollectibles).values({ id, productId: P, name: '条目' });
    await applyWriteback(buildWritebackPlan('collectible', id, 'https://oss/col.jpg', 'a-col'));
    const [row] = await db.select({ image: pmsBuiWenlvCollectibles.image })
      .from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.id, id));
    expect(row.image).toBe('https://oss/col.jpg');
  });

  // T18（spec §5.4）：NPC 立绘回写 `npcs.portrait_url`。target_id 是 NPC id。
  // 与 collectible 同型——按自身实体展开，buildWritebackPlan 拿 targetId 找行。
  it('npc_portrait → npcs.portraitUrl', async () => {
    const id = `wbtnpc-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvNpcs).values({
      id, productId: P, orderId: 0, name: 'NPC 立绘回写夹具',
      // lines 列 NOT NULL DEFAULT '{}'，但 drizzle 入参不带时落默认；这里显式给空数组保口径一致。
      lines: [],
    });
    await applyWriteback(buildWritebackPlan('npc_portrait', id, 'https://oss/npc.png', 'a-npc'));
    const [row] = await db.select({ portraitUrl: pmsBuiWenlvNpcs.portraitUrl })
      .from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id));
    expect(row.portraitUrl).toBe('https://oss/npc.png');
  });

  // T11（spec §11）：角色头像回写 `characters.avatar_url`。target_id 是角色 id。
  // 与 npc_portrait 同型——按自身实体展开，buildWritebackPlan 拿 targetId 找行。
  it('character_avatar → characters.avatarUrl', async () => {
    const id = `wbtchar-${randomUUID().slice(0, 8)}`;
    await db.insert(pmsBuiWenlvCharacters).values({
      id, productId: P, name: '沈砚', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    });
    await applyWriteback(buildWritebackPlan('character_avatar', id, 'https://oss/ch.png', 'a-ch'));
    const [row] = await db.select({ avatarUrl: pmsBuiWenlvCharacters.avatarUrl })
      .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id));
    expect(row.avatarUrl).toBe('https://oss/ch.png');
  });

  it('targetId 为空 → 不写、返回 false（缺键静默跳过）', async () => {
    expect(await applyWriteback(buildWritebackPlan('ending', null, 'u', 'a'))).toBe(false);
  });
});
