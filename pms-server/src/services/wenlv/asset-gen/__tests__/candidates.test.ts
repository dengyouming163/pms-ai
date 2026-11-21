import { describe, it, expect } from 'vitest';
import {
  MAX_CANDIDATES, MAX_STYLE_REFS, SEQUENTIAL_TOTAL_LIMIT, resolveCandidateCount,
} from '../candidates.js';

describe('候选配额', () => {
  it('常态：参考图少时按请求数出', () => {
    expect(resolveCandidateCount(4, 1)).toBe(4);
    expect(resolveCandidateCount(4, 5)).toBe(4);
  });

  it('请求数超过候选上限 → 夹到 4（计划中唯一会真实生效的夹取）', () => {
    // ⚠️ 这条是 MAX_CANDIDATES 的**唯一**守卫。没有它，把 `Math.min` 的第三项
    //    改成 5/6/7/8、或整项删掉，其余用例**全绿** —— 因为它们的 requested
    //    都不大于 4，MAX_CANDIDATES 永远不是最小值。而按计划的调用点
    //    （refs = 锚 1 + 图集 ≤6 + 涂鸦 1 ≤ 8 ⇒ 余量 ≥ 7）那条配额抛错分支
    //    **走不到**，于是「真实生效的夹取」与「被测到的夹取」正好错开。
    // 15 - 1 = 14 的余量 > 4 ⇒ 结果只可能来自 MAX_CANDIDATES 这一项。
    expect(resolveCandidateCount(99, 1)).toBe(4); // 字面量 4：前端另有一份同值硬编码，改这里要同步改那儿
  });

  it('配额不够时按剩余额度截断', () => {
    // 15 - 13 = 2
    expect(resolveCandidateCount(4, 13)).toBe(2);
    // 15 - 14 = 1
    expect(resolveCandidateCount(4, 14)).toBe(1);
  });

  it('参考图 = 15 → 候选 0 → 抛错（绝不静默降级成「少发几张参考图」）', () => {
    expect(() => resolveCandidateCount(4, 15)).toThrow(/参考图/);
  });

  it('参考图 > 15 → 同样抛错（配额边界之外）', () => {
    expect(() => resolveCandidateCount(1, 16)).toThrow(/参考图/);
  });

  it('常量本身自洽：单张卡全部参考图（锚 1 + 图集 6 + 涂鸦 1）加候选上限仍 < 总配额', () => {
    // 1 + 6 + 1 + 4 = 12 < 15。把 MAX_STYLE_REFS 抬到 9 这条就红
    // （1 + 9 + 1 + 4 = 15，涂鸦位被吃掉）。
    expect(1 + MAX_STYLE_REFS + 1 + MAX_CANDIDATES).toBeLessThan(SEQUENTIAL_TOTAL_LIMIT);
  });

  it('非整数入参 → 抛错（否则 4 张参考图配 13.5 会算出 1.5 张候选发出去）', () => {
    expect(() => resolveCandidateCount(2.5, 1)).toThrow(/候选数/);
    expect(() => resolveCandidateCount(4, 13.5)).toThrow(/参考图/);
    expect(() => resolveCandidateCount(NaN, 1)).toThrow(/候选数/);
    expect(() => resolveCandidateCount(4, NaN)).toThrow(/参考图/);
  });

  it('请求数为 0 或负数 → 抛错（调用方算错了，不是「不要了」）', () => {
    expect(() => resolveCandidateCount(0, 1)).toThrow();
    expect(() => resolveCandidateCount(-1, 1)).toThrow();
  });
});
