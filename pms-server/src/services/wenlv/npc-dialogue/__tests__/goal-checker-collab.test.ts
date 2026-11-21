import { describe, it, expect, vi } from 'vitest';
import { checkGoalReached } from '../goal-checker.js';
import type { WenlvChapterGoal, WenlvDialogueMessage } from '../../../../db/schema/wenlv.js';

// 判据匹配自 2ffa9c46 起为 LLM 语义裁决（evaluateCriteriaWithLLM）；桩其返回
// 「1」= 第 1 条判据命中，写法同 attitude-evaluator.test.ts。
function stubCriteriaHit() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '1' } }] }),
  }));
}

const goal: WenlvChapterGoal = {
  type: 'puzzle',
  description: '协作解谜',
  answerCriteria: ['暗道'],
  minTurns: 2,
  collaborative: true,
};

describe('checkGoalReached collaborative', () => {
  it('团队模式所有队员各发≥1条消息 + 答对 → pass', async () => {
    stubCriteriaHit();
    const messages: WenlvDialogueMessage[] = [
      { role: 'assistant', content: '你们来了。', ts: 1 },
      { role: 'user', content: '[队员aaa] 我看到暗道入口', ts: 2 },
      { role: 'assistant', content: '嗯。', ts: 3 },
      { role: 'user', content: '[队员bbb] 暗道在祠堂下', ts: 4 },
    ];
    const r = await checkGoalReached({ goal, messages, turnCount: 2, teamSize: 2 });
    expect(r.passed).toBe(true);
    vi.unstubAllGlobals();
  });

  it('团队模式只有 1 个队员发言 → 不通过', async () => {
    const messages: WenlvDialogueMessage[] = [
      { role: 'assistant', content: '你们来了。', ts: 1 },
      { role: 'user', content: '[队员aaa] 暗道入口', ts: 2 },
      { role: 'assistant', content: '嗯。', ts: 3 },
      { role: 'user', content: '[队员aaa] 暗道在祠堂下', ts: 4 },
    ];
    const r = await checkGoalReached({ goal, messages, turnCount: 2, teamSize: 2 });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('所有队员');
  });

  it('单人模式（teamSize 未传）行为不变', async () => {
    // 同样桩 LLM 命中；本文件模块级 criteriaCache 可能已缓存同文案裁决，
    // 桩只保证即使缓存未命中也不走真实网络，故此处不断言 fetch 调用次数。
    stubCriteriaHit();
    const messages: WenlvDialogueMessage[] = [
      { role: 'assistant', content: '你来了。', ts: 1 },
      { role: 'user', content: '暗道入口', ts: 2 },
      { role: 'assistant', content: '嗯。', ts: 3 },
      { role: 'user', content: '暗道在祠堂下', ts: 4 },
    ];
    const r = await checkGoalReached({ goal, messages, turnCount: 2 });
    expect(r.passed).toBe(true);
    vi.unstubAllGlobals();
  });
});
