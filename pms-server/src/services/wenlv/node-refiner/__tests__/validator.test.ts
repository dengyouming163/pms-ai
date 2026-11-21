import { describe, it, expect } from 'vitest';
import { validateRefineDraft } from '../validator.js';
import type { RefineAnchor } from '../anchor-builder.js';

const anchor = {
  product: { id: 'p1', name: '将军令', subtitle: null, theme: {}, config: {}, styleBible: null },
  node: { id: 'n1' },
  venuePointName: '老榕树下',
  whitelist: {
    collectibles: [{ id: 'c1', name: '铜钱', type: 'clue' }],
    npcs: [{ id: 'npc1', name: '老周' }],
    characters: [{ id: 'ch1', name: '阿秀', identity: null }],
    nodes: [{ id: 'n1', title: '村口', nodeType: 'scene' }, { id: 'n2', title: '祠堂', nodeType: 'scene' }],
  },
  neighbors: { prev: [], next: [] },
} as unknown as RefineAnchor;

const base = {
  targetType: 'scene' as const, title: '村口', storyText: '文本', puzzle: null,
  grants: [], requires: null, chapterGoal: null, openingLine: null,
  arDialogue: null, npcId: null, newNpc: null, notes: '',
};

describe('validateRefineDraft', () => {
  it('合法普通草稿无错误', () => {
    expect(validateRefineDraft(base, anchor)).toEqual([]);
  });
  it('grants 引用白名单外 id 被拒', () => {
    expect(validateRefineDraft({ ...base, grants: ['ghost'] }, anchor).join()).toContain('grants');
  });
  it('npcId 不在 NPC 库被拒', () => {
    expect(validateRefineDraft({ ...base, targetType: 'npc', npcId: 'x', chapterGoal: { type: 'reveal', description: 'd', answerCriteria: [], minTurns: 2 }, openingLine: '嗨' }, anchor).join()).toContain('NPC');
  });
  it('转 npc 缺 chapterGoal 被拒', () => {
    expect(validateRefineDraft({ ...base, targetType: 'npc', npcId: 'npc1' }, anchor).join()).toContain('章节目标');
  });
  it('转 npc 缺 openingLine 被拒', () => {
    expect(validateRefineDraft({ ...base, targetType: 'npc', npcId: 'npc1', chapterGoal: { type: 'reveal', description: 'd', answerCriteria: [], minTurns: 2 } }, anchor).join()).toContain('开场白');
  });
  it('choice goal 的 nextNodeId 悬空被拒', () => {
    const d = { ...base, targetType: 'npc' as const, npcId: 'npc1', openingLine: '嗨',
      chapterGoal: { type: 'choice' as const, description: 'd', answerCriteria: [], minTurns: 2, options: [{ label: '去', nextNodeId: 'n9' }] } };
    expect(validateRefineDraft(d, anchor).join()).toContain('下一节点');
  });
  it('newNpc 草稿允许 npcId 为空（采纳时新建）', () => {
    const d = { ...base, targetType: 'npc' as const, npcId: null, openingLine: '嗨',
      newNpc: { name: '老周', persona: { personality: ['稳'], tone: '低', catchphrases: [], backstory: '', clues: [], taboos: [] } },
      chapterGoal: { type: 'reveal' as const, description: 'd', answerCriteria: [], minTurns: 2 } };
    expect(validateRefineDraft(d, anchor)).toEqual([]);
  });
  it('普通草稿携带 chapterGoal 被拒（类型与内容必须一致）', () => {
    const d = { ...base, chapterGoal: { type: 'reveal' as const, description: 'd', answerCriteria: [], minTurns: 2 } };
    expect(validateRefineDraft(d, anchor).join()).toContain('NPC');
  });
  it('普通草稿携带 npcId 被拒（消息点名 npcId 并提示改 targetType）', () => {
    const d = { ...base, npcId: 'npc1' };
    const msg = validateRefineDraft(d, anchor).join();
    expect(msg).toContain('npcId');
    expect(msg).toContain('NPC');
  });
  it('普通草稿携带 openingLine 同样被拒', () => {
    const d = { ...base, openingLine: '嗨' };
    expect(validateRefineDraft(d, anchor).join()).toContain('openingLine');
  });
});
