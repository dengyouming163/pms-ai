import { Hono } from 'hono';
import { z } from 'zod';
import { getMiniUser } from '../../middleware/mini-auth.js';
import {
  jsapiPartnerOrder, mwebPartnerOrder, buildMiniPayParams, toRfc3339Cst, getWxpayPrivateKey,
} from '../../services/wechat-pay.js';
import { buildJsSdkConfig } from '../../services/wechat-mp.js';
import { requireEnv } from '../../constants.js';
import { resolveOrderPayment, PayOrderError } from '../../services/pay-order.js';
import { serverError } from '../../lib/http-error.js';

// ============================================================
// H5 支付路由（Task 11）— 房间订单（pmsBuiOrders）与套餐订单（po_）均可支付
//   1. /wxmp-jsapi   公众号 JSAPI（服务号内微信浏览器，platform=wx_mp）
//        wx.chooseWXPay 调起：prepay_id + RSA paySign（appId=公众号 appid）
//   2. /h5-mweb      普通浏览器 H5（MWEB 拉起，返回 h5_url 供前端跳转）
//   3. /jssdk-config 公众号 JSSDK config（wx.chooseWXPay 前置 wx.config 签名）
// 取价/支付单创建统一走 services/pay-order.ts（服务端取价，不信任客户端）。
// 回调统一复用 /api/mini/pay/notify（按 out_trade_no 幂等，与小程序 JSAPI 一致）。
// ⚠️ 公众号 sub_appid 绑定与 paySign 签名正确性需在阶段2 联调核对（已登记在支付配置说明.md）。
// ============================================================

const route = new Hono();
const jsapiSchema = z.object({ orderId: z.string().min(1) });

/** 兼容取订单超时时间：房间订单 otaTimeout(Date)，套餐订单 payDeadline(string/Date)；无效时间回退 undefined */
export function parseOrderTimeout(order: any): Date | undefined {
  const t = order?.otaTimeout || order?.payDeadline;
  if (!t) return undefined;
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// 公众号 JSAPI（服务号内微信浏览器，platform=wx_mp）
route.post('/wxmp-jsapi', async (c) => {
  let orderId = '';
  try {
    const parsed = jsapiSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);
    orderId = parsed.data.orderId;

    const miniUser = getMiniUser(c);
    if (miniUser.platform !== 'wx_mp' || !miniUser.openid) {
      // 记录平台错位（支付失败排查关键日志：h5/小程序 token 请求公众号 JSAPI）
      console.warn('[pay-h5] 非 wx_mp 平台请求公众号 JSAPI', {
        platform: miniUser.platform,
        miniUserId: miniUser.miniUserId,
        orderId,
      });
      return c.json({ success: false, error: '请先通过服务号登录' }, 400);
    }

    const { order, payment, amountFen, subMchid } = await resolveOrderPayment(c, orderId, { channel: 'wx' });
    const timeout = parseOrderTimeout(order);
    const prepayId = await jsapiPartnerOrder({
      subMchid,
      description: (order.roomType || order.productName || '住宿') + '',
      outTradeNo: payment.outTradeNo,
      amountFen,
      openid: miniUser.openid,
      // 公众号场景：subAppid=公众号 appid + subOpenid=公众号 openid（payer 用 sub_openid）
      subAppid: requireEnv('WX_MP_APPID'),
      subOpenid: miniUser.openid,
      timeExpire: timeout ? toRfc3339Cst(timeout) : undefined,
    });

    // 公众号 wx.chooseWXPay 调起参数：RSA 签名，appId=公众号 appid（参与支付验签，须随 paySign 一并返回给前端透传）
    const appId = requireEnv('WX_MP_APPID');
    const payParams = buildMiniPayParams(appId, prepayId, getWxpayPrivateKey());
    return c.json({ success: true, data: { appId, ...payParams } });
  } catch (e: any) {
    if (e instanceof PayOrderError) return c.json({ success: false, error: e.message }, e.status);
    console.error('[pay-h5] 公众号 JSAPI 下单失败', orderId, e);
    return serverError(c, e, '下单失败');
  }
});

// 普通浏览器 H5（MWEB 拉起）
route.post('/h5-mweb', async (c) => {
  let orderId = '';
  try {
    const parsed = jsapiSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);
    orderId = parsed.data.orderId;

    const { order, payment, amountFen, subMchid } = await resolveOrderPayment(c, orderId, { channel: 'wx' });
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || '127.0.0.1';
    const timeout = parseOrderTimeout(order);
    const { mwebUrl } = await mwebPartnerOrder({
      subMchid,
      description: (order.roomType || order.productName || '住宿') + '',
      outTradeNo: payment.outTradeNo,
      amountFen,
      clientIp: ip,
      timeExpire: timeout ? toRfc3339Cst(timeout) : undefined,
    });
    return c.json({ success: true, data: { mwebUrl } });
  } catch (e: any) {
    if (e instanceof PayOrderError) return c.json({ success: false, error: e.message }, e.status);
    console.error('[pay-h5] MWEB 下单失败', orderId, e);
    return serverError(c, e, '下单失败');
  }
});

// 公众号 JSSDK config（wx.chooseWXPay 前置 wx.config 签名，需登录后调用）
route.get('/jssdk-config', async (c) => {
  const url = c.req.query('url') || '';
  if (!url) return c.json({ success: false, error: '缺少 url 参数' }, 400);
  try {
    const config = await buildJsSdkConfig(url);
    return c.json({ success: true, data: config });
  } catch (e: any) {
    console.error('[pay-h5] JSSDK config 生成失败', url, e);
    return serverError(c, e, '签名失败', 502);
  }
});

export default route;
