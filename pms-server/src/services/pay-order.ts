import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  pmsBuiOrders, pmsBuiMiniPayments, pmsBuiMerchantApplications,
} from '../db/schema/index.js';
import { getMiniUser } from '../middleware/mini-auth.js';
import { closeOrder, effectiveAmountFen, effectiveProductAmountFen } from './wechat-pay.js';
import { getPlatformProductOrder } from './platform-client.js';
import { requireEnv } from '../constants.js';
import { HttpError } from '../lib/http-error.js';

// ============================================================
// 待支付订单解析（房间订单 + 平台套餐订单统一入口，供 H5 支付路由使用）
//   房间订单（orderId 非 po_ 前缀）：本地 pmsBuiOrders + pmsBuiMiniPayments（otaTimeout 超时）
//   套餐订单（orderId 以 po_ 开头）：平台内部接口拉取 + 复用 pmsBuiMiniPayments（payDeadline 超时）
// 金额口径与取价位置对齐 mini/pay.ts 与 mini/pay-product.ts：服务端取价，不信任客户端。
// 说明：既有 /api/mini/pay /jsapi、/dy-jsapi 与 pay-product 的 handleProductJsapi/DyJsapi
//       仍走各自原始实现（资金代码，避免重构回归）；本解析仅供 pay-h5 路由使用。
// ============================================================

/** 支付解析业务错误（带 HTTP 状态码，限定为可作 c.json 状态码的合法字面量） */
export class PayOrderError extends HttpError {
  // 继承后基类 status 为 number，这里收窄回原有字面量联合类型：既保持公开类型不变
  // （消费方 c.json(..., e.status) 依赖 ContentfulStatusCode），又不影响运行时取值。
  declare status: 400 | 404 | 500 | 502;
  constructor(status: 400 | 404 | 500 | 502, message: string) {
    super(status, message);
    this.name = 'PayOrderError';
  }
}

/** 套餐订单应付金额（分）：模式A 付订金，模式B 付全款。
 *  0 分支付单微信会拒收，订金缺失/为 0 时抛 400「订金金额无效」，全款同理防 0 分。 */
export function payableFen(order: any): number {
  const yuan = (order.mode === 'A' && order.depositAmount != null)
    ? Number(order.depositAmount)
    : Number(order.totalAmount);
  const fen = Math.round(yuan * 100);
  if (!Number.isFinite(fen) || fen <= 0) {
    throw new PayOrderError(400, order.mode === 'A' ? '订金金额无效' : '订单金额无效');
  }
  return fen;
}

export interface ResolveOrderPaymentResult {
  /** 订单对象：房间订单为 pmsBuiOrders 行；套餐订单为平台订单对象（字段含 productName/payDeadline/mode 等） */
  order: any;
  payment: typeof pmsBuiMiniPayments.$inferSelect;
  amountFen: number;
  subMchid: string;
}

/**
 * 解析待支付订单并创建/复用支付单（房间订单 + 平台套餐订单统一入口）。
 * @param channel 支付渠道：'wx'（微信 JSAPI/MWEB，需进件完成 + 金额不一致时同步关单兜底）/ 'douyin'（抖音直连，不校验进件）
 */
