import { describe, it, expect } from 'vitest';
import { validateWenlvIntegrity, collectRefs } from '../wenlv-integrity.js';

const base = {
  product: { id: 'P1', name: '合成样例', status: 'draft' as const },
  nodes: [] as any[], collectibles: [] as any[], endings: [] as any[], rewards: [] as any[],
};

describe('validateWenlvIntegrity（publish 前置完整性校验）', () => {
  it('空气包（零节点）报 NARRATIVE_NO_SCENE', () => {
    const errs = validateWenlvIntegrity({ ...base });
    expect(errs.some((e) => e.includes('至少 1 个剧情节点'))).toBe(true);
  });

  it('纯 npc 节点（无 scene）不报错 NARRATIVE_NO_SCENE', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'N1', nodeType: 'npc', title: 'NPC 剧情' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: null, rewardId: null }],
    });
    expect(errs.some((e) => e.includes('剧情节点'))).toBe(false);
  });

  it('缺少结局报错', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口' }],
    });
    expect(errs.some((e) => e.includes('至少 1 个结局'))).toBe(true);
  });

  it('grants 引用不存在的线索报错', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', grants: ['GHOST'] }],
      collectibles: [{ id: 'C1', name: '密信' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: null }],
    });
    expect(errs.some((e) => e.includes('GHOST'))).toBe(true);
  });

  it('ending.trigger_condition 引用 kind=collected 但 id 不存在报错', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'C_X' } } }],
    });
    expect(errs.some((e) => e.includes('C_X'))).toBe(true);
  });

  it('condition kind 与实体类型不匹配报错（visited 指向线索）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口' }],
      collectibles: [{ id: 'C1', name: '密信' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'visited', id: 'C1' } } }],
    });
    expect(errs.some((e) => e.includes('C1'))).toBe(true);
  });

  it('组合条件递归：all/any/nofM 嵌套、多 ref、of 空数组均不崩溃且幽灵被报', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [
        { id: 'N1', nodeType: 'scene', title: '村口' },
        {
          id: 'N2', nodeType: 'puzzle', title: '对暗号',
          requires: {
            type: 'all',
            conditions: [
              { type: 'ref', ref: { kind: 'visited', id: 'N1' } },
              {
                type: 'any',
                conditions: [
                  { type: 'ref', ref: { kind: 'collected', id: 'C1' } },
                  { type: 'ref', ref: { kind: 'visited', id: 'GHOST_NODE' } },
                ],
              },
              { type: 'nofM', n: 1, of: [{ type: 'ref', ref: { kind: 'completed', id: 'GHOST_CMP' } }] },
              { type: 'nofM', n: 0, of: [] },
            ],
          },
        },
      ],
      collectibles: [{ id: 'C1', name: '密信' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: null }],
    });
    // 嵌套递归收集到两个幽灵 ref
    expect(errs.some((e) => e.includes('GHOST_NODE'))).toBe(true);
    expect(errs.some((e) => e.includes('GHOST_CMP'))).toBe(true);
    // 有效引用与空 of 不产生多余错误
    expect(errs.some((e) => e.includes('节点[N1]'))).toBe(false);
    // 2026-09-15 随可达性规则收紧而**精确化**：原断言是 `C1 不出现在任何错误里`，
    // 当时唯一可能提到 C1 的规则就是「引用不存在的线索」，故两者等价。
    // 现在 C1 虽存在、却没有任何节点 grant 它 ⇒ 新规则正确地报了一条可达性错误。
    // 本用例关心的是「**幽灵**才报」，故收敛为原始意图（C1 不得被当作不存在）。
    expect(errs.some((e) => e.includes('C1') && e.includes('不存在'))).toBe(false);
  });

  it('ending.rewardId 引用不存在的奖励报错', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口' }],
      collectibles: [{ id: 'C1', name: '密信' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'C1' } }, rewardId: 'GHOST_REWARD' }],
      rewards: [{ id: 'R1', name: '锦囊' }],
    });
    expect(errs.some((e) => e.includes('引用不存在的奖励'))).toBe(true);
  });

  it('合法内容零错误', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [
        { id: 'N1', nodeType: 'scene', title: '村口' },
        { id: 'N2', nodeType: 'puzzle', title: '对暗号', requires: { type: 'ref', ref: { kind: 'visited', id: 'N1' } }, grants: ['C1'], puzzle: { type: 'single', question: '暗号是？', options: ['A'], answer: 'A' } },
      ],
      collectibles: [{ id: 'C1', name: '密信' }],
      endings: [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'C1' } }, rewardId: 'R1' }],
      rewards: [{ id: 'R1', name: '锦囊' }],
    });
    expect(errs).toEqual([]);
  });
});

describe('validateWenlvIntegrity（mode 分流：rally）', () => {
  const base = {
    product: { id: 'p', name: '集章测试', mode: 'rally' as const },
    nodes: [] as any[],
    collectibles: [] as any[],
    endings: [] as any[],
    rewards: [] as any[],
    tiers: [] as any[],
  };

  it('narrative：空气包（无任何节点）/无 ending 报错', () => {
    const errs = validateWenlvIntegrity({ ...base, product: { id: 'p', name: 'x', mode: 'narrative' } });
    expect(errs.some((e) => e.includes('剧情节点'))).toBe(true);
    expect(errs.some((e) => e.includes('结局'))).toBe(true);
  });

  it('narrative：纯 NPC 节点（0 个 scene）不报 NARRATIVE_NO_SCENE', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      product: { id: 'p', name: 'x', mode: 'narrative' },
      nodes: [{ id: 'n1', nodeType: 'npc', title: '族长的召集' }],
      endings: [{ id: 'e1', title: '圆满', triggerCondition: null, rewardId: null }],
    } as any);
    expect(errs.some((e) => e.includes('剧情节点'))).toBe(false);
  });

  it('rally 含 ending 报错（保非终局）', () => {
    const input = {
      ...base,
      nodes: [{ id: 'n1', nodeType: 'puzzle', title: 'p', grants: ['s1'], requires: null, puzzle: { type: 'single', question: 'q', options: ['a'], answer: 'a' } }],
      collectibles: [{ id: 's1', name: '印', type: 'stamp' }],
      endings: [{ id: 'e1', title: 'x', triggerCondition: null, rewardId: null }],
      tiers: [{ id: 't1', name: '档', condition: { type: 'nofM', n: 1, of: [{ type: 'ref', ref: { kind: 'collected', id: 's1' } }] }, rewardId: 'r1' }],
      rewards: [{ id: 'r1', name: '奖' }],
    };
    expect(validateWenlvIntegrity(input as any).some((e) => e.includes('不能包含结局'))).toBe(true);
  });

  it('rally 无 tier 报错', () => {
    const input = { ...base, nodes: [{ id: 'n1', nodeType: 'scene', title: 's', grants: [], requires: null, puzzle: null }], collectibles: [{ id: 's1', name: '印' }], tiers: [] };
    expect(validateWenlvIntegrity(input as any).some((e) => e.includes('至少 1 个档位'))).toBe(true);
  });

  it('rally tier.condition 只允许 collected 引用，且引用实体存在、rewardId 存在', () => {
    const mk = (cond: any, rewardId: string | null) => ({
      ...base,
      nodes: [{ id: 'n1', nodeType: 'scene', title: 's', grants: [], requires: null, puzzle: null }],
      collectibles: [{ id: 's1', name: '印', type: 'stamp' }],
      rewards: rewardId ? [{ id: 'r1', name: '奖' }] : [],
      tiers: [{ id: 't1', name: '档', condition: cond, rewardId }],
    });
    const badKind = validateWenlvIntegrity(mk({ type: 'ref', ref: { kind: 'visited', id: 'n1' } }, 'r1') as any);
    expect(badKind.some((e) => e.includes('只能引用 collected'))).toBe(true);
    const badRef = validateWenlvIntegrity(mk({ type: 'ref', ref: { kind: 'collected', id: 'zz' } }, 'r1') as any);
    expect(badRef.some((e) => e.includes('不存在'))).toBe(true);
    const badReward = validateWenlvIntegrity(mk({ type: 'ref', ref: { kind: 'collected', id: 's1' } }, 'r2') as any);
    expect(badReward.some((e) => e.includes('奖励'))).toBe(true);
  });

  it('rally puzzle 题型答案缺失/空 answerable 报错；photo 出现在 puzzle 报错', () => {
    // venuePointId：rally 的发章节点必须绑定点位（到场证明闸门），故合法夹具也须绑定
    const baseNode = { id: 'n1', nodeType: 'puzzle', title: 'p', venuePointId: 'pt1', grants: ['s1'], requires: null };
    const ok = {
      ...base, product: { id: 'p', name: '集章测试', mode: 'rally' as const, venueId: 'v1' },
      nodes: [{ ...baseNode, puzzle: { type: 'multiple', question: 'q', options: ['a'], answer: ['a'] } }],
      collectibles: [{ id: 's1', name: '印', type: 'stamp' }], rewards: [{ id: 'r1', name: '奖' }],
      tiers: [{ id: 't1', name: '档', condition: { type: 'ref', ref: { kind: 'collected', id: 's1' } }, rewardId: 'r1' }],
      points: [{ id: 'pt1', code: 'WLP-PUZ0001', venueId: 'v1' }],
    };
    expect(validateWenlvIntegrity(ok as any)).toEqual([]);
    const emptyAns = { ...ok, nodes: [{ ...baseNode, puzzle: { type: 'single', question: 'q', options: ['a'], answer: '' } }] };
    expect(validateWenlvIntegrity(emptyAns as any).length).toBeGreaterThan(0);
    const photoPuzzle = { ...ok, nodes: [{ ...baseNode, puzzle: { type: 'photo', question: 'q' } }] };
    expect(validateWenlvIntegrity(photoPuzzle as any).some((e) => e.includes('不接受 photo'))).toBe(true);
  });

  it('rally 合法结构通过（空错误数组）', () => {
    // 每个发章节点都绑定到一个「有码且属于本场地」的点位 —— 这才是真正合法的集章结构
    const nodes = [
      { id: 'n1', nodeType: 'puzzle', title: 'p1', venuePointId: 'pt1', grants: ['s1'], requires: null, puzzle: { type: 'multiple', question: 'q', options: ['a', 'b'], answer: ['a'] } },
      { id: 'n2', nodeType: 'puzzle', title: 'p2', venuePointId: 'pt2', grants: ['s2'], requires: null, puzzle: { type: 'judge', question: 'q', answer: 'true' } },
      { id: 'n3', nodeType: 'scene', title: 'check', venuePointId: 'pt3', grants: ['s3'], requires: null, puzzle: null },
    ];
    const tiers = [1, 2, 3].map((i) => ({ id: `t${i}`, name: `档${i}`, condition: { type: 'nofM', n: i, of: ['s1', 's2', 's3'].map((id) => ({ type: 'ref', ref: { kind: 'collected', id } })) }, rewardId: 'r1' }));
    const input = {
      ...base,
      product: { id: 'p', name: '集章测试', mode: 'rally' as const, venueId: 'v1' },
      nodes,
      collectibles: ['s1', 's2', 's3'].map((id) => ({ id, name: id, type: 'stamp' })),
      rewards: [{ id: 'r1', name: '奖' }], tiers,
      points: [
        { id: 'pt1', code: 'WLP-RALLY0001', venueId: 'v1' },
        { id: 'pt2', code: 'WLP-RALLY0002', venueId: 'v1' },
        { id: 'pt3', code: 'WLP-RALLY0003', venueId: 'v1' },
      ],
    };
    expect(validateWenlvIntegrity(input as any)).toEqual([]);
  });
});

