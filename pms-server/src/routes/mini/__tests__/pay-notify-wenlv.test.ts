// BFF 支付回调：文旅订单「补座失败」⇒ 立刻自动退款（Task 9.5 Step 5）。
//
// 正反两条（防「恒调用」与「恒不调用」两种空断言）：
//   seatReacquireFailed=true + miniUserId ⇒ 断言调用了 refundWenlvOrder 且入参 miniUserId 正确；
//   seatReacquireFailed=false ⇒ 断言没调用。
//
// 三处模块被 stub：verifyNotifySignature/decryptNotifyResource（wechat-pay）、
//   confirmWenlvOrderPaid（platform-client，回读响应体）、refundWenlvOrder（wenlv-refund，退款编排）。
//   支付单读写走真实本地库（RUN_DB 门控），保证「置 paid 之后才退款」的顺序真的被执行。
//
// ⚠️ 本仓 vi.mock 工厂在类型桩里声明成 () => unknown（不带 importOriginal 形参）。故照仓内既定
//    做法：工厂整体 as any，常量直接写死在工厂里（不引用外层 const，避免 vi.mock 被提升后踩 TDZ），
//    被 mock 的绑定按「被用到的调用面」显式取类型。vi 各 API 是否可用以 src/types/vitest.d.ts 为准。

process.env.WXPAY_APIV3_KEY = 'test-wxpay-key';

vi.mock('../../../services/wechat-pay.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  verifyNotifySignature: vi.fn().mockResolvedValue(true),
  decryptNotifyResource: vi.fn().mockReturnValue({
    trade_state: 'SUCCESS',
    transaction_id: 'txn-1',
    out_trade_no: 'OUT-WENLV-D1-T95',
    amount: { total: 1000 },
  }),
})) as any);
vi.mock('../../../services/platform-client.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  confirmWenlvOrderPaid: vi.fn(),
})) as any);
vi.mock('../../../services/wenlv-refund.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  refundWenlvOrder: vi.fn(),
})) as any);

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import payRoute from '../pay.js';
import { db } from '../../../db/index.js';
import { pmsBuiMiniPayments } from '../../../db/schema/index.js';
import { confirmWenlvOrderPaid } from '../../../services/platform-client.js';
import { refundWenlvOrder } from '../../../services/wenlv-refund.js';

const OUT_TRADE_NO = 'OUT-WENLV-D1-T95';

// 被 mock 的绑定运行时就是 vi.fn()；桩没有 vi.mocked，按被用到的调用面显式取类型。
type FnMock = { mockResolvedValue: (v: unknown) => void };
const confirmMock = confirmWenlvOrderPaid as unknown as FnMock;
const refundMock = refundWenlvOrder as unknown as FnMock;

describe.skipIf(!process.env.RUN_DB)('mini/pay notify 文旅补座失败自动退款（D1）', () => {
  const orderId = 'wlv-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);

  beforeAll(async () => {
    // 清掉上次可能的残留（out_trade_no 唯一），再种一条 pending 文旅支付单
    await db.delete(pmsBuiMiniPayments).where(eq(pmsBuiMiniPayments.outTradeNo, OUT_TRADE_NO));
    await db.insert(pmsBuiMiniPayments).values({
      id: 'pay-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
      storeId: 'platform',
      orderId,
      orderNo: 'WENLV' + Date.now(),
      outTradeNo: OUT_TRADE_NO,
      amount: 1000,
      status: 'pending',
    }).onConflictDoNothing();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    refundMock.mockResolvedValue({ refundAmount: 10, message: '已受理' });
    // 上一条用例已把支付单置 paid，重置回 pending 让下一条再次走进文旅分支
    await db.update(pmsBuiMiniPayments).set({ status: 'pending' })
      .where(eq(pmsBuiMiniPayments.outTradeNo, OUT_TRADE_NO));
  });

  afterAll(async () => {
    await db.delete(pmsBuiMiniPayments).where(eq(pmsBuiMiniPayments.outTradeNo, OUT_TRADE_NO));
  });

  const notify = () => payRoute.request('/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'TRANSACTION.SUCCESS', resource: { ciphertext: 'dummy' } }),
  });

  it('seatReacquireFailed=true + miniUserId ⇒ 调用 refundWenlvOrder 且入参正确', async () => {
    confirmMock.mockResolvedValue({
      ok: true, status: 200,
      data: { success: true, data: { seatReacquireFailed: true, miniUserId: 'u1' } },
    });
    const res = await notify();
    expect(res.status).toBe(200);
    expect(confirmWenlvOrderPaid).toHaveBeenCalledWith(orderId, 'txn-1');
    expect(refundWenlvOrder).toHaveBeenCalledTimes(1);
    expect(refundWenlvOrder).toHaveBeenCalledWith(orderId, { miniUserId: 'u1', reason: '场次座位不足，自动退款' });
  });

  it('seatReacquireFailed=false ⇒ 不调用 refundWenlvOrder', async () => {
    confirmMock.mockResolvedValue({
      ok: true, status: 200,
      data: { success: true, data: { seatReacquireFailed: false, miniUserId: 'u1' } },
    });
    const res = await notify();
    expect(res.status).toBe(200);
    expect(refundWenlvOrder).not.toHaveBeenCalled();
  });
});
