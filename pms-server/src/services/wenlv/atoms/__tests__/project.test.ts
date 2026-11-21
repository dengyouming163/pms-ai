import { describe, it, expect } from 'vitest';
import type { WenlvAtom } from '../../../../db/schema/wenlv.js';
import { puzzleToAtom, normalizeNodeAtoms, toClientAtom, ATOM_CLIENT_SECRET_KEYS } from '../project';
import { ATOM_CONFIG_SCHEMAS } from '../registry';

describe('puzzleToAtom（读端投影，不写库）', () => {
  it('single 题投影为 quiz 原子，id 稳定为 quiz_main', () => {
    const a = puzzleToAtom({ type: 'single', question: 'q', options: ['a', 'b'], answer: 'a' });
    expect(a).toMatchObject({ id: 'quiz_main', type: 'single', config: { question: 'q', options: ['a', 'b'], answer: 'a' } });
  });
  it('photo 无 answer 也投影', () => {
    expect(puzzleToAtom({ type: 'photo', question: '拍' })!.type).toBe('photo');
  });
});

describe('normalizeNodeAtoms', () => {
  it('null/[] ⇒ null（老剧本零变更）', () => {
    expect(normalizeNodeAtoms(null)).toBeNull();
    expect(normalizeNodeAtoms([])).toBeNull();
  });
  it('重复 id ⇒ 抛错', () => {
    expect(() => normalizeNodeAtoms([
      { id: 'a1', type: 'observe', config: { prompt: 'p', criteria: 'c' } },
      { id: 'a1', type: 'human-quest', config: { questBrief: 'b' } },
    ])).toThrow();
  });
  it('guest-social 未上架 ⇒ 抛错（P1 拦截）', () => {
    expect(() => normalizeNodeAtoms([{ id: 'g', type: 'guest-social', config: { boardBrief: 'b' } }])).toThrow('未上架');
  });
  it('非法 config ⇒ 抛错并带原子 id', () => {
    expect(() => normalizeNodeAtoms([{ id: 'a1', type: 'physical-search', config: {} }])).toThrow(/a1/);
  });
  it('合法数组原样返回', () => {
    const atoms: WenlvAtom[] = [{ id: 'a1', type: 'human-quest', config: { questBrief: 'b' }, required: false }];
    expect(normalizeNodeAtoms(atoms)).toEqual(atoms);
  });
  it('非数组（对象/字符串）⇒ 抛中文「atoms 必须是原子数组」，不迭代字符', () => {
    expect(() => normalizeNodeAtoms({} as never)).toThrow('atoms 必须是原子数组');
    expect(() => normalizeNodeAtoms('abc' as never)).toThrow('atoms 必须是原子数组');
  });
});

describe('脱敏注册表一致性（防新增含答案原子漏登记导致 C 端静默剧透）', () => {
  const SPOILER_KEYS = ['answer', 'expectedCode', 'criteria', 'revealText'];
  it('schema shape 出现剧透键的类型，必须在 ATOM_CLIENT_SECRET_KEYS 登记且覆盖该键', () => {
    const pairs: Array<[string, string]> = [];
    for (const [type, schema] of Object.entries(ATOM_CONFIG_SCHEMAS)) {
      if (!schema || !('shape' in schema)) continue;
      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape ?? {};
      for (const key of Object.keys(shape)) {
        if (!SPOILER_KEYS.includes(key)) continue;
        pairs.push([type, key]);
        expect(ATOM_CLIENT_SECRET_KEYS[type as keyof typeof ATOM_CLIENT_SECRET_KEYS] ?? [],
          `${type}.${key} 是剧透键但未登记脱敏`).toContain(key);
      }
    }
    // 当前事实快照：恰好 8 对（类型×剧透键）；有意新增含答案原子后同步登记并改此数。
    expect(pairs).toHaveLength(8);
  });
});

