import { describe, it, expect } from 'vitest';
import { planBatch, PUBLIC_POOL_TYPES, iterationBlockReason } from '../enqueue.js';
import { ASSET_TYPES, ALL_ASSET_TYPES } from '../asset-types.js';
import type { WenlvStyleBible } from '../../../../db/schema/wenlv.js';

const bible: WenlvStyleBible = { artStyle: 's', palette: [], mustHave: [], forbidden: [], mood: '' };

/** 两个节点 / 两个图鉴条目 / 两个结局 / 两个奖励 / 两个档位 —— 用来分辨展开键。 */
const base = {
  batchId: 'b1', venueId: 'v1', productId: 'p1',
  types: [] as never[],
  bible,
  nodes: [
    { id: 'n1', title: '节点一', storyText: '故事一' },
    { id: 'n2', title: '节点二', storyText: '故事二' },
  ],
  collectibles: [
    { id: 'c1', name: '证物一', description: '描述一' },
    { id: 'c2', name: '证物二', description: '描述二' },
  ],
  endings: [
    { id: 'e1', title: '结局一', text: '结局文本一' },
    { id: 'e2', title: '结局二', text: '结局文本二' },
  ],
  rewards: [
    { id: 'r1', name: '奖励一', description: '奖励描述一' },
    { id: 'r2', name: '奖励二', description: '奖励描述二' },
  ],
  tiers: [
    { id: 't1', name: '档位一', description: '档位描述一' },
    { id: 't2', name: '档位二', description: '档位描述二' },
  ],
  skipAnchorInsert: true,
  communityStyleTag: null,
} as never;

const run = (types: string[]) => planBatch({ ...(base as object), types } as never);

