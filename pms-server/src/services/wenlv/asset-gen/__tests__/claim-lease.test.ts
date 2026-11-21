import { describe, it, expect } from 'vitest';
import { isLeaseExpired } from '../claim.js';

describe('租约过期判定（纯函数）', () => {
  const MIN = 60_000;

  it('未超时 → 不判过期', () => {
    expect(isLeaseExpired(new Date(Date.now() - 5 * MIN), 15, Date.now())).toBe(false);
  });

  it('刚超时 → 判过期', () => {
    expect(isLeaseExpired(new Date(Date.now() - 16 * MIN), 15, Date.now())).toBe(true);
  });

  it('边界：正好等于阈值 → 不过期（与 SQL 的 lt 同向，只差 1ms）', () => {
    const now = Date.now();
    expect(isLeaseExpired(new Date(now - 15 * MIN), 15, now)).toBe(false);
  });

  it('边界内侧：差 1ms 不到阈值 → 不过期', () => {
    const now = Date.now();
    expect(isLeaseExpired(new Date(now - 15 * MIN + 1), 15, now)).toBe(false);
  });

  it('minutes = 0 → 已过去 1ms 就判过期（误传 0 会导致批量误杀）', () => {
    const now = Date.now();
    expect(isLeaseExpired(new Date(now - 1), 0, now)).toBe(true);
  });

  it('now 早于 startedAt（时钟回拨）→ 不判过期（安全方向）', () => {
    const now = Date.now();
    expect(isLeaseExpired(new Date(now + 60_000), 15, now)).toBe(false);
  });
});
