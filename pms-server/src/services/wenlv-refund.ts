// 文旅门票订单退款：money-first 编排。结构严格对齐 product-refund.ts（套餐订单退款），差异：
//  - 文旅只走微信（wenlv-pay 未接抖音），无渠道分支；
//  - 支付单判别用 storeId==='platform'（与 pay.ts 既有文旅分支同一判别法）；
//  - 多一道本地「游玩进度」闸：券只在商户核销时才 used，玩完不核销即无痕迹，只判券状态会被「玩完再退」钻空子。
// 全部纯判定先于任何状态变更（否则会被卡在 refunding）；资金最终态由退款回调落定（pay.ts /refund-notify 文旅分支）。
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiMiniPayments, pmsBuiWenlvProgress } from '../db/schema/index.js';
import { refundOrder, queryRefund, WxpayApiError } from './wechat-pay.js';
import { requireEnv } from '../constants.js';
import {
  getWenlvOrder, getWenlvOrderRefundCheck, revertWenlvOrderRefund,
} from './platform-client.js';
import { HttpError } from '../lib/http-error.js';

/** 退款业务错误（带 HTTP 状态码） */
export class WenlvRefundError extends HttpError {
  constructor(status: number, message: string) { super(status, message); this.name = 'WenlvRefundError'; }
}

interface WenlvOrderLike {
  status: string;
  paymentStatus: string;
  totalAmount: string | number;
  tickets: { status: string; contentProductId: string }[];
}

/** 纯判定（无 IO）：平台侧资格 + 本地游玩进度 → 可退性。
 *  顺序有意：核销 → 进度 → 订单状态 —— 「钱已换服务」的两条最先拦。 */
export function assessWenlvRefund(
  order: WenlvOrderLike,
  progressVisited: number,
): { ok: true; contentProductId: string; refundAmount: number } | { ok: false; status: number; error: string } {
  const tickets = order.tickets ?? [];
  if (tickets.some((t) => t.status === 'used')) return { ok: false, status: 400, error: '门票已核销，不可退款' };
  if (progressVisited > 0) return { ok: false, status: 400, error: '已产生游玩进度，不可退款' };
  if (order.status === 'refunding') return { ok: false, status: 409, error: '退款处理中' };
  if (order.status === 'refunded' || order.paymentStatus === 'refunded') return { ok: false, status: 409, error: '订单已退款' };
  if (order.status === 'cancelled') return { ok: false, status: 400, error: '订单已取消，不可退款' };
  if (order.status !== 'paid' || order.paymentStatus !== 'paid') return { ok: false, status: 400, error: '订单未支付，不可退款' };
  // 下单即发券，正常单必有券；无券属异常，拒绝而非 fail-open 按 0 元退
  const contentProductId = tickets[0]?.contentProductId;
  if (!contentProductId) return { ok: false, status: 400, error: '订单无有效门票，请联系客服' };
  const refundAmount = Number(order.totalAmount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) return { ok: false, status: 400, error: '可退金额无效' };
  return { ok: true, contentProductId, refundAmount };
}

/** 查本地游玩进度：返回已访问节点数（0 = 无进度）。进度表在 pms-server 库，BFF 看不到，故必须本地查。 */
async function countVisitedNodes(contentProductId: string, miniUserId: string): Promise<number> {
  if (!contentProductId) return 0;
  const [row] = await db.select({ state: pmsBuiWenlvProgress.state })
    .from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.productId, contentProductId), eq(pmsBuiWenlvProgress.miniUserId, miniUserId)))
    .limit(1);
  if (!row) return 0;
  const visited = (row.state as { visited?: Record<string, unknown> } | null)?.visited;
  return visited ? Object.keys(visited).length : 0;
}

