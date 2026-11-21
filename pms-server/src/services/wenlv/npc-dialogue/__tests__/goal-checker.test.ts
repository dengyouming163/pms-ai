import { describe, it, expect, vi } from 'vitest';
import { checkGoalReached } from '../goal-checker.js';
import type { WenlvChapterGoal, WenlvDialogueMessage } from '../../../../db/schema/wenlv.js';

/**
 * 桩 LLM 裁决：content 即 evaluateCriteriaWithLLM 约定的命中编号（'1' = 第 1 条判据命中，
 * '0' = 全未命中）。puzzle/reveal 的判据匹配自 2ffa9c46 起改为 LLM 语义判定
 * （evaluateCriteriaWithLLM，替代旧的本地精确子串匹配），故与 attitude-evaluator.test.ts
 * 同款用 vi.stubGlobal('fetch', ...) 拦下网络调用，单测只验证检查器自身的闸逻辑。
 */
function stubCriteriaVerdict(content: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
}

describe('checkGoalReached', () => {
  const goal: WenlvChapterGoal = {
    type: 'puzzle',
    description: '猜出密码',
    answerCriteria: ['暗道', '秘密通道'],
    minTurns: 3,
  };

  it('轮次不足时拒绝', async () => {
    const messages: WenlvDialogueMessage[] = [
      { role: 'assistant', content: '你来了', ts: 1 },
      { role: 'user', content: '你好', ts: 2 },
    ];
    const r = await checkGoalReached({ goal, messages, turnCount: 1 });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('轮次');
  });

  it('未命中判据时拒绝', async () => {
    // LLM 裁决「0」= 全未命中。此前本例不桩网络，靠真实 fetch 失败回落 [] 才绿
    // （绿得错误且依赖外网），现显式桩死。
    stubCriteriaVerdict('0');
    const messages: WenlvDialogueMessage[] = [
      { role: 'user', content: '你好', ts: 1 },
      { role: 'assistant', content: '嗯', ts: 2 },
      { role: 'user', content: '今天天气不错', ts: 3 },
      { role: 'assistant', content: '是啊', ts: 4 },
    ];
    const r = await checkGoalReached({ goal, messages, turnCount: 3 });
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('目标');
    vi.unstubAllGlobals();
  });

  it('命中判据且轮次足够时通过', async () => {
    stubCriteriaVerdict('1');
    const messages: WenlvDialogueMessage[] = [
      { role: 'user', content: '你好', ts: 1 },
      { role: 'assistant', content: '嗯', ts: 2 },
      { role: 'user', content: '听说这里有条暗道', ts: 3 },
      { role: 'assistant', content: '你怎么知道', ts: 4 },
    ];
    const r = await checkGoalReached({ goal, messages, turnCount: 3 });
    expect(r.passed).toBe(true);
    vi.unstubAllGlobals();
  });

  it('判据匹配忽略大小写', async () => {
    // 大小写不敏感的语义判断由 LLM 侧承担；桩同时核验检查器把小写判据与大写玩家原文
    // 都原样透传给了 LLM，并按其「1 = 命中」裁决放行。
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ?? '';
      const hit = body.includes('secret channel') && body.includes('SECRET CHANNEL');
      return { ok: true, json: async () => ({ choices: [{ message: { content: hit ? '1' : '0' } }] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const messages: WenlvDialogueMessage[] = [
      { role: 'user', content: 'a', ts: 1 },
      { role: 'assistant', content: 'b', ts: 2 },
      { role: 'user', content: '这是 SECRET CHANNEL', ts: 3 },
    ];
    const g: WenlvChapterGoal = { ...goal, answerCriteria: ['secret channel'] };
    const r = await checkGoalReached({ goal: g, messages, turnCount: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.passed).toBe(true);
    vi.unstubAllGlobals();
  });

  it('choice 类型直接通过（由 choice API 保证）', async () => {
    const g: WenlvChapterGoal = { type: 'choice', description: '选边', answerCriteria: [], minTurns: 1 };
    const r = await checkGoalReached({ goal: g, messages: [], turnCount: 1 });
    expect(r.passed).toBe(true);
  });
});
