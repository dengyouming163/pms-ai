import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 vi.hoisted 把 db mock 提升到 vi.mock 之前。
// 注意：仓内 src/types/vitest.d.ts 类型桩未声明 vi.hoisted（纪律上本任务不改它），
// 故这里按运行时能力用 (vi as any).hoisted，并给解构结果显式类型，避免 strict 下隐式 any。
// 链式 select(cols?).from(table).where() 之后既可 .limit(1) 也可直接 await；
// 每次 .from(table) 记录一条 { table, cols, limit }，resolveSelect 按**表对象**分发不同返回行 ——
// 这样「白名单来自对应表」的断言才有分辨力（按表返回不同形状，不是恒真）。
type SelectRec = { table: unknown; cols: unknown; limit: boolean };
const { dbMock, selectCalls, resolveSelect }: {
  dbMock: any;
  selectCalls: SelectRec[];
  resolveSelect: any;
} = (vi as any).hoisted(() => {
  const selectCalls: SelectRec[] = [];
  const resolveSelect = vi.fn(async (): Promise<any[]> => []);
  const dbMock = {
    select: vi.fn((cols?: unknown) => ({
      from: vi.fn((table: unknown) => {
        const rec: SelectRec = { table, cols, limit: false };
        selectCalls.push(rec);
        return {
          where: vi.fn(() => {
            const branch: any = {
              orderBy: vi.fn(() => resolveSelect(rec)),
              limit: vi.fn((_n?: number) => {
                rec.limit = true;
                return resolveSelect(rec);
              }),
            };
            // 无 limit 的查询直接 await where() 的返回值（thenable）
            branch.then = (resolve: (v: any) => void) => resolve(resolveSelect(rec));
            return branch;
          }),
        };
      }),
    })),
  };
  return { dbMock, selectCalls, resolveSelect };
});

vi.mock('../../../../db/index.js', () => ({ db: dbMock }));

// 只 mock db，表对象用真实模块（与 anchor-builder 内 import 解析到同一模块实例，可直接 === 比较）
import {
  pmsBuiWenlvProducts,
  pmsBuiWenlvScenes,
  pmsBuiWenlvFlows,
  pmsBuiWenlvChapters,
  pmsBuiWenlvScriptRooms,
  pmsBuiWenlvCollectibles,
  pmsBuiWenlvNpcs,
  pmsBuiWenlvCharacters,
  pmsBuiWenlvVenuePoints,
} from '../../../../db/schema/wenlv.js';
import { buildRefineAnchor, projectPoint, computeNeighbors } from '../anchor-builder.js';

const productRow = {
  id: 'p1',
  name: '古井疑云',
  subtitle: '民国小镇一夜悬案',
  theme: { templateId: 'tpl-ink' },
  config: { checkinRule: '扫码到场' },
  styleBible: { artStyle: '水墨' },
};

const roomRow = { id: 'room-p1', contentId: 'p1', name: '古井疑云房', mode: 'narrative' };
const chapterRows = [{ id: 'ch-p1', scriptRoomId: 'room-p1', title: '第一章', order: 0 }];

// 当前节点（scenes 全列，供 prompt 上下文）
const currentNode = {
  id: 'n-cur',
  chapterId: 'ch-p1',
  type: 'narrative',
  title: '当前节点',
  venuePointId: 'vp1',
  content: '正文在此',
};

// 全剧本场景（loadRuntimeGraph 投影为 nodes：type='npc'→nodeType='npc'，其余→'scene'；ending 剔除）
const allNodeRows = [
  { id: 'n-prev', chapterId: 'ch-p1', type: 'narrative', title: '前文' },
  { id: 'n-cur', chapterId: 'ch-p1', type: 'narrative', title: '当前节点' },
  { id: 'n-next', chapterId: 'ch-p1', type: 'npc', title: '后文' },
];

// flows（projectFlowsToEdges：fromSceneId→fromNodeId，toSceneId→toNodeId，type→edgeType）
const edgeRows = [
  { id: 'e-prev', fromSceneId: 'n-prev', toSceneId: 'n-cur', type: 'choice', choiceText: null, condition: null, grants: [], sanDelta: 0, sortOrder: 0 },
  { id: 'e-next', fromSceneId: 'n-cur', toSceneId: 'n-next', type: 'auto', choiceText: null, condition: null, grants: [], sanDelta: 0, sortOrder: 0 },
];

