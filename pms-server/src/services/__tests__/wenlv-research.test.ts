import { describe, it, expect } from 'vitest';
import {
  RESEARCH_STALE_MS, RESEARCH_SECTIONS,
  isStaleRunning, decideResearchStart, isResearchSectionState,
} from '../wenlv-research.js';

const NOW = new Date('2026-09-24T12:00:00Z');

describe('isStaleRunning —— 看门狗', () => {
  it('running 且刚开跑 ⇒ 不陈旧', () => {
    expect(isStaleRunning({ status: 'running', startedAt: new Date('2026-09-24T11:50:00Z') }, NOW)).toBe(false);
  });

  it('running 且超过 15 分钟 ⇒ 陈旧（进程重启丢了终态，必须放行重跑）', () => {
    expect(isStaleRunning({ status: 'running', startedAt: new Date('2026-09-24T11:44:00Z') }, NOW)).toBe(true);
  });

  it('边界：正好 15 分钟 ⇒ 不算陈旧（判据是「超过」，不是「达到」）', () => {
    const at = new Date(NOW.getTime() - RESEARCH_STALE_MS);
    expect(isStaleRunning({ status: 'running', startedAt: at }, NOW)).toBe(false);
  });

  it('终态行永不算陈旧（ready 放多久都不是「疑似中断」）', () => {
    expect(isStaleRunning({ status: 'ready', startedAt: new Date('2026-09-20T00:00:00Z') }, NOW)).toBe(false);
  });

  it('started_at 缺失 ⇒ 算陈旧（无法证明它在跑，宁可放行重跑也不要把场地永久锁死）', () => {
    expect(isStaleRunning({ status: 'running', startedAt: null }, NOW)).toBe(true);
  });

  it('started_at 是脏字符串 ⇒ 算陈旧（同上，不抛）', () => {
    expect(isStaleRunning({ status: 'running', startedAt: '不是日期' }, NOW)).toBe(true);
  });
});

describe('decideResearchStart —— POST 的三种动作', () => {
  it('没有行 ⇒ insert', () => {
    expect(decideResearchStart(null, 'r1', NOW)).toEqual({ action: 'insert' });
  });

  it('已有终态行 ⇒ reset（重跑覆盖同一行，id 不变）', () => {
    const row = { id: 'r1', status: 'ready', startedAt: new Date('2026-09-24T11:00:00Z') };
    expect(decideResearchStart(row, 'r2', NOW)).toEqual({ action: 'reset', id: 'r1' });
  });

  it('正在跑且不陈旧、且请求带的是**另一个** id ⇒ conflict（并发保护）', () => {
    const row = { id: 'r1', status: 'running', startedAt: new Date('2026-09-24T11:58:00Z') };
    expect(decideResearchStart(row, 'r2', NOW)).toEqual({ action: 'conflict' });
  });

  it('正在跑但**同一个 id** ⇒ 仍 reset —— 这是断网重试自己那一次请求（幂等重入）', () => {
    const row = { id: 'r1', status: 'running', startedAt: new Date('2026-09-24T11:58:00Z') };
    expect(decideResearchStart(row, 'r1', NOW)).toEqual({ action: 'reset', id: 'r1' });
  });

  it('正在跑但已陈旧 ⇒ reset（看门狗放行，否则这行被 409 永久锁死）', () => {
    const row = { id: 'r1', status: 'running', startedAt: new Date('2026-09-24T11:30:00Z') };
    expect(decideResearchStart(row, 'r2', NOW)).toEqual({ action: 'reset', id: 'r1' });
  });

  it('请求不带 id 且正在跑 ⇒ conflict（不陈旧时，无 id 不等于「我自己的那次」）', () => {
    const row = { id: 'r1', status: 'running', startedAt: new Date('2026-09-24T11:58:00Z') };
    expect(decideResearchStart(row, undefined, NOW)).toEqual({ action: 'conflict' });
  });
});

describe('isResearchSectionState —— 读端不许把「键不在」当 done', () => {
  // ⚠️ `it.each` 的**平铺数组**会被当成「元组列表」：元素类型被推成 `unknown[]`，
  // 于是 `it.each(['pending', …])` 报 TS2345（string 不是 unknown[]）。
  // 每个用例**包一层数组**才对 —— 这是 ts-check 抓出来的，vitest 全绿也看不见。
  it.each([['pending'], ['running'], ['done'], ['failed']])('%s 是合法取值', (s) => {
    expect(isResearchSectionState(s)).toBe(true);
  });
  it.each([[undefined], [null], [''], ['DONE'], ['ok'], [1], [{}]])('%s 不是合法取值', (s) => {
    expect(isResearchSectionState(s)).toBe(false);
  });
});

describe('RESEARCH_SECTIONS', () => {
  it('五个检索节，顺序固定（App 的展示顺序与进度文案都依赖它）', () => {
    expect(RESEARCH_SECTIONS).toEqual(['history', 'materials', 'points', 'people', 'context']);
  });
});