// Task 7：节点引用物理点位（narrative / rally 两种 mode 通用）。
// 这里做**发布前**拦截；运行时那半（`/trigger` 改读点位的 code、无码则 fail-closed 拒绝）
// 与本次**同批发布**，尚未落在本 commit 上 —— 详见 wenlv-integrity.ts 内注释，勿单独部署本闸。
// 注意：以下用例都在「不传 points」与「传 points」两侧各钉一条，前者是向后兼容的护栏：
// 既有调用点（含本文件上面的全部用例）不传 points，绝不能因为新增校验而变红。
describe('validateWenlvIntegrity（点位引用校验）', () => {
  // narrative 模式最小可发布骨架
  const baseProduct = { id: 'p1', name: '测试剧本', mode: 'narrative', status: 'draft', venueId: 'v1' };
  const sceneNode = (over: Record<string, unknown> = {}) => ({
    id: 'n1', nodeType: 'scene', title: '村口', grants: [], ...over,
  });
  // `type: 'all' as const`：不加会被字面量放宽成 string，与 WenlvCondition 的判别联合不兼容
  const oneEnding = { id: 'e1', title: '结局', triggerCondition: { type: 'all' as const, conditions: [] } };

  const run = (over: Record<string, unknown> = {}, venueId: string | null = 'v1') =>
    validateWenlvIntegrity({
      product: { ...baseProduct, venueId },
      nodes: [sceneNode()],
      collectibles: [],
      endings: [oneEnding],
      rewards: [],
      points: [{ id: 'pt1', code: 'WLP-AAAABBBBCCCC', venueId: 'v1' }],
      ...over,
    });

  it('未引用点位的节点照常通过（不引入新错误）', () => {
    expect(run()).toEqual([]);
  });

  it('引用了存在且带码、且属于本场地的点位 → 通过', () => {
    expect(run({ nodes: [sceneNode({ venuePointId: 'pt1' })] })).toEqual([]);
  });

  it('引用不存在的点位 → 报错', () => {
    const errs = run({ nodes: [sceneNode({ venuePointId: 'nope' })] });
    expect(errs.some((e) => e.includes('不存在'))).toBe(true);
  });

  it('点位存在但 code 为空 → 报错（fail-closed 的发布前拦截）', () => {
    const errs = run({
      nodes: [sceneNode({ venuePointId: 'pt1' })],
      points: [{ id: 'pt1', code: null, venueId: 'v1' }],
    });
    expect(errs.some((e) => e.includes('未配置触发凭证'))).toBe(true);
  });

  it('点位不属于本场地 → 报错', () => {
    const errs = run({
      nodes: [sceneNode({ venuePointId: 'pt1' })],
      points: [{ id: 'pt1', code: 'WLP-AAAABBBBCCCC', venueId: 'v2' }],
    });
    expect(errs.some((e) => e.includes('不属于本产品的场地'))).toBe(true);
  });

  it('产品未归属场地却引用了点位 → 报错', () => {
    const errs = run({ nodes: [sceneNode({ venuePointId: 'pt1' })] }, null);
    expect(errs.some((e) => e.includes('未归属场地'))).toBe(true);
  });

  it('产品未归属场地且点位集合为空（publish 的真实形态）→ 报「未归属场地」，不报误导性的「不存在」', () => {
    const errs = run({ nodes: [sceneNode({ venuePointId: 'pt1' })], points: [] }, null);
    expect(errs.some((e) => e.includes('未归属场地'))).toBe(true);
    expect(errs.some((e) => e.includes('不存在'))).toBe(false);
  });

  // `points` 是按场地过滤后传进来的，校验器结构上无法区分「点位被删了」与「点位属于别的场地」，
  // 后者反而更常见（删点位有 DELETE 409 守卫，改产品场地没有任何守卫），故文案必须同时指出两种可能。
  it('点位 id 不在本场地点位集合中 → 报错文案同时指出「不存在」与「不属于本产品的场地」两种可能', () => {
    const errs = run({
      nodes: [sceneNode({ venuePointId: 'other-venue-pt' })],
      points: [{ id: 'pt1', code: 'WLP-AAAABBBBCCCC', venueId: 'v1' }],
    });
    const hit = errs.find((e) => e.includes('other-venue-pt'));
    expect(!!hit && hit.includes('不存在') && hit.includes('不属于本产品的场地')).toBe(true);
  });

  // 节点**必须**引用一个「不传 points 时显然无法满足」的点位，本条才咬得住守卫：
  // 若节点不引用点位，被删掉守卫（`if (input.points)` 恒真）后依然零错误——
  // 那样这条测试就分不清「没校验」与「校验了但没东西可校验」，等于没测。
  it('未传 points 时即使节点引用了点位也不校验（省略 = 不校验，向后兼容）', () => {
    expect(run({ nodes: [sceneNode({ venuePointId: 'anything' })], points: undefined })).toEqual([]);
  });

  // 纯空白码与「码为空」同罪：`!p.code?.trim()` 必须把 '   ' 也算成没码
  // （现场贴一张空白二维码与没贴二维码，对游客是同一件事）。
  it('点位 code 为纯空白 → 同样报「未配置触发凭证」', () => {
    const errs = run({
      nodes: [sceneNode({ venuePointId: 'pt1' })],
      points: [{ id: 'pt1', code: '   ', venueId: 'v1' }],
    });
    expect(errs.some((e) => e.includes('未配置触发凭证'))).toBe(true);
  });

  // 点位校验在 mode 分流**之前**，rally 同样要过 —— 集章正是最依赖「到场证明」的一条线。
  it('rally 产品引用了无凭证点位 → 同样被拦（点位校验不分 mode）', () => {
    const errs = validateWenlvIntegrity({
      product: { id: 'p2', name: '集章剧本', mode: 'rally', status: 'draft', venueId: 'v1' },
      nodes: [sceneNode({ venuePointId: 'pt1' })],
      collectibles: [],
      endings: [],
      rewards: [],
      tiers: [{ id: 't1', name: '档一', condition: { type: 'all', conditions: [] }, rewardId: null }],
      points: [{ id: 'pt1', code: null, venueId: 'v1' }],
    } as any);
    expect(errs.some((e) => e.includes('未配置触发凭证'))).toBe(true);
  });
});

