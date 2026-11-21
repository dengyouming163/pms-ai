import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用 vi.hoisted 把 db mock 提升到 vi.mock 之前，这样 factory 能引用它，
// 测试里也能访问 capturedSets / select 等 vi.fn 做断言。
const { dbMock, capturedSets, selectLimitFn } = vi.hoisted(() => {
  const capturedSets: any[] = [];
  const selectLimitFn = vi.fn(async () => []);
  const dbMock = {
    execute: vi.fn(async () => ({ rows: [] })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimitFn,
        })),
      })),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((payload: any) => {
        capturedSets.push(payload);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
    transaction: vi.fn(),
    insert: vi.fn(() => ({ values: vi.fn() })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  };
  return { dbMock, capturedSets, selectLimitFn };
});

vi.mock('../../../../db/index.js', () => ({ db: dbMock }));

vi.mock('../../node-refiner/index.js', () => ({
  refineNode: vi.fn(async (_productId: string, _nodeId: string, targetType: string) =>
    ({ draft: { targetType, title: '草稿节点' }, anchor: {} })),
}));

import { claimNextNpcJob, processNpcJob } from '../npc-gen-scheduler.js';
import { refineNode } from '../../node-refiner/index.js';

const makeJob = (overrides: any = {}) => ({
  id: 'job1', type: 'single_optimize', productId: 'p1', npcId: 'npc1',
  status: 'running', targetId: null, nodeId: null, stage: null,
  error: null, result: null, createdAt: new Date(), updatedAt: new Date(),
  ...overrides,
});

// single_optimize 里两次 fetch：第一次 /refine（AI crew），第二次 /generate-image（头像）。
const mockFetch = vi.fn();

describe('npc-gen-scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSets.length = 0;
    vi.stubGlobal('fetch', mockFetch);
  });

  it('claimNextNpcJob 无 pending 时返回 null', async () => {
    const r = await claimNextNpcJob();
    expect(r).toBeNull();
  });
});