/** 文旅门票订单退款（整单退）。成功后资金态待微信回调落定。 */
export async function refundWenlvOrder(
  orderId: string,
  opts: { miniUserId?: string; reason: string },
): Promise<{ refundAmount: number; message: string }> {
  // 1) 读订单+券（BFF 既有端点）。miniUserId 为调用方（BFF 创作台）必须提供项：
  //    GET /api/wenlv/orders/:id 把它当必填参数，缺失一律 400「参数错误」；提供后由该端点校归属（不匹配 404）。
  const orderRes = await getWenlvOrder(orderId, opts.miniUserId);
  if (!orderRes.ok || !orderRes.data?.data) {
    throw new WenlvRefundError(orderRes.status === 404 ? 404 : 502, orderRes.data?.error || '订单服务不可用');
  }
  const order = orderRes.data.data;

  // 2) 纯判定：券状态 + 游玩进度
  const progressVisited = await countVisitedNodes(
    (order.tickets ?? [])[0]?.contentProductId ?? '', order.miniUserId,
  );
  const verdict = assessWenlvRefund(order, progressVisited);
  if (!verdict.ok) throw new WenlvRefundError(verdict.status, verdict.error);

  // 3) 本地支付单（文旅统一收款：storeId 占位 'platform'）
  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(and(
      eq(pmsBuiMiniPayments.orderId, orderId),
      eq(pmsBuiMiniPayments.status, 'paid'),
      eq(pmsBuiMiniPayments.storeId, 'platform'),
    )).limit(1);
  if (!payment) throw new WenlvRefundError(404, '支付单不存在，请联系客服处理');

  // 4) 金额封顶：政策应退 vs 实付（测试金额开关等场景下实付可能更小）
  const refundFen = Math.min(Math.round(verdict.refundAmount * 100), payment.amount);
  if (refundFen <= 0) throw new WenlvRefundError(400, '可退金额为 0');

  const subMchid = requireEnv('WXPAY_SUB_MCHID');
  const outRefundNo = `RF${payment.outTradeNo}`;

  // 5) 钱侧先占位（money-first）：CAS paid→refunding 防并发重复退款
  const reserved = await db.update(pmsBuiMiniPayments).set({
    status: 'refunding', refundNo: outRefundNo, refundAmount: refundFen, updatedAt: new Date(),
  }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'paid')))
    .returning({ id: pmsBuiMiniPayments.id });
  if (reserved.length === 0) throw new WenlvRefundError(409, '退款已在处理中，请勿重复提交');

  // 6) BFF 侧复核 + 预留订单 → refunding；失败则回滚本地支付单（此时钱未动，可安全回滚）
  const check = await getWenlvOrderRefundCheck(orderId, opts.miniUserId);
  if (!check.ok) {
    const rolled = await rollbackPayment(payment.id);
    // 回滚成功 = 本地确知无退款在途 → BFF 侧的预留也必须释放，否则订单永久卡 refunding
    // （refund-check 的 CAS 可能已提交但响应丢失；而微信侧无退款单 ⇒ 永远不会有回调来落定）
    // 若 check 是业务拒绝（400/409），其 CAS 在拒绝分支之前就返回了，revert 是 0 行 no-op，安全。
    if (rolled) {
      await revertWenlvOrderRefund(orderId, opts.reason).catch((e: any) =>
        console.error('[wenlv-refund] BFF 订单回滚失败，须人工对账', orderId, e?.message || e));
    } else {
      console.error('[wenlv-refund] 本地支付单回滚未命中（并发已落定？），未释放 BFF 预留', payment.id);
    }
    throw new WenlvRefundError(check.status >= 400 && check.status < 500 ? check.status : 502,
      check.data?.error || '退款校验失败');
  }

  // 7) 渠道退款 + 三分支消歧
  try {
    await refundOrder({
      subMchid, outTradeNo: payment.outTradeNo, outRefundNo, refundFen, totalFen: payment.amount, reason: opts.reason,
    });
    // 轻量兜底：申请成功后主动确认受理一次（回调仍是最终落定）
    try {
      await queryRefund(subMchid, outRefundNo);
    } catch (qErr) {
      console.warn('[wenlv-refund] 微信退款主动查询失败（不阻塞，依赖回调）', outRefundNo, qErr);
    }
    return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
  } catch (err) {
    console.error('[wenlv-refund] 微信退款申请异常，查询消歧', payment.outTradeNo, err);
    let wxAccepted = false, confirmedRejected = false;
    try { await queryRefund(subMchid, outRefundNo); wxAccepted = true; }
    catch (qErr) {
      // 仅 4xx（明确的业务拒绝）判为「申请被拒」；5xx/网络一律状态不明，保守保持 refunding 待对账
      if (qErr instanceof WxpayApiError && qErr.status >= 400 && qErr.status < 500) confirmedRejected = true;
      else console.error('[wenlv-refund] 微信退款状态查询失败，状态不明', outRefundNo, qErr);
    }
    if (wxAccepted) return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
    if (!confirmedRejected) {
      console.error('[wenlv-refund] 警告：退款申请结果不明，保持退款中待对账', outRefundNo);
      throw new WenlvRefundError(502, '退款处理中，请稍后查看退款结果');
    }
    // 明确拒绝：回滚两侧（本地支付单 + BFF 订单）让用户可重试
    const rolled = await rollbackPayment(payment.id);
    if (!rolled) {
      // 并发回调已落定（refunded）——退款实际成功，按成功返回
      return { refundAmount: refundFen / 100, message: '退款已受理，将原路退回' };
    }
    await revertWenlvOrderRefund(orderId, opts.reason).catch((e: any) =>
      console.error('[wenlv-refund] BFF 订单回滚失败，须人工对账', orderId, e?.message || e));
    throw new WenlvRefundError(502, '退款申请失败，请稍后重试');
  }
}

/** CAS 回滚本地支付单 refunding→paid。返回是否真的回滚了（false = 并发已落定） */
async function rollbackPayment(paymentId: string): Promise<boolean> {
  const rows = await db.update(pmsBuiMiniPayments).set({ status: 'paid', updatedAt: new Date() })
    .where(and(eq(pmsBuiMiniPayments.id, paymentId), eq(pmsBuiMiniPayments.status, 'refunding')))
    .returning({ id: pmsBuiMiniPayments.id });
  return rows.length > 0;
}