const collectibleRows = [{ id: 'c1', name: '半封密信', type: 'clue' }];
const npcRows = [{ id: 'npc1', name: '老更夫' }];
const characterRows = [
  { id: 'ch1', name: '苏捕快', identityDesc: '退隐江湖的老捕头' },
  { id: 'ch2', name: '无名客', identityDesc: null },
];
// 刻意带上 code：点位 code 是到场凭证，绝不能经任何路径进入锚点（spec §6.2）
const pointRows = [{ name: '古井旁·石阶', code: 'POINT-SECRET-999' }];

// 正常路径的按表分发
const installHappyDispatcher = () => {
  resolveSelect.mockImplementation(async (rec: SelectRec) => {
    switch (rec.table) {
      case pmsBuiWenlvProducts:
        return [productRow];
      case pmsBuiWenlvScenes:
        // limit=1 是当前节点查询；无 limit 是 loadRuntimeGraph 查全量场景
        return rec.limit ? [currentNode] : allNodeRows;
      case pmsBuiWenlvScriptRooms:
        return [roomRow];
      case pmsBuiWenlvChapters:
        return chapterRows;
      case pmsBuiWenlvFlows:
        return edgeRows;
      case pmsBuiWenlvCollectibles:
        return collectibleRows;
      case pmsBuiWenlvNpcs:
        return npcRows;
      case pmsBuiWenlvCharacters:
        return characterRows;
      case pmsBuiWenlvVenuePoints:
        return pointRows;
      default:
        return [];
    }
  });
};

describe('buildRefineAnchor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectCalls.length = 0;
  });

  it('装配完整锚点：白名单分表 / 点位投影 / 邻接方向 / code 不泄露 / node 装载', async () => {
    installHappyDispatcher();

    const anchor = await buildRefineAnchor('p1', 'n-cur');

    // ── 断言 1：四类白名单各自来自对应表查询，内容随表不同 ──
    expect(anchor.whitelist.collectibles).toEqual([{ id: 'c1', name: '半封密信', type: 'clue' }]);
    expect(anchor.whitelist.npcs).toEqual([{ id: 'npc1', name: '老更夫' }]);
    expect(anchor.whitelist.characters).toEqual([
      { id: 'ch1', name: '苏捕快', identity: '退隐江湖的老捕头' },
      { id: 'ch2', name: '无名客', identity: null }, // identityDesc 空值归一 null
    ]);
    expect(anchor.whitelist.nodes).toEqual([
      { id: 'n-prev', title: '前文', nodeType: 'scene' },
      { id: 'n-cur', title: '当前节点', nodeType: 'scene' },
      { id: 'n-next', title: '后文', nodeType: 'npc' },
    ]);

    // 查询确实打向各自的表（且投影形态互不相同，证明不是恒真）
    const queriedTables = selectCalls.map((r) => r.table);
    expect(queriedTables).toContain(pmsBuiWenlvCollectibles);
    expect(queriedTables).toContain(pmsBuiWenlvNpcs);
    expect(queriedTables).toContain(pmsBuiWenlvCharacters);
    const collRec = selectCalls.find((r) => r.table === pmsBuiWenlvCollectibles)!;
    const npcRec = selectCalls.find((r) => r.table === pmsBuiWenlvNpcs)!;
    const charRec = selectCalls.find((r) => r.table === pmsBuiWenlvCharacters)!;
    expect(Object.keys(collRec.cols as Record<string, unknown>)).toEqual(['id', 'name', 'type']);
    expect(Object.keys(npcRec.cols as Record<string, unknown>)).toEqual(['id', 'name']);
    expect(Object.keys(charRec.cols as Record<string, unknown>)).toEqual(['id', 'name', 'identityDesc']);
    // scenes 被查三次：当前节点（limit 1）+ assembleGraph 全量场景 + getScriptRoomFlows 反查 sceneIds
    const nodeRecs = selectCalls.filter((r) => r.table === pmsBuiWenlvScenes);
    expect(nodeRecs).toHaveLength(3);
    expect(nodeRecs.some((r) => r.limit === true)).toBe(true);

    // ── 断言 2：venuePointName 取点位 name，且点位查询只投影 name（code 连查都没查）──
    expect(anchor.venuePointName).toBe('古井旁·石阶');
    const vpRec = selectCalls.find((r) => r.table === pmsBuiWenlvVenuePoints)!;
    expect(vpRec.limit).toBe(true);
    expect(Object.keys(vpRec.cols as Record<string, unknown>)).toEqual(['name']);

    // ── 断言 3：prev 来自 toNodeId=当前节点的边的 from 端；next 来自 fromNodeId=当前节点的边的 to 端 ──
    expect(anchor.neighbors.prev).toEqual([{ id: 'n-prev', title: '前文', edgeType: 'choice' }]);
    expect(anchor.neighbors.next).toEqual([{ id: 'n-next', title: '后文', edgeType: 'auto' }]);

    // ── 断言 4：序列化锚点绝不含点位 code；node/product 装载正确 ──
    const serialized = JSON.stringify(anchor);
    expect(serialized).not.toContain('POINT-SECRET-999');
    expect(anchor.node).toEqual(currentNode);
    expect(anchor.product).toMatchObject({
      id: 'p1',
      name: '古井疑云',
      subtitle: '民国小镇一夜悬案',
      theme: { templateId: 'tpl-ink' },
      config: { checkinRule: '扫码到场' },
      styleBible: { artStyle: '水墨' },
    });
  });

  it('node 无 venuePointId：venuePointName=null 且不发起点位表查询', async () => {
    resolveSelect.mockImplementation(async (rec: SelectRec) => {
      switch (rec.table) {
        case pmsBuiWenlvProducts:
          return [productRow];
        case pmsBuiWenlvScenes:
          return rec.limit ? [{ ...currentNode, venuePointId: null }] : allNodeRows;
        case pmsBuiWenlvScriptRooms:
          return [roomRow];
        case pmsBuiWenlvChapters:
          return chapterRows;
        case pmsBuiWenlvFlows:
          return edgeRows;
        case pmsBuiWenlvCollectibles:
          return collectibleRows;
        case pmsBuiWenlvNpcs:
          return npcRows;
        case pmsBuiWenlvCharacters:
          return characterRows;
        default:
          return []; // venuePoints 不应被调用
      }
    });

    const anchor = await buildRefineAnchor('p1', 'n-cur');

    expect(anchor.venuePointName).toBeNull();
    expect(selectCalls.map((r) => r.table)).not.toContain(pmsBuiWenlvVenuePoints);
  });

  it('产品不存在时抛出「产品不存在」', async () => {
    resolveSelect.mockImplementation(async (rec: SelectRec) => {
      switch (rec.table) {
        case pmsBuiWenlvProducts:
          return [];
        case pmsBuiWenlvScenes:
          return rec.limit ? [currentNode] : allNodeRows;
        default:
          return [];
      }
    });

    await expect(buildRefineAnchor('missing-p', 'n-cur')).rejects.toThrow('产品不存在');
  });

  it('节点不存在（id+productId 过滤为空）时抛出「节点不存在」', async () => {
    resolveSelect.mockImplementation(async (rec: SelectRec) => {
      switch (rec.table) {
        case pmsBuiWenlvProducts:
          return [productRow];
        case pmsBuiWenlvScenes:
          return rec.limit ? [] : allNodeRows;
        default:
          return [];
      }
    });

    await expect(buildRefineAnchor('p1', 'missing-node')).rejects.toThrow('节点不存在');
    // 节点缺失时不应再发起点位查询
    expect(selectCalls.map((r) => r.table)).not.toContain(pmsBuiWenlvVenuePoints);
  });
});

