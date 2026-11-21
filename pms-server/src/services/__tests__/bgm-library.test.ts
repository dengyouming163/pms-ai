import { describe, it, expect } from 'vitest';
import {
  BGM_MAP, DEFAULT_BGM_KEY, SOUND_STYLE_ALIAS,
  buildBgmUrl, buildBgmUrlOrNull, resolveBgmUrl,
} from '../bgm-library.js';
import { BUILTIN_WENLV_TEMPLATES } from '../../db/wenlv-design-builtin.js';

// 本文件是纯函数测试：不连库、不需要 OSS 凭据。
// 「不需要凭据」由 getOSSBaseUrl 的函数体结构性保证（只读 bucket/region），不靠测试保证。
// BUILTIN_WENLV_TEMPLATES 是纯数据模块（该文件头注：无任何副作用、不 import db），可直接 import。

describe('bgm-library', () => {
  it('BGM_MAP 的键是短名、值是以 bgm- 开头的文件名前缀', () => {
    // 键值写反是本模块最容易犯的错，用形状断言钉死方向
    const keys = Object.keys(BGM_MAP);
    expect(keys).toContain('relaxing');
    expect(keys).toContain('chinese');
    expect(keys).not.toContain('bgm-chinese-style');
    for (const k of keys) {
      expect(BGM_MAP[k]).toMatch(/^bgm-/);
    }
    expect(BGM_MAP.chinese).toBe('bgm-chinese-style');
  });

  it('buildBgmUrl 按短名拼出 mp3 地址', () => {
    expect(buildBgmUrl('chinese')).toMatch(/^https:\/\/[^/]+\/pms\/bgm\/bgm-chinese-style\.mp3$/);
  });

  it('resolveBgmUrl：中文 soundStyle 标签映射到对的曲子（§4.3 映射表）', () => {
    // ⚠️ 这是本模块最容易静默失效的一层：soundStyle 落库的是中文标签，
    // BGM_MAP 的键是英文短名，少这一层每个产品都会**静默**落到默认曲（不报错、只是没声/错声）。
    expect(resolveBgmUrl('东方古韵')).toContain('/pms/bgm/bgm-chinese-style.mp3');
    expect(resolveBgmUrl('空灵古琴')).toContain('/pms/bgm/bgm-relaxing.mp3');
    expect(resolveBgmUrl('电子脉冲')).toContain('/pms/bgm/bgm-dynamic.mp3');
    // 空灵古琴必须**不等于**默认曲 —— 否则「映射到 relaxing」这条断言是假的
    expect(resolveBgmUrl('空灵古琴')).not.toBe(resolveBgmUrl(undefined));
  });

  it('resolveBgmUrl：英文短名仍可直取（兼容旧数据 / 视频合成侧）', () => {
    expect(resolveBgmUrl('chinese')).toContain('/pms/bgm/bgm-chinese-style.mp3');
    expect(resolveBgmUrl('relaxing')).toContain('/pms/bgm/bgm-relaxing.mp3');
    expect(resolveBgmUrl('dynamic')).toContain('/pms/bgm/bgm-dynamic.mp3');
  });

  it('resolveBgmUrl：未匹配 / 空 / undefined 一律落到默认风格（不返回 undefined）', () => {
    // 默认落 chinese —— 历史题材默认古风
    const def = resolveBgmUrl(undefined);
    expect(def).toContain(`/pms/bgm/${BGM_MAP[DEFAULT_BGM_KEY]}.mp3`);
    expect(resolveBgmUrl('')).toBe(def);
    expect(resolveBgmUrl('no-such-style')).toBe(def);
    expect(resolveBgmUrl(null)).toBe(def);
  });

  it('每个内置模板的 soundStyle 都在 SOUND_STYLE_ALIAS 里（防静默落默认曲）', () => {
    // 防漂移锁：新增内置模板风格却不补映射时，这里必须红。
    // 没有这条，上述中文映射用例全绿也证明不了「内置模板真的被覆盖到了」。
    expect(BUILTIN_WENLV_TEMPLATES.length).toBeGreaterThan(0);
    // 收集成一份清单再断言：失败时打印出「哪些模板的哪个标签没映射」，
    // 比在循环里逐条断更容易定位（循环内首条失败就中断，看不到全貌）。
    const unmapped = BUILTIN_WENLV_TEMPLATES
      .map((tpl) => ({ id: tpl.id, style: tpl.tokens.soundStyle }))
      .filter(({ style }) => typeof style !== 'string' || !Object.hasOwn(SOUND_STYLE_ALIAS, style));
    expect(unmapped).toEqual([]);
  });

  it('原型链上的假键不会被当成命中（constructor / toString / __proto__）', () => {
    // 用 BGM_MAP[key] 真值判断的写法会被这些键穿过，拼出
    // `.../pms/bgm/function Object() { [native code] }.mp3` 这种 404 地址。
    expect(buildBgmUrlOrNull('constructor')).toBeNull();
    expect(buildBgmUrlOrNull('toString')).toBeNull();
    expect(buildBgmUrlOrNull('__proto__')).toBeNull();
    // 归一后也绝不能漏出去
    const def = resolveBgmUrl(undefined);
    expect(resolveBgmUrl('constructor')).toBe(def);
    expect(resolveBgmUrl('toString')).toBe(def);
    expect(resolveBgmUrl('__proto__')).toBe(def);
  });

  it('buildBgmUrlOrNull：未匹配 / 空 / undefined 一律返回 null（**不是** undefined.mp3）', () => {
    // 这条锁的是 video-promo 的既有语义：没指定 / 不认识 → 不配 BGM。
    // 写坏了的表现是往视频流水线里塞一个 /pms/bgm/undefined.mp3 的 404 地址。
    expect(buildBgmUrlOrNull('chinese')).toContain('/pms/bgm/bgm-chinese-style.mp3');
    expect(buildBgmUrlOrNull('no-such-style')).toBeNull();
    expect(buildBgmUrlOrNull('')).toBeNull();
    expect(buildBgmUrlOrNull(undefined)).toBeNull();
    expect(buildBgmUrlOrNull(null)).toBeNull();
    // 反向锁死：绝不能拼出含 "undefined" 的地址
    for (const bad of ['no-such-style', '', undefined, null]) {
      expect(String(buildBgmUrlOrNull(bad))).not.toContain('undefined');
    }
  });
});