describe('npc-gen-scheduler single_optimize（NPC AI 优化）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSets.length = 0;
    vi.stubGlobal('fetch', mockFetch);
    // 默认返回存在的 NPC，让 single_optimize 通过前置校验
    selectLimitFn.mockResolvedValue([{ id: 'npc1', productId: 'p1', name: '原NPC' }]);
  });

  it('关系网 snake_case → camelCase 字段归一（target_npc_id→targetNpcId 等）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ output: { npcs: { npcs: [{
        name: '优化后NPC',
        portrait_prompt: null,
        relationships: [
          { target_npc_id: 'npc2', relation_type: '亲属', description: '兄妹关系' },
          { target_npc_id: 'npc3', relation_type: '同事', description: '同僚' },
        ],
      }] } } }),
    });

    await processNpcJob(makeJob() as any);

    // 第一次 set 是 NPC 全字段更新（含 relationships）
    // s：db.update().set(payload) 捕获的写入载荷，来自上方 vi.hoisted 的 capturedSets（payload 为 any）
    const npcUpdate = capturedSets.find((s: any) => 'relationships' in s);
    expect(npcUpdate).toBeDefined();
    expect(npcUpdate.relationships).toEqual([
      { targetNpcId: 'npc2', relationType: '亲属', description: '兄妹关系' },
      { targetNpcId: 'npc3', relationType: '同事', description: '同僚' },
    ]);
    // description 两边同名，应原样保留
    expect(npcUpdate.relationships[0].description).toBe('兄妹关系');
  });

  it('AI 已返回 camelCase 字段时不重复转换（兼容两种输出）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ output: { npcs: { npcs: [{
        name: 'NPC',
        portrait_prompt: null,
        relationships: [
          { targetNpcId: 'npc2', relationType: '朋友', description: '好友' },
        ],
      }] } } }),
    });

    await processNpcJob(makeJob() as any);

    const npcUpdate = capturedSets.find((s: any) => 'relationships' in s);
    expect(npcUpdate.relationships).toEqual([
      { targetNpcId: 'npc2', relationType: '朋友', description: '好友' },
    ]);
  });

  it('有 portrait_prompt 时调 generate-image 并回写 portraitUrl', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ output: { npcs: { npcs: [{
          name: 'NPC',
          portrait_prompt: '一位身着青衫的古代书生',
          relationships: [],
        }] } } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: { url: 'https://img.example.com/npc.jpg' } }),
      });

    await processNpcJob(makeJob() as any);

    // 第二次 fetch 是 generate-image
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [imgUrl, imgInit] = mockFetch.mock.calls[1];
    expect(imgUrl).toContain('/generate-image');
    const body = JSON.parse(imgInit.body);
    expect(body.prompt).toBe('一位身着青衫的古代书生');
    expect(body.asset_type).toBe('avatar');

    // portraitUrl 回写到 NPC 表
    const portraitUpdate = capturedSets.find((s: any) => 'portraitUrl' in s);
    expect(portraitUpdate).toBeDefined();
    expect(portraitUpdate.portraitUrl).toBe('https://img.example.com/npc.jpg');
  });

  it('generate-image 失败只 warn 不影响 job 成功', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ output: { npcs: { npcs: [{
          name: 'NPC',
          portrait_prompt: 'prompt',
          relationships: [],
        }] } } }),
      })
      .mockRejectedValueOnce(new Error('image service down'));

    // 不应抛错——头像生成被 try-catch 包裹
    await expect(processNpcJob(makeJob() as any)).resolves.not.toThrow();

    // job 仍标记 succeeded（s 同为 capturedSets 捕获的 set 写入载荷）
    const jobUpdate = capturedSets.find((s: any) => s.status === 'succeeded');
    expect(jobUpdate).toBeDefined();
  });

  it('无 portrait_prompt 时不调 generate-image', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ output: { npcs: { npcs: [{
        name: 'NPC',
        portrait_prompt: null,
        relationships: [],
      }] } } }),
    });

    await processNpcJob(makeJob() as any);

    // 只调用一次 fetch（AI crew refine），没有 generate-image
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/refine');
  });
});

describe('npc-gen-scheduler node_refine（节点二元化精修）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSets.length = 0;
  });

  it('以 (productId, nodeId, targetType, linkNpcId) 调 refineNode，成功后草稿写入 result', async () => {
    await processNpcJob(makeJob({
      type: 'node_refine',
      nodeId: 'node1',
      result: { targetType: 'scene' },
    }) as any);

    expect(refineNode).toHaveBeenCalledTimes(1);
    expect(refineNode).toHaveBeenCalledWith('p1', 'node1', 'scene', null);

    const jobUpdate = capturedSets.find((s: any) => s.status === 'succeeded');
    expect(jobUpdate).toBeDefined();
    expect(jobUpdate.result).toEqual({ refine: { targetType: 'scene', title: '草稿节点' } });
  });

  it('targetType 缺省时按 keep 精修', async () => {
    await processNpcJob(makeJob({
      type: 'node_refine',
      nodeId: 'node1',
      result: null,
    }) as any);

    expect(refineNode).toHaveBeenCalledWith('p1', 'node1', 'keep', null);
    expect(capturedSets.find((s: any) => s.status === 'succeeded')).toBeDefined();
  });

  it('nodeId 缺失 → job 置 failed 且不调 refineNode', async () => {
    await processNpcJob(makeJob({
      type: 'node_refine',
      nodeId: null,
      result: { targetType: 'npc', linkNpcId: 'npc9' },
    }) as any);

    expect(refineNode).not.toHaveBeenCalled();
    const jobUpdate = capturedSets.find((s: any) => s.status === 'failed');
    expect(jobUpdate).toBeDefined();
    expect(jobUpdate.error).toContain('node_refine 缺少 nodeId');
  });
});
