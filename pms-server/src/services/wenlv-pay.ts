// 文旅门票订单微信 JSAPI 下单：复用 pmsBuiMiniPayments 支付单，服务端从 BFF 取价，不信任客户端。
// 与 pay-product.ts 的 handleProductJsapi 同模式，差异：文旅订单无门店（平台统一收款 storeId 占位 'platform'）、
// 金额字段为 totalAmount、miniUser 由调用方（wenlv-trade 已 parseMiniToken）传入而非本模块 getMiniUser。
import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiMiniPayments } from '../db/schema/index.js';
import {
  jsapiPartnerOrder, buildMiniPayParams, closeOrder, toRfc3339Cst, getWxpayPrivateKey,
} from './wechat-pay.js';
import { requireEnv } from '../constants.js';
import { getWenlvOrder } from './platform-client.js';
import { HttpError, serverError } from '../lib/http-error.js';

/** 业务错误（带 HTTP 状态码） */
export class PayError extends HttpError {
  // 收窄回原有字面量联合类型，保持本文件内 c.json(..., e.status) 的类型不变
  declare status: 400 | 404 | 500 | 502;
  constructor(status: 400 | 404 | 500 | 502, message: string) {
    super(status, message);
    this.name = 'PayError';
  }
}

/** 文旅订单测试金额（分）：WENLV_PAY_TEST_AMOUNT_FEN 为正整数时强制该分值，便于小额联调；生产环境强制忽略防误置 */
function wenlvAmountFen(realFen: number): number {
  if (process.env.NODE_ENV === 'production') return realFen;
  const test = Number(process.env.WENLV_PAY_TEST_AMOUNT_FEN || '0');
  return Number.isFinite(test) && test > 0 ? test : realFen;
}

/** 从 BFF 拉取文旅订单并做通用校验（归属/状态/超时），返回订单对象 */
async function loadWenlvOrder(orderId: string, miniUserId: string): Promise<any> {
  const res = await getWenlvOrder(orderId, miniUserId);
  if (!res.ok) {
    throw new PayError(res.status === 404 ? 404 : 502, res.data?.error || '订单服务不可用');
  }
  const order = res.data?.data;
  if (!order) throw new PayError(404, '订单不存在');
  if (order.miniUserId !== miniUserId) throw new PayError(404, '订单不存在'); // 本地兜底，不泄露他人订单
  if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
    throw new PayError(400, '订单状态不可支付');
  }
  if (order.payDeadline && new Date(order.payDeadline).getTime() < Date.now()) {
    throw new PayError(400, '订单已超时，请重新下单');
  }
  return order;
}

/** 文旅门票微信 JSAPI 下单。miniUser 由调用方鉴权后传入（含 miniUserId/openid） */
export async function handleWenlvJsapi(c: Context, orderId: string, miniUser: { miniUserId: string; openid: string }): Promise<Response> {
  try {
    const order = await loadWenlvOrder(orderId, miniUser.miniUserId);
    // 文旅平台统一收款，统一平台子商户号（不分账、不按门店进件）
    const subMchid = requireEnv('WXPAY_SUB_MCHID');

    // 应付金额（分）：文旅订单 totalAmount 为元（decimal string mode），复用文旅独立测试金额开关便于小额联调
    const amountFen = wenlvAmountFen(Math.round(Number(order.totalAmount) * 100));
    if (!Number.isFinite(amountFen) || amountFen <= 0) {
      throw new PayError(400, '订单金额无效');
    }

    // 幂等：同订单复用未支付支付单，金额不一致则关旧建新（与 pay-product/pay.ts 一致）
    let payment: typeof pmsBuiMiniPayments.$inferSelect | undefined = (await db.select().from(pmsBuiMiniPayments)
      .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
    if (payment && payment.amount !== amountFen) {
      await db.update(pmsBuiMiniPayments).set({ status: 'closed', updatedAt: new Date() })
        .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));
      try {
        await closeOrder(subMchid, payment.outTradeNo);
      } catch (err) {
        console.error('[wenlv-pay] 微信关单失败（不阻塞新单）', payment.outTradeNo, err);
      }
      payment = undefined;
    }
    if (!payment) {
      [payment] = await db.insert(pmsBuiMiniPayments).values({
        id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        merchantId: 'default',
        storeId: 'platform', // 文旅平台统一收款，无具体门店（store_id notNull 需占位）
        orderId: order.id,
        orderNo: order.orderNo,
        outTradeNo: `${order.orderNo}T${Date.now().toString().slice(-6)}`,
        amount: amountFen,
      }).onConflictDoNothing().returning();
      if (!payment) {
        [payment] = await db.select().from(pmsBuiMiniPayments)
          .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1);
      }
      if (!payment) throw new PayError(500, '支付单创建失败，请重试');
    }

    const prepayId = await jsapiPartnerOrder({
      subMchid,
      description: order.productName || '文旅门票',
      outTradeNo: payment.outTradeNo,
      amountFen: payment.amount,
      openid: miniUser.openid,
      timeExpire: order.payDeadline ? toRfc3339Cst(new Date(order.payDeadline)) : undefined,
    });

    const payParams = buildMiniPayParams(requireEnv('WX_MINI_APPID'), prepayId, getWxpayPrivateKey());
    return c.json({ success: true, data: payParams });
  } catch (e: any) {
    if (e instanceof PayError) return c.json({ success: false, error: e.message }, e.status);
    console.error('[wenlv-pay] 微信下单失败', orderId, e);
    return serverError(c, e, '下单失败');
  }
}