describe('projectPoint', () => {
  it('undefined → null；只投影 name，结构上拿不到 code', () => {
    expect(projectPoint(undefined)).toBeNull();
    expect(projectPoint({ name: '古井旁' })).toBe('古井旁');
    // 即使行里带 code，投影结果也只是一个字符串
    const withCode = projectPoint({ name: '古井旁', code: 'POINT-SECRET-999' } as any);
    expect(withCode).toBe('古井旁');
    expect(JSON.stringify(withCode)).not.toContain('POINT-SECRET-999');
  });
});

describe('computeNeighbors', () => {
  it('prev/next 方向正确，titleMap 缺名回退「(未命名)」', () => {
    const edges = [
      { fromNodeId: 'a', toNodeId: 'cur', edgeType: 'choice' },
      { fromNodeId: 'cur', toNodeId: 'b', edgeType: 'auto' },
      { fromNodeId: 'ghost', toNodeId: 'cur', edgeType: 'puzzle_fail' },
    ];
    const result = computeNeighbors('cur', edges, { a: '甲节点', b: '乙节点' });

    expect(result.prev).toEqual([
      { id: 'a', title: '甲节点', edgeType: 'choice' },
      { id: 'ghost', title: '(未命名)', edgeType: 'puzzle_fail' },
    ]);
    expect(result.next).toEqual([{ id: 'b', title: '乙节点', edgeType: 'auto' }]);
  });

  it('无边时 prev/next 均为空数组', () => {
    const result = computeNeighbors('cur', [], {});
    expect(result.prev).toEqual([]);
    expect(result.next).toEqual([]);
  });
});
