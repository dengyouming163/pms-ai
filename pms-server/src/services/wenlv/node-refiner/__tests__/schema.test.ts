import { describe, it, expect } from 'vitest';
import { refineDraftSchema } from '../schema.js';

const validScene = {
  targetType: 'scene', title: '村口', storyText: '夜凉如水。', puzzle: null,
  grants: [], requires: null, chapterGoal: null, openingLine: null,
  arDialogue: null, npcId: null, newNpc: null, notes: '新建',
};

describe('refineDraftSchema', () => {
  it('接受合法普通节点草稿', () => {
    expect(refineDraftSchema.safeParse(validScene).success).toBe(true);
  });
  it('接受合法 NPC 草稿（含 newNpc 人格卡六字段）', () => {
    const d = {
      ...validScene, targetType: 'npc',
      chapterGoal: { type: 'puzzle', description: '问出暗道', answerCriteria: ['暗道'], minTurns: 3 },
      openingLine: '你来了。',
      newNpc: { name: '老周', persona: { personality: ['沉稳'], tone: '低沉', catchphrases: ['哼'], backstory: '守祠人', clues: ['暗道'], taboos: ['莫谈兵灾'] } },
    };
    expect(refineDraftSchema.safeParse(d).success).toBe(true);
  });
  it('拒绝非法 targetType', () => {
    expect(refineDraftSchema.safeParse({ ...validScene, targetType: 'puzzle' }).success).toBe(false);
  });
  it('拒绝 judge 非法答案', () => {
    const d = { ...validScene, puzzle: { type: 'judge', question: '真假？', answer: '对' } };
    expect(refineDraftSchema.safeParse(d).success).toBe(false);
  });
  it('拒绝非法 chapterGoal.type', () => {
    const d = { ...validScene, targetType: 'npc', chapterGoal: { type: 'boss', description: 'x', answerCriteria: [], minTurns: 2 }, openingLine: '嗨' };
    expect(refineDraftSchema.safeParse(d).success).toBe(false);
  });
});
