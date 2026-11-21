import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiMiniPayments } from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import {
  jsapiPartnerOrder, buildMiniPayParams, closeOrder, toRfc3339Cst, effectiveProductAmountFen, getWxpayPrivateKey,
} from '../../services/wechat-pay.js';
import { createOrder as dyCreateOrder } from '../../services/douyin-pay.js';
import { requireEnv } from '../../constants.js';
import { getPlatformProductOrder } from '../../services/platform-client.js';
import { HttpError, serverError } from '../../lib/http-error.js';

// ============================================================
// 套餐订单（platform product-order，po_ 前缀）支付单创建
// 复用 pmsBuiMiniPayments 支付单（orderId=平台订单 id, orderNo=平台订单号），
// 订单信息（金额/描述/门店）通过平台内部接口获取，服务端取价，不信任客户端。
// 主入口在 mini/product-orders.ts 代理（POST /api/mini/product-orders/:id/pay），
// 本路由同时暴露 /jsapi、/dy-jsapi 供直连调用。
// ============================================================

const route = new Hono();

const jsapiSchema = z.object({ orderId: z.string().min(1) });

/** 业务错误（带 HTTP 状态码，限定为可作 c.json 状态码的合法字面量） */
export class PayError extends HttpError {
  // 收窄回原有字面量联合类型，保持本文件内 c.json(..., e.status) 的类型不变
  declare status: 400 | 404 | 500 | 502;
  constructor(status: 400 | 404 | 500 | 502, message: string) {
    super(status, message);
    this.name = 'PayError';
  }
}

/** 从平台内部接口拉取套餐订单并做通用校验（归属/状态/超时），返回订单对象 */
async function loadPlatformOrder(c: Context, orderId: string): Promise<any> {
  const miniUser = getMiniUser(c);
  const res = await getPlatformProductOrder(orderId);
  if (!res.ok) {
    throw new PayError(res.status === 404 ? 404 : 502, res.data?.error || '订单服务不可用');
  }
  const order = res.data?.data;
  if (!order) throw new PayError(404, '订单不存在');
  if (order.miniUserId !== miniUser.miniUserId) throw new PayError(404, '订单不存在'); // 不泄露他人订单
  if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
    throw new PayError(400, '订单状态不可支付');
  }
  if (order.payDeadline && new Date(order.payDeadline).getTime() < Date.now()) {
    throw new PayError(400, '订单已超时，请重新下单');
  }
  return order;
}

/** 应付金额（分）：模式A 付订金，模式B 付全款。
 *  套餐专用测试金额 PRODUCT_PAY_TEST_AMOUNT_FEN 生效时强制该分值（如 1=1分钱），仅套餐路径；
 *  0 分支付单微信/抖音会拒收，模式A 订金缺失/为 0 时抛 400「订金金额无效」，全款同理防 0 分。 */
function payableFen(order: any): number {
  const yuan = (order.mode === 'A' && order.depositAmount != null)
    ? Number(order.depositAmount)
    : Number(order.totalAmount);
  const fen = effectiveProductAmountFen(Math.round(yuan * 100));
  if (!Number.isFinite(fen) || fen <= 0) {
    throw new PayError(400, order.mode === 'A' ? '订金金额无效' : '订单金额无效');
  }
  return fen;
}

// ==================== 微信 JSAPI 下单 ====================
export async function handleProductJsapi(c: Context, orderId: string): Promise<Response> {
  try {
    const miniUser = getMiniUser(c);
    const order = await loadPlatformOrder(c, orderId);

    // 平台套餐订单统一使用平台子商户号（不再按门店进件查 sub_mchid）
    const subMchid = requireEnv('WXPAY_SUB_MCHID');

    const amountFen = payableFen(order);

    // 幂等：同订单复用未支付的支付单，金额不一致则关旧建新（与 mini/pay.ts 一致）
    let payment: typeof pmsBuiMiniPayments.$inferSelect | undefined = (await db.select().from(pmsBuiMiniPayments)
      .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
    if (payment && payment.amount !== amountFen) {
      await db.update(pmsBuiMiniPayments).set({ status: 'closed', updatedAt: new Date() })
        .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));
      try {
        await closeOrder(subMchid, payment.outTradeNo);
      } catch (err) {
        console.error('[pay-product] 微信关单失败（不阻塞新单）', payment.outTradeNo, err);
      }
      payment = undefined;
    }
    if (!payment) {
      [payment] = await db.insert(pmsBuiMiniPayments).values({
        id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        merchantId: order.merchantId || 'default',
        storeId: order.storeId,
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
      description: order.productName || '平台套餐',
      outTradeNo: payment.outTradeNo,
      amountFen: payment.amount,
      openid: miniUser.openid,
      timeExpire: order.payDeadline ? toRfc3339Cst(new Date(order.payDeadline)) : undefined,
    });

    const payParams = buildMiniPayParams(
      requireEnv('WX_MINI_APPID'), prepayId, getWxpayPrivateKey(),
    );
    return c.json({ success: true, data: payParams });
  } catch (e: any) {
    if (e instanceof PayError) return c.json({ success: false, error: e.message }, e.status);
    console.error('[pay-product] 微信下单失败', orderId, e);
    return serverError(c, e, '下单失败');
  }
}

// ==================== 抖音 JSAPI 下单（直连单商户） ====================
export async function handleProductDyJsapi(c: Context, orderId: string): Promise<Response> {
  try {
    const miniUser = getMiniUser(c);
    const order = await loadPlatformOrder(c, orderId);
    const amountFen = payableFen(order);

    let payment: typeof pmsBuiMiniPayments.$inferSelect | undefined = (await db.select().from(pmsBuiMiniPayments)
      .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
    if (payment && payment.amount !== amountFen) {
      await db.update(pmsBuiMiniPayments).set({ status: 'closed', updatedAt: new Date() })
        .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));
      payment = undefined;
    }
    if (!payment) {
      [payment] = await db.insert(pmsBuiMiniPayments).values({
        id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        merchantId: order.merchantId || 'default',
        storeId: order.storeId,
        orderId: order.id,
        orderNo: order.orderNo,
        channel: 'douyin',
        outTradeNo: `${order.orderNo}D${Date.now().toString().slice(-6)}`,
        amount: amountFen,
      }).onConflictDoNothing().returning();
      if (!payment) {
        [payment] = await db.select().from(pmsBuiMiniPayments)
          .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1);
      }
      if (!payment) throw new PayError(500, '支付单创建失败，请重试');
    }

    const description = order.productName || '平台套餐';
    const dyPayParams = await dyCreateOrder({
      outOrderNo: payment.outTradeNo,
      totalAmountFen: payment.amount,
      subject: description,
      body: description,
      notifyUrl: `${requireEnv('DY_PAY_NOTIFY_BASE')}/api/mini/pay/dy-notify`,
      payerUid: miniUser.openid,
    });
    return c.json({ success: true, data: dyPayParams });
  } catch (e: any) {
    if (e instanceof PayError) return c.json({ success: false, error: e.message }, e.status);
    console.error('[pay-product] 抖音下单失败', orderId, e);
    return serverError(c, e, '下单失败', 502);
  }
}

// ==================== 路由（直连入口，主入口在 mini/product-orders 代理） ====================
route.post('/jsapi', async (c) => {
  const parsed = jsapiSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);
  return handleProductJsapi(c, parsed.data.orderId);
});

route.post('/dy-jsapi', async (c) => {
  const parsed = jsapiSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);
  return handleProductDyJsapi(c, parsed.data.orderId);
});

export default route;