describe('validateWenlvIntegrity（S4 Important-1：rally 只允许引用 stamp）', () => {
  const base = {
    product: { id: 'p', name: '集章', mode: 'rally' as const },
    rewards: [{ id: 'r1', name: '奖' }],
    endings: [] as any[],
  };
  const cls = (type: string) => ({ id: 'c-' + type, name: 'x', type });
  const tierCond = (id: string) => ({ type: 'ref' as const, ref: { kind: 'collected' as const, id } });

  it('rally 档位条件引用 clue 报错（非 stamp）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'n1', nodeType: 'scene', title: 's', grants: [], requires: null, puzzle: null }],
      collectibles: [cls('stamp'), cls('clue')],
      tiers: [{ id: 't1', name: '档', condition: tierCond('c-clue'), rewardId: 'r1' }],
    } as any);
    expect(errs.some((e) => e.includes('非印章'))).toBe(true);
  });

  it('rally 节点 grants 引用 clue 报错（非 stamp）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'n1', nodeType: 'scene', title: 's', grants: ['c-clue'], requires: null, puzzle: null }],
      collectibles: [cls('clue')],
      tiers: [{ id: 't1', name: '档', condition: tierCond('c-clue'), rewardId: 'r1' }],
    } as any);
    expect(errs.some((e) => e.includes('grants 引用') && e.includes('非印章'))).toBe(true);
  });

  it('rally 节点 requires 引用 clue 报错（非 stamp）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'n1', nodeType: 'puzzle', title: 'p', grants: [], requires: tierCond('c-clue'), puzzle: { type: 'single', question: 'q', options: ['a'], answer: 'a' } }],
      collectibles: [cls('clue')],
      tiers: [{ id: 't1', name: '档', condition: tierCond('c-clue'), rewardId: 'r1' }],
    } as any);
    expect(errs.some((e) => e.includes('requires 引用') && e.includes('非印章'))).toBe(true);
  });

  it('rally 全部引用 stamp 且合法时零错误', () => {
    // 发章节点须绑定点位（到场证明），合法夹具补上 venueId/points/venuePointId
    const errs = validateWenlvIntegrity({
      ...base,
      product: { id: 'p', name: '集章', mode: 'rally' as const, venueId: 'v1' },
      nodes: [{ id: 'n1', nodeType: 'scene', title: 's', venuePointId: 'pt1', grants: ['c-stamp'], requires: null, puzzle: null }],
      collectibles: [cls('stamp')],
      tiers: [{ id: 't1', name: '档', condition: tierCond('c-stamp'), rewardId: 'r1' }],
      points: [{ id: 'pt1', code: 'WLP-CSTAMP01', venueId: 'v1' }],
    } as any);
    expect(errs).toEqual([]);
  });
});

// 集章到场证明（发布侧）：核心商业承诺「到场才能盖章」。发章节点必须绑定物理点位。
// 这条闸必须是**逐节点**的：只要求「至少一个点位节点」时，一个绑定点位 + 若干未绑定的
// 发章节点仍可从沙发上集满并兑出真码（本文件新增用例正是钉住这一点）。
describe('validateWenlvIntegrity（集章到场证明：发章节点必须绑定点位）', () => {
  const base = {
    product: { id: 'p', name: '集章', mode: 'rally' as const, venueId: 'v1' },
    collectibles: [{ id: 's1', name: '印1', type: 'stamp' }, { id: 's2', name: '印2', type: 'stamp' }],
    endings: [] as any[],
    rewards: [{ id: 'r1', name: '奖' }],
    tiers: [{
      id: 't1', name: '档',
      condition: {
        type: 'nofM' as const, n: 2,
        of: [
          { type: 'ref' as const, ref: { kind: 'collected' as const, id: 's1' } },
          { type: 'ref' as const, ref: { kind: 'collected' as const, id: 's2' } },
        ],
      },
      rewardId: 'r1',
    }],
    points: [
      { id: 'pt1', code: 'WLP-PT0001', venueId: 'v1' },
      { id: 'pt2', code: 'WLP-PT0002', venueId: 'v1' },
    ],
  };

  it('唯一发章节点未绑定点位（venuePointId=null）→ 拒绝，且文案点名该节点', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [{ id: 'n1', nodeType: 'scene', title: '远程章', grants: ['s1'], requires: null, puzzle: null }],
    } as any);
    const hit = errs.find((e) => e.includes('未绑定点位'));
    expect(!!hit && hit.includes('远程章')).toBe(true);
  });

  it('混合：部分节点绑定、其中一个发章节点未绑定 → 仍拒绝（「至少一个点位节点」会漏掉的形态）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [
        { id: 'n1', nodeType: 'scene', title: '绑定的章', venuePointId: 'pt1', grants: ['s1'], requires: null, puzzle: null },
        { id: 'n2', nodeType: 'scene', title: '远程的章', grants: ['s2'], requires: null, puzzle: null },
      ],
    } as any);
    expect(errs.some((e) => e.includes('远程的章') && e.includes('未绑定点位'))).toBe(true);
    // 已绑定的那个不得被误伤
    expect(errs.some((e) => e.includes('绑定的章'))).toBe(false);
  });

  it('每个发章节点都绑定点位 → 零错误（正例）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [
        { id: 'n1', nodeType: 'scene', title: '章一', venuePointId: 'pt1', grants: ['s1'], requires: null, puzzle: null },
        { id: 'n2', nodeType: 'scene', title: '章二', venuePointId: 'pt2', grants: ['s2'], requires: null, puzzle: null },
      ],
    } as any);
    expect(errs).toEqual([]);
  });

  it('不发章的节点（grant 为空）不必绑定点位 → 不误伤开场/过场节点', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      nodes: [
        { id: 'n1', nodeType: 'scene', title: '章一', venuePointId: 'pt1', grants: ['s1'], requires: null, puzzle: null },
        { id: 'n2', nodeType: 'scene', title: '章二', venuePointId: 'pt2', grants: ['s2'], requires: null, puzzle: null },
        { id: 'n3', nodeType: 'scene', title: '开场白', grants: [], requires: null, puzzle: null },
      ],
    } as any);
    expect(errs).toEqual([]);
  });
});

