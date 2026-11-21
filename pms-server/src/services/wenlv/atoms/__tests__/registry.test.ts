import { describe, it, expect } from 'vitest';
import type { WenlvAtomType } from '../../../../db/schema/wenlv.js';
import { ATOM_META, parseAtomConfig, isCommerceAtom, requiredAtomIds } from '../registry';

describe('ATOM_META 注册表', () => {
  it('覆盖 21 个类型（15 新含 guest-social 预留 + 6 兼容题型）', () => {
    expect(Object.keys(ATOM_META).length).toBe(21);
  });
  it('商业原子只有 cipher-contact / merchant-grant / token-redeem / paid-customization', () => {
    expect(Object.entries(ATOM_META).filter(([, m]) => m.isCommerce).map(([k]) => k))
      .toEqual(['cipher-contact', 'merchant-grant', 'token-redeem', 'paid-customization']);
  });
  it('guest-social 上架标记为 false（P1 默认关闭）', () => {
    expect(ATOM_META['guest-social'].enabled).toBe(false);
  });
});

describe('parseAtomConfig', () => {
  it('physical-search 缺 prompt ⇒ 抛错', () => {
    expect(() => parseAtomConfig('physical-search', {})).toThrow();
  });
  it('physical-search 合法配置通过并剥多余键', () => {
    const c = parseAtomConfig('physical-search', { prompt: '找钥匙', expectedCode: 'A12', junk: 1 });
    expect(c).toEqual({ prompt: '找钥匙', expectedCode: 'A12' });
  });
  it('未注册类型 ⇒ 抛错', () => {
    expect(() => parseAtomConfig('nope' as WenlvAtomType, {})).toThrow('未注册原子类型');
  });
  it('quiz 兼容题型：single 必须有 question/options/answer', () => {
    expect(() => parseAtomConfig('single', { question: 'q', options: ['a'], answer: 'a' })).not.toThrow();
    expect(() => parseAtomConfig('single', { question: 'q' })).toThrow();
  });
});
