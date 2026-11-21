import { describe, it, expect } from 'vitest';
import { isNpcDrivenNode, hasNodePuzzle, NODE_TYPE_VALUES } from '../node-model.js';

describe('node-model 二元谓词', () => {
  it('npc 类型 + npcId + chapterGoal 才算 NPC 驱动', () => {
    expect(isNpcDrivenNode({ nodeType: 'npc', npcId: 'n1', chapterGoal: { type: 'reveal' } })).toBe(true);
    expect(isNpcDrivenNode({ nodeType: 'npc', npcId: null, chapterGoal: { type: 'reveal' } })).toBe(false);
    expect(isNpcDrivenNode({ nodeType: 'npc', npcId: 'n1', chapterGoal: null })).toBe(false);
    expect(isNpcDrivenNode({ nodeType: 'scene', npcId: 'n1', chapterGoal: { type: 'reveal' } })).toBe(false);
  });
  it('普通节点是否答题只看 puzzle 对象有无', () => {
    expect(hasNodePuzzle({ nodeType: 'scene', puzzle: { type: 'judge', question: 'q', answer: 'true' } })).toBe(true);
    expect(hasNodePuzzle({ nodeType: 'scene', puzzle: null })).toBe(false);
    expect(hasNodePuzzle({ nodeType: 'npc', puzzle: null })).toBe(false);
    // 变异钉：npc 节点即使挂了 puzzle 也不算答题节点（删掉实现里的 nodeType !== 'npc' 必须变红）
    expect(hasNodePuzzle({ nodeType: 'npc', puzzle: { type: 'judge', question: 'q', answer: 'true' } })).toBe(false);
  });
  it('二元类型只含 scene/npc', () => {
    expect([...NODE_TYPE_VALUES]).toEqual(['scene', 'npc']);
  });
});