// 可达性（2026-09-15）。旧规则只查「引用存在」，于是「引用了存在、但永不被满足的 id」静默过闸。
// 这是 AI 生成剧本的系统性缺陷：scene 节点普遍不自 complete，而后继节点把前一个 scene 当作
// completed 引用 ⇒ 第 2 关硬死锁，玩家永远玩不下去（生产实测 4 个产品共 28 处）。
//
// 本组用例的关键设计：**每条都要有「引用存在」这一半** —— 若引用的 id 根本不存在，
// 旧规则就已经报错了，用例会在实现之前就是绿的（分不清「新规则咬住了」与「旧规则本来就在报」）。
// 故 R1/R2 的负例里被引用的 id 都真实存在于 nodes/collectibles 中。
describe('validateWenlvIntegrity（可达性：引用存在但永不被满足）', () => {
  // 最小可发布 narrative 骨架：1 scene + 1 ending
  const narrative = (nodes: any[], endings: any[], collectibles: any[] = []) => ({
    product: { id: 'P1', name: '合成样例', mode: 'narrative' as const, status: 'draft' as const },
    nodes, collectibles, endings, rewards: [],
  });

  it('R1：unlock_condition 要求某节点 completed，但无人 complete 它 → 报错（该 id 存在，旧规则放行）', () => {
    const errs = validateWenlvIntegrity(
      narrative(
        [
          { id: 'N1', nodeType: 'scene', title: '村口', grants: [] },
          {
            id: 'N2', nodeType: 'puzzle', title: '对暗号',
            requires: { type: 'ref', ref: { kind: 'completed', id: 'N1' } },
            grants: [],
          },
        ],
        [{ id: 'E1', title: '圆满', triggerCondition: null }],
      ) as any,
    );
    // 两半都要断言：N2 存在（旧规则不报）+ 新规则报了
    expect(errs.some((e) => e.includes('引用不存在的节点'))).toBe(false);
    expect(errs.some((e) => e.includes('N1') && e.includes('永远无法满足'))).toBe(true);
  });

  it('R1：结局 trigger_condition 要求 completed 的节点无人 complete 它 → 报错', () => {
    const errs = validateWenlvIntegrity(
      narrative(
        [{ id: 'N1', nodeType: 'scene', title: '村口', grants: [] }],
        [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'completed', id: 'N1' } } }],
      ) as any,
    );
    expect(errs.some((e) => e.includes('N1') && e.includes('永远无法满足'))).toBe(true);
  });

  it('R1：visited 引用同一节点**不**报错（visited 由 markVisited 写入，人人可达）', () => {
    const errs = validateWenlvIntegrity(
      narrative(
        [
          { id: 'N1', nodeType: 'scene', title: '村口', grants: [] },
          {
            id: 'N2', nodeType: 'puzzle', title: '对暗号',
            requires: { type: 'ref', ref: { kind: 'visited', id: 'N1' } },
            grants: [], puzzle: { type: 'single', question: '暗号是？', options: ['A'], answer: 'A' },
          },
        ],
        [{ id: 'E1', title: '圆满', triggerCondition: null }],
      ) as any,
    );
    expect(errs).toEqual([]);
  });

  it('R2：结局引用一条无人发放的线索 → 报错（线索存在，旧规则放行）', () => {
    const errs = validateWenlvIntegrity(
      narrative(
        [{ id: 'N1', nodeType: 'scene', title: '村口', grants: [] }],
        [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'C1' } } }],
        [{ id: 'C1', name: '孤儿线索', type: 'clue' }],
      ) as any,
    );
    expect(errs.some((e) => e.includes('引用不存在的线索'))).toBe(false);
    expect(errs.some((e) => e.includes('C1') && e.includes('永远无法满足'))).toBe(true);
  });

  it('R2 正例：有节点发放该线索 → 零错误', () => {
    const errs = validateWenlvIntegrity(
      narrative(
        [{ id: 'N1', nodeType: 'scene', title: '村口', grants: ['C1'] }],
        [{ id: 'E1', title: '圆满', triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'C1' } } }],
        [{ id: 'C1', name: '密信', type: 'clue' }],
      ) as any,
    );
    expect(errs).toEqual([]);
  });

  // 集章线与 narrative 共用同一套引擎语义，故 R1/R2 必须同样咬住 rally
  // （集章的档位条件是 collected 引用，正是 R2 的适用面）
  it('R1/R2 在 rally 下同样生效：节点 unlock 死锁 + 档位引用无人发放的印章', () => {
    const errs = validateWenlvIntegrity({
      product: { id: 'p', name: '集章', mode: 'rally' as const, venueId: 'v1' },
      nodes: [
        { id: 'n1', nodeType: 'scene', title: '起点', venuePointId: 'pt1', grants: [], requires: null, puzzle: null },
        {
          id: 'n2', nodeType: 'scene', title: '终点', venuePointId: 'pt1',
          grants: ['s1'],
          requires: { type: 'ref', ref: { kind: 'completed', id: 'n1' } }, puzzle: null,
        },
      ],
      collectibles: [{ id: 's1', name: '印1', type: 'stamp' }, { id: 's2', name: '印2', type: 'stamp' }],
      endings: [],
      rewards: [{ id: 'r1', name: '奖' }],
      tiers: [{ id: 't1', name: '档', condition: { type: 'ref', ref: { kind: 'collected', id: 's2' } }, rewardId: 'r1' }],
      points: [{ id: 'pt1', code: 'WLP-R0001', venueId: 'v1' }],
    } as any);
    // 两条规则的收尾词不同（节点是「条件永远无法满足」、档位是「档位永远无法达成」），故断言公共前缀
    expect(errs.some((e) => e.includes('n1') && e.includes('永远无法'))).toBe(true);
    expect(errs.some((e) => e.includes('s2') && e.includes('永远无法'))).toBe(true);
  });
});

