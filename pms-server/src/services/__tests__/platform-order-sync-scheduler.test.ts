import { describe, it, expect } from 'vitest';
import { pickUsedForCheckin, USED_LINK_WINDOW_MS } from '../platform-order-sync-scheduler.js';

describe('pickUsedForCheckin（轮询核销联动候选筛选）', () => {
  const NOW = Date.UTC(2026, 7, 11, 12, 0, 0); // 2026-08-11 12:00 UTC
  it('仅选 status=used 且 usedAt 在时间窗内的订单，跳过空项', () => {
    const orders = [
      { id: 'a', status: 'used', usedAt: new Date(NOW - 60_000).toISOString() },
      { id: 'b', status: 'store_accepted' },
      null,
    ];
    expect(pickUsedForCheckin(orders as any, NOW).map((o: any) => o.id)).toEqual(['a']);
  });
  it('退款/取消不联动入住', () => {
    const orders = [{ id: 'a', status: 'refunded' }, { id: 'b', status: 'cancelled' }];
    expect(pickUsedForCheckin(orders as any, NOW)).toEqual([]);
  });
  it('超窗（历史存量）不追溯：usedAt 早于窗口 → 跳过', () => {
    const orders = [{ id: 'old', status: 'used', usedAt: new Date(NOW - (USED_LINK_WINDOW_MS + 60_000)).toISOString() }];
    expect(pickUsedForCheckin(orders as any, NOW)).toEqual([]);
  });
  it('缺 usedAt 的 used 订单不联动（无法证明为新单）', () => {
    const orders = [{ id: 'x', status: 'used' }];
    expect(pickUsedForCheckin(orders as any, NOW)).toEqual([]);
  });
});
