import { describe, it, expect } from 'vitest';
import { evalCondition, applyGrants, markVisited, mergeStates, findTriggeredEndings, selectEnding, isAnswerCorrect, maskInteractionAnswers, findSatisfiedTiers, deriveNeedStampCount, buildClaimState, QUIZ_TYPES, ACTION_TYPES, isQuizInteraction } from '../wenlv-engine.js';
import type { WenlvCondition, WenlvInteraction, WenlvState } from '../../db/schema/wenlv.js';

const empty: WenlvState = { visited: {}, collected: {}, completed: {} };

describe('evalCondition', () => {
  it('ref 命中已收集线索为 true', () => {
    const state: WenlvState = { visited: {}, collected: { clueX: true }, completed: {} };
    expect(evalCondition({ type: 'ref', ref: { kind: 'collected', id: 'clueX' } }, state)).toBe(true);
    expect(evalCondition({ type: 'ref', ref: { kind: 'collected', id: 'clueY' } }, state)).toBe(false);
  });

  it('all 要求全部满足', () => {
    const state: WenlvState = { visited: {}, collected: { a: true }, completed: { b: true } };
    expect(evalCondition({ type: 'all', conditions: [
      { type: 'ref', ref: { kind: 'collected', id: 'a' } },
      { type: 'ref', ref: { kind: 'completed', id: 'b' } },
    ] }, state)).toBe(true);
  });

  it('any 任一满足即 true', () => {
    const state: WenlvState = { visited: {}, collected: { a: true }, completed: {} };
    expect(evalCondition({ type: 'any', conditions: [
      { type: 'ref', ref: { kind: 'collected', id: 'z' } },
      { type: 'ref', ref: { kind: 'collected', id: 'a' } },
    ] }, state)).toBe(true);
  });

  it('nofM 满足 N 个即 true', () => {
    const state: WenlvState = { visited: {}, collected: { a: true, b: true, c: true }, completed: {} };
    expect(evalCondition({ type: 'nofM', n: 2, of: ['a', 'b', 'z'].map((id) => ({ type: 'ref', ref: { kind: 'collected', id } })) }, state)).toBe(true);
    expect(evalCondition({ type: 'nofM', n: 2, of: ['a', 'z'].map((id) => ({ type: 'ref', ref: { kind: 'collected', id } })) }, state)).toBe(false);
  });

  it('空条件视为 true（无前置）', () => {
    expect(evalCondition(undefined, empty)).toBe(true);
    expect(evalCondition(null, empty)).toBe(true);
  });
});

describe('applyGrants', () => {
  it('发放线索，且不污染原对象', () => {
    const before: WenlvState = { visited: {}, collected: {}, completed: {} };
    const after = applyGrants(['clueC'], before);
    expect(after.collected.clueC).toBe(true);
    expect(before.collected.clueC).toEqual(undefined); // 原对象未变
  });
});

describe('markVisited', () => {
  it('标记到访', () => {
    const after = markVisited(empty, 'nodeA');
    expect(after.visited.nodeA).toBe(true);
  });
});

describe('findTriggeredEndings', () => {
  it('返回所有满足触发条件的结局 id', () => {
    const state: WenlvState = { visited: {}, collected: { x: true, y: true }, completed: {} };
    const endings: { id: string; triggerCondition: WenlvCondition }[] = [
      { id: 'end1', triggerCondition: { type: 'all', conditions: [
        { type: 'ref', ref: { kind: 'collected', id: 'x' } },
        { type: 'ref', ref: { kind: 'collected', id: 'y' } },
      ] } },
      { id: 'end2', triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'z' } } },
    ];
    expect(findTriggeredEndings(endings, state)).toEqual(['end1']);
  });
});

describe('isAnswerCorrect（按题型）', () => {
  it('single 精确相等（沿用旧语义，含 trim）', () => {
    expect(isAnswerCorrect({ type: 'single', question: 'q', options: ['a', 'b'], answer: 'a' }, 'a')).toBe(true);
    expect(isAnswerCorrect({ type: 'single', question: 'q', options: ['a', 'b'], answer: 'a' }, ' a ')).toBe(true);
    expect(isAnswerCorrect({ type: 'single', question: 'q', options: ['a', 'b'], answer: 'a' }, 'b')).toBe(false);
    expect(isAnswerCorrect({ type: 'single', question: 'q', options: ['a', 'b'], answer: 'a' }, 123 as unknown)).toBe(false);
  });
  it('input 精确相等（沿用旧语义）', () => {
    expect(isAnswerCorrect({ type: 'input', question: 'q', answer: '张飞' }, '张飞')).toBe(true);
    expect(isAnswerCorrect({ type: 'input', question: 'q', answer: '张飞' }, '关羽')).toBe(false);
  });
  it('judge 对/错', () => {
    expect(isAnswerCorrect({ type: 'judge', question: 'q', answer: 'true' }, 'true')).toBe(true);
    expect(isAnswerCorrect({ type: 'judge', question: 'q', answer: 'false' }, 'true')).toBe(false);
  });
  it('multiple 集合等值，忽略顺序与首尾空格', () => {
    const m: WenlvInteraction = { type: 'multiple', question: 'q', options: ['a', 'b', 'c'], answer: ['a', 'c'] };
    expect(isAnswerCorrect(m, ['a', 'c'])).toBe(true);
    expect(isAnswerCorrect(m, ['c', ' a '])).toBe(true);
    expect(isAnswerCorrect(m, ['a'])).toBe(false);
    expect(isAnswerCorrect(m, ['a', 'b', 'c'])).toBe(false);
    expect(isAnswerCorrect(m, 'ac')).toBe(false);
    expect(isAnswerCorrect(m, [])).toBe(false);
    expect(isAnswerCorrect({ ...m, answer: [] }, [])).toBe(false); // 空答案集永远为错
  });
  it('photo 不参与判定', () => {
    expect(isAnswerCorrect({ type: 'photo', question: 'q' }, 'x')).toBe(false);
  });
});

