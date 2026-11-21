import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock db 模块：factory 内直接用 vi.fn()（与 platform-orders.test.ts 同款写法），
// 避免 vi.hoisted（本项目 tsc 下 vi 类型不含 hoisted，会报 TS2339）
vi.mock('../../db/index.js', () => ({ db: { select: vi.fn() } }));

import { db } from '../../db/index.js';
import { findStayOrderByPlatformOrder } from '../platform-order-converter.js';

function mockRows(rows: any[]) {
  (db.select as any).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  });
}

describe('findStayOrderByPlatformOrder（平台单反查住宿订单）', () => {
  beforeEach(() => vi.clearAllMocks());
  it('命中返回住宿订单', async () => {
    mockRows([{ id: 'ob_1', platformOrderId: 'po_1', channel: '私域平台' }]);
    const stay = await findStayOrderByPlatformOrder('po_1');
    expect(stay?.id).toBe('ob_1');
  });
  it('未命中返回 null', async () => {
    mockRows([]);
    expect(await findStayOrderByPlatformOrder('po_999')).toBe(null);
  });
  it('空参数直接返回 null，不查库', async () => {
    expect(await findStayOrderByPlatformOrder('')).toBe(null);
    expect(db.select).not.toHaveBeenCalled();
  });
});
