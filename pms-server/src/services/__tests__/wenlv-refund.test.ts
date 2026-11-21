import { describe, it, expect } from 'vitest';
import { assessWenlvRefund } from '../wenlv-refund.js';

// 纯判定：全部拒退路径 + 可退。不触库不触网（DB/微信路径由 RUN_DB 用例与生产验收覆盖）。
const order = {
  status: 'paid', paymentStatus: 'paid', totalAmount: '99.00', miniUserId: 'u1',
  tickets: [{ status: 'unused', contentProductId: 'P1' }],
};

describe('assessWenlvRefund', () => {
  it('已支付 + 券未核销 + 无进度 → 可退，返回 contentProductId 与金额', () => {
    expect(assessWenlvRefund(order, 0)).toEqual({ ok: true, contentProductId: 'P1', refundAmount: 99 });
  });

  it('有游玩进度 → 400（玩完再退的敞口）', () => {
    expect(assessWenlvRefund(order, 3)).toEqual({ ok: false, status: 400, error: '已产生游玩进度，不可退款' });
  });

  it('券已核销 → 400', () => {
    expect(assessWenlvRefund({ ...order, tickets: [{ status: 'used', contentProductId: 'P1' }] }, 0))
      .toEqual({ ok: false, status: 400, error: '门票已核销，不可退款' });
  });

  it('未支付 → 400', () => {
    expect(assessWenlvRefund({ ...order, status: 'pending', paymentStatus: 'unpaid' }, 0))
      .toEqual({ ok: false, status: 400, error: '订单未支付，不可退款' });
  });

  it('已退款 → 409', () => {
    expect(assessWenlvRefund({ ...order, status: 'refunded', paymentStatus: 'refunded' }, 0))
      .toEqual({ ok: false, status: 409, error: '订单已退款' });
  });

  it('无券（异常单）→ 400，不 fail-open', () => {
    expect(assessWenlvRefund({ ...order, tickets: [] }, 0))
      .toEqual({ ok: false, status: 400, error: '订单无有效门票，请联系客服' });
  });

  it('金额非法（0）→ 400', () => {
    expect(assessWenlvRefund({ ...order, totalAmount: '0' }, 0))
      .toEqual({ ok: false, status: 400, error: '可退金额无效' });
  });
});