describe('maskInteractionAnswers（按题型脱敏）', () => {
  it('single/input/judge 抹 answer，multiple 抹 answer 数组，photo 原样', () => {
    expect((maskInteractionAnswers({ type: 'single', question: 'q', options: ['a'], answer: 'a' }) as { answer: unknown }).answer).toBe('');
    expect((maskInteractionAnswers({ type: 'multiple', question: 'q', options: ['a'], answer: ['a'] }) as { answer: unknown }).answer).toEqual([]);
    expect((maskInteractionAnswers({ type: 'judge', question: 'q', answer: 'true' }) as { answer: unknown }).answer).toBe('');
    expect(maskInteractionAnswers({ type: 'photo', question: 'q' })).toEqual({ type: 'photo', question: 'q' });
  });
});

describe('findSatisfiedTiers', () => {
  it('返回 condition 满足的档位，按 order 降序（高优先在前）；无条件=恒满足', () => {
    const state: WenlvState = { visited: {}, collected: { s1: true, s2: true }, completed: {} };
    const tiers: { id: string; order: number; condition: WenlvCondition | null }[] = [
      { id: 't1', order: 1, condition: { type: 'nofM', n: 2, of: ['s1', 's2', 's3'].map((id) => ({ type: 'ref', ref: { kind: 'collected', id } })) } },
      { id: 't2', order: 2, condition: { type: 'nofM', n: 3, of: ['s1', 's2', 's3'].map((id) => ({ type: 'ref', ref: { kind: 'collected', id } })) } },
      { id: 't3', order: 3, condition: null },
    ];
    expect(findSatisfiedTiers(tiers, state)).toEqual(['t3', 't1']); // t1 满足(nofM2)；t2 不满足(需3)；t3 无条件=恒满足；按 order 降序 → t3 先于 t1
  });
});

describe('deriveNeedStampCount', () => {
  const refs = ['a', 'b', 'c'].map((id) => ({ type: 'ref' as const, ref: { kind: 'collected' as const, id } }));

  it('顶层 nofM 取 n', () => {
    expect(deriveNeedStampCount({ type: 'nofM', n: 3, of: refs })).toBe(3);
  });

  it('all/any 单子叶递归解开', () => {
    const inner = { type: 'nofM', n: 2, of: refs } as WenlvCondition;
    expect(deriveNeedStampCount({ type: 'all', conditions: [inner] })).toBe(2);
    expect(deriveNeedStampCount({ type: 'any', conditions: [inner] })).toBe(2);
  });

  it('多子叶或非 nofM 无法表达为单一 N → null', () => {
    expect(deriveNeedStampCount({ type: 'all', conditions: [{ type: 'nofM', n: 2, of: refs }, { type: 'nofM', n: 1, of: refs }] })).toBe(null);
    expect(deriveNeedStampCount({ type: 'ref', ref: { kind: 'collected', id: 'a' } })).toBe(null);
  });

  it('null/undefined → null', () => {
    expect(deriveNeedStampCount(null)).toBe(null);
    expect(deriveNeedStampCount(undefined)).toBe(null);
  });
});

