import { describe, it, expect, vi, beforeEach } from 'vitest';

// 仓内 src/types/vitest.d.ts 类型桩未声明 vi.hoisted，沿用 (vi as any).hoisted。
// 0079：integrity 经 loadRuntimeGraph 取投影节点/边，db 仅用于 R4/R5/R6 三张表查询，
// 这里把 loadRuntimeGraph mock 成返回给定 nodes/edges（endings/graph 给空），db 三查统一返回空数组。
const { graphFn, selectResultFn } = (vi as any).hoisted(() => {
  const graphFn = vi.fn(async () => ({ graph: null, nodes: [], edges: [], endings: [] }));
  const selectResultFn = vi.fn(async () => []);
  return { graphFn, selectResultFn };
});

vi.mock('../../script-room.js', () => ({ loadRuntimeGraph: graphFn }));

vi.mock('../../../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        // R4 直接 await from() 结果；R5/R6 再链 where()，where() 结果同样被 await。
        const branch: any = {
          where: vi.fn(() => branch),
        };
        branch.then = (resolve: (v: any) => void) => resolve(selectResultFn());
        return branch;
      }),
    })),
  },
}));

import { validateGraphIntegrity } from '../integrity.js';

const now = new Date('2026-01-01T00:00:00.000Z');

const makeNode = (id: string, overrides: Record<string, any> = {}) => ({
  id,
  productId: 'p1',
  nodeType: 'scene',
  title: '节点',
  storyText: null,
  requires: null,
  geo: null,
  mapX: null,
  mapY: null,
  image: null,
  narrationUrl: null,
  venuePointId: null,
  grants: [],
  puzzle: null,
  order: 0,
  npcId: null,
  npcLineIds: [],
  perspectiveCharacterId: null,
  chapterGoal: null,
  openingLine: null,
  sanDelta: 0,
  arAssetUrl: null,
  arAssetUrls: {},
  arDialogue: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const makeEdge = (overrides: Record<string, any> = {}) => ({
  id: 'edge-uuid',
  productId: 'p1',
  fromNodeId: 'nodeA',
  toNodeId: 'nodeB',
  edgeType: 'auto',
  label: null,
  condition: null,
  grants: [],
  sanDelta: 0,
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const npcGoal = (type: string, extra: Record<string, any> = {}) => ({
  type,
  description: '章节目标',
  answerCriteria: [],
  minTurns: 1,
  ...extra,
});

/** 完整合法二元剧本：scene+puzzle、npc 三类 chapterGoal、auto/choice/puzzle 边、无环、单入口。 */
const makeValidGraph = () => {
  const nodes = [
    makeNode('s1', {
      order: 1,
      title: '起点',
      puzzle: { type: 'single', question: '题面', options: ['A', 'B'], answer: 'A' },
    }),
    makeNode('n1', {
      order: 2,
      nodeType: 'npc',
      title: '分支 NPC',
      npcId: 'npc-1',
      openingLine: '你好',
      chapterGoal: npcGoal('choice', {
        options: [
          { label: '去审判', nextNodeId: 's2' },
          { label: '去终点', nextNodeId: 's3' },
        ],
      }),
    }),
    makeNode('s2', {
      order: 3,
      title: '审判',
      puzzle: { type: 'judge', question: '判断', answer: 'true' },
    }),
    makeNode('s3', { order: 4, title: '终点' }),
    makeNode('n2', {
      order: 5,
      nodeType: 'npc',
      title: '揭露 NPC',
      npcId: 'npc-2',
      openingLine: '真相只有一个',
      chapterGoal: npcGoal('reveal'),
    }),
    makeNode('n3', {
      order: 6,
      nodeType: 'npc',
      title: '说服 NPC',
      npcId: 'npc-3',
      openingLine: '请相信我',
      chapterGoal: npcGoal('convince'),
    }),
  ];
  const edges = [
    makeEdge({ id: 'e1', fromNodeId: 's1', toNodeId: 'n1', edgeType: 'auto' }),
    makeEdge({ id: 'e2', fromNodeId: 'n1', toNodeId: 's2', edgeType: 'choice' }),
    makeEdge({ id: 'e3', fromNodeId: 'n1', toNodeId: 's3', edgeType: 'choice' }),
    makeEdge({ id: 'e4', fromNodeId: 's2', toNodeId: 'n2', edgeType: 'puzzle_pass' }),
    makeEdge({ id: 'e5', fromNodeId: 's2', toNodeId: 's3', edgeType: 'puzzle_fail' }),
    makeEdge({ id: 'e6', fromNodeId: 's3', toNodeId: 'n3', edgeType: 'auto' }),
  ];
  return { nodes, edges };
};

describe('validateGraphIntegrity 二元节点模型 R7 NPC 内容闸', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultFn.mockResolvedValue([]);
  });

  it('a) npc 节点缺 npcId → 未绑定 NPC', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('n1', {
          nodeType: 'npc',
          title: '证人',
          chapterGoal: npcGoal('reveal'),
          openingLine: '开场白',
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors.some((e) => e.includes('未绑定 NPC'))).toBe(true);
    expect(errors).toContain('R7: NPC 剧情「证人」未绑定 NPC');
  });

  it('b) npc 缺 chapterGoal → 缺少章节目标', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('n1', {
          nodeType: 'npc',
          title: '证人',
          npcId: 'npc-1',
          openingLine: '开场白',
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toContain('R7: NPC 剧情「证人」缺少章节目标');
  });

  for (const openingLine of ['', '   ', '\t\n ']) {
    it(`c) npc openingLine 为空白(${JSON.stringify(openingLine)}) → 缺少开场白`, async () => {
      graphFn.mockResolvedValueOnce({
        nodes: [
          makeNode('n1', {
            nodeType: 'npc',
            title: '证人',
            npcId: 'npc-1',
            chapterGoal: npcGoal('reveal'),
            openingLine,
          }),
        ],
        edges: [],
      });

      const errors = await validateGraphIntegrity('p1');
      expect(errors).toContain('R7: NPC 剧情「证人」缺少开场白');
    });
  }

  it("d) npc chapterGoal choice 的 nextNodeId 指向不存在节点 → 分支选项下一节点不存在", async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('n1', {
          nodeType: 'npc',
          title: '分叉者',
          npcId: 'npc-1',
          openingLine: '选吧',
          chapterGoal: npcGoal('choice', {
            options: [
              { label: '存在的分支', nextNodeId: 's2' },
              { label: '幽灵分支', nextNodeId: 'ghost' },
            ],
          }),
        }),
        makeNode('s2', { title: '后继' }),
      ],
      edges: [makeEdge({ id: 'e1', fromNodeId: 'n1', toNodeId: 's2', edgeType: 'choice' })],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors.some((e) => e.includes('分支选项下一节点不存在'))).toBe(true);
    expect(errors).toContain('R7:「分叉者」分支选项下一节点不存在：ghost');
    // 指向存在节点的选项不应报错
    expect(errors.some((e) => e.includes('s2') && e.includes('下一节点不存在'))).toBe(false);
  });
});