describe('注册表驱动的批次展开', () => {
  it('icon 随**档位**展开（每个 tier 一条），不是随节点', () => {
    const jobs = run(['icon']);
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.targetKind)).toEqual(['tier', 'tier']);
    expect(jobs.map(j => j.targetId).sort()).toEqual(['t1', 't2']);
    // 关键反证：若仍随节点展开，这里会是 ['n1','n2']
    expect(jobs.map(j => j.targetId)).not.toContain('n1');
  });

  it('stamp 随**图鉴条目**展开（每个 collectible 一条），不是随节点', () => {
    const jobs = run(['stamp']);
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.targetKind)).toEqual(['collectible', 'collectible']);
    expect(jobs.map(j => j.targetId).sort()).toEqual(['c1', 'c2']);
  });

  it('ending / reward 各按自身实体展开，nodeId 恒为 null', () => {
    expect(run(['ending']).map(j => j.targetId).sort()).toEqual(['e1', 'e2']);
    expect(run(['reward']).map(j => j.targetId).sort()).toEqual(['r1', 'r2']);
    for (const j of [...run(['ending']), ...run(['reward'])]) expect(j.nodeId).toBeNull();
  });

  // ⚠️ 上面那条只断 targetId / nodeId —— 实测把 ending/reward/tier 三处的 name 改成常量、
  //    sourceText 改成 null，**整个文件仍然全绿**。而这两项会**逐字**进喂给 LLM 的提示词
  //   （scheduler 的 `素材：` 行读 name；轮询器从 job.sourceText 现算画面描述），
  //    静默改坏 = 出图内容错、且无任何报错。所以必须逐条钉住**拼接后的期望值**。
  //
  // 断言写成 [id, name] 成对而不是裸数组：`jobs` 的顺序 = **输入数组顺序**，不是按 id 排序；
  // 配成对之后顺序就算将来变了也能一眼看出是哪一条错。
  // name 的期望值必须带 `·类型` 后缀（`fitName` = `title + '·' + suffix`），
  // 且**不能**退化成 toContain / 只断长度 —— 那样拼错类型后缀照样绿。
  it('ending / reward / tier 的 name 与 sourceText 逐条钉死（写坏即污染 LLM 提示词）', () => {
    const e = run(['ending']);
    expect(e.map(j => [j.targetId, j.name]))
      .toEqual([['e1', '结局一·ending'], ['e2', '结局二·ending']]);
    expect(e.map(j => j.sourceText)).toEqual(['结局文本一', '结局文本二']);

    const r = run(['reward']);
    expect(r.map(j => [j.targetId, j.name]))
      .toEqual([['r1', '奖励一·reward'], ['r2', '奖励二·reward']]);
    expect(r.map(j => j.sourceText)).toEqual(['奖励描述一', '奖励描述二']);

    // tier 这条**必须走 icon**（icon 的 scope 是 tier）：名字取的是**档位**名，不是节点名。
    const t = run(['icon']);
    expect(t.map(j => [j.targetId, j.name]))
      .toEqual([['t1', '档位一·icon'], ['t2', '档位二·icon']]);
    expect(t.map(j => j.sourceText)).toEqual(['档位描述一', '档位描述二']);
  });

  it('五类既有类型行为不变（逐条钉住 job 数）', () => {
    expect(run(['background'])).toHaveLength(2);   // 2 节点
    expect(run(['narration'])).toHaveLength(2);
    expect(run(['collectible'])).toHaveLength(2);
    expect(run(['cover'])).toHaveLength(1);        // 产品级
  });

  it('未勾选的类型不得展开（防「勾一个出全部」）', () => {
    const jobs = run(['background']);
    // ⚠️ 先钉条数再断 every：`[].every(...)` **恒真**，展开逻辑坏成一条不产时
    // 下面那条照样绿 —— 这正是「静默失效」的形状（测试报告全绿，功能已死）。
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.assetType === 'background')).toBe(true);
  });

  it('stamp 已移出公共池（绑定到具体条目的章不是公共素材）', () => {
    expect(PUBLIC_POOL_TYPES.has('stamp' as never)).toBe(false);
    expect(PUBLIC_POOL_TYPES.has('icon' as never)).toBe(true);
  });

  // ⛔ 下面两条是**回归守卫**，不是新功能。node/product 两类本来就能回写，
  //    但回写键从 `node_id` 换成通用对 `target_kind`/`target_id` 之后，
  //    漏填 targetId 会让**本来好的**背景图/封面静默停止回写（Task 6 起统一读 job.targetId）。
  it('节点级类型也带 targetKind/targetId（漏填 = 背景图/旁白永远不回写）', () => {
    const jobs = run(['background']);
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.targetKind)).toEqual(['node', 'node']);
    expect(jobs.map(j => j.targetId).sort()).toEqual(['n1', 'n2']);
    // 与迁移 0033 回填的口径一致：`target_id` 必须等于 `nodeId`，不能一处有一处无
    expect(jobs.map(j => j.targetId)).toEqual(jobs.map(j => j.nodeId));
  });

  it('产品级（cover）与锚图都指向 product，targetId = productId', () => {
    const jobs = planBatch({ ...(base as object), types: ['cover'], skipAnchorInsert: false } as never);
    expect(jobs.map(j => j.targetKind)).toEqual(['product', 'product']);
    expect(jobs.map(j => j.targetId)).toEqual(['p1', 'p1']);
  });
});

// `iterationBlockReason()` 仍是**面向用户**的独立整句文案，**不并入注册表** ——
// 注册表的 `AssetTypeDef.iterationBlockReason` 是给开发者看的短理由，两者口径不同。
// 但「哪些类型不可迭代」这件事必须**只有一份规格**，所以口径要逐类型一致 ——
// 这条守卫抓的是日后注册表把某个类型改成 `iterable: false` 却忘了在函数里补一条文案
//（后果：用户点「迭代」看到空按钮、或一句 `类型 xxx 不支持迭代` 的兜底，**不报错**）。
describe('迭代闸的单一真源守卫', () => {
  it('iterationBlockReason 与注册表的 iterable 逐类型一致（防两处漂移）', () => {
    for (const t of ALL_ASSET_TYPES) {
      expect(
        iterationBlockReason(t) !== null,
        `${t}: 注册表 iterable=${ASSET_TYPES[t].iterable}，但函数判定 blocked=${iterationBlockReason(t) !== null}`,
      ).toBe(!ASSET_TYPES[t].iterable);
    }
  });
});
