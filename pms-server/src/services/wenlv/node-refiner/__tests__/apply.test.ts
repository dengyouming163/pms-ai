import { describe, it, expect } from 'vitest';
import { buildRefinePatch } from '../apply.js';

const draft = {
  targetType: 'npc', title: '新标题', storyText: '新文本', puzzle: null, grants: ['c1'],
  requires: null, chapterGoal: { type: 'reveal', description: 'd', answerCriteria: [], minTurns: 2 },
  openingLine: '你来了', arDialogue: null, npcId: null,
  newNpc: { name: '老周', persona: { personality: ['稳'], tone: '低', catchphrases: [], backstory: '', clues: [], taboos: [] } },
  notes: '',
};

describe('buildRefinePatch', () => {
  it('targetType 必应用；未勾选字段不进 patch；结构字段被白名单拦截', () => {
    const patch = buildRefinePatch(draft as any, ['title', 'venuePointId', 'mapX']);
    expect(patch.nodeType).toBe('npc');
    expect(patch.title).toBe('新标题');
    expect('storyText' in patch).toBe(false);
    expect('venuePointId' in patch).toBe(false);
    expect('mapX' in patch).toBe(false);
  });
  it('转普通时按草稿清空 goal/openingLine/puzzle（仅当勾选）', () => {
    const scene = { ...draft, targetType: 'scene', chapterGoal: null, openingLine: null, newNpc: null };
    const patch = buildRefinePatch(scene as any, ['chapterGoal', 'openingLine']);
    expect(patch.nodeType).toBe('scene');
    expect(patch.chapterGoal).toBeNull();
  });

  describe('类型转换（第 4 参 currentNodeType 存在且与 targetType 不同）', () => {
    it('scene→npc：只勾 title 也强制带 chapterGoal/openingLine（草稿值）、puzzle:null、npc 绑定（override 优先）', () => {
      // draft.npcId 为 null，但事务内已新建 NPC 并传入 override
      const patch = buildRefinePatch(draft as any, ['title'], 'npc_new_1', 'scene');
      expect(patch.nodeType).toBe('npc');
      expect(patch.title).toBe('新标题');
      // 强制写入，与勾选无关
      expect(patch.chapterGoal).toEqual(draft.chapterGoal);
      expect(patch.openingLine).toBe('你来了');
      expect(patch.puzzle).toBeNull();
      expect(patch.npcId).toBe('npc_new_1');
      // 未勾选的普通内容字段不进 patch
      expect('storyText' in patch).toBe(false);
    });
    it('scene→npc：无 override 时 npcId 取草稿值（绑定已有 NPC 的转型）', () => {
      const bound = { ...draft, npcId: 'npc1', newNpc: null };
      const patch = buildRefinePatch(bound as any, [], undefined, 'scene');
      expect(patch.npcId).toBe('npc1');
      expect(patch.chapterGoal).toEqual(draft.chapterGoal);
      expect(patch.openingLine).toBe('你来了');
      expect(patch.puzzle).toBeNull();
    });
    it('npc→scene：只勾 title 也强制 chapterGoal/openingLine/npcId 全为 null', () => {
      // 草稿形态：LLM 产出的合法 scene 草稿（耦合字段本就为 null）
      const scene = { ...draft, targetType: 'scene', chapterGoal: null, openingLine: null, npcId: null, newNpc: null };
      const patch = buildRefinePatch(scene as any, ['title'], undefined, 'npc');
      expect(patch.nodeType).toBe('scene');
      expect(patch.chapterGoal).toBeNull();
      expect(patch.openingLine).toBeNull();
      expect(patch.npcId).toBeNull();
      expect('puzzle' in patch).toBe(false); // 非 npc 转型不额外强制 puzzle
      expect('storyText' in patch).toBe(false);
    });
    it('npc→scene：即便勾选了 chapterGoal 且传入残留 override，转型结果仍强制清空（防脏数据）', () => {
      const scene = { ...draft, targetType: 'scene', chapterGoal: null, openingLine: null, npcId: null, newNpc: null };
      const patch = buildRefinePatch(scene as any, ['title', 'chapterGoal', 'openingLine', 'npcId'], 'npc_should_not_bind', 'npc');
      expect(patch.chapterGoal).toBeNull();
      expect(patch.openingLine).toBeNull();
      expect(patch.npcId).toBeNull();
    });
  });

  describe('同类型编辑（第 4 参缺省或等于 targetType）', () => {
    it('同类型 npc 只勾 title：不强制 chapterGoal/openingLine/npcId', () => {
      const patch = buildRefinePatch(draft as any, ['title'], undefined, 'npc');
      expect(patch.nodeType).toBe('npc');
      expect(patch.title).toBe('新标题');
      expect('chapterGoal' in patch).toBe(false);
      expect('openingLine' in patch).toBe(false);
      expect('npcId' in patch).toBe(false);
      expect('puzzle' in patch).toBe(false);
    });
    it('第 4 参不传时行为与历史完全一致（勾什么写什么）', () => {
      const patch = buildRefinePatch(draft as any, ['title', 'openingLine']);
      expect(patch.title).toBe('新标题');
      expect(patch.openingLine).toBe('你来了');
      expect('chapterGoal' in patch).toBe(false);
      expect('npcId' in patch).toBe(false);
    });
  });
});