describe('validateGraphIntegrity 二元节点模型 R7 scene 谜题闸', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultFn.mockResolvedValue([]);
  });

  it("e) scene+puzzle judge answer='maybe' → 判断题答案非法", async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', {
          title: '审判题',
          puzzle: { type: 'judge', question: '对吗', answer: 'maybe' },
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toContain('R7: 节点「审判题」判断题答案非法');
  });

  it('f1) scene+puzzle single 选项不足 2 个 → 选择题选项不足 2 个', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', {
          title: '单选题',
          puzzle: { type: 'single', question: '选啥', options: ['只有我'], answer: '只有我' },
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toContain('R7: 节点「单选题」选择题选项不足 2 个');
  });

  it('f2) scene+puzzle single 答案不在选项中 → 选择题答案未命中选项', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', {
          title: '单选题',
          puzzle: { type: 'single', question: '选啥', options: ['A', 'B'], answer: 'C' },
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toContain('R7: 节点「单选题」选择题答案未命中选项');
  });

  it('f3) scene+puzzle multiple 任一答案不在选项中 → 选择题答案未命中选项', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', {
          title: '多选题',
          puzzle: { type: 'multiple', question: '选啥', options: ['A', 'B', 'C'], answer: ['A', 'X'] },
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toContain('R7: 节点「多选题」选择题答案未命中选项');
  });

  it('f4) scene+puzzle 缺题面 / judge 合法 / meditate 非法秒数 均按变体校验', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', { title: '无题面', puzzle: { type: 'input', answer: 'x' } }),
        makeNode('s2', { title: '静坐', puzzle: { type: 'meditate', question: '静心', seconds: 0 } }),
      ],
      edges: [makeEdge({ id: 'e1', fromNodeId: 's1', toNodeId: 's2', edgeType: 'auto' })],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toContain('R7: 节点「无题面」谜题缺少题面');
    expect(errors).toContain('R7: 节点「静坐」静坐时长非法');
  });
});