export async function resolveOrderPayment(
  c: Context,
  orderId: string,
  opts: { channel?: 'wx' | 'douyin' } = {},
): Promise<ResolveOrderPaymentResult> {
  const channel = opts.channel || 'wx';
  const miniUser = getMiniUser(c);

  // ---- 订单加载 + 归属/状态/超时校验 ----
  let order: any;
  let storeId = '';
  let merchantId = '';
  let orderNo = '';
  let amountFen = 0;

  if (orderId.startsWith('po_')) {
    // 套餐订单：平台内部接口拉取（服务端取价）
    const res = await getPlatformProductOrder(orderId);
    if (!res.ok) {
      throw new PayOrderError(res.status === 404 ? 404 : 502, res.data?.error || '订单服务不可用');
    }
    order = res.data?.data;
    if (!order) throw new PayOrderError(404, '订单不存在');
    if (order.miniUserId !== miniUser.miniUserId) throw new PayOrderError(404, '订单不存在'); // 不泄露他人订单
    if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
      throw new PayOrderError(400, '订单状态不可支付');
    }
    if (order.payDeadline && new Date(order.payDeadline).getTime() < Date.now()) {
      throw new PayOrderError(400, '订单已超时，请重新下单');
    }
    // 门店信息缺失：不能写空串落入 NOT NULL 的 store_id 列（Minor#3 修复）
    if (!order.storeId) throw new PayOrderError(400, '订单门店信息缺失');
    storeId = order.storeId;
    merchantId = order.merchantId || 'default';
    orderNo = order.orderNo || '';
    amountFen = effectiveProductAmountFen(payableFen(order));
  } else {
    // 房间订单：本地库按 门店+小程序用户 归属查询
    const [room] = await db.select().from(pmsBuiOrders)
      .where(and(eq(pmsBuiOrders.id, orderId), eq(pmsBuiOrders.guestId, miniUser.miniUserId))).limit(1);
    if (!room) throw new PayOrderError(404, '订单不存在');
    if (room.status !== 'pending' || room.paymentStatus !== 'unpaid') {
      throw new PayOrderError(400, '订单状态不可支付');
    }
    if (room.otaTimeout && room.otaTimeout.getTime() < Date.now()) {
      throw new PayOrderError(400, '订单已超时，请重新下单');
    }
    order = room;
    storeId = room.storeId || '';
    merchantId = room.merchantId || 'default';
    orderNo = room.orderNo;
    amountFen = effectiveAmountFen(room.totalPrice * 100); // 元 → 分（唯一换算点）
    // 房单金额 0 分守卫：与 po_ 分支 payableFen 同口径，防 0 分单被微信拒收（Minor#2 修复）
    if (!Number.isFinite(amountFen) || amountFen <= 0) {
      throw new PayOrderError(400, '订单金额无效');
    }
  }

  // 子商户号解析：
  //   平台套餐订单（po_）：统一使用平台子商户号 WXPAY_SUB_MCHID（不校验门店进件）
  //   房间订单：门店必须已完成进件（服务商特约商户号）；抖音直连单商户不校验进件
  let subMchid: string;
  if (orderId.startsWith('po_')) {
    subMchid = requireEnv('WXPAY_SUB_MCHID');
  } else {
    const [application] = await db.select().from(pmsBuiMerchantApplications)
      .where(eq(pmsBuiMerchantApplications.storeId, storeId)).limit(1);
    if (channel === 'wx' && (!application?.subMchid || application.status !== 'finished')) {
      throw new PayOrderError(400, '该门店收款配置未完成');
    }
    subMchid = application?.subMchid || '';
  }

  // ---- 幂等：同订单复用未支付支付单（同渠道），金额/渠道不一致则关旧建新 ----
  // 跨渠道守卫（资金路径，Important#1）：部分唯一索引 uniq_mini_payments_order_pending 只约束
  // 「同订单最多一条 pending」（跨渠道亦然）。若仅按 orderId+pending 复用，会误拿其他渠道（如先抖音后微信）
  // 的支付单，导致同一 outTradeNo 双渠道同时可付。故先查「当前渠道」的 pending；
  // 查不到时再兜底查「任意渠道」的 pending（跨渠道残留），命中即关闭后按当前渠道重建。
  let payment: typeof pmsBuiMiniPayments.$inferSelect | undefined = (await db.select().from(pmsBuiMiniPayments)
    .where(and(eq(pmsBuiMiniPayments.orderId, orderId), eq(pmsBuiMiniPayments.channel, channel), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
  if (!payment) {
    payment = (await db.select().from(pmsBuiMiniPayments)
      .where(and(eq(pmsBuiMiniPayments.orderId, orderId), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
  }
  // 复用前一致性检查：金额不一致或渠道不一致（跨渠道残留）→ 关旧单建新单（本渠道）
  if (payment && (payment.amount !== amountFen || payment.channel !== channel)) {
    await db.update(pmsBuiMiniPayments).set({ status: 'closed', updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));
    // 微信关单必须按「旧单自身渠道」门控：旧单为微信且有 subMchid 才失效旧 prepay 防继续支付；
    // 旧单为抖音直连无微信侧 prepay，不得调微信关单；失败不阻塞新单（旧单本地已 closed，回调会短路）
    if (payment.channel === 'wx' && subMchid) {
      try {
        await closeOrder(subMchid, payment.outTradeNo);
      } catch (err) {
        console.error('[pay-order] 微信关单失败（不阻塞新单）', payment.outTradeNo, err);
      }
    }
    payment = undefined;
  }
  if (!payment) {
    // 部分唯一索引 uniq_mini_payments_order_pending 保证同订单最多一条 pending 支付单；
    // 并发插入冲突时 onConflictDoNothing 返回空，回读复用对方刚建的支付单
    const suffix = channel === 'douyin' ? 'D' : 'T';
    [payment] = await db.insert(pmsBuiMiniPayments).values({
      id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId,
      storeId,
      orderId,
      orderNo,
      channel,
      outTradeNo: `${orderNo}${suffix}${Date.now().toString().slice(-6)}`,
      amount: amountFen,
    }).onConflictDoNothing().returning();
    if (!payment) {
      // 并发对方已建「同渠道」pending → 复用；若回读落到其他渠道 pending 说明竞态残留，宁可 500 让用户重试，
      // 也不复用错误渠道支付单（资金安全优先）
      [payment] = await db.select().from(pmsBuiMiniPayments)
        .where(and(eq(pmsBuiMiniPayments.orderId, orderId), eq(pmsBuiMiniPayments.channel, channel), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1);
    }
    if (!payment) throw new PayOrderError(500, '支付单创建失败，请重试');
  }

  return { order, payment, amountFen: payment.amount, subMchid };
}