describe('toClientAtom（mini DTO 出参脱敏）', () => {
  it('single：剥离 answer，保留 question/options/hint', () => {
    const out = toClientAtom({ id: 'a1', type: 'single', config: { question: 'q', options: ['a', 'b'], answer: 'a', hint: 'h' } });
    expect(out.config).toEqual({ question: 'q', options: ['a', 'b'], hint: 'h' });
    expect((out.config as Record<string, unknown>).answer).toBeUndefined();
  });

  it('multiple：剥离 answer 数组，保留 options', () => {
    const out = toClientAtom({ id: 'a1', type: 'multiple', config: { question: 'q', options: ['a', 'b'], answer: ['a', 'b'] } });
    expect(out.config).toEqual({ question: 'q', options: ['a', 'b'] });
    expect((out.config as Record<string, unknown>).answer).toBeUndefined();
  });

  it('judge/input：剥离 answer', () => {
    const judge = toClientAtom({ id: 'j', type: 'judge', config: { question: '对吗', answer: 'true' } });
    expect(judge.config).toEqual({ question: '对吗' });
    const input = toClientAtom({ id: 'i', type: 'input', config: { question: '填啥', answer: '42' } });
    expect(input.config).toEqual({ question: '填啥' });
  });

  it('physical-search：剥离 expectedCode，保留 prompt/hint', () => {
    const out = toClientAtom({ id: 'ps', type: 'physical-search', config: { prompt: '找钥匙', expectedCode: 'X1', hint: '柜台后' } });
    expect(out.config).toEqual({ prompt: '找钥匙', hint: '柜台后' });
    expect((out.config as Record<string, unknown>).expectedCode).toBeUndefined();
  });

  it('observe：剥离 criteria，保留 prompt/photoRequired', () => {
    const out = toClientAtom({ id: 'ob', type: 'observe', config: { prompt: '看墙面', criteria: '新鲜划痕', photoRequired: true } });
    expect(out.config).toEqual({ prompt: '看墙面', photoRequired: true });
    expect((out.config as Record<string, unknown>).criteria).toBeUndefined();
  });

  it('fragment-assembly：剥离 answer，pieces 完整保留', () => {
    const pieces = [{ id: 'p1', text: '半张地图' }, { id: 'p2', text: '另一半' }];
    const out = toClientAtom({ id: 'fa', type: 'fragment-assembly', config: { pieces, answer: 'p2p1' } });
    expect(out.config).toEqual({ pieces });
    expect((out.config as Record<string, unknown>).answer).toBeUndefined();
  });

  it('item-combine：剥离 revealText，保留 itemIds', () => {
    const out = toClientAtom({ id: 'ic', type: 'item-combine', config: { itemIds: ['key', 'map'], revealText: '暗门开了' } });
    expect(out.config).toEqual({ itemIds: ['key', 'map'] });
    expect((out.config as Record<string, unknown>).revealText).toBeUndefined();
  });

  it('无密键类型：原样返回同一引用（cipher-contact/photo/meditate 字段不丢）', () => {
    const cipher: WenlvAtom = { id: 'cc', type: 'cipher-contact', config: { cipherPhrase: '月黑风高', replyHint: '回上半句' } };
    expect(toClientAtom(cipher)).toBe(cipher);
    expect(toClientAtom(cipher).config).toEqual({ cipherPhrase: '月黑风高', replyHint: '回上半句' });

    const photo: WenlvAtom = { id: 'ph', type: 'photo', config: { question: '拍门牌' } };
    expect(toClientAtom(photo)).toBe(photo);
    expect(toClientAtom(photo).config).toEqual({ question: '拍门牌' });

    const meditate: WenlvAtom = { id: 'md', type: 'meditate', config: { question: '静心', seconds: 60 } };
    expect(toClientAtom(meditate)).toBe(meditate);
    expect(toClientAtom(meditate).config).toEqual({ question: '静心', seconds: 60 });
  });

  it('不修改入参对象：返回新对象/新 config，原 atom.config 仍含 answer', () => {
    const atom: WenlvAtom = { id: 'a1', type: 'single', config: { question: 'q', options: ['x'], answer: 'X' } };
    const out = toClientAtom(atom);
    expect(out).not.toBe(atom);
    expect(out.config).not.toBe(atom.config);
    expect((atom.config as Record<string, unknown>).answer).toBe('X');
    expect((out.config as Record<string, unknown>).answer).toBeUndefined();
  });
});
