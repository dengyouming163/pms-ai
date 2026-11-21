import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../prompt-builder.js';
import type { WenlvNpcPersona, WenlvChapterGoal } from '../../../../db/schema/wenlv.js';

describe('buildSystemPrompt', () => {
  const persona: WenlvNpcPersona = {
    personality: ['寡言', '多疑'],
    tone: '短句、低沉',
    catchphrases: ['天黑别出门。'],
    backstory: '守了三十年夜，儿子十年前失踪。',
    clues: ['祠堂后院有暗道'],
    taboos: ['拒绝谈论儿子死因'],
  };
  const goal: WenlvChapterGoal = {
    type: 'reveal',
    description: '引导玩家发现祠堂暗道',
    answerCriteria: ['暗道', '秘密通道'],
    minTurns: 3,
  };

  it('包含 NPC 身份和人格', () => {
    const p = buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona, goal });
    expect(p).toContain('老周');
    expect(p).toContain('守夜人');
    expect(p).toContain('寡言');
  });

  it('包含章节目标', () => {
    const p = buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona, goal });
    expect(p).toContain('引导玩家发现祠堂暗道');
  });

  it('包含线索和禁忌', () => {
    const p = buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona, goal });
    expect(p).toContain('祠堂后院有暗道');
    expect(p).toContain('拒绝谈论儿子死因');
  });

  it('包含行为约束（禁止提前完成）', () => {
    const p = buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona, goal });
    expect(p).toContain('completeNode');
    expect(p).toContain('禁止提前结束对话');
  });

  it('memory 非空时注入印象', () => {
    const p = buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona, goal, memory: '这个玩家很谨慎。' });
    expect(p).toContain('这个玩家很谨慎');
  });

  it('空字段不渲染对应段', () => {
    const emptyPersona: WenlvNpcPersona = {};
    const p = buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona: emptyPersona, goal });
    expect(p).toContain('老周');
    expect(p).not.toContain('口头禅');
    expect(p).not.toContain('性格');
  });

  // P3B-B3：注入关系网 + 跨 NPC 提及 —— 单元覆盖「NPC A mentionNpc NPC B → NPC B 下次出场能看到 mention」链路。
  it('relationships 非空时渲染【你认识的人】并含 targetNpcId 与关系描述', () => {
    const p = buildSystemPrompt({
      npcName: '老周', npcRole: '守夜人', persona, goal,
      relationships: [
        { targetNpcId: 'npc-chen', relationType: '旧识', description: '老周怀疑陈婶偷过祠堂钥匙' },
      ],
    });
    expect(p).toContain('你认识的人');
    expect(p).toContain('npc-chen');
    expect(p).toContain('老周怀疑陈婶偷过祠堂钥匙');
    expect(p).toContain('mentionNpc');
    expect(p).toContain('transferInfo');
  });

  it('pendingMentions 非空时渲染【其他 NPC 提到你的内容】并含 fromNpcName 与提及内容', () => {
    const p = buildSystemPrompt({
      npcName: '陈婶', npcRole: '村民', persona, goal,
      pendingMentions: [
        { fromNpcId: 'npc-zhou', fromNpcName: '老周', context: '老周提到陈婶最近行为反常', ts: 1 },
      ],
    });
    expect(p).toContain('其他 NPC 提到你的内容');
    expect(p).toContain('老周');
    expect(p).toContain('老周提到陈婶最近行为反常');
  });

  it('relationships + pendingMentions 均为空数组时不渲染对应段', () => {
    const p = buildSystemPrompt({
      npcName: '老周', npcRole: '守夜人', persona, goal,
      relationships: [], pendingMentions: [],
    });
    expect(p).not.toContain('你认识的人');
    expect(p).not.toContain('其他 NPC 提到你的内容');
  });
});
