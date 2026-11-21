import { describe, it, expect } from 'vitest';
import { pickPublicProduct, PUBLIC_PRODUCT_KEYS } from '../wenlv-public-fields.js';

describe('pickPublicProduct', () => {
  it('剔除全部内部字段', () => {
    const row = {
      id: 'p1', name: '雨夜渡口', subtitle: '副标题', coverImage: 'https://x/y.png',
      mode: 'rally', playMode: 'group', theme: { a: 1 }, config: { b: 2 },
      merchantId: 'm1', venueId: 'v1',
      aiInput: '商户的原始提示词', styleBible: { 内部: '基线' },
      styleAnchorUrl: 'https://x/anchor.png', styleReferences: [{ url: 'https://x/r.png' }],
      publishedVersion: 3, generationStartedAt: new Date(), contentReadyAt: new Date(),
      status: 'published', createdAt: new Date(), updatedAt: new Date(),
    };
    const out = pickPublicProduct(row as any);
    for (const k of ['aiInput', 'styleBible', 'styleAnchorUrl', 'styleReferences',
                     'merchantId', 'venueId', 'publishedVersion',
                     'generationStartedAt', 'contentReadyAt']) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it('保留游客端真正会读的字段（防投影过窄把页面弄坏）', () => {
    const row = { id: 'p1', name: 'n', subtitle: 's', coverImage: 'c', mode: 'rally',
                  playMode: 'group', theme: { t: 1 }, config: { c: 1 } };
    const out = pickPublicProduct(row as any);
    expect(Object.keys(out).sort()).toEqual([...PUBLIC_PRODUCT_KEYS].sort());
  });

  it('白名单外的键一律不下发（实现改回 {...row} 展开或改成黑名单时必红）', () => {
    // 白名单的含义就是「新列默认不下发」。本用例把这句话变成可执行的判据：
    // 若有人把实现改回 `{...row}` 或改成黑名单，这里立刻红。
    const out = pickPublicProduct({ id: 'p', 意外的新列: 'leak' } as any);
    expect(out).not.toHaveProperty('意外的新列');
  });

  it('输入为 null / undefined 不抛（端点容错）', () => {
    expect(pickPublicProduct(null as any)).toEqual({});
    expect(pickPublicProduct(undefined as any)).toEqual({});
  });

  it('config 内层剔掉 AI 出稿快照 characters（它带 ip_prompt / role，表侧明文不下发）', () => {
    const out = pickPublicProduct({
      id: 'p',
      config: { checkinRule: '签到', characters: { characters: [{ ip_prompt: '内部形象描述', role: '内奸' }] } },
    } as any);
    const cfg = out.config as Record<string, unknown>;
    expect(cfg).not.toHaveProperty('characters');
    expect(cfg.checkinRule).toBe('签到'); // 防「整块 config 被删掉」的实现
  });

  it('config 为 null / 非对象时原样透传（不替前端做决定）', () => {
    expect((pickPublicProduct({ id: 'p', config: null } as any) as any).config).toBeNull();
    expect((pickPublicProduct({ id: 'p', config: 'x' } as any) as any).config).toBe('x');
    expect((pickPublicProduct({ id: 'p', config: [1, 2] } as any) as any).config).toEqual([1, 2]);
  });
});
