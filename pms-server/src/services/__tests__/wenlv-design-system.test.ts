import { describe, it, expect } from 'vitest';
import { resolveProductTokens } from '../wenlv-design-system.js';

describe('resolveProductTokens（引用覆盖解析）', () => {
  it('无模板无 theme 返回空 tokens', () => {
    expect(resolveProductTokens(null, null)).toEqual({});
  });

  it('有模板无 theme 原样返回模板 tokens', () => {
    const tpl = { colors: { primary: '#C8102E' }, radius: 8 };
    expect(resolveProductTokens(tpl, null)).toEqual(tpl);
  });

  it('theme.primaryColor 覆盖模板 colors.primary', () => {
    const tpl = { colors: { primary: '#C8102E', accent: '#F5C518' } };
    const theme = { primaryColor: '#0000FF' };
    const out = resolveProductTokens(tpl, theme);
    expect(out.colors?.primary).toBe('#0000FF');
    expect(out.colors?.accent).toBe('#F5C518'); // 未覆盖字段保留
  });

  it('theme.motion 浅合并覆盖模板 motion', () => {
    const tpl = { motion: { easing: 'ease-out', duration: 300 } };
    const theme = { motion: { duration: 500 } };
    const out = resolveProductTokens(tpl, theme);
    expect(out.motion).toEqual({ easing: 'ease-out', duration: 500 });
  });

  it('theme.soundStyle/haptic 覆盖模板对应字段', () => {
    const tpl = { soundStyle: '东方古韵', haptic: { stamp: false } };
    const theme = { soundStyle: '电子脉冲', haptic: { stamp: true, checkin: true } };
    const out = resolveProductTokens(tpl, theme);
    expect(out.soundStyle).toBe('电子脉冲');
    expect(out.haptic).toEqual({ stamp: true, checkin: true });
  });

  it('theme.font 覆盖模板 fonts.body', () => {
    const tpl = { fonts: { heading: '思源宋体', body: '思源黑体' } };
    const theme = { font: '站酷小薇' };
    expect(resolveProductTokens(tpl, theme).fonts?.body).toBe('站酷小薇');
  });

  it('无对应字段时不产生空 key（按需输出守护）', () => {
    expect(resolveProductTokens({ radius: 8 }, {})).toEqual({ radius: 8 });
    expect(resolveProductTokens(undefined, { primaryColor: '#000' })).toEqual({ colors: { primary: '#000' } });
  });

  it('theme.haptic 部分覆盖时浅合并保留模板其余布尔', () => {
    const tpl = { haptic: { stamp: false, checkin: true } };
    const theme = { haptic: { stamp: true } };
    expect(resolveProductTokens(tpl, theme).haptic).toEqual({ stamp: true, checkin: true });
  });
});
