import { db } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { pmsBuiMiniPayments } from '../db/schema/index.js';
import { refundOrder, queryRefund, WxpayApiError } from './wechat-pay.js';
import { createRefund as dyCreateRefund, queryRefund as dyQueryRefund, DyPayApiError, DY_REFUND_REJECTED_ERRNOS } from './douyin-pay.js';
import { requireEnv } from '../constants.js';
import { getPlatformProductOrderRefundQuote } from './platform-client.js';
import { HttpError } from '../lib/http-error.js';

/** 退款业务错误（带 HTTP 状态码） */
export class RefundError extends HttpError {
  constructor(status: number, message: string) { super(status, message); this.name = 'RefundError'; }
}

/** 套餐订单退款（money-first）：平台试算 → 查支付单 → 金额封顶 → 标记 refunding → 调微信/抖音退款。
 *  资金最终态由退款回调落定（Task 7 将接线 pay.ts refund-notify/dy-refund-notify 的 po_ 分支调用 refund-confirm）。 */
export async function refundPlatformProductOrder(
  orderId: string,
  reason: string,
  opts?: { storeId?: string },
): Promise<{ refundAmount: number; message: string }> {
  // 1) 平台试算（校验可退 + 按取消政策算金额，不写库）
  const quote = await getPlatformProductOrderRefundQuote(orderId, opts?.storeId);
  // 透传平台真实状态码（403 越权/404 不存在保持原样，其余业务错误统一 400）
  if (!quote.ok) {
    const status = quote.status >= 400 && quote.status < 500 ? quote.status : 400;
    throw new RefundError(status, quote.data?.error || '退款校验失败');
  }
  const quoteAmount = Number(quote.data?.data?.refundAmount);
  if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) throw new RefundError(400, '可退金额无效');

  // 2) 查支付单（平台订单 po_ 对应的 pms-server 支付单）
  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(and(eq(pmsBuiMiniPayments.orderId, orderId), eq(pmsBuiMiniPayments.status, 'paid')))
    .limit(1);
  if (!payment) throw new RefundError(404, '支付单不存在，请联系客服处理');

  // 3) 金额封顶：订金单（mode A）实付订金 < 政策应退时按实付退
  const refundFen = Math.min(Math.round(quoteAmount * 100), payment.amount);
  if (refundFen <= 0) throw new RefundError(400, '可退金额为 0');

  // 4) 子商户号：平台套餐订单统一使用平台子商户号（不再按门店进件查 sub_mchid）
  const subMchid = requireEnv('WXPAY_SUB_MCHID');

  // 5) 条件标记 refunding（防并发重复退款）
  const outRefundNo = `RF${payment.outTradeNo}`;
  const updated = await db.update(pmsBuiMiniPayments).set({
    status: 'refunding', refundNo: outRefundNo, refundAmount: refundFen, updatedAt: new Date(),
  }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'paid')))
    .returning({ id: pmsBuiMiniPayments.id });
  if (updated.length === 0) throw new RefundError(409, '退款已在处理中，请勿重复提交');

  // 6) 渠道退款
  if (payment.channel === 'douyin') {
    try {
      await dyCreateRefund({
        outOrderNo: payment.outTradeNo,
        outRefundNo,
        refundAmountFen: refundFen,
        refundReason: reason,
        notifyUrl: `${requireEnv('DY_PAY_NOTIFY_BASE')}/api/mini/pay/dy-refund-notify`,
      });
      // 轻量兜底：申请成功后主动确认受理一次（回调仍是最终落定）
      try {
        await dyQueryRefund(outRefundNo);
      } catch (qErr) {
        console.warn('[product-refund] 抖音退款主动查询失败（不阻塞，依赖回调）', outRefundNo, qErr);
      }
      return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
    } catch (err) {
      console.error('[product-refund] 抖音退款申请异常，查询消歧', payment.outTradeNo, err);
      // 三分支消歧：申请异常 ≠ 申请失败（网络超时可能抖音侧已受理）
      let dyAccepted = false, confirmedRejected = false;
      try {
        await dyQueryRefund(outRefundNo);
        dyAccepted = true;
      } catch (qErr) {
        // 仅当抖音明确返回「退款单不存在」类错误码时才判定申请被拒绝并回滚；
        // 其余 DyPayApiError（含 HTTP 5xx / err_no 缺失）一律视为状态不明，
        // 保守保持退款中待对账，避免误把在途退款回滚为已支付。
        // ⚠️ 联调核对点：错误码以沙箱实测为准，确认后填入 DY_REFUND_REJECTED_ERRNOS。
        if (qErr instanceof DyPayApiError && DY_REFUND_REJECTED_ERRNOS.includes(qErr.errNo)) confirmedRejected = true;
        else console.error('[product-refund] 抖音退款状态查询失败，状态不明', outRefundNo, qErr);
      }
      if (dyAccepted) return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
      if (!confirmedRejected) {
        console.error('[product-refund] 警告：抖音退款申请结果不明，保持退款中待对账', outRefundNo);
        throw new RefundError(502, '退款处理中，请稍后查看退款结果');
      }
      // 明确拒绝：回滚为 paid 让用户可重试（并发回调已落定则按成功返回）
      const rolledBack = await db.update(pmsBuiMiniPayments).set({ status: 'paid', updatedAt: new Date() })
        .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
        .returning({ id: pmsBuiMiniPayments.id });
      if (rolledBack.length === 0) {
        return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
      }
      throw new RefundError(502, '退款申请失败，请稍后重试');
    }
  }

  try {
    await refundOrder({
      subMchid,
      outTradeNo: payment.outTradeNo,
      outRefundNo,
      refundFen,
      totalFen: payment.amount,
      reason,
    });
    // 轻量兜底：申请成功后主动确认受理一次（回调仍是最终落定）
    try {
      await queryRefund(subMchid, outRefundNo);
    } catch (qErr) {
      console.warn('[product-refund] 微信退款主动查询失败（不阻塞，依赖回调）', outRefundNo, qErr);
    }
  } catch (err) {
    console.error('[product-refund] 微信退款申请异常，查询消歧', payment.outTradeNo, err);
    let wxAccepted = false, confirmedRejected = false;
    try { await queryRefund(subMchid, outRefundNo); wxAccepted = true; }
    catch (qErr) {
      if (qErr instanceof WxpayApiError && qErr.status >= 400 && qErr.status < 500) confirmedRejected = true;
      else console.error('[product-refund] 微信退款状态查询失败，状态不明', outRefundNo, qErr);
    }
    if (wxAccepted) return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
    if (!confirmedRejected) {
      console.error('[product-refund] 警告：退款申请结果不明，保持退款中待对账', outRefundNo);
      throw new RefundError(502, '退款处理中，请稍后查看退款结果');
    }
    // 明确拒绝：回滚为 paid 让用户可重试
    const rolledBack = await db.update(pmsBuiMiniPayments).set({ status: 'paid', updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (rolledBack.length === 0) {
      // 并发退款回调已把状态落定（refunded）——退款实际成功，按成功返回
      return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
    }
    throw new RefundError(502, '退款申请失败，请稍后重试');
  }
  return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
}
