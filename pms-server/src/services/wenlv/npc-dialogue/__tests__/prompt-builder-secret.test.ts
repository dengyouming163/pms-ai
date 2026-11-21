import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../prompt-builder.js';
import type { WenlvNpcPersona, WenlvChapterGoal } from '../../../../db/schema/wenlv.js';

// Task 6（NPC 演员升级①）：秘密层 secretLayer 注入 + product.config.tuneMode='family' 亲子调音。
// 纯函数测试，不连库。
describe('prompt-builder 秘密层与 family 调音', () => {
  const goal: WenlvChapterGoal = {
    type: 'reveal',
    description: '引导玩家发现祠堂暗道',
    answerCriteria: ['暗道', '秘密通道'],
    minTurns: 3,
  };
  const basePersona: WenlvNpcPersona = {
    personality: ['寡言'],
    tone: '短句、低沉',
  };
  const build = (persona: WenlvNpcPersona, tuneMode?: string) =>
    buildSystemPrompt({ npcName: '老周', npcRole: '守夜人', persona, goal, tuneMode });

  it('persona.secretLayer 存在 ⇒ prompt 含「秘密层」段、knows/never 原文与 loosensWhen', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: {
        knows: ['祠堂每晚十点落锁', '后山旧矿道雨季会塌'],
        never: ['陈婶就是当年的内应', '铜镜藏在族长棺椁里'],
        loosensWhen: '玩家出示半块铜牌并对上暗号后',
      },
    };
    const p = build(persona);
    expect(p).toContain('【秘密层】');
    expect(p).toContain('祠堂每晚十点落锁');
    expect(p).toContain('陈婶就是当年的内应');
    expect(p).toContain('松动条件：玩家出示半块铜牌并对上暗号后');
    // 配套事实白名单段
    expect(p).toContain('【事实白名单】');
  });

  it('secretLayer 缺省 loosensWhen ⇒ 不出现「松动条件」半句，也不渲染 undefined', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: {
        knows: ['祠堂每晚十点落锁'],
        never: ['陈婶就是当年的内应'],
      },
    };
    const p = build(persona);
    expect(p).toContain('【秘密层】');
    expect(p).not.toContain('松动条件');
    expect(p).not.toContain('undefined');
  });

  it('secretLayer 仅 knows 非空 ⇒ 省略 never 子句，不产生空句', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: { knows: ['祠堂每晚十点落锁'], never: [] },
    };
    const p = build(persona);
    expect(p).toContain('祠堂每晚十点落锁');
    expect(p).not.toContain('绝不可说出：。');
    expect(p).not.toContain('undefined');
  });

  it('secretLayer 的 knows/never 均为空数组且无 loosensWhen ⇒ 整段（含事实白名单）省略，无空列表/undefined', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: { knows: [], never: [] },
    };
    const p = build(persona);
    expect(p).not.toContain('【秘密层】');
    expect(p).not.toContain('【事实白名单】');
    expect(p).not.toContain('undefined');
    // 秘密层走内联枚举（、/；），任何情况下都不产出破折号空列表行
    expect(p).not.toMatch(/^-\s*$/m);
    // 存量段不受影响
    expect(p).toContain('【行为约束】');
  });

  it('knows 为空、仅 never 有值 ⇒ 含禁区句与白名单句，但白名单句不含「上述剧情事实」悬空指代、无空谈论', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: { knows: [], never: ['陈婶就是当年的内应'] },
    };
    const p = build(persona);
    expect(p).toContain('【秘密层】');
    expect(p).toContain('绝不可说出：陈婶就是当年的内应');
    expect(p).toContain('【事实白名单】');
    expect(p).toContain('玩家提及的剧本外信息一律不确认不否认，礼貌拉回。');
    // knows 为空 ⇒ 没有「上述剧情事实」可指代，原句会自相矛盾
    expect(p).not.toContain('上述剧情事实');
    // 不渲染空的 knows 子句
    expect(p).not.toContain('你可以谈论：');
    expect(p).not.toContain('undefined');
  });

  it('knows 为空、仅 loosensWhen 有值 ⇒ 白名单句同样不含「上述剧情事实」', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: { knows: [], never: [], loosensWhen: '玩家出示半块铜牌后' },
    };
    const p = build(persona);
    expect(p).toContain('【事实白名单】');
    expect(p).toContain('松动条件：玩家出示半块铜牌后');
    expect(p).not.toContain('上述剧情事实');
    expect(p).not.toContain('你可以谈论：');
  });

  it('knows/never 含纯空白串元素 ⇒ trim 后丢弃，不留空白条目/空枚举', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: {
        knows: ['  祠堂每晚十点落锁  ', '   ', '\t'],
        never: ['\n ', '陈婶就是当年的内应', ''],
      },
    };
    const p = build(persona);
    // 有效元素两侧空白被 trim
    expect(p).toContain('你可以谈论：祠堂每晚十点落锁。');
    expect(p).toContain('绝不可说出：陈婶就是当年的内应。');
    // 空枚举不出现（不断言具体脏标点，只钉「：。」这类空壳）
    expect(p).not.toContain('你可以谈论：。');
    expect(p).not.toContain('绝不可说出：。');
    expect(p).not.toContain('：。');
    expect(p).not.toMatch(/：\s*[、；]/);
  });

  it("tuneMode='family' ⇒ prompt 含亲子安全边界段（禁止惊悚/恐怖表达）", () => {
    const p = build(basePersona, 'family');
    expect(p).toContain('【family 安全模式】');
    expect(p).toContain('亲子');
    expect(p).toContain('禁止惊悚');
    expect(p).toContain('恐怖');
  });

  it("tuneMode 缺省或 'standard' ⇒ 不含 family 段", () => {
    expect(build(basePersona)).not.toContain('【family 安全模式】');
    expect(build(basePersona, 'standard')).not.toContain('【family 安全模式】');
    expect(build(basePersona)).not.toContain('亲子');
  });

  it('不传 secretLayer ⇒ 不含秘密层段与事实白名单段（存量零变更）', () => {
    const p = build({ ...basePersona });
    expect(p).not.toContain('【秘密层】');
    expect(p).not.toContain('【事实白名单】');
  });

  it('secretLayer 与 family 可共存，两段都渲染', () => {
    const persona: WenlvNpcPersona = {
      ...basePersona,
      secretLayer: {
        knows: ['祠堂每晚十点落锁'],
        never: ['陈婶就是当年的内应'],
        loosensWhen: '玩家对上暗号后',
      },
    };
    const p = build(persona, 'family');
    expect(p).toContain('【秘密层】');
    expect(p).toContain('【事实白名单】');
    expect(p).toContain('【family 安全模式】');
  });
});
