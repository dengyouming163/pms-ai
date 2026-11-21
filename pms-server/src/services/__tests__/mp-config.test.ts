import { describe, it, expect } from 'vitest';
import { SUBSCRIBE_REPLY, KEYWORD_REPLIES, DEFAULT_REPLY } from '../../config/mp-reply.js';
import { MP_MENU } from '../../config/mp-menu.js';
import { buildSeedConfig, getEffectiveConfig } from '../mp-reply.js';

describe('buildSeedConfig 配置 seed 初始化', () => {
  it('返回常量种子的完整默认配置（菜单/欢迎语/关键词/默认回复）', () => {
    const seed = buildSeedConfig();
    expect(seed.menu).toEqual(MP_MENU);
    expect(seed.welcome).toBe(SUBSCRIBE_REPLY);
    expect(seed.keywordReplies).toEqual(KEYWORD_REPLIES);
    expect(seed.defaultReply).toBe(DEFAULT_REPLY);
  });
});

describe('getEffectiveConfig 合并 DB 行与种子（CRUD/回调共用）', () => {
  it('无 DB 行 → 全量回落种子默认', () => {
    expect(getEffectiveConfig(null)).toEqual(buildSeedConfig());
    expect(getEffectiveConfig(undefined)).toEqual(buildSeedConfig());
  });
  it('部分字段配置 → 逐项优先 DB，缺失字段回落种子', () => {
    const eff = getEffectiveConfig({ welcome: '新欢迎语', defaultReply: '新默认回复' });
    expect(eff.welcome).toBe('新欢迎语');
    expect(eff.defaultReply).toBe('新默认回复');
    expect(eff.menu).toEqual(MP_MENU); // 未配置菜单 → 种子
    expect(eff.keywordReplies).toEqual(KEYWORD_REPLIES); // 未配置关键词 → 种子
  });
  it('关键词回复为空数组 → 回落种子关键词（未配置视为用默认）', () => {
    const eff = getEffectiveConfig({ keywordReplies: [] });
    expect(eff.keywordReplies).toEqual(KEYWORD_REPLIES);
  });
  it('字段为 null（jsonb 未填）→ 回落种子', () => {
    const eff = getEffectiveConfig({ menu: null, welcome: null, keywordReplies: null, defaultReply: null });
    expect(eff).toEqual(buildSeedConfig());
  });
  it('完整配置 → 全部使用 DB 值', () => {
    const row = {
      menu: { button: [{ name: '自定义菜单' }] },
      welcome: '欢迎',
      keywordReplies: [{ keywords: ['订房'], reply: '订房回复' }],
      defaultReply: '默认',
    };
    expect(getEffectiveConfig(row)).toEqual(row);
  });
});
