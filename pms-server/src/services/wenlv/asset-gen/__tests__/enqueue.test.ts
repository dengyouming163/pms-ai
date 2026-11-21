import { describe, it, expect, beforeEach, vi } from 'vitest';
import { planBatch, toJobRow, enqueueBatch, enqueueIteration, fitTag, MAX_TAG, MAX_EDIT_INPUT_URL, iterationBlockReason } from '../enqueue.js';
import { pmsBuiWenlvAssetJobs, type WenlvStyleBible } from '../../../../db/schema/wenlv.js';

const bible: WenlvStyleBible = { artStyle: '水墨', forbidden: ['现代物件'] };

/** 除锚图相关用例外，其余一律以 skipAnchorInsert: true 起步 —— 单独验锚图插入。 */
const base = {
  batchId: 'b1', venueId: 'v1', productId: 'p1', bible,
  communityStyleTag: null as string | null, skipAnchorInsert: true,
};

describe('planBatch（纯函数）', () => {
  it('为每个节点产出一条 background job + 一条 narration job', () => {
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: '你走进古镇。' },
              { id: 'n2', title: '古井', storyText: '井水很凉。' }],
      types: ['background', 'narration'], communityStyleTag: 'ink',
    });
    // 不写 toHaveLength —— length + toBe 等价，这里保持本文件既有写法。
    // ⚠️ 2026-09-19 更正：原注释给的理由（「桩未声明它（同 toThrow）」）**两半都已不成立** ——
    //    toHaveLength 与 toThrow 自 d5a65359 起都在桩内。是否可用以 src/types/vitest.d.ts 为准。
    expect(jobs.filter(j => j.assetType === 'background').length).toBe(2);
    expect(jobs.filter(j => j.assetType === 'narration').length).toBe(2);
  });

  it('公共池归属按类型判定：印章本轮移出，点位背景私有', () => {
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }],
      // 印章的展开键本轮由「节点」改为「图鉴条目」（spec §5.3），所以要给它一条条目
      // 才会真的产出 job —— 缺了它 `find(...)` 是 undefined，下面的断言会以 TypeError
      // 而不是 AssertionError 变红，读起来像实现崩了。
      collectibles: [{ id: 'c1', name: '铜钱', description: 'd' }],
      types: ['stamp', 'background'], communityStyleTag: 'ink',
    });
    // 印章本轮改为**绑定具体条目**，不再跨剧本复用（spec §5.3）⇒ 不再是公共素材
    expect(jobs.find(j => j.assetType === 'stamp')!.assetIsPublic).toBe(false);
    // 点位背景写实 → 私有
    expect(jobs.find(j => j.assetType === 'background')!.assetIsPublic).toBe(false);
    // 「公共池仍收着谁」由上面的「anchor 进公共池」一条反向钉住 —— 两条一起才排除
    // 「assetIsPublic 恒为 false」这个实现。
  });

  it('基线是**快照**不是引用 —— 基线后续被改，这一版仍解释得清', () => {
    const live: WenlvStyleBible = { artStyle: '水墨', forbidden: ['现代物件'] };
    const jobs = planBatch({
      ...base, bible: live,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }, { id: 'n2', title: '古井', storyText: 'y' }],
      types: ['background'],
    });
    // 两个节点各一条 —— 标题里的「每条」名副其实
    for (const j of jobs) {
      expect(j.styleBibleSnapshot).toEqual(live);
      // 引用实现下这一句必红 —— 这才是「快照」二字真正的判据
      // （toHaveLength 等未在类型桩声明，逐元素断言是等价写法）
      expect(j.styleBibleSnapshot).not.toBe(live);
    }
    live.artStyle = '赛博';
    expect(jobs[0].styleBibleSnapshot.artStyle).toBe('水墨');
    expect(jobs[1].styleBibleSnapshot.artStyle).toBe('水墨');
  });

  it('首版 iteration=1、parentJobId=null、guidance=null', () => {
    const jobs = planBatch({
      ...base, nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
    });
    expect(jobs[0].iteration).toBe(1);
    expect(jobs[0].parentJobId).toBeNull();
    expect(jobs[0].guidance).toBeNull();
  });

  it('节点没有 storyText 时不产 narration job（没有词可念）', () => {
    const jobs = planBatch({
      ...base, nodes: [{ id: 'n1', title: '入镇', storyText: null }], types: ['narration'],
    });
    expect(jobs.length).toBe(0);
  });

  it('storyText 只有空白也当没词 —— 合成空音频只会得到一个坏 URL', () => {
    const jobs = planBatch({
      ...base, nodes: [{ id: 'n1', title: '入镇', storyText: '\n\t ' }], types: ['narration'],
    });
    expect(jobs.length).toBe(0);
  });

  it('超长标题不撑爆 name 列 —— 否则整批 INSERT 原子回滚，连锚图一起丢', () => {
    const long = '镇'.repeat(150);          // 节点标题列宽 200，这是完全合法的标题
    const jobs = planBatch({
      ...base, nodes: [{ id: 'n1', title: long, storyText: 'x' }], types: ['background'],
    });
    const bg = jobs.find(j => j.assetType === 'background')!;
    // 列宽 100。不用 toBeLessThanOrEqual —— 类型桩没声明它
    expect(bg.name.length <= 100).toBe(true);
    expect(bg.name.endsWith('·background')).toBe(true);   // 后缀必须留着，截的是标题
  });

  it('emoji 标题按码点截断 —— 不留下落库变 U+FFFD 的孤立代理项', () => {
    const title = '镇'.repeat(88) + '😀';        // 89 码点 / 90 码元，足够触发截断
    const jobs = planBatch({
      ...base, nodes: [{ id: 'n1', title, storyText: 'x' }], types: ['background'],
    });
    const bg = jobs.find(j => j.assetType === 'background')!;
    // ⚠️ 这一句**必须走一趟 UTF-8 编码往返**才是活的。直接对内存里的 JS 字符串
    //    查 U+FFFD 是一个**恒真的死断言**：截断产生的是**孤立代理项**（U+D800–U+DFFF），
    //    不是 U+FFFD —— U+FFFD 只在**编码那一刻**才被写出来（`Buffer.from` 把孤立
    //    代理项编成 EF BF BD）。2026-09-13 独立复核实测：旧实现下这一句**不会红**，
    //    真正变红的只有下面那条代理项正则，它给了「双重覆盖」的错觉。
    //    加这趟往返，判据才真的等价于落库路径。
    const stored = Buffer.from(bg.name, 'utf8').toString('utf8');
    expect(stored.includes(String.fromCharCode(0xFFFD))).toBe(false);
    // 也不能留孤立代理项本身（U+D800–U+DFFF）——落库时同样会变 U+FFFD。
    // 先消掉**合法**的代理对（高+低成对），再查是否还剩**孤立**的：
    // 旧实现按码元 slice，截断点正好卡在 😀 的代理对中间，会留下一个孤立高代理项。
    expect(/[\uD800-\uDFFF]/.test(bg.name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
    expect(bg.name.endsWith('·background')).toBe(true);
  });

  it('每条 job 的 id 互不相同', () => {
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: 'A', storyText: 'x' }, { id: 'n2', title: 'B', storyText: 'y' }],
      types: ['background'],
    });
    expect(new Set(jobs.map(j => j.id)).size).toBe(2);
    // `new Set(...).size === 2` 对「id 直接取 nodeId」也成立（n1/n2 本就不同），
    // 所以必须钉住 id 不是点位 id 的别名：同一个点位出多条 job 时会撞主键。
    expect(jobs[0].id).not.toBe('n1');
  });

  it('每条 job 带 nodeId 与 sourceText —— 轮询器靠它们写回点位与出词', () => {
    // 这两个字段是「行上的快照」。若只留在 PlannedJob 上不落库，轮询器从
    // 领回的行里读到的是 undefined：旁白必失败，图类的故事部分静默丢失。
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: '你走进古镇。' }],
      types: ['background', 'narration'], communityStyleTag: 'ink',
    });
    const bg = jobs.find(j => j.assetType === 'background')!;
    const na = jobs.find(j => j.assetType === 'narration')!;
    expect(bg.nodeId).toBe('n1');
    expect(bg.sourceText).toBe('你走进古镇。');   // 图类的画面描述同样吃这段故事文本
    expect(na.nodeId).toBe('n1');
    expect(na.sourceText).toBe('你走进古镇。');
    expect(na.communityStyleTag).toBe('ink');   // 落库后 design_assets.style_tag 才有值
  });

  it('锚图没有来源点位：nodeId 与 sourceText 均为 null', () => {
    const jobs = planBatch({ ...base, skipAnchorInsert: false, nodes: [], types: [] });
    expect(jobs[0].assetType).toBe('anchor');
    expect(jobs[0].nodeId).toBeNull();
    expect(jobs[0].sourceText).toBeNull();
  });

  it('没有锚图时，**首条**是 anchor job —— 排在前面，后续图才能参考它', () => {
    const jobs = planBatch({
      ...base, skipAnchorInsert: false,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
    });
    expect(jobs[0].assetType).toBe('anchor');
    expect(jobs.filter(j => j.assetType === 'anchor').length).toBe(1);
  });

  it('已有锚图时不插 anchor job（不重复花这笔钱）', () => {
    const jobs = planBatch({
      ...base, skipAnchorInsert: true,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
    });
    expect(jobs.find(j => j.assetType === 'anchor')).toBe(undefined);
  });

  it('anchor 进公共池 —— 锚图是剧本级资源，不是某场地点位的产物', () => {
    const jobs = planBatch({
      ...base, skipAnchorInsert: false,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
    });
    expect(jobs[0].assetIsPublic).toBe(true);
  });

  it('只选 narration 且无锚图时也插 anchor（后续再加图就有锚了）', () => {
    const jobs = planBatch({
      ...base, skipAnchorInsert: false,
      nodes: [{ id: 'n1', title: '入镇', storyText: '词' }], types: ['narration'],
    });
    expect(jobs[0].assetType).toBe('anchor');
    expect(jobs.length).toBe(2);
  });

  // 封面是**产品级**素材：一个剧本只有一张。曾经按节点展开 ⇒ 6 节点剧本勾一次封面
  // 出 6 张图、计 6 次费，且 6 张互相覆盖同一个 products.cover_image（终值取决于哪条最后完成）。
  it('封面只产一条、nodeId 为 null —— 不随节点数放大', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}`, title: `节点${i}`, storyText: `第 ${i} 段故事`,
    }));
    const jobs = planBatch({
      batchId: 'b-cover', venueId: null, productId: 'p1', bible: {},
      skipAnchorInsert: true, nodes, types: ['cover'], communityStyleTag: null,
    });
    const covers = jobs.filter((j) => j.assetType === 'cover');
    expect(covers.length).toBe(1);
    expect(covers[0]!.nodeId).toBeNull();
    expect(covers[0]!.sourceText).toBeNull();
  });

  // name 不是装饰：scheduler 在 nodeId 为空时拿它当 nodeTitle 喂给 LLM（见
  // wenlv-asset-gen-scheduler.ts 的「不能用 job.name」注释块）。若这里带上 `·cover`
  // 后缀，每张封面的画面描述都会被一个英文素材类型污染。
  // 断言只用**整串相等**：「不带 ·cover 后缀」已被它完全蕴含（`'剧本封面'` 不含
  // `'cover'`），另立一条 `not.toContain` 只会得到一条永远不会独立变红的死断言。
  it('产品级封面的 name 是一个可直接给 LLM 看的中文串，不带素材类型后缀', () => {
    const jobs = planBatch({
      batchId: 'b-cover', venueId: null, productId: 'p1', bible: {},
      skipAnchorInsert: true,
      nodes: [{ id: 'n0', title: '入镇', storyText: '故事' }],
      types: ['cover'], communityStyleTag: null,
    });
    expect(jobs[0]!.name).toBe('剧本封面');
  });

  // 反向锁：上面两条只证明「产了 1 条」。若实现把 cover 整个删掉（而不是抽出来），
  // 也会「不放大」——它必须同时证明「选了 cover 就一定有 1 条」。
  // 这里同时钉**逐类型条数**：节点级类型必须仍按节点数展开（修 cover 不能连带改坏
  // 它们或把别的类型也收成产品级），产品级类型则恒为 1。
  // ⚠️ `stamp` / `icon` 的 `types` 勾选集不变，但两者的展开键本轮从「节点」修正为
  // 「图鉴条目」/「奖励档位」（spec §5.3）—— 所以要给 fixture 各补两条**自身实体**，
  // 下面的 `toBe(2)` 才继续钉住「按自身实体展开」这个真不变量，而不是节点数。
  it('2 节点 × 全类型：节点级各 2 条、产品级（cover）只 1 条', () => {
    const jobs = planBatch({
      batchId: 'b-cover', venueId: null, productId: 'p1', bible: {},
      skipAnchorInsert: true,
      nodes: [
        { id: 'n0', title: '入镇', storyText: '故事一' },
        { id: 'n1', title: '古井', storyText: '故事二' },
      ],
      collectibles: [
        { id: 'c1', name: '铜钱', description: 'd1' },
        { id: 'c2', name: '镖旗', description: 'd2' },
      ],
      tiers: [
        { id: 't1', name: '基础档', description: 'd1' },
        { id: 't2', name: '豪华档', description: 'd2' },
      ],
      types: ['background', 'stamp', 'icon', 'cover', 'narration'],
      communityStyleTag: null,
    });
    const count = (t: string) => jobs.filter((j) => j.assetType === t).length;
    expect(count('background')).toBe(2);
    expect(count('stamp')).toBe(2);
    expect(count('icon')).toBe(2);
    expect(count('narration')).toBe(2);
    expect(count('cover')).toBe(1);
  });

  // 重复的 types 项不该放大成多条 job —— `types` 是集合语义。
  // 曾用 `input.types.includes('cover')`（天然只产一条），改成逐项遍历后
  // `['cover','cover']` 会产 2 条。生产入口 `/batch` 自己有 `new Set`，
  // 但那是别的文件里的保证 —— 这条用例把归一钉在 planBatch 自己身上。
  it('types 含重复项时不放大 —— 归一是 planBatch 自己的责任', () => {
    const jobs = planBatch({
      batchId: 'b-dup', venueId: null, productId: 'p1', bible: {},
      skipAnchorInsert: true,
      nodes: [{ id: 'n0', title: '入镇', storyText: '故事' }],
      types: ['cover', 'cover', 'background', 'background'], communityStyleTag: null,
    });
    expect(jobs.filter((j) => j.assetType === 'cover').length).toBe(1);
    expect(jobs.filter((j) => j.assetType === 'background').length).toBe(1);
  });

  it('collectible 按**条目**展开，不随节点展开（防 17 节点 × 1 条的笛卡尔积）', () => {
    const jobs = planBatch({
      ...base,
      nodes: [
        { id: 'n1', title: '入镇', storyText: '你走进古镇。' },
        { id: 'n2', title: '古井', storyText: '井水很凉。' },
        { id: 'n3', title: '渡口', storyText: '船在晃。' },
      ],
      collectibles: [
        { id: 'c1', name: '半枚残破铜钱', description: '沈砚随身携带。' },
        { id: 'c2', name: '未送出的镖旗', description: null },
      ],
      types: ['collectible'], communityStyleTag: null,
    });
    // 期望 = 条目数，**不是**节点数，也不是两者之积
    expect(jobs.length).toBe(2);
    expect(jobs.filter(j => j.assetType === 'collectible').length).toBe(2);
    // 每条都挂 collectibleId、且 nodeId 必须为 null（否则回写会打到错的表）
    expect(jobs.every(j => j.assetType !== 'collectible' || j.collectibleId !== null)).toBe(true);
    expect(jobs.some(j => j.assetType === 'collectible' && j.nodeId !== null)).toBe(false);
    // description 落成 sourceText 快照；null 保持 null（不写空串）
    expect(jobs.find(j => j.collectibleId === 'c1')!.sourceText).toBe('沈砚随身携带。');
    expect(jobs.find(j => j.collectibleId === 'c2')!.sourceText).toBeNull();
    // 名字带类型后缀（与 background 同款展示信号）；截断口径见本文件 fitName 的 emoji 用例
    expect(jobs.find(j => j.collectibleId === 'c1')!.name).toBe('半枚残破铜钱·collectible');
    expect(jobs.find(j => j.collectibleId === 'c1')!.assetIsPublic).toBe(false);
  });

  // T18（spec §5.4 S2）：npc_portrait 按**NPC 自身**展开，与 collectible 同族——
  // 一条 job 对应一个 NPC，target_id = NPC id（回写 npc.portrait_url 的权威键），
  // 不与节点做笛卡尔积。`description` 这里是 portrait_prompt，落成 sourceText 快照。
  it('npc_portrait 按 NPC 展开，target_id = NPC id、sourceText = portrait_prompt', () => {
    const jobs = planBatch({
      ...base,
      nodes: [
        { id: 'n1', title: '入镇', storyText: '你走进古镇。' },
        { id: 'n2', title: '古井', storyText: '井水很凉。' },
      ],
      npcs: [
        { id: 'npc-1', name: '沈墨秋', description: '水墨风，青衫' },
        { id: 'npc-2', name: '小厮', description: null },
      ],
      types: ['npc_portrait'], communityStyleTag: null,
    });
    // 期望 = NPC 数，**不是**节点数，也不是两者之积
    expect(jobs.length).toBe(2);
    expect(jobs.every(j => j.assetType === 'npc_portrait')).toBe(true);
    // targetKind / targetId 必须钉死成 'npc' / NPC id —— 回写 buildWritebackPlan 靠它
    for (const j of jobs) {
      expect(j.targetKind).toBe('npc');
      expect(j.targetId).toBeTruthy();
      expect(j.nodeId).toBeNull();      // NPC 级不挂节点
      expect(j.collectibleId).toBeNull();
    }
    // description 落成 sourceText 快照；null 保持 null（不写空串）
    expect(jobs.find(j => j.targetId === 'npc-1')!.sourceText).toBe('水墨风，青衫');
    expect(jobs.find(j => j.targetId === 'npc-2')!.sourceText).toBeNull();
    // 名字带类型后缀（与 collectible 同款展示信号）
    expect(jobs.find(j => j.targetId === 'npc-1')!.name).toBe('沈墨秋·npc_portrait');
    // npc_portrait 不在 PUBLIC_POOL_TYPES —— 立绘绑定具体 NPC，不进公共池
    expect(jobs.every(j => j.assetIsPublic === false)).toBe(true);
  });

  it('**没勾** npc_portrait 时一条都不建（展开键 ≠ 筛选键，与 collectible 同族坑）', () => {
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }],
      npcs: [{ id: 'npc-1', name: '沈墨秋', description: '水墨风' }],
      types: ['background'], communityStyleTag: null,
    });
    expect(jobs.filter(j => j.assetType === 'npc_portrait').length).toBe(0);
  });

  // T11（spec §11）：character_avatar 按**角色自身**展开，与 npc_portrait 同族——
  // 一条 job 对应一个角色，target_id = 角色 id（回写 characters.avatar_url 的权威键）。
  // `ipPrompt` 落成 sourceText 快照。
  it('character_avatar 按角色展开：N 个角色 → N 条 job，各绑自己的 targetId', () => {
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: '你走进古镇。' }],
      characters: [
        { id: 'ch1', name: '沈砚', ipPrompt: '水墨青衫' },
        { id: 'ch2', name: '陆青衫', ipPrompt: null },
      ],
      types: ['character_avatar'], communityStyleTag: null,
    });
    // 期望 = 角色数，**不是**节点数，也不是两者之积。
    // ⚠️ 这行是承重的：红态下 jobs 恰好是 `[]`，而 `[].every(…)` 恒为 true
    //    ⇒ 没有这行，下面两条 every 断言在红态**空转**，用例只剩一半判别力。
    expect(jobs.length).toBe(2);
    expect(jobs.every(j => j.assetType === 'character_avatar')).toBe(true);
    // targetKind / targetId 必须钉死成 'character' / 角色 id —— 回写 buildWritebackPlan 靠它
    for (const j of jobs) {
      expect(j.targetKind).toBe('character');
      expect(j.nodeId).toBeNull();        // 角色级不挂节点（串上会污染「按节点分组」的读路径）
      expect(j.collectibleId).toBeNull(); // 也不是图鉴条目
    }
    expect(jobs.map(j => j.targetId)).toEqual(['ch1', 'ch2']);
    // ipPrompt 落成 sourceText 快照；null 保持 null（不写空串）
    expect(jobs.find(j => j.targetId === 'ch1')!.sourceText).toBe('水墨青衫');
    expect(jobs.find(j => j.targetId === 'ch2')!.sourceText).toBeNull();
    // 名字带类型后缀（与 collectible / npc_portrait 同款展示信号）
    expect(jobs.find(j => j.targetId === 'ch1')!.name).toBe('沈砚·character_avatar');
    // 不在 PUBLIC_POOL_TYPES —— 头像绑定具体角色，不进公共池
    expect(jobs.every(j => j.assetIsPublic === false)).toBe(true);
  });

  it('**没勾** character_avatar 时一条都不建（展开键 ≠ 筛选键，与 npc_portrait 同族坑）', () => {
    // 反向对照：characters 有 N 个、但 types 里没有 character_avatar ⇒ 一条 job 都不该建。
    // 缺了它，「把展开键当成筛选键」或「无条件按 characters 展开」的实现都不会红
    // （正向用例只证「勾了会建」，证不了「没勾不建」）。
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }],
      characters: [{ id: 'ch1', name: '沈砚', ipPrompt: '水墨青衫' }],
      types: ['background'], communityStyleTag: null,
    });
    expect(jobs.filter(j => j.assetType === 'character_avatar').length).toBe(0);
  });

  it('同时勾 collectible 与 background：两类各自展开，互不串', () => {
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }],
      collectibles: [{ id: 'c1', name: '铜钱', description: 'd' }],
      types: ['background', 'collectible'], communityStyleTag: null,
    });
    expect(jobs.filter(j => j.assetType === 'background').length).toBe(1);
    expect(jobs.filter(j => j.assetType === 'collectible').length).toBe(1);
    // 笛卡尔积漏网的形态：collectible 混进节点循环会产出 1 条带 nodeId 的
    expect(jobs.find(j => j.assetType === 'collectible')!.nodeId).toBeNull();
    // 上面三条**在实现之前就是绿的**：早年的「产品级」常量表里没有 collectible，
    // 取到的是 `undefined`，而 `undefined !== null` 为真 ⇒ 产品级循环会 push 一条
    // 垃圾 job（name=undefined、sourceText=null、nodeId=null），恰好满足它们。
    // 这两条把垃圾 job 与正确 job 的取值区分开 —— 垃圾 job 不可能同时是
    // '铜钱·collectible' 且有 'd'。
    // （那份常量表本轮已删，展开键改由注册表的 `scope` 派生 —— 本条注释记的是
    //  **为什么这两条断言必须存在**，与当下的实现无关。）
    expect(jobs.find(j => j.assetType === 'collectible')!.name).toBe('铜钱·collectible');
    expect(jobs.find(j => j.assetType === 'collectible')!.sourceText).toBe('d');
  });

  it('**没勾** collectible 时一条都不建（展开键 ≠ 筛选键，坑一在条目级复发）', () => {
    // 上面两条的 `types` 都含 'collectible'，钉不到这道闸门 —— 删掉
    // `if (types.includes('collectible'))` 它们**全绿**，因为循环照样跑、结果一样。
    //
    // 为什么必须在这一层钉：`collectibles` 是调用方一次查出来的**整个产品**的条目列表，
    // 而 `types` 才是「这一批要哪几类」。少了闸门，勾「插画」也会为全部条目建 job ——
    // 龙门镇 22 条 ⇒ 白出 22 张图、白计 22 次费，且不报任何错。
    // 唯一会红的 DB 用例（wenlv-asset-gen.test.ts 的 D7）在 `describe.skipIf(!RUN_DB)` 里，
    // 默认门禁下 0 覆盖；本模块开头承诺「展开逻辑必须能在无库环境下被钉死」，就在这里兑现。
    const jobs = planBatch({
      ...base,
      nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }],
      collectibles: [{ id: 'c1', name: '铜钱', description: 'd' }],
      types: ['background'], communityStyleTag: null,
    });
    expect(jobs.length).toBeGreaterThan(0);   // ← 对照：本批**确实**展开了 job，不是空数组
    expect(jobs.filter((j) => j.assetType === 'collectible').length).toBe(0);
  });
});

// 这一组钉的是**落库映射**。轮询器生成素材时是从库里把行读回来的（claimNextJobs），
// 行上没有的字段它永远拿不到 —— 所以「计划对象 → 插入行」这一段必须逐列验，
// 它才是本模块存在的全部理由。
// 2026-09-13 实测：把 .values() 里 nodeId/sourceText/communityStyleTag 整行删掉，
// 上面整个 planBatch 用例组仍然全绿 —— 那段映射此前零覆盖。
describe('toJobRow（计划 → 插入行）', () => {
  it('三列来源快照必须落库 —— 删掉任一列，轮询器读到的就是 undefined', () => {
    const jobs = planBatch({
      ...base, communityStyleTag: 'ink',
      nodes: [{ id: 'n1', title: '入镇', storyText: '你走进古镇。' }],
      types: ['narration'],
    });
    const row = toJobRow(jobs[0]);
    expect(row.nodeId).toBe('n1');                  // 旁白写回 nodes.narration_url 靠它
    expect(row.sourceText).toBe('你走进古镇。');      // 出词 / 画面描述靠它
    expect(row.communityStyleTag).toBe('ink');      // design_assets.style_tag 靠它
  });

  it('整行字段被钉住 —— batchId 断链会把一批拆成 N 批，venueId 写死会让私有素材落进公共池', () => {
    const [job] = planBatch({
      ...base, nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
    });
    expect(toJobRow(job)).toMatchObject({
      batchId: 'b1', venueId: 'v1', productId: 'p1', name: '入镇·background',
      id: job.id,
      assetType: 'background',
      prompt: null,                                 // 轮询器领取时现算，不在这里落
      iteration: 1, parentJobId: null, guidance: null,
      status: 'pending', attempt: 0, costAmount: '0',
    });
  });

  // ⛔ 这里是 `PlannedJob → job 行` 的**唯一映射表**：给它加了字段而这段没带，落到库就是
  //    null，**不报错、ts-check 也不报**（少写一个可选属性不是类型错误）。回写侧拿到空
  //    key 直接返回 ⇒ job 是 succeeded、素材库里有图、**只有业务表永远是空的**。
  //    这正是本子项目要修的「结局图/奖励图出不来」的同一个形状 —— 只不过它打在本来
  //    好好的背景图上，是**回归**。所以正向钉一条（下面），与上面那条一起看。
  it('targetKind / targetId 必须投影 —— 漏了则回写静默失效（成功但业务表永远空）', () => {
    const [job] = planBatch({
      ...base, nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
    });
    const row = toJobRow(job);
    expect(row.targetKind).toBe('node');
    expect(row.targetId).toBe('n1');   // 与迁移 0033 的回填口径一致：= nodeId
  });

  it('collectibleId 必须落库 —— 轮询器只从行上读，漏写即写回丢键', () => {
    const row = toJobRow({
      id: 'j1', batchId: 'b1', venueId: 'v1', productId: 'p1',
      assetType: 'collectible', name: '铜钱·collectible',
      nodeId: null, collectibleId: 'c1', sourceText: 'd',
      targetKind: 'collectible', targetId: 'c1',
      assetIsPublic: false, communityStyleTag: null,
      styleBibleSnapshot: bible, iteration: 1, parentJobId: null, guidance: null,
      // Task 10 给 PlannedJob 加的两个入队期字段（手搓的 PlannedJob 字面量必须补齐，
      // 否则 ts-check 报「missing editInputUrl, candidateCount」）。
      editInputUrl: null, candidateCount: 1,
    });
    expect(row.collectibleId).toBe('c1');
  });
});

// 这四条**不需要库**：守卫的抛出发生在 db.insert 之前（本文件已 mock 掉 db —— 见文件末尾的
// vi.mock，它的 insert 恒 resolve）。钉住的是「超宽要出声」这个行为本身。
describe('enqueueBatch 边界检查', () => {
  const oneJob = () => planBatch({
    ...base, nodes: [{ id: 'n1', title: '入镇', storyText: 'x' }], types: ['background'],
  });

  it('素材名超长在插入前出声 —— 否则整批 INSERT 原子回滚且报错不指向具体行', async () => {
    const jobs = oneJob();
    jobs[0].name = 'x'.repeat(101);          // 越过 name 列宽 100
    await expect(enqueueBatch(jobs)).rejects.toThrow('素材名超长');
  });

  it('风格标签超长在插入前出声 —— 静默截断会让一批素材裂成两个 tag', async () => {
    const jobs = oneJob();
    jobs[0].communityStyleTag = 'x'.repeat(51);   // 越过 community_style_tag 列宽 50
    await expect(enqueueBatch(jobs)).rejects.toThrow('风格标签超长');
  });

  // 下面两条钉的是**计数口径**：`.length` 数码元、Postgres 的 varchar 数码点。
  // 一个 emoji 算 2（码元）还是 1（码点）—— 口径用错就会把合法数据误判超长。
  //
  // 构造法：合法的那条后面跟一条**确定会被守卫拦下**的哨兵 job。
  // 哨兵保证用例既能验到「合法那条过了守卫」（报错出自哨兵而非它），
  // 又永远走不到 db.insert —— 否则合法的第一条过了守卫就会真去插库（碰库即假红/脏写）。
  it('纯 emoji 名字按码点数 —— 200 码元但只有 100 码点，不该被误报超长', async () => {
    const legal = oneJob()[0];
    legal.name = '😀'.repeat(100);          // 100 码点 / 200 码元，列宽 100 放得下
    const sentinel = oneJob()[0];
    sentinel.name = '😀'.repeat(101);       // 101 码点，必抛

    let err: unknown = null;
    try { await enqueueBatch([legal, sentinel]); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    // 报错必须出自**哨兵**（按码点数 101）。若第一条被误杀，数字会是 200（码元数）。
    expect(String(err)).toContain('101 > 100');
    expect(String(err)).not.toContain('200 > 100');
  });

  it('纯 emoji 风格标签同理按码点数 —— 50 码点合法，51 码点才出声', async () => {
    const legal = oneJob()[0];
    legal.communityStyleTag = '🏷'.repeat(50);    // 50 码点 / 100 码元，列宽 50 放得下
    const sentinel = oneJob()[0];
    sentinel.communityStyleTag = '🏷'.repeat(51); // 51 码点，必抛

    let err: unknown = null;
    try { await enqueueBatch([legal, sentinel]); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err)).toContain('51 > 50');
    expect(String(err)).not.toContain('100 > 50');
  });
});

/**
 * fitTag：风格标签的**唯一**归一入口（`/batch` 与 scheduler 的 writeAsset 都调它）。
 * 它存在的原因是同一列曾有两套规则（job 行硬抛 / design_assets 行静默截断）——
 * 一条 51 字的场地名会让 POST /batch 稳定 500，而素材行本来会被正常截断。
 */
describe('fitTag（风格标签归一到列宽）', () => {
  it('null / undefined / 空串 / 纯空白 → null（空串是对读侧隐形的脏值）', () => {
    expect(fitTag(null)).toBeNull();
    expect(fitTag(undefined)).toBeNull();
    expect(fitTag('')).toBeNull();
    expect(fitTag('   ')).toBeNull();
  });

  it('列宽内原样返回；首尾空白剥掉', () => {
    expect(fitTag('ink')).toBe('ink');
    expect(fitTag('  ink  ')).toBe('ink');
  });

  it('超宽截到 MAX_TAG，且按**码点**数（不是 UTF-16 码元）', () => {
    expect(fitTag('场'.repeat(60))).toBe('场'.repeat(MAX_TAG));
    // 50 个 emoji = 50 码点 / 100 码元：按码点不该被截，按码元会只剩 25 个
    expect(fitTag('🏷'.repeat(50))).toBe('🏷'.repeat(50));
    expect(Array.from(fitTag('🏷'.repeat(80))!).length).toBe(50);
  });
});

describe('iterationBlockReason（哪些类型的反馈无处可施）', () => {
  // 判别表就是规则本身，逐类型写死 —— **不要**写成「不在白名单里的一律拒」：
  // 那样以后新增一种素材类型会被**默默拒掉迭代**（用户点了没反应，且没人发现）。
  // 这份表只列**确知**读不到 guidance 的三类，其余一律放行。
  it('旁白 / 风格锚图 → 给出拒绝原因', () => {
    expect(iterationBlockReason('narration')).toContain('旁白不支持迭代');
    expect(iterationBlockReason('anchor')).toContain('锚图不支持迭代');
  });

  // 合成行（`bootstrapStyleBible` 落的那条 `style_bible` 行）是**可被迭代的**候选里
  // 最危险的一条：它 `status: 'succeeded'`、也能被 `/iterate` 查到，而它没有任何画面 ——
  // 放它过去 = 每点一次「迭代」就原样再调一次付费 LLM，且新行还会以 pending 落库。
  it('style_bible 不支持迭代', () => {
    expect(iterationBlockReason('style_bible')).toContain('风格基线自举不支持迭代');
  });

  it('图类与印章一律放行（它们的 guidance 真的会进提示词）', () => {
    for (const t of ['background', 'cover', 'icon', 'stamp', 'collectible'] as const) {
      expect(iterationBlockReason(t)).toBeNull();
    }
  });

  it('未知 / 空类型不拒（fail-open：拦住未来新增的类型比放过去更糟）', () => {
    expect(iterationBlockReason(null)).toBeNull();
    expect(iterationBlockReason(undefined)).toBeNull();
    expect(iterationBlockReason('')).toBeNull();
  });
});

/**
 * `enqueueIteration` 的 insert 是**逐列写死**的：漏一列既不报错也不回滚，只是该列恒为 NULL。
 * 迭代行的 `collectible_id` 落成 NULL 后的后果是**静默**的（不是「回写丢键」）：调度器「取条目真名」
 * 那一支（`wenlv-asset-gen-scheduler.ts` 的 `else if (job.collectibleId)`）查不到 ⇒ 画面描述里的「素材」名
 * 回落到 `…·collectible` 这种带类型后缀的 `job.name`。⚠️ 两个用例名里的那半句「漏写即写回丢键」/
 * 「缺键则回写静默跳过」是 0033 把回写键统一成 `targetId` 之前的旧机制；名字进 TAP 输出、外层仓计划
 * 文档里有逐字引用，故**留名不改**。与 `toJobRow` 同理，这段映射必须能被单独钉住，不能靠「跑一遍没报错」。
 *
 * **必须替换 db**：`enqueueIteration` 先 `select` 父行、再 `insert`，无库跑不动
 * （本文件其余用例都是纯函数，只有这一组碰库）。桩只做两件事：喂回用例指定的父行、
 * 把 insert 的 values 抄下来。状态挂 `globalThis` 而不是模块作用域的变量：`vi.mock`
 * 的工厂会被提升到 import 之前，引用外面的 `let` 会撞 TDZ
 * （vitest 报 "Cannot access '…' before initialization"）。
 */
vi.mock('../../../../db/index.js', () => {
  const g = globalThis as any;
  g.__wenlvEnqueueDbStub = { parentRows: [] as any[], capturedRows: [] as any[] };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(g.__wenlvEnqueueDbStub.parentRows) }),
        }),
      }),
      insert: () => ({
        values: (v: any) => {
          g.__wenlvEnqueueDbStub.capturedRows.push(v);
          return Promise.resolve();
        },
      }),
    },
  };
});

describe('enqueueIteration（迭代行必须继承来源键）', () => {
  const stub = () => (globalThis as any).__wenlvEnqueueDbStub;
  /** 一条「已成功、可迭代」的父行（键名取 db.select() 返回的 drizzle 行形状） */
  const parent = (over: Record<string, unknown>) => ({
    id: 'parent-1', status: 'succeeded', assetType: 'collectible',
    venueId: 'v1', productId: 'p1', name: '铜钱·collectible',
    nodeId: null, collectibleId: 'c1', sourceText: 'd',
    communityStyleTag: null, styleBibleSnapshot: {}, iteration: 1,
    ...over,
  });

  beforeEach(() => {
    stub().parentRows = [];
    stub().capturedRows = [];
  });

  it('图鉴迭代行原样继承 collectibleId —— 缺键则回写静默跳过', async () => {
    stub().parentRows = [parent({})];
    await enqueueIteration({ parentJobId: 'parent-1', guidance: 'g', batchId: 'b1' });
    expect(stub().capturedRows[0].collectibleId).toBe('c1');
  });

  // 反向对照：只写「等于 'c1'」抓不住「恒填一个非 null 常量」的实现 ——
  // 两条方向一起才排除了「恒为某个非 null 值」。（漏写该列时，两条都会红：
  // 读到的都是 undefined，既非 'c1' 也非 null。）
  it('反向对照：父行 collectibleId 为 null（如 background）时迭代行也是 null', async () => {
    stub().parentRows = [parent({ id: 'parent-2', assetType: 'background', collectibleId: null, nodeId: 'n1' })];
    await enqueueIteration({ parentJobId: 'parent-2', guidance: 'g', batchId: 'b1' });
    expect(stub().capturedRows[0].collectibleId).toBeNull();
  });

  /**
   * 🔒 **锁测试 —— 不是「验缺陷」，它锁的是 `enqueue.ts` 里那条有意为之的产品决策。**
   *
   * 本 describe 的标题是「迭代行必须继承来源键」，而下面这一项正是那条规则的
   * **书面反例**（标题指的是 nodeId / collectibleId / targetKind / targetId 这一组；
   * `candidateCount` 被 `enqueue.ts` 明确排除在外）。放在这里是因为要复用同一套
   * 桩与父行夹具，不是因为这一项该「继承」。
   *
   * 被锁的代码注释（`enqueue.ts` 的 `enqueueIteration`，`.values({...})` 列清单内）逐字写着：
   *   ⚠️ **有意不继承 `candidateCount`**：迭代（涂鸦重绘 / 反馈重出）默认出 **1 张**，
   *      不跟原 job 走 …… 上面那几行都写了「漏了 = 静默失效」，唯独这一项是**反例**，
   *      别照邻居的模式把它补上。…… 这是**产品决策**，不是遗漏。
   *
   * 为什么必须有这条断言：那只是一段**注释**，没有任何测试看着它。相邻几行全都在说
   * 「漏了 = 静默失效」，后人极易把这一项归为同一类遗漏而「顺手修掉」——
   * 补一句 `candidateCount: parent.candidateCount` 后**全仓测试照样全绿**，
   * 产品语义（迭代只出 1 张）被静默改掉且不报错。这条就是堵住这个口子的闸。
   *
   * 规格要**两件事同时成立**才算完整（缺一不可）：
   *   甲 · 插入对象**不带 `candidateCount` 这个键** ⇒ 落库走列默认值；
   *   乙 · 该列的**声明默认值就是 1** ⇒ 「走默认值」确实等于「出 1 张」。
   * 只断甲：日后有人把 `default(1)` 改成 `default(4)`，甲照样绿，语义已经变了。
   * 只断乙：完全测不到「迭代不继承」这件事本身。
   *
   * ⛔ **请勿把本用例当「被固化的 bug」删掉。** 若产品确实改成「迭代也出 N 张」，
   *    正确做法是**同时**改 `enqueue.ts`（像 `targetKind` 那样显式继承父行的
   *    `candidateCount`）**并**改这条用例，而不是删掉它。
   */
  it('🔒锁：迭代行**有意不继承** candidateCount（插入对象无该键 + 列默认值恰为 1）', async () => {
    // 父行刻意给 4（> 1）。这是判别力的前提：若父行也是 1，
    // 「不继承」与「继承」的结果**完全相同**，下面那条断言就什么都测不出来。
    stub().parentRows = [parent({ candidateCount: 4 })];
    await enqueueIteration({ parentJobId: 'parent-1', guidance: 'g', batchId: 'b1' });

    // 反向对照（先断，避免下面的「无键」是「压根没插成行」的假绿）：
    expect(stub().capturedRows).toHaveLength(1);
    expect(stub().parentRows[0].candidateCount).toBe(4);
    const row = stub().capturedRows[0];

    // 甲 · 插入对象里**根本没有这个键**。
    //     注意断的是 `in`，不是 `=== 1`：显式写 `candidateCount: 1` 与不写键，
    //     SQL 层是两回事（前者是显式赋值，后者才走列默认值）。这里钉的是后者。
    expect('candidateCount' in row).toBe(false);

    // 乙 · 列的**声明默认值**是 1，把上面那条「无键」与产品语义「出 1 张」接上。
    //     `default` 是 drizzle 列构建器上的**运行时**属性（不在「列名/类型」那层 TS 面里），
    //     但它是**有类型**的 —— `pnpm ts-check` 在**不加任何断言**的情况下通过，故此处
    //     不做类型断言（不引入 `as any` / `as unknown`）。
    //     （实测 2026-09-20：`.default === 1`、`.hasDefault === true`、`.notNull === true`。
    //      若日后 drizzle 改版把 `default` 从类型面移除，这里会以 TS 报错而非静默失败变红。）
    expect(pmsBuiWenlvAssetJobs.candidateCount.default).toBe(1);
  });
});

/**
 * `enqueueIteration` 的 **editInputUrl 长度自守**（服务层，无库）。
 *
 * 为什么要自守：`edit_input_url` 是 `varchar(500)`，而本函数此前对该入参只做
 * `.trim() || null`、没有任何长度钳制。`/iterate` 会在更早处给出 400，但
 * `enqueueIteration` 是**导出的** —— 别的调用方绕过去照样得被挡住（与上面那三条
 * 「父行存在 / 状态 / iterationBlockReason」自守同源）。
 *
 * 位置要求：守卫必须在**父行 SELECT 之前**。判据因此刻意把 `parentRows` 留空 ——
 * 守卫若在 SELECT 之后，抛的会是「要迭代的任务不存在」；只有它在 SELECT 之前，
 * 才可能抛长度错误。这条断言因此**有鉴别力**，不是恒真。
 */
describe('enqueueIteration 的 editInputUrl 长度自守（无库）', () => {
  const stub = () => (globalThis as any).__wenlvEnqueueDbStub;
  const PREFIX = 'https://a.co/';   // 12 码点
  /** 拼出**恰好** n 个码点的 URL（前缀 + x 填充）。 */
  const urlOf = (n: number) => PREFIX + 'x'.repeat(n - PREFIX.length);

  beforeEach(() => {
    stub().parentRows = [];
    stub().capturedRows = [];
  });

  it('超过列宽（>500 码点）→ 抛错，且**在父行 SELECT 之前**、没有落任何行', async () => {
    const url = urlOf(MAX_EDIT_INPUT_URL + 100);
    expect(Array.from(url).length).toBeGreaterThan(MAX_EDIT_INPUT_URL);
    await expect(enqueueIteration({ parentJobId: 'x', guidance: 'g', batchId: 'b', editInputUrl: url }))
      .rejects.toThrow(`超过 ${MAX_EDIT_INPUT_URL} 个字符`);
    // 守卫早于 INSERT ⇒ 一行都没落
    expect(stub().capturedRows).toHaveLength(0);
  });

  it('对照：**恰好** 500 码点不被长度守卫拒绝（边界没有误伤）', async () => {
    const url = urlOf(MAX_EDIT_INPUT_URL);
    // 把「500」钉死成列宽事实：常量被改宽/改窄时这条先红（避免恒真的形状断言）。
    expect(Array.from(url).length).toBe(500);
    // 父行不存在 ⇒ 应当抛的是**那一句**，而不是长度错误。
    // ⛔ 只写 `.rejects.toThrow()` 不够：那样「长度守卫误伤边界值」与「父行确实不存在」
    //    无法区分 —— 必须断到**抛的是哪一句**。
    await expect(enqueueIteration({ parentJobId: 'x', guidance: 'g', batchId: 'b', editInputUrl: url }))
      .rejects.toThrow('要迭代的任务不存在');
  });
});