describe('buildClaimState', () => {
  const empty: WenlvState = { visited: {}, collected: {}, completed: {} };
  const tier = (id: string, order: number, n: number) => ({
    id, order,
    condition: { type: 'nofM' as const, n, of: ['s1', 's2', 's3'].map((x) => ({ type: 'ref' as const, ref: { kind: 'collected' as const, id: x } })) },
  });

  it('空进度：collected=0，全档未达、未领，need 取 n，按 order 升序', () => {
    const out = buildClaimState([tier('t3', 3, 3), tier('t1', 1, 2)], new Set<string>(), empty);
    expect(out.collectedStampCount).toBe(0);
    expect(out.tiers.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(out.tiers[0]).toEqual({ id: 't1', order: 1, met: false, claimed: false, need: 2 });
  });

  it('已集满足档位 + 已领标记', () => {
    const state: WenlvState = { visited: {}, collected: { s1: true, s2: true }, completed: {} };
    const out = buildClaimState([tier('t1', 1, 2)], new Set(['t1']), state);
    expect(out.collectedStampCount).toBe(2);
    expect(out.tiers[0].met).toBe(true);
    expect(out.tiers[0].claimed).toBe(true);
  });

  it('state 为 null 视为空（未 start 兜底）', () => {
    const out = buildClaimState([tier('t1', 1, 1)], new Set(), null);
    expect(out.collectedStampCount).toBe(0);
    expect(out.tiers[0].met).toBe(false);
  });
});

describe('交互类型判定（S4④：scene 现场动作）', () => {
  it('QUIZ_TYPES 是可判定题型，不含 photo/meditate', () => {
    expect([...QUIZ_TYPES].sort()).toEqual(['input', 'judge', 'multiple', 'single']);
  });
  it('ACTION_TYPES 是现场动作，只有 photo/meditate', () => {
    expect([...ACTION_TYPES].sort()).toEqual(['meditate', 'photo']);
  });
  it('isQuizInteraction 对四类题型为真、对 photo/meditate/未知为假', () => {
    for (const t of ['single', 'multiple', 'judge', 'input']) expect(isQuizInteraction({ type: t })).toBe(true);
    for (const t of ['photo', 'meditate', 'foo', undefined]) expect(isQuizInteraction({ type: t } as any)).toBe(false);
  });
});

describe('selectEnding 确定性解析', () => {
  const st = (collected: string[]): WenlvState => ({
    visited: {}, completed: {},
    collected: Object.fromEntries(collected.map((c) => [c, true])),
  });
  const e = (id: string, priority: number, clues: string[]) => ({
    id, priority,
    triggerCondition: { type: 'all' as const, conditions: clues.map((c) => ({ type: 'ref' as const, ref: { kind: 'collected' as const, id: c } })) },
  });

  it('多个同时满足 ⇒ 取 priority 最大者，且 satisfiedIds[0] === endingId', () => {
    const endings = [e('A', 1, ['c1']), e('B', 5, ['c1', 'c2']), e('C', 3, ['c1'])];
    const r = selectEnding(endings, st(['c1', 'c2']));
    expect(r.endingId).toBe('B');
    expect(r.satisfiedIds[0]).toBe('B');
    expect([...r.satisfiedIds].sort()).toEqual(['A', 'B', 'C']);
  });

  it('与输入顺序无关（把数组倒过来结果相同）—— 证明不是在赌行序', () => {
    const endings = [e('A', 1, ['c1']), e('B', 5, ['c1', 'c2']), e('C', 3, ['c1'])];
    const forward = selectEnding(endings, st(['c1', 'c2']));
    const backward = selectEnding([...endings].reverse(), st(['c1', 'c2']));
    expect(backward).toEqual(forward);
  });

  it('priority 平手 ⇒ 按 id 字典序，与输入顺序无关', () => {
    const endings = [e('zz', 0, ['c1']), e('aa', 0, ['c1'])];
    expect(selectEnding(endings, st(['c1'])).endingId).toBe('aa');
    expect(selectEnding([...endings].reverse(), st(['c1'])).endingId).toBe('aa');
  });

  it('priority 缺省（旧行/undefined/null）按 0 参与比较，不抛', () => {
    const endings = [
      { id: 'old', triggerCondition: { type: 'all' as const, conditions: [{ type: 'ref' as const, ref: { kind: 'collected' as const, id: 'c1' } }] } } as any,
      e('new', 2, ['c1']),
    ];
    expect(selectEnding(endings, st(['c1'])).endingId).toBe('new');
    expect(selectEnding([endings[1], endings[0]] as any, st(['c1'])).endingId).toBe('new');
  });

  it('无满足项 ⇒ endingId=null 且 satisfiedIds=[]', () => {
    expect(selectEnding([e('A', 1, ['c1'])], st([]))).toEqual({ endingId: null, satisfiedIds: [] });
  });
});

describe('mergeStates（队伍并集：逐键 OR）', () => {
  const st = (o: Partial<WenlvState>): WenlvState => ({ visited: {}, collected: {}, completed: {}, ...o });

  it('空数组 / 全空 state ⇒ 空并集', () => {
    expect(mergeStates([])).toEqual(empty);
    expect(mergeStates([null, undefined, st({})])).toEqual(empty);
  });

  it('键取并集、值为 OR（三人各带一段进度 ⇒ 三段都在）', () => {
    const out = mergeStates([
      st({ visited: { n1: true } }),
      st({ collected: { c1: true } }),
      st({ completed: { e1: true } }),
    ]);
    expect(out).toEqual({ visited: { n1: true }, collected: { c1: true }, completed: { e1: true } });
  });

  it('只认 true：false 值既不构键也不成值（与 evalRef 的 `!!` 语义一致）', () => {
    expect(mergeStates([st({ visited: { n1: false, n2: true } })])).toEqual(st({ visited: { n2: true } }));
  });

  it('纯函数：不改入参', () => {
    const a = st({ visited: { n1: true } });
    mergeStates([a, st({ visited: { n2: true } })]);
    expect(a).toEqual({ visited: { n1: true }, collected: {}, completed: {} });
  });
});