describe('interactions 规则（S4④：puzzle 判定 / scene 现场动作）', () => {
  const narrative = (nodes: any[], endings: any[] = [{ id: 'E1', title: '圆满', triggerCondition: null }]) =>
    ({ product: { id: 'P1', name: '合成', mode: 'narrative' as const }, nodes, collectibles: [], endings, rewards: [] });
  const q = { type: 'single', question: 'q', options: ['a'], answer: 'a' };
  const scene = (p: any) => [{ id: 'N1', nodeType: 'scene', title: '村口', grants: [], puzzle: p }];
  const puzzle = (p: any) => [
    { id: 'N1', nodeType: 'scene', title: '村口', grants: [] },
    { id: 'N2', nodeType: 'puzzle', title: '对暗号', grants: [], puzzle: p },
  ];

  it('puzzle 用 photo → 报错且文案指向 scene 节点', () => {
    const errs = validateWenlvIntegrity(narrative(puzzle({ type: 'photo', question: 'q' })) as any);
    expect(errs.some((e) => e.includes('不接受 photo') && e.includes('scene'))).toBe(true);
  });

  it('puzzle 用 meditate → 报错且文案指向 scene 节点', () => {
    const errs = validateWenlvIntegrity(narrative(puzzle({ type: 'meditate', question: 'q', seconds: 60 })) as any);
    expect(errs.some((e) => e.includes('不接受 meditate') && e.includes('scene'))).toBe(true);
  });

  it('puzzle 无交互 → 报错（narrative 下首次生效）', () => {
    const errs = validateWenlvIntegrity(narrative(puzzle(null)) as any);
    expect(errs.some((e) => e.includes('必须有交互题目'))).toBe(true);
  });

  it('puzzle 单选取空答案 → 报错', () => {
    const errs = validateWenlvIntegrity(narrative(puzzle({ ...q, answer: '' })) as any);
    // 必须同时钉 `谜题[` 前缀：scene 兜底分支对 quiz 空答案推的是**逐字相同**的文案，
    // 只把前缀从「谜题[」换成「节点[」。只断「答案不能为空」的话，把整个 puzzle 分支
    // 删掉、让 puzzle 节点落进 scene 分支时，本用例依然绿（实测：这正是被掩掉的形态）。
    expect(errs.some((e) => e.includes('谜题[') && e.includes('答案不能为空'))).toBe(true);
  });

  it('puzzle 合法 → 零错误', () => {
    expect(validateWenlvIntegrity(narrative(puzzle(q)) as any)).toEqual([]);
  });

  // 注意：本用例在改动前就是绿的 —— 旧实现压根不校验 narrative 的 scene 交互，
  // 所以它**不是**「救活 37 条」的证据，只是一条「不要过严」的正例护栏：
  // 新规则若把带答案的剧情回味题误判成错误，这里才会红。
  // 真正证明新规则生效的是那些「改动前绿、改动后红」的报错用例（见本 describe 内的负例）。
  it('scene 带剧情回味题（有答案）→ 零错误（正例护栏，非修复证据）', () => {
    expect(validateWenlvIntegrity(narrative(scene(q)) as any)).toEqual([]);
  });

  it('scene 取空答案 → 报错', () => {
    const errs = validateWenlvIntegrity(narrative(scene({ ...q, answer: '' })) as any);
    // 对称地钉 `节点[` 前缀：puzzle 分支对 quiz 空答案推的是「谜题[...] 答案不能为空」，
    // 只断「答案不能为空」无法区分「scene 分支生效」与「scene 节点被 puzzle 分支接管」。
    expect(errs.some((e) => e.includes('节点[') && e.includes('答案不能为空'))).toBe(true);
  });

  it('scene 用 photo → 零错误', () => {
    expect(validateWenlvIntegrity(narrative(scene({ type: 'photo', question: '拍一张' })) as any)).toEqual([]);
  });

  it('scene 用 meditate 且 seconds=60 → 零错误', () => {
    expect(validateWenlvIntegrity(narrative(scene({ type: 'meditate', question: '静坐', seconds: 60 })) as any)).toEqual([]);
  });

  it('scene meditate 的 seconds 为 0 / 1800.5 / 缺失 / 2000 → 一律报错', () => {
    for (const seconds of [0, 1800.5, undefined, 2000]) {
      const errs = validateWenlvIntegrity(narrative(scene({ type: 'meditate', question: '静坐', seconds })) as any);
      expect(errs.some((e) => e.includes('节点[') && e.includes('静坐时长')), `seconds=${seconds} 应报错`).toBe(true);
    }
  });

  it('scene 用未知类型 → 报错', () => {
    const errs = validateWenlvIntegrity(narrative(scene({ type: 'foo', question: 'q' })) as any);
    expect(errs.some((e) => e.includes('节点[') && e.includes("'foo'"))).toBe(true);
  });

  it('rally 下同样生效：scene 用未知类型 → 报错', () => {
    const errs = validateWenlvIntegrity({
      product: { id: 'P1', name: '集章', mode: 'rally' as const },
      nodes: [{ id: 'N1', nodeType: 'scene', title: '点', grants: [], puzzle: { type: 'foo', question: 'q' } }],
      collectibles: [], endings: [], rewards: [], tiers: [{ id: 't1', name: '档', condition: null }],
    } as any);
    expect(errs.some((e) => e.includes('节点[') && e.includes("'foo'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 现场动作的题干非空（2026-09-18，块 C）。发布闸此前对 scene 上的 photo 是**零校验**
// （原句 `if (t === 'photo') continue;`），meditate 也只看 seconds —— 而前端
// pms-nimi/src/pages/wenlv/play.vue 的 photo/meditate 两个分支都直接渲染 `it.question`，
// 空的题干会让游客看到一个没有任何文字的弹层。空 question 在库里完全合法，
// 所以只有发布闸能拦。Python 侧（pms-ai-crew/src/services/wenlv_integrity.py）已同步 ——
// 见 `wenlv-integrity.ts` 里 `checkInteractions` 上方那条「逐字同构」约束（不写行号 —— 会漂），由 pms-ai-crew 的
// test_error_message_literals_match_ts_integrity 自动执行。
// ---------------------------------------------------------------------------
describe('scene 节点的现场动作题干（块 C）', () => {
  const narrative = (p: any) => ({
    product: { id: 'P1', name: '合成', mode: 'narrative' as const },
    nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', grants: [], puzzle: p }],
    collectibles: [], endings: [{ id: 'E1', title: '圆满', triggerCondition: null }], rewards: [],
  });

  it('photo 缺 question → 报错', () => {
    const errs = validateWenlvIntegrity(narrative({ type: 'photo' }) as any);
    expect(errs.some((e) => e.includes('拍照打卡') && e.includes('题干'))).toBe(true);
  });

  it('photo 的 question 是纯空白 → 同样报错（trim 后才算有题）', () => {
    const errs = validateWenlvIntegrity(narrative({ type: 'photo', question: '   ' }) as any);
    expect(errs.some((e) => e.includes('拍照打卡') && e.includes('题干'))).toBe(true);
  });

  // 对称于 judge 取值域的「不做隐式转换」：数字 123 不是题干。
  it('photo 的 question 非字符串（数字）→ 报错（不做隐式转换）', () => {
    const errs = validateWenlvIntegrity(narrative({ type: 'photo', question: 123 }) as any);
    expect(errs.some((e) => e.includes('拍照打卡') && e.includes('题干'))).toBe(true);
  });

  it('photo 有非空 question → 零错误', () => {
    expect(validateWenlvIntegrity(narrative({ type: 'photo', question: '拍下渡口的灯' }) as any)).toEqual([]);
  });

  it('meditate 缺 question → 报错', () => {
    const errs = validateWenlvIntegrity(narrative({ type: 'meditate', seconds: 60 }) as any);
    expect(errs.some((e) => e.includes('静坐计时') && e.includes('题干'))).toBe(true);
  });

  it('meditate 有 question 但 seconds 非法 → 仍只报 seconds 那条（两条规则互不吞并）', () => {
    const errs = validateWenlvIntegrity(narrative({ type: 'meditate', question: '静坐一会儿', seconds: 0 }) as any);
    expect(errs.some((e) => e.includes('静坐时长'))).toBe(true);
    expect(errs.some((e) => e.includes('题干'))).toBe(false);
  });

  // 反向：两条规则的**另一侧** —— 缺题干时 seconds 那条不能被题干校验短路掉。
  it('meditate 缺 question 且 seconds 非法 → 两条都报', () => {
    const errs = validateWenlvIntegrity(narrative({ type: 'meditate', seconds: 0 }) as any);
    expect(errs.some((e) => e.includes('静坐时长'))).toBe(true);
    expect(errs.some((e) => e.includes('静坐计时') && e.includes('题干'))).toBe(true);
  });

  // 回归：photo / meditate 合并成一个分支后若漏掉末尾的 `continue`，控制流会掉到
  // 「交互类型 'photo' 非法」那条 ⇒ 每个现场动作节点都平白多报一条。
  it('photo / meditate 不冒「交互类型非法」（photo/meditate 分支必须留住）', () => {
    // 新 schema 下每个节点只有一个 puzzle，故用两个节点分别承载 photo 与 meditate。
    const errs = validateWenlvIntegrity({
      product: { id: 'P1', name: '合成', mode: 'narrative' as const },
      nodes: [
        { id: 'N1', nodeType: 'scene', title: '村口', grants: [], puzzle: { type: 'photo' } },
        { id: 'N2', nodeType: 'scene', title: '渡口', grants: [], puzzle: { type: 'meditate', seconds: 60 } },
      ],
      collectibles: [], endings: [{ id: 'E1', title: '圆满', triggerCondition: null }], rewards: [],
    } as any);
    expect(errs.some((e) => e.includes('交互类型'))).toBe(false);
  });

  it('谜题节点里出现 photo 仍被拒（回归：puzzle 分支不许 photo/meditate）', () => {
    const errs = validateWenlvIntegrity({
      product: { id: 'P1', name: '合成', mode: 'narrative' as const },
      nodes: [
        { id: 'N1', nodeType: 'scene', title: '村口', grants: [] },
        { id: 'N2', nodeType: 'puzzle', title: '对暗号', grants: [], puzzle: { type: 'photo' } },
      ],
      collectibles: [], endings: [{ id: 'E1', title: '圆满', triggerCondition: null }], rewards: [],
    } as any);
    expect(errs.some((e) => e.includes('不接受 photo'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// judge 答案取值域（2026-09-17）。
// 全链路只认 'true' | 'false' 字面量：schema 类型（db/schema/wenlv.ts）、创作台下拉、
// pms-nimi 的 pickedJudge、engine 的 isAnswerCorrect 逐字比较。生成器此前没有任何取值域契约，
// AI 按人类可读写 ⇒ 生产全库 17 条 judge 写成「对」「正确」，客户端提交 'true'/'false' 永远不等。
// 旧校验器只查「答案非空」，于是这 17 条一路通过生成闸与发布闸。
// **两种 nodeType 都要覆盖** —— 旧校验器只在 puzzle 分支里检查，才让脏数据积压。
// ---------------------------------------------------------------------------
describe('validateWenlvIntegrity（judge 答案取值域）', () => {
  // puzzle 节点不能没有交互题（谜题必须有题目），故非被测一侧塞一条合法 single 占位。
  const filler = () => ({ type: 'single', question: '占位', options: ['a'], answer: 'a' });
  const withNode = (nodeType: 'scene' | 'puzzle', p: any) => ({
    product: { id: 'P1', name: '合成', mode: 'narrative' as const },
    nodes: [
      { id: 'N1', nodeType: 'scene', title: '村口', grants: [], puzzle: nodeType === 'scene' ? p : null },
      { id: 'N2', nodeType: 'puzzle', title: '对暗号', grants: [], puzzle: nodeType === 'puzzle' ? p : filler() },
    ],
    collectibles: [], endings: [{ id: 'E1', title: '圆满', triggerCondition: null }], rewards: [],
  });
  const judge = (extra: Record<string, unknown>) => ({ type: 'judge', question: '这句话对吗？', ...extra });
  const valueDomainErrs = (errs: string[]) => errs.filter((e) => e.includes("只能是 'true' 或 'false'"));
  const emptyErrs = (errs: string[]) => errs.filter((e) => e.includes('答案不能为空'));

  for (const nodeType of ['puzzle', 'scene'] as const) {
    it(`${nodeType}: judge + answer'对' → 只报取值域，不报「答案不能为空」`, () => {
      const errs = validateWenlvIntegrity(withNode(nodeType, judge({ answer: '对' })) as any);
      expect(valueDomainErrs(errs).length).toBe(1);
      expect(valueDomainErrs(errs)[0]).toContain('对');
      expect(emptyErrs(errs)).toEqual([]);
    });

    it(`${nodeType}: judge + answer'正确' → 报取值域`, () => {
      const errs = validateWenlvIntegrity(withNode(nodeType, judge({ answer: '正确' })) as any);
      expect(valueDomainErrs(errs).length).toBe(1);
      expect(emptyErrs(errs)).toEqual([]);
    });

    it(`${nodeType}: judge + answer'true' → 不报错`, () => {
      expect(validateWenlvIntegrity(withNode(nodeType, judge({ answer: 'true' })) as any)).toEqual([]);
    });

    it(`${nodeType}: judge + answer'false' → 不报错`, () => {
      expect(validateWenlvIntegrity(withNode(nodeType, judge({ answer: 'false' })) as any)).toEqual([]);
    });

    it(`${nodeType}: judge 无 answer 键 → 报「答案不能为空」而非取值域`, () => {
      const errs = validateWenlvIntegrity(withNode(nodeType, { type: 'judge', question: 'q' }) as any);
      expect(emptyErrs(errs).length).toBe(1);
      expect(valueDomainErrs(errs)).toEqual([]);
    });

    it(`${nodeType}: 非 judge 题型不受取值域约束（single + answer'对' 不报错）`, () => {
      const errs = validateWenlvIntegrity(
        withNode(nodeType, { type: 'single', question: 'q', options: ['对', '错'], answer: '对' }) as any,
      );
      expect(errs).toEqual([]);
    });
  }

  it('judge 的 answer 为非字符串真值（数字 1）→ 报取值域（不做隐式转换）', () => {
    const errs = validateWenlvIntegrity(withNode('puzzle', judge({ answer: 1 })) as any);
    expect(valueDomainErrs(errs).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 结局可区分性（2026-09-18）。设计依据：specs/2026-09-18-wenlv-ending-resolution-design.md §2.1
// —— 条件语言单调 ⇒ 互斥的多结局在本表达力下**数学上不可能存在**，只能是阶梯。
// 既然互斥做不到，**可区分性**就必须由发布闸硬保证，否则运行时「取 priority 最大者」在两
// 结局同真同假 / 同 priority 时只能静默退化成任意选择（同条件）或 id 字典序（平手）。
//   ① 引用集合完全相同 ⇒ 两个结局在任何状态下同真同假 ⇒ 硬拒。
//   ② priority 重复 ⇒ 平手 ⇒ 硬拒（要求作者显式打破）。
// ---------------------------------------------------------------------------
describe('validateWenlvIntegrity（结局可区分性：同条件 / 重复 priority）', () => {
  const ref = (id: string) => ({ type: 'ref' as const, ref: { kind: 'collected' as const, id } });
  const all = (...ids: string[]) => ({ type: 'all' as const, conditions: ids.map(ref) });
  // 非 collected 的 kind 也需要能被夹具表达（key 必须覆盖全部 kind，见下面的新用例）
  const refKind = (kind: 'collected' | 'completed' | 'visited', id: string) => ({ type: 'ref' as const, ref: { kind, id } });
  const allOf = (...conds: any[]) => ({ type: 'all' as const, conditions: conds });
  // 最小可发布 narrative 骨架：1 个 scene 发放全部线索（满足 R2 可达性）+ 结局由参数给。
  // C1/C2 必须被某个节点 grant，否则会额外触发可达性错误、污染断言的判别力。
  // extraNodes：需要引用 completed 时补节点（N5 必须存在且被某节点 complete，否则触发 R1）。
  const narrative = (endings: any[], extraNodes: any[] = []) => ({
    product: { id: 'P1', name: '合成样例', mode: 'narrative' as const, status: 'draft' as const },
    nodes: [
      { id: 'N1', nodeType: 'scene', title: '村口', grants: ['C1', 'C2'] },
      ...extraNodes,
    ],
    collectibles: [{ id: 'C1', name: '密信', type: 'clue' }, { id: 'C2', name: '地图', type: 'clue' }],
    endings,
    rewards: [],
  });

  it('两个结局的引用集合完全相同 ⇒ 拒绝（无法区分，玩家拿到哪个无意义）', () => {
    // 两个结局引用**同一组**线索；第二个把顺序写反，证明判定依赖的是集合而非书写顺序。
    // priority 给不同值，令本用例只咬「同条件」这一条、与「重复 priority」正交。
    const errs = validateWenlvIntegrity(
      narrative([
        { id: 'E1', title: '真相大白', priority: 1, triggerCondition: all('C1', 'C2') },
        { id: 'E2', title: '故人归来', priority: 2, triggerCondition: all('C2', 'C1') },
      ]) as any,
    );
    expect(errs.some((e) => e.includes('达成条件完全相同'))).toBe(true);
  });

  it('同一产品内 priority 重复 ⇒ 拒绝（平手必须由作者显式打破）', () => {
    // 两个结局条件不同（不触发「同条件」规则），但 priority 都是 3。
    const errs = validateWenlvIntegrity(
      narrative([
        { id: 'E1', title: '真相大白', priority: 3, triggerCondition: all('C1') },
        { id: 'E2', title: '故人归来', priority: 3, triggerCondition: all('C2') },
      ]) as any,
    );
    expect(errs.some((e) => e.includes('priority 重复'))).toBe(true);
  });

  it('条件不同且 priority 不同 ⇒ 零错误（反过度拦截正例）', () => {
    // 两条新规则都不得误伤合法的阶梯式多结局：条件不同、priority 互异 ⇒ 整份输入零错误。
    const errs = validateWenlvIntegrity(
      narrative([
        { id: 'E1', title: '小成', priority: 1, triggerCondition: all('C1') },
        { id: 'E2', title: '大成', priority: 2, triggerCondition: all('C1', 'C2') },
      ]) as any,
    );
    expect(errs).toEqual([]);
  });

  // 下面三条钉住 refKeyOf 的**假阳性**修复（2026-09-18）：
  // 旧实现 `[...new Set(collectRefs(c).filter(r => r.kind === 'collected').map(r => r.id))]`
  // 只收集 collected 引用 ⇒ 「collected 集合相同、仅非 collected 引用不同」的两个结局会撞键，
  // 被误报「达成条件完全相同」。但它们**可区分**（见各用例内的状态论证），拦下合法内容。
  it('部分重叠的引用集合（all(collected C1) vs all(collected C1, completed N5)）⇒ 不得误报「完全相同」', () => {
    // 旧键：两者都得到 "C1" ⇒ 误报。新键：分别 "collected:C1" 与 "collected:C1|completed:N5"。
    // 状态 {collected:{C1:true}} 满足前者、不满足后者 —— 二者可区分。
    // N5 必须存在；completed 引用现已废弃（会报 deprecated 错误），但本用例只关心
    // refKey 是否把两种 kind 区分开，故只断言不报「完全相同」假阳性。
    const errs = validateWenlvIntegrity(
      narrative(
        [
          { id: 'E1', title: '小成', priority: 1, triggerCondition: all('C1') },
          { id: 'E2', title: '大成', priority: 2, triggerCondition: allOf(ref('C1'), refKind('completed', 'N5')) },
        ],
        [{ id: 'N5', nodeType: 'scene', title: '尾声', grants: [] }],
      ) as any,
    );
    expect(errs.some((e) => e.includes('完全相同'))).toBe(false);
  });

  it('key 覆盖 visited/completed 全部 kind（同一节点 id、仅 kind 不同）⇒ 不得误报「完全相同」', () => {
    // 旧键：visited/completed 都被过滤 ⇒ 两者都是空串 ⇒ 误报。
    // 若只按 id 去重（忽略 kind），两者都会是 "N5" ⇒ 同样误报。
    // 但「访问过 N5」不蕴含「已完成 N5」⇒ 二者可区分，键必须以 kind 为前缀。
    // 注：completed 现已废弃（恒报 deprecated 错误），本用例只钉 refKey 不撞键这一点。
    const errs = validateWenlvIntegrity(
      narrative(
        [
          { id: 'E1', title: '到过', priority: 1, triggerCondition: allOf(refKind('visited', 'N5')) },
          { id: 'E2', title: '完成', priority: 2, triggerCondition: allOf(refKind('completed', 'N5')) },
        ],
        [{ id: 'N5', nodeType: 'scene', title: '尾声', grants: [] }],
      ) as any,
    );
    expect(errs.some((e) => e.includes('完全相同'))).toBe(false);
  });

  it('原判据仍 bite：同一组线索、书写顺序不同 ⇒ 仍判「完全相同」（集合比较、与顺序无关）', () => {
    const errs = validateWenlvIntegrity(
      narrative([
        { id: 'E1', title: '真相大白', priority: 1, triggerCondition: all('C1', 'C2') },
        { id: 'E2', title: '故人归来', priority: 2, triggerCondition: all('C2', 'C1') },
      ]) as any,
    );
    expect(errs.some((e) => e.includes('达成条件完全相同'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 档位 condition 必填，从「仅 rally」推广到「两种模式」（2026-09-20）。
// 依据：wenlv-engine.ts 的 evalCondition 开头是 `if (!cond) return true;`（空条件恒真），
// 而 /redeem 没有任何 mode 判据 ⇒ narrative 可静默发布一个「无条件、人人可领」的档位。
// 原先只有 rally 分支拦这一条。生产实测：两种模式的档位数合计为 0 ⇒ 本次零行为变更。
// 注意本组只钉「condition 是否为空」；rally 专有的引用语义（只能 collected / 必须 stamp /
// 必须有人发放）留在 rally 分支内，**不要**搬进 narrative —— 那会凭空产生错误。
// ---------------------------------------------------------------------------
describe('档位 condition：两种模式同规则', () => {
  /** narrative 分支还要求 ≥1 个 scene 节点、≥1 个 ending，故夹具必须补齐，
   *  否则报错会来自别的规则、无法归因到 condition。 */
  const narrativeBase = {
    ...base,
    product: { ...base.product, mode: 'narrative' },
    nodes: [{ id: 'N1', nodeType: 'scene', title: '村口' }] as any[],
    endings: [{ id: 'E1', title: '归途' }] as any[],
  };

  it('narrative 模式下的 condition=null 档位 → 报「必须设置达成条件」（本次修复）', () => {
    const errs = validateWenlvIntegrity({
      ...narrativeBase,
      tiers: [{ id: 'T1', name: '银档', condition: null }] as any[],
    });
    expect(errs.some((e) => e.includes('必须设置达成条件'))).toBe(true);
  });

  it('narrative 模式下条件合法 → 不因档位报错（防修成一刀切）', () => {
    const errs = validateWenlvIntegrity({
      ...narrativeBase,
      tiers: [{ id: 'T1', name: '银档', condition: { type: 'ref', ref: { kind: 'collected', id: 'C1' } } }] as any[],
    });
    expect(errs.some((e) => e.includes('必须设置达成条件'))).toBe(false);
  });

  it('rally 模式下的 condition=null 档位 → 报同样的错（既有行为，防回归）', () => {
    const errs = validateWenlvIntegrity({
      ...base,
      product: { ...base.product, mode: 'rally' },
      tiers: [{ id: 'T1', name: '银档', condition: null }] as any[],
    });
    expect(errs.some((e) => e.includes('必须设置达成条件'))).toBe(true);
  });
});

// Task 11（N2 Phase）：collectRefs 扩展 npc_id / npc_line_ids。
// collectRefs 原本只 walk 条件树（WenlvCondition）收集 collected/completed/visited 引用；
// 现多态：传 IntegrityNode[] 时收集 npc / npc_line 引用（R-N1/R-N2 校验用）。
// npc_line 引用**必须带 npcId 上下文** —— T12 的 R-N2 要在所属 NPC 内查台词是否存在，
// 否则跨 NPC 同名台词会误判。计划 Step 1 的测试草图写的是 `{ kind: 'npc_line', id: 'l1' }`，
// 但与 Step 3 实现 `{ ..., npcId: node.npc_id }` 在 toContainEqual（深度相等）下互斥；
// 任务描述明确「npc_line 引用要带 npcId 上下文」是 must，故测试按实现断言 npcId。
// 本 task **只**扩 collectRefs，**不**实现 R-N1~R-N4 校验规则（T12 的事），
// 也不改 validateWenlvIntegrity 的行为。
describe('collectRefs（npc_id / npc_line_ids 扩展）', () => {
  it('collectRefs collects npc_id + npc_line_ids from nodes', () => {
    const nodes = [{ npcId: 'npc-1', npcLineIds: ['l1', 'l2'] }];
    const refs = collectRefs(nodes as any);
    expect(refs).toContainEqual({ kind: 'npc', id: 'npc-1' });
    // npc_line 带 npcId 上下文：R-N2 校验时需在该 NPC 内查台词
    expect(refs).toContainEqual({ kind: 'npc_line', id: 'l1', npcId: 'npc-1' });
    expect(refs).toContainEqual({ kind: 'npc_line', id: 'l2', npcId: 'npc-1' });
  });

  it('collectRefs 传 WenlvCondition 时仍走原条件树遍历（不破坏）', () => {
    // 多态分流的另一侧：传条件时仍递归收集 ref 叶子
    const cond = {
      type: 'all' as const,
      conditions: [
        { type: 'ref' as const, ref: { kind: 'visited' as const, id: 'N1' } },
        { type: 'ref' as const, ref: { kind: 'collected' as const, id: 'C1' } },
      ],
    };
    const refs = collectRefs(cond);
    expect(refs).toContainEqual({ kind: 'visited', id: 'N1' });
    expect(refs).toContainEqual({ kind: 'collected', id: 'C1' });
    // 不应混入 npc 引用
    expect(refs.some((r) => r.kind === 'npc' || r.kind === 'npc_line')).toBe(false);
  });

  it('collectRefs 传 null/undefined 时返回空数组（向后兼容）', () => {
    expect(collectRefs(null)).toEqual([]);
    expect(collectRefs(undefined)).toEqual([]);
  });

  // 边界用例（T12 前置：锁定 collectRefs 输出契约，防 R-N1/R-N2 实现时被误改）
  it('collectRefs 空节点数组返回空', () => {
    expect(collectRefs([])).toEqual([]);
  });

  it('collectRefs 节点有 npc_id 但空 npc_line_ids 只产 npc ref', () => {
    const refs = collectRefs([{ npcId: 'n1', npcLineIds: [] }] as any);
    expect(refs).toEqual([{ kind: 'npc', id: 'n1' }]);
  });

  // 悬挂 npc_line_ids（无 npc_id）：实现里 `if (node.npc_id)` 为假 ⇒ 不产 npc ref；
  // 但 `if (node.npc_line_ids)` 仍真 ⇒ 进循环产 npc_line ref，npcId 经 `?? undefined` 归一为 undefined。
  // 这是当前契约：悬挂台词仍被收集，但无 NPC 上下文（T12 的 R-N2 会判定为非法并报错）。
  // 本用例钉死该形状，防 T12 实现时误把悬挂台词静默吞掉或误填 npcId。
  it('collectRefs 悬挂 npc_line_ids 无 npc_id 产 npcId=undefined', () => {
    const refs = collectRefs([{ npcLineIds: ['l1'] }] as any);
    expect(refs).toContainEqual({ kind: 'npc_line', id: 'l1', npcId: undefined });
    // 不应误产 npc ref（无 npc_id 可引用）
    expect(refs.some((r) => r.kind === 'npc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 12：R-N1~R-N4 NPC 引用完整性（spec §9）。
// 错误格式与既有规则同款 —— string[] 文案数组，每条错误含 [R-Nx] 编号便于定位。
// 校验位置：mode 分流之前（narrative / rally 共享，NPC 引用与 mode 无关）。
// 跳过条件：input.npcs 未提供 ⇒ R-N1~R-N4 全部跳过（向后兼容既有调用点）；
//           节点无 npc_id ⇒ R-N1/R-N2 跳过该节点；
//           npc 无 character_id ⇒ R-N3 跳过该 npc；
//           input.characters 未提供 ⇒ R-N3 跳过（但 R-N1/R-N2/R-N4 仍跑）。
// ---------------------------------------------------------------------------
describe('validateWenlvIntegrity（Task 12: R-N1~R-N4 NPC 引用完整性）', () => {
  // 合法 narrative 骨架：1 scene + 1 ending，且补全合法 npc/character/line。
  // 既是 R-N1~R-N4 的「全部合法」正例，也是各负例的基线夹具（每条用例只改一处）。
  const baseNpc = {
    product: { id: 'P1', name: 'NPC 测试', mode: 'narrative' as const, status: 'draft' as const },
    nodes: [
      { id: 'N1', nodeType: 'scene', title: '村口', npcId: 'npc1', npcLineIds: ['l1'] },
    ],
    collectibles: [],
    endings: [{ id: 'E1', title: '圆满', triggerCondition: null }],
    rewards: [],
    npcs: [
      {
        id: 'npc1', name: '张三', characterId: 'ch1',
        portraitPrompt: '古风立绘 prompt', voiceId: 'voice-1',
        lines: [{ id: 'l1', text: '你好' }],
      },
    ],
    characters: [{ id: 'ch1', name: '主角', faction: '正派', identity: '少侠', vitality: 80, wisdom: 70, insight: 60 }],
  };

  it('R-N1: 节点 npc_id 不在产品 NPC 表内 → 报错且文案点名该 NPC 与节点', () => {
    // npc_line_ids 非空（['l1']）：R-N1 命中后实现里有 `continue` 跳过该节点的 R-N2。
    // 若有人删掉那个 continue，R-N2 会拿 undefined 的 npc 去查 lines —— 本用例钉住
    // 「R-N1 命中 ⇒ 该节点不再走 R-N2」这一短路：R-N2 必须不报。
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', npcId: 'missing', npcLineIds: ['l1'] }],
    } as any);
    const hit = errs.find((e) => e.includes('R-N1'));
    expect(!!hit && hit.includes('missing') && hit.includes('村口')).toBe(true);
    // R-N2 必须不报：R-N1 命中后 continue 短路了该节点的 R-N2
    expect(errs.some((e) => e.includes('R-N2'))).toBe(false);
  });

  it('R-N2: 节点 npc_line_ids 引用的台词不在所属 NPC.lines 内 → 报错', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', npcId: 'npc1', npcLineIds: ['ghost-line'] }],
    } as any);
    const hit = errs.find((e) => e.includes('R-N2'));
    expect(!!hit && hit.includes('ghost-line') && hit.includes('npc1')).toBe(true);
  });

  // I-1 判别力用例：台词 EXISTS 但在 WRONG NPC。若有人把 R-N2 改成「扫所有 NPC 的 lines」
  // （而非对照 node.npc_id 指向的那个 NPC），l2 会在全局扫描中找到 ⇒ 错误地通过本用例。
  // 正确实现只查 npc1 的 lines（含 l1 不含 l2）⇒ 报 R-N2。这是 R-N2 区分「按 NPC 查」与
  // 「全局查」的唯一用例 —— ghost-line 那条两个实现都报，无法区分。
  it('R-N2: 台词存在于另一 NPC 但不在所属 NPC → 报错（判别力：禁止全局扫描 NPC.lines）', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', npcId: 'npc1', npcLineIds: ['l2'] }],
      npcs: [
        { id: 'npc1', name: '张三', characterId: 'ch1', lines: [{ id: 'l1', text: '你好' }] },
        { id: 'npc2', name: '李四', characterId: 'ch1', lines: [{ id: 'l2', text: '别的台词' }] },
      ],
      characters: [{ id: 'ch1', name: '主角' }],
    } as any);
    const hit = errs.find((e) => e.includes('R-N2'));
    // 文案必须点名 l2（被引用的台词）与 npc1（应该拥有它的 NPC，但没有）
    expect(!!hit && hit.includes('l2') && hit.includes('npc1')).toBe(true);
  });

  it('R-N3: npc.character_id 不在 character 表内 → 报错', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      npcs: [{
        id: 'npc1', name: '张三', characterId: 'ghost-char',
        lines: [{ id: 'l1', text: '你好' }],
      }],
      characters: [{ id: 'ch1', name: '主角' }],
    } as any);
    const hit = errs.find((e) => e.includes('R-N3'));
    expect(!!hit && hit.includes('ghost-char') && hit.includes('npc1')).toBe(true);
  });

  it('R-N4: npc.lines.id 在该 NPC 内重复 → 报错', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      npcs: [{
        id: 'npc1', name: '张三', characterId: 'ch1',
        lines: [{ id: 'l1', text: '你好' }, { id: 'l1', text: '重复台词' }],
      }],
      characters: [{ id: 'ch1', name: '主角' }],
    } as any);
    expect(errs.some((e) => e.includes('R-N4') && e.includes('l1'))).toBe(true);
  });

  it('R-N4: npc.lines 为空数组 → 报错（lines 至少 1 条，强制约束）', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', npcId: 'npc1', npcLineIds: [] }],
      npcs: [{ id: 'npc1', name: '张三', characterId: 'ch1', lines: [] }],
      characters: [{ id: 'ch1', name: '主角' }],
    } as any);
    // 同时钉住「至少 1 条台词」这一空 lines 专属文案，区分「空」与「id 重复」两个分支：
    // 若有人把空分支删掉、让空数组也走重复检查分支，本断言会红（空数组不产「至少」文案）。
    expect(errs.some((e) => e.includes('R-N4') && e.includes('至少需要 1 条台词'))).toBe(true);
  });

  it('npcs 未提供 → R-N1~R-N4 全部跳过（向后兼容，既有调用点不传 npcs）', () => {
    // 节点引用了不存在的 npc_id 与台词，但不传 npcs ⇒ 全部跳过，零 NPC 错误。
    // 这条是既有 90 条用例的护栏：它们都没传 npcs，新增校验不能让它们变红。
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      npcs: undefined,
      characters: undefined,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口', npcId: 'whatever', npcLineIds: ['ghost'] }],
    } as any);
    expect(errs.some((e) => e.includes('R-N'))).toBe(false);
  });

  it('R-N1~R-N4 全部合法 → 零错误（正例护栏，防过度拦截）', () => {
    expect(validateWenlvIntegrity(baseNpc as any)).toEqual([]);
  });

  // characters 未提供但 npcs 提供 ⇒ R-N3 跳过，R-N1/R-N2/R-N4 仍生效
  it('characters 未提供 ⇒ R-N3 跳过但 R-N1/R-N2/R-N4 仍跑', () => {
    // npc.characterId 指向不存在的角色，但 characters 未传 ⇒ R-N3 不报；
    // npc.lines 重复 ⇒ R-N4 仍报。
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      npcs: [{
        id: 'npc1', name: '张三', characterId: 'ghost-char',
        lines: [{ id: 'l1', text: 'a' }, { id: 'l1', text: 'b' }],
      }],
      characters: undefined,
    } as any);
    expect(errs.some((e) => e.includes('R-N3'))).toBe(false);
    expect(errs.some((e) => e.includes('R-N4'))).toBe(true);
  });

  // npc 无 character_id（null/undefined）⇒ R-N3 跳过该 npc（spec：若存在）
  it('npc.character_id 缺省（null）⇒ R-N3 跳过该 npc 不报', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      npcs: [{
        id: 'npc1', name: '张三', characterId: null,
        portraitPrompt: '古风立绘 prompt', voiceId: 'voice-1',
        lines: [{ id: 'l1', text: '你好' }],
      }],
      characters: [{ id: 'ch1', name: '主角', faction: '正派', identity: '少侠', vitality: 80, wisdom: 70, insight: 60 }],
    } as any);
    expect(errs.some((e) => e.includes('R-N3'))).toBe(false);
    expect(errs).toEqual([]);
  });

  // 节点无 npc_id ⇒ R-N1/R-N2 跳过该节点（老剧本零迁移）
  it('节点无 npc_id ⇒ R-N1/R-N2 跳过该节点（老剧本零迁移）', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      nodes: [{ id: 'N1', nodeType: 'scene', title: '村口' /* 无 npc_id */ }],
    } as any);
    expect(errs.some((e) => e.includes('R-N'))).toBe(false);
  });

  // rally 模式下 R-N1~R-N4 同样生效（NPC 校验在 mode 分流之前）
  it('rally 模式下 R-N1~R-N4 同样生效（NPC 校验不分 mode）', () => {
    const errs = validateWenlvIntegrity({
      ...baseNpc,
      product: { id: 'P1', name: '集章 NPC', mode: 'rally' as const, status: 'draft' as const, venueId: 'v1' },
      nodes: [
        {
          id: 'N1', nodeType: 'scene', title: '村口', venuePointId: 'pt1',
          npcId: 'missing', npcLineIds: ['ghost'],
          grants: [], requires: null, puzzle: null,
        },
      ],
      collectibles: [{ id: 's1', name: '印', type: 'stamp' }],
      endings: [],
      rewards: [{ id: 'r1', name: '奖' }],
      tiers: [{ id: 't1', name: '档', condition: { type: 'ref', ref: { kind: 'collected', id: 's1' } }, rewardId: 'r1' }],
      points: [{ id: 'pt1', code: 'WLP-RALLY0001', venueId: 'v1' }],
    } as any);
    expect(errs.some((e) => e.includes('R-N1'))).toBe(true);
  });
});

describe('R3 隐秘任务引用可达（角色体系）', () => {
  const base = () => ({
    product: { id: 'p', name: '测试剧本', mode: 'narrative' },
    nodes: [
      { id: 'n1', nodeType: 'scene', title: '第一幕', grants: ['c1'] },
    ],
    collectibles: [{ id: 'c1', name: '线索一' }, { id: 'c2', name: '无人发放的线索' }],
    endings: [{ id: 'e1', title: '结局', triggerCondition: null }],
    rewards: [],
    tiers: [],
    characters: [] as any[],
  });

  it('隐秘任务引用**不存在**的线索 ⇒ 报错', () => {
    const errs = validateWenlvIntegrity({
      ...base(),
      characters: [{ id: 'ch1', name: '沈砚', faction: '隐', identity: '隐士', vitality: 50, wisdom: 80, insight: 90, hiddenQuest: { title: 't', description: 'd', collectible_ids: ['nope'] } }],
    } as any);
    // 承重：必须同时钉住「点到了那个 id」与「错因是『不存在』」——
    // 只断言 includes('nope') 时，把第 1 臂文案换成第 2 臂（无人发放）的文案仍会报出 nope
    // ⇒ 全绿（消息塌缩变异零信号，2026-09-30 复核实测：107 passed / 退出码 0）。
    expect(errs.some((e) => e.includes('nope') && e.includes('不存在的线索'))).toBe(true);
    expect(errs.filter((e) => e.includes('没有任何节点发放'))).toEqual([]);
  });

  it('隐秘任务引用**存在但无人发放**的线索 ⇒ 报错（与 level 的可达性判据同型）', () => {
    const errs = validateWenlvIntegrity({
      ...base(),
      characters: [{ id: 'ch1', name: '沈砚', faction: '隐', identity: '隐士', vitality: 50, wisdom: 80, insight: 90, hiddenQuest: { title: 't', description: 'd', collectible_ids: ['c2'] } }],
    } as any);
    // 承重：必须同时钉住「点到了那个 id」与「错因是『无人发放』」——
    // 只断言 includes('c2') 时，把第 2 臂文案换成第 1 臂（不存在）的文案仍会报出 c2
    // ⇒ 全绿（反向消息塌缩变异零信号，2026-09-30 复核实测：107 passed / 退出码 0）。
    expect(errs.some((e) => e.includes('c2') && e.includes('没有任何节点发放'))).toBe(true);
    expect(errs.filter((e) => e.includes('不存在的线索'))).toEqual([]);
  });

  it('隐秘任务引用有发放的线索 ⇒ 不报错', () => {
    const errs = validateWenlvIntegrity({
      ...base(),
      characters: [{ id: 'ch1', name: '沈砚', faction: '隐', identity: '隐士', vitality: 50, wisdom: 80, insight: 90, hiddenQuest: { title: 't', description: 'd', collectible_ids: ['c1'] } }],
    } as any);
    expect(errs).toEqual([]);
  });

  it('没有隐秘任务的角色 ⇒ 不报错', () => {
    const errs = validateWenlvIntegrity({
      ...base(),
      characters: [{ id: 'ch1', name: '沈砚', faction: '隐', identity: '隐士', vitality: 50, wisdom: 80, insight: 90, hiddenQuest: null }],
    } as any);
    expect(errs).toEqual([]);
  });

  it('characters 缺省（旧调用点不传）⇒ 不报错（向后兼容）', () => {
    const { characters, ...noChars } = base();
    void characters;
    expect(validateWenlvIntegrity(noChars as any)).toEqual([]);
  });
});
