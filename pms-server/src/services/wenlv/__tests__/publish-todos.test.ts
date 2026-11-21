import { describe, it, expect, vi } from 'vitest';

// 图结构校验走 DB（getScriptGraph），本地无 PG；本文件只测内容校验的结构化+路由，
// 图校验解析由 parseGraphError 的纯逻辑覆盖（见下方 mock 注入的用例）。
const graphMock = vi.fn(async (_productId: string): Promise<string[]> => []);
vi.mock('../node-graph/integrity.js', () => ({
  validateGraphIntegrity: (productId: string) => graphMock(productId),
}));

import { buildPublishTodos, type PublishTodo } from '../publish-todos.js';
import type { IntegrityInput } from '../../wenlv-integrity.js';

function makeInput(overrides: Partial<IntegrityInput> = {}): IntegrityInput {
  return {
    product: { id: 'P1', name: '测试产品', mode: 'narrative', status: 'draft', venueId: null },
    nodes: [],
    collectibles: [],
    endings: [],
    rewards: [],
    tiers: [],
    points: [],
    npcs: [],
    characters: [],
    ...overrides,
  };
}

// 不依赖 DB 的纯内容校验测试（图结构校验在 integration 层单独测）。
describe('buildPublishTodos（结构化 + 路由）', () => {
  it('空产品（narrative）→ 至少 scene 与 ending 两条，且 R7 图结构未参与', async () => {
    const todos = await buildPublishTodos(makeInput({ product: { id: 'P1', name: '测试', mode: 'narrative', venueId: null } }));
    expect(todos.map((t) => t.code)).toContain('NARRATIVE_NO_SCENE');
    expect(todos.map((t) => t.code)).toContain('NARRATIVE_NO_ENDING');
    expect(todos.some((t) => t.fixBy === 'ai')).toBe(true);
    expect(todos.every((t) => t.message.length > 0)).toBe(true);
  });

  it('节点内容类错误带 AI 修复路由', async () => {
    const todos = await buildPublishTodos(makeInput({
      nodes: [{ id: 'N1', title: '山门', nodeType: 'puzzle', puzzle: null, grants: [], requires: null }],
    }));
    const todo = todos.find((t) => t.code === 'PUZZLE_REQUIRED');
    expect(todo).toBeDefined();
    expect(todo!.fixBy).toBe('ai');
    expect(todo!.aiAction!.type).toBe('node_refine');
    expect(todo!.target!.id).toBe('N1');
  });

  it('NPC 缺台词 → AI 补台词', async () => {
    const todos = await buildPublishTodos(makeInput({
      npcs: [{ id: 'NPC1', name: '李白', lines: [] }],
    }));
    const todo = todos.find((t) => t.code === 'NPC_NO_LINES');
    expect(todo!.fixBy).toBe('ai');
    expect(todo!.aiAction!.type).toBe('single_optimize');
  });

  it('NPC 缺音色 → manual', async () => {
    const todos = await buildPublishTodos(makeInput({
      npcs: [{ id: 'NPC1', name: '李白', voiceId: '', lines: [{ id: 'L1', text: 'Hi' }] }],
    }));
    const todo = todos.find((t) => t.code === 'NPC_VOICE_EMPTY');
    expect(todo!.fixBy).toBe('manual');
  });

  it('角色名称为空 → character_optimize', async () => {
    const todos = await buildPublishTodos(makeInput({
      characters: [{ id: 'C1', name: '', faction: '', identity: '' }],
    }));
    const todo = todos.find((t) => t.code === 'CHAR_NAME_EMPTY');
    expect(todo!.fixBy).toBe('ai');
    expect(todo!.aiAction!.type).toBe('character_optimize');
  });

  it('图校验消息解析：R7 → node_refine + 按标题反查 nodeId；R1 → manual', async () => {
    graphMock.mockResolvedValueOnce([
      'R7: NPC 剧情「山门」未绑定 NPC',
      'R1: 节点「山门」无入边',
    ]);
    const todos = await buildPublishTodos(makeInput({
      nodes: [{ id: 'N1', title: '山门', nodeType: 'npc', npcId: null, grants: [], requires: null } as any],
    }));
    const r7 = todos.find((t) => t.code === 'GRAPH_R7');
    expect(r7).toBeDefined();
    expect(r7!.fixBy).toBe('ai');
    expect(r7!.aiAction!.type).toBe('node_refine');
    expect(r7!.target).toEqual({ kind: 'node', id: 'N1', name: '山门' });
    const r1 = todos.find((t) => t.code === 'GRAPH_R1');
    expect(r1!.fixBy).toBe('manual');
  });

  it('图校验消息解析：R10 → manual + 取首对「」（节点标题）做深链，消息含两对「」', async () => {
    graphMock.mockResolvedValueOnce([
      'R10: 节点「晚饭」的商业原子「暗号接头」缺少免费旁路（config.bypass.how），主线必须100%免费可达',
    ]);
    const todos = await buildPublishTodos(makeInput({
      nodes: [{ id: 'N10', title: '晚饭', nodeType: 'scene', grants: [], requires: null } as any],
    }));
    const r10 = todos.find((t) => t.code === 'GRAPH_R10');
    expect(r10).toBeDefined();
    expect(r10!.fixBy).toBe('manual');
    // R10 是首个含两对「」的图错误：首对是节点标题，第二对是商业原子名；
    // 深链必须按首对「晚饭」反查到节点，绝不能误取「暗号接头」。
    expect(r10!.target).toEqual({ kind: 'node', id: 'N10', name: '晚饭' });
    expect(r10!.target!.name).not.toBe('暗号接头');
    expect(r10!.manualHint).toBeTruthy();
    expect(r10!.manualHint).toContain('bypass');
  });

  it('清单清空 ⇔ 无 AI/manual 待办（只有 R7 图校验可能仍带 graph 错误）', async () => {
    const todos = await buildPublishTodos(makeInput({
      characters: undefined, // 不传 ⇒ R1 角色检查跳过（向后兼容语义）
      nodes: [
        { id: 'N1', title: '入口', nodeType: 'scene', grants: [], requires: null },
      ],
      endings: [{ id: 'E1', title: '完美结局', triggerCondition: null, priority: 0 }],
    }));
    // 内容校验通过，只剩图结构错误（R1 无入边）—— 图结构在集成测试里测
    expect(todos.every((t) => t.code.startsWith('GRAPH_') || t.code === 'OTHER')).toBe(true);
  });
});