describe('validateGraphIntegrity 合法剧本零错误', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultFn.mockResolvedValue([]);
  });

  it('g) 完整合法二元剧本（scene+puzzle、npc 三类 chapterGoal、四类边、无环、单入口）→ 零错误', async () => {
    const { nodes, edges } = makeValidGraph();
    graphFn.mockResolvedValueOnce({ nodes, edges });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toEqual([]);
  });

  it('h) 老线性剧本（全 scene 无 puzzle、线性 auto 边）→ 零错误（存量行为不变）', async () => {
    const nodes = [
      makeNode('s1', { order: 1, title: '开场' }),
      makeNode('s2', { order: 2, title: '发展' }),
      makeNode('s3', { order: 3, title: '收尾' }),
    ];
    const edges = [
      makeEdge({ id: 'e1', fromNodeId: 's1', toNodeId: 's2', edgeType: 'auto' }),
      makeEdge({ id: 'e2', fromNodeId: 's2', toNodeId: 's3', edgeType: 'auto' }),
    ];
    graphFn.mockResolvedValueOnce({ nodes, edges });

    const errors = await validateGraphIntegrity('p1');
    expect(errors).toEqual([]);
  });
});

describe('validateGraphIntegrity R1 全节点锚点与 R7 分支补盲', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultFn.mockResolvedValue([]);
  });

  it('i) R1 对全部节点生效：入口外的孤立 npc 节点无入边 → 报该 npc 且豁免入口 scene', async () => {
    // 两个节点均无入边：数组首个 scene 被识别为入口而豁免，其后的孤立 npc 必须被 R1 拦下。
    // npc 必填字段齐备、图无边（无环 / 无悬空引用），排除 R3-R8 噪音。
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', { order: 1, title: '入口场景' }),
        makeNode('n1', {
          order: 2,
          nodeType: 'npc',
          title: '孤立 NPC',
          npcId: 'npc-1',
          openingLine: '你好',
          chapterGoal: npcGoal('reveal'),
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors.some((e) => /R1/.test(e) && e.includes('孤立 NPC'))).toBe(true);
    expect(errors).toContain('R1: 节点「孤立 NPC」无入边');
    expect(errors.some((e) => /R1/.test(e) && e.includes('入口场景'))).toBe(false);
    // 仅此一条 R1，R3-R8 全部通过
    expect(errors).toHaveLength(1);
  });

  it('j) scene+puzzle multiple answer 为裸字符串（非数组）→ 选择题答案未命中选项', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', {
          title: '多选题',
          puzzle: {
            type: 'multiple',
            question: 'q',
            options: [{ value: 'a' }, { value: 'b' }],
            answer: 'a',
          },
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors.some((e) => e.includes('答案未命中'))).toBe(true);
    expect(errors).toContain('R7: 节点「多选题」选择题答案未命中选项');
  });

  it('k) scene+puzzle meditate seconds=1.5（非正整数）→ 静坐时长非法', async () => {
    graphFn.mockResolvedValueOnce({
      nodes: [
        makeNode('s1', {
          title: '静坐',
          puzzle: { type: 'meditate', question: '静心', seconds: 1.5 },
        }),
      ],
      edges: [],
    });

    const errors = await validateGraphIntegrity('p1');
    expect(errors.some((e) => e.includes('静坐时长非法'))).toBe(true);
    expect(errors).toContain('R7: 节点「静坐」静坐时长非法');
  });
});
