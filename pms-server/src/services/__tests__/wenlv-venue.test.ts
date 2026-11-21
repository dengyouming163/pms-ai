import { describe, it, expect } from 'vitest';
import {
  VENUE_STAGES, isVenueStage, canTransitionVenueStage,
  stampForStage, computeStagePatch, generatePointCode,
} from '../wenlv-venue.js';

describe('场地状态机', () => {
  it('枚举含全部 6 个阶段', () => {
    expect([...VENUE_STAGES]).toEqual(['lead', 'surveying', 'deploying', 'pilot', 'live', 'archived']);
  });

  it('isVenueStage 认合法值、拒非法值', () => {
    expect(isVenueStage('surveying')).toBe(true);
    expect(isVenueStage('nope')).toBe(false);
    expect(isVenueStage(undefined)).toBe(false);
    // to 来自不受信的 JSON body，非字符串一并拒收
    expect(isVenueStage(null)).toBe(false);
    expect(isVenueStage(123)).toBe(false);
    expect(isVenueStage({})).toBe(false);
  });

  it('合法相邻流转放行', () => {
    expect(canTransitionVenueStage('lead', 'surveying')).toBe(true);
    expect(canTransitionVenueStage('surveying', 'deploying')).toBe(true);
    expect(canTransitionVenueStage('deploying', 'pilot')).toBe(true);
    expect(canTransitionVenueStage('pilot', 'live')).toBe(true);
    expect(canTransitionVenueStage('live', 'archived')).toBe(true);
    expect(canTransitionVenueStage('archived', 'live')).toBe(true);
  });

  it('打回上一阶段放行', () => {
    expect(canTransitionVenueStage('surveying', 'lead')).toBe(true);
    expect(canTransitionVenueStage('deploying', 'surveying')).toBe(true);
    expect(canTransitionVenueStage('pilot', 'deploying')).toBe(true);
  });

  it('跳级被拒（lead → live）', () => {
    expect(canTransitionVenueStage('lead', 'live')).toBe(false);
    expect(canTransitionVenueStage('surveying', 'pilot')).toBe(false);
    expect(canTransitionVenueStage('lead', 'pilot')).toBe(false);
  });

  it('原地不动被拒', () => {
    expect(canTransitionVenueStage('live', 'live')).toBe(false);
  });

  it('任何阶段都可归档', () => {
    for (const s of VENUE_STAGES) {
      if (s === 'archived') continue;
      expect(canTransitionVenueStage(s, 'archived')).toBe(true);
    }
  });
});

describe('盖章规则', () => {
  it('只有 surveying 盖 surveyStartedAt，其余三个盖上一阶段完成时刻', () => {
    expect(stampForStage('surveying')).toBe('surveyStartedAt');
    expect(stampForStage('deploying')).toBe('surveyedAt');
    expect(stampForStage('pilot')).toBe('deployedAt');
    expect(stampForStage('live')).toBe('liveAt');
  });

  it('lead 与 archived 不盖章', () => {
    expect(stampForStage('lead')).toBeNull();
    expect(stampForStage('archived')).toBeNull();
  });

  it('进入 surveying 时盖 surveyStartedAt', () => {
    const now = new Date('2026-09-12T10:00:00Z');
    expect(computeStagePatch({}, 'surveying', now)).toEqual({ surveyStartedAt: now });
  });

  it('已有章不被覆盖（返工不掩盖时长）', () => {
    const first = new Date('2026-09-01T00:00:00Z');
    const now = new Date('2026-09-12T10:00:00Z');
    // 先走过一轮：surveyStartedAt 已盖
    expect(computeStagePatch({ surveyStartedAt: first }, 'surveying', now)).toEqual({});
  });

  it('未盖章的列是 null（Drizzle 行的真实形状）时仍会盖章', () => {
    const allNull = { surveyStartedAt: null, surveyedAt: null, deployedAt: null, liveAt: null };
    const now = new Date('2026-09-12T10:00:00Z');
    expect(computeStagePatch(allNull, 'surveying', now)).toEqual({ surveyStartedAt: now });
    // 已盖过章的列即便同批里还有 null，也不阻止盖章；但同键已存在时不覆盖
    expect(computeStagePatch({ ...allNull, surveyedAt: new Date('2026-09-01T00:00:00Z') }, 'deploying', now)).toEqual({});
  });

  it('未经手的前序阶段不补章', () => {
    const now = new Date('2026-09-12T10:00:00Z');
    // 直接到 pilot：只盖 deployedAt，不凭空补 surveyStartedAt / surveyedAt
    expect(computeStagePatch({}, 'pilot', now)).toEqual({ deployedAt: now });
  });

  it('归档不盖章', () => {
    expect(computeStagePatch({}, 'archived', new Date())).toEqual({});
  });
});

describe('点位码生成', () => {
  it('形如 WLP- 加 12 位', () => {
    expect(generatePointCode(() => 0)).toBe('WLP-000000000000');
  });

  it('字母表剔除易混字符 I/L/O/U', () => {
    const all = new Set<string>();
    for (let i = 0; i < 32; i++) all.add(generatePointCode(() => i / 32));
    // replaceAll：每条码都带 WLP- 前缀，只 replace 一次会残留其余前缀里的 L
    const letters = [...all].join('').replaceAll('WLP-', '');
    for (const bad of ['I', 'L', 'O', 'U']) expect(letters.includes(bad)).toBe(false);
    expect(new Set(letters).size).toBe(32);   // 32 个字符全部可达，不只是"坏的没出现"

    let calls = 0;                             // 确认是 12 次独立抽样，而非 1 次重复 12 遍
    const counted = () => { calls++; return 0.5; };
    generatePointCode(counted);
    expect(calls).toBe(12);
  });

  it('满量程取到字母表末位 Z', () => {
    expect(generatePointCode(() => 0.999999)).toBe('WLP-ZZZZZZZZZZZZ');
  });
});
