import crypto from 'node:crypto';
import { requireEnv } from '../constants.js';

// 抖音支付（直连单商户模式）服务
// ⚠️ 资金代码：商户号申请到位后，必须先在沙箱环境用官方 DEMO 逐字段核对
//    签名串拼接规则与 create_order/notify 字段名，再切换到生产。
//    当前实现基于公开文档，标注了所有「联调核对点」。

/** 支付环境：sandbox=沙箱（open-sandbox.douyin.com）/ 默认=生产（developer.toutiao.com） */
export function dyPayBase(): string {
  return process.env.DY_PAY_ENV === 'sandbox'
    ? 'https://open-sandbox.douyin.com'
    : 'https://developer.toutiao.com';
}

/** 直连单商户配置（凭据全部来自环境变量，缺失即启动失败） */
export function dyPayConfig() {
  return {
    appId: requireEnv('TT_MINI_APPID'),
    merchantId: requireEnv('DY_PAY_MERCHANT_ID'),
    privateKey: requireEnv('DY_PAY_PRIVATE_KEY').replace(/\\n/g, '\n'),
    platformPublicKey: requireEnv('DY_PAY_PLATFORM_PUBLIC_KEY').replace(/\\n/g, '\n'),
  };
}

/** SHA256withRSA 签名，返回 base64 */
export function signWithRsa(message: string, privateKeyPem: string): string {
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKeyPem, 'base64');
}

/** 用平台公钥验签（回调/响应），验签失败返回 false，不抛异常 */
export function verifyWithRsa(message: string, signature: string, publicKeyPem: string): boolean {
  try {
    return crypto.createVerify('RSA-SHA256').update(message).verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * 抖音支付签名串：参数名 ASCII 升序，key=value 用 & 拼接；
 * 空值/未定义参数不参与签名。
 * ⚠️ 联调核对点：不同渠道/版本资料对「排除字段」有差异——sign 必排除；
 *    部分文档要求同时排除 cp_tp；本实现将排除字段集中在此，便于联调时调整。
 */
export function buildSignStr(params: Record<string, string | number>, excludeKeys: string[] = ['sign', 'cp_tp']): string {
  return Object.keys(params)
    .filter((k) => !excludeKeys.includes(k) && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/** 抖音支付接口业务错误 */
export class DyPayApiError extends Error {
  constructor(public errNo: number, dyMessage: string) {
    super(`抖音支付接口错误 [${errNo}]: ${dyMessage}`);
    this.name = 'DyPayApiError';
  }
}

/** 退款被明确拒绝/退款单不存在的错误码白名单（沙箱联调确认后填写）。
 *  空清单 = 保守不判定拒绝（状态不明 → 保持退款中待对账），避免误回滚在途退款。 */
export const DY_REFUND_REJECTED_ERRNOS: number[] = [];

async function dyRequest(path: string, body: Record<string, string | number>): Promise<any> {
  const res = await fetch(`${dyPayBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.err_no !== 0) {
    throw new DyPayApiError(data.err_no, data.err_tips || data.err_msg || '');
  }
  return data;
}

export interface DyCreateOrderParams {
  outOrderNo: string;
  totalAmountFen: number;
  subject: string;
  body: string;
  validTime?: number;   // 秒
  notifyUrl: string;
  payerUid?: string;    // 抖音 openid（pay 时用于标识支付用户）
}

/**
 * 统一下单 → 返回前端 tt.requestPayment 调起参数。
 * ⚠️ 联调核对点：字段名（out_order_no/total_amount/payer_uid 等）与
 *    返回 data 结构（order_id / order_param 或 order_token）以沙箱实测为准。
 */
export async function createOrder(params: DyCreateOrderParams): Promise<{
  app_id: string;
  merchant_id: string;
  order_id: string;
  order_param: string;
}> {
  const cfg = dyPayConfig();
  const body: Record<string, string | number> = {
    app_id: cfg.appId,
    merchant_id: cfg.merchantId,
    out_order_no: params.outOrderNo,
    total_amount: params.totalAmountFen,
    subject: params.subject,
    body: params.body,
    valid_time: params.validTime || 900,
    notify_url: params.notifyUrl,
    timestamp: Math.floor(Date.now() / 1000),
    nonce_str: crypto.randomBytes(16).toString('hex'),
  };
  if (params.payerUid) body.payer_uid = params.payerUid;
  body.sign = signWithRsa(buildSignStr(body), cfg.privateKey);

  const data = await dyRequest('/api/apps/ecpay/v1/create_order', body);
  const d = data.data || {};
  if (!d.order_id) throw new DyPayApiError(data.err_no, '响应缺少 order_id');
  // 前端 tt.requestPayment 需要 app_id / merchant_id / order_id / order_param
  return {
    app_id: cfg.appId,
    merchant_id: cfg.merchantId,
    order_id: d.order_id,
    order_param: d.order_param || d.order_token || '',
  };
}

export interface DyRefundParams {
  outOrderNo: string;
  outRefundNo: string;
  refundAmountFen: number;
  refundReason?: string;
  notifyUrl: string;
}

/** 申请退款（直连单商户） */
export async function createRefund(params: DyRefundParams): Promise<any> {
  const cfg = dyPayConfig();
  const body: Record<string, string | number> = {
    app_id: cfg.appId,
    merchant_id: cfg.merchantId,
    out_order_no: params.outOrderNo,
    out_refund_no: params.outRefundNo,
    refund_amount: params.refundAmountFen,
    refund_reason: params.refundReason || '用户取消订单',
    notify_url: params.notifyUrl,
    timestamp: Math.floor(Date.now() / 1000),
    nonce_str: crypto.randomBytes(16).toString('hex'),
  };
  body.sign = signWithRsa(buildSignStr(body), cfg.privateKey);
  return dyRequest('/api/apps/ecpay/v1/create_refund', body);
}

/**
 * 支付/退款回调验签。
 * 抖音回调将业务字段与 sign 一并 POST 过来；验签用平台公钥，
 * 排除 sign（及 cp_tp）。⚠️ 联调核对点：排除字段清单与拼接规则以沙箱实测为准。
 */
export function verifyNotify(params: Record<string, string | number>): boolean {
  const cfg = dyPayConfig();
  const signature = params.sign as string | undefined;
  if (!signature) return false;
  return verifyWithRsa(buildSignStr(params), signature, cfg.platformPublicKey);
}

/** 查询退款单（直连单商户）。返回完整响应信封 { err_no, data }（退款单字段在 data 内）；
 *  业务失败抛 DyPayApiError。⚠️ 联调核对点：接口路径（query_refund）与响应字段（refund_status 等）以沙箱实测为准。 */
export async function queryRefund(outRefundNo: string): Promise<any> {
  const cfg = dyPayConfig();
  const body: Record<string, string | number> = {
    app_id: cfg.appId,
    merchant_id: cfg.merchantId,
    out_refund_no: outRefundNo,
    timestamp: Math.floor(Date.now() / 1000),
    nonce_str: crypto.randomBytes(16).toString('hex'),
  };
  body.sign = signWithRsa(buildSignStr(body), cfg.privateKey);
  return dyRequest('/api/apps/ecpay/v1/query_refund', body);
}
