import { describe, it, expect } from 'vitest';
import { buildWritebackPlan } from '../writeback.js';
import { ASSET_TYPES } from '../asset-types.js';

describe('回写计划（纯函数）', () => {
  it('background 写 nodes.image 的 URL', () => {
    expect(buildWritebackPlan('background', 'n1', 'https://x/a.jpg', 'a-1'))
      .toEqual({ entity: 'node', id: 'n1', column: 'image', jsonKey: null, value: 'https://x/a.jpg' });
  });

  it('stamp 写 collectibles.stamp_meta 的 assetId 子键（不是 URL）', () => {
    expect(buildWritebackPlan('stamp', 'c1', 'https://x/a.jpg', 'a-1'))
      .toEqual({ entity: 'collectible', id: 'c1', column: 'stampMeta', jsonKey: 'stampAssetId', value: 'a-1' });
  });

  it('ending / reward / icon 各有自己的目标', () => {
    expect(buildWritebackPlan('ending', 'e1', 'u', 'a')).toMatchObject({ entity: 'ending', column: 'image' });
    expect(buildWritebackPlan('reward', 'r1', 'u', 'a')).toMatchObject({ entity: 'reward', column: 'image' });
    expect(buildWritebackPlan('icon', 't1', 'u', 'a')).toMatchObject({ entity: 'tier', column: 'icon' });
  });

  it('没有 targetId 时返回 null（缺键静默跳过，不构成任务失败）', () => {
    expect(buildWritebackPlan('background', null, 'u', 'a')).toBeNull();
  });

  it('writeback 为 null 的类型（style_bible）返回 null', () => {
    expect(buildWritebackPlan('style_bible', 'p1', 'u', 'a')).toBeNull();
  });

  it('每个类型都落到正确的表/列/值（穷举钉死，防注册表漂移）', () => {
    // ⚠️ 这张表**必须手写**，不许从 ASSET_TYPES 派生 ——
    //    派生了就又变成同一律：注册表改错、表跟着改、永远绿。
    //    它的价值正是「与注册表独立」，所以改错注册表会红。
    const want = {
      anchor:      { entity: 'product',     column: 'styleAnchorUrl', jsonKey: null, value: 'https://u/a.jpg' },
      background:  { entity: 'node',        column: 'image',         jsonKey: null, value: 'https://u/a.jpg' },
      // AR 灵体视频（d7c9a02a / 迁移 0064 nodes_ar_asset_urls）：node 级展开，
      // 回写 nodes.ar_asset_url（writeback.ts 的 node 分支按 column 分派）。值为视频 URL。
      ar:          { entity: 'node',        column: 'arAssetUrl',    jsonKey: null, value: 'https://u/a.jpg' },
      cover:       { entity: 'product',     column: 'coverImage',    jsonKey: null, value: 'https://u/a.jpg' },
      collectible: { entity: 'collectible', column: 'image',         jsonKey: null, value: 'https://u/a.jpg' },
      // 旁白**刻意为 null**：它由 writeNarrationUrl 单点承担，不进 applyWriteback。
      // 见 asset-types.ts 的 narration 条。别「顺手」把它填回来。
      narration:   null,
      stamp:       { entity: 'collectible', column: 'stampMeta',     jsonKey: 'stampAssetId', value: 'a-1' },
      icon:        { entity: 'tier',        column: 'icon',          jsonKey: null, value: 'https://u/a.jpg' },
      ending:      { entity: 'ending',      column: 'image',         jsonKey: null, value: 'https://u/a.jpg' },
      reward:      { entity: 'reward',      column: 'image',         jsonKey: null, value: 'https://u/a.jpg' },
      // T18：NPC 立绘回写 `npcs.portrait_url`（spec §5.4「选定后回写 npc.portrait_url」）。
      npc_portrait:{ entity: 'npc',         column: 'portraitUrl',  jsonKey: null, value: 'https://u/a.jpg' },
      // T11：角色头像回写 `characters.avatar_url`（spec §11）。
      character_avatar:{ entity: 'character',    column: 'avatarUrl',    jsonKey: null, value: 'https://u/a.jpg' },
      style_bible: null,
      // 评审**刻意为 null**（与 style_bible 同类）：它是合成行，没有产物、不回写业务表，
      // 只有一笔 token 花费落在 asset_jobs 上。别「顺手」给它编一个回写目标。
      review:      null,
    } as const;

    // 穷举双向：注册表加了类型而这里漏写 ⇒ 红（逼出一次有意识的决定）。
    expect(Object.keys(want).sort()).toEqual(Object.keys(ASSET_TYPES).sort());

    for (const [t, w] of Object.entries(want)) {
      const got = buildWritebackPlan(t as never, 'x1', 'https://u/a.jpg', 'a-1');
      if (w === null) expect(got, t).toBeNull();
      else expect(got, t).toEqual({ id: 'x1', ...w });
    }
  });
});
