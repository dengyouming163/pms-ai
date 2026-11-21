import crypto from 'node:crypto';
import fs from 'node:fs';
import { requireEnv } from '../constants.js';

const WXPAY_BASE = 'https://api.mch.weixin.qq.com';

// ---------- 纯函数（可单测） ----------

/** 构造 APIv3 待签名报文 */
export function buildSignMessage(method: string, urlPath: string, timestamp: number, nonce: string, body: string): string {
  return `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

/** SHA256withRSA 签名，返回 base64 */
export function signWithRsa(message: string, privateKeyPem: string): string {
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKeyPem, 'base64');
}

/** 构造 Authorization 请求头 */
export function buildAuthHeader(
  method: string,
  urlPath: string,
  body: string,
  cred: { mchid: string; serialNo: string; privateKey: string },
): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signWithRsa(buildSignMessage(method, urlPath, timestamp, nonce, body), cred.privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${cred.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${cred.serialNo}"`;
}

/** 解密回调 resource（AES-256-GCM，authTag 为密文末 16 字节） */
export function decryptNotifyResource(
  apiV3Key: string,
  resource: { ciphertext: string; nonce: string; associated_data?: string },
): any {
  const buf = Buffer.from(resource.ciphertext, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', apiV3Key, resource.nonce);
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 生成小程序 wx.requestPayment 调起参数 */
export function buildMiniPayParams(appid: string, prepayId: string, privateKeyPem: string) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const pkg = `prepay_id=${prepayId}`;
  const paySign = signWithRsa(`${appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`, privateKeyPem);
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA' as const, paySign };
}

/**
 * 测试金额（分）的**唯一**实现处。
 *
 * **生产恒返回 null** ⇒ 调用方一律回落真实金额。这条纪律不是新立的：
 * 姊妹实现 `services/wenlv-pay.ts` 的 `wenlvAmountFen` 一直有这道闸，
 * 本文件的另外两个开关此前漏了（2026-09-20 收尾迭代补）。
 *
 * 为什么必须有：这两个 env 是「联调期把金额压到 1 分钱」的开关，
 * 一旦生产被置成正整数而无人察觉，**全部订单会按该分值收款**，且没有任何信号。
 * 生产现状（2026-09-20 实测）是「存在但为空」，故加闸零行为变更。
 *
 * 生产仍会**出声告警**：静默忽略等于把一处误配置藏起来，
 * 而「配置了却不生效」正是最难查的一类故障。
 */
function testAmountFen(envKey: string): number | null {
  const raw = Number(process.env[envKey] || '0');
  const positive = Number.isFinite(raw) && raw > 0;
  if (process.env.NODE_ENV === 'production') {
    // 只在**真的配了正整数**时告警：生产现状是空串，不该每次支付都刷一行噪音。
    if (positive) {
      console.warn(
        `[wechat-pay] ${envKey}=${raw} 在生产被忽略（测试金额开关在生产恒不生效，本单按真实金额收款）`,
      );
    }
    return null;
  }
  return positive ? raw : null;
}

/** 测试模式金额（分）：`WXPAY_TEST_AMOUNT_FEN` 为正整数时强制所有支付金额为该分值。
 *  **生产恒不生效**（见 `testAmountFen`）。 */
export function effectiveAmountFen(realFen: number): number {
  return testAmountFen('WXPAY_TEST_AMOUNT_FEN') ?? realFen;
}

/** 套餐订单测试金额（分）：`PRODUCT_PAY_TEST_AMOUNT_FEN` 为正整数时强制套餐订单支付该分值。
 *  仅套餐路径生效（pay-product 调用），房间订单仍走 `WXPAY_TEST_AMOUNT_FEN`。
 *  **生产恒不生效**（见 `testAmountFen`）。 */
export function effectiveProductAmountFen(realFen: number): number {
  return testAmountFen('PRODUCT_PAY_TEST_AMOUNT_FEN') ?? realFen;
}

/** Date → RFC3339 东八区格式（如 2026-07-15T18:30:00+08:00）。微信 time_expire 要求带时区偏移 */
export function toRfc3339Cst(date: Date): string {
  const cst = new Date(date.getTime() + 8 * 3600 * 1000);
  return cst.toISOString().slice(0, 19) + '+08:00';
}

// ---------- API 调用（薄封装） ----------

/** 微信支付 API 业务错误（带 HTTP 状态码与业务 code，供调用方区分明确拒绝与网络异常） */
export class WxpayApiError extends Error {
  constructor(public status: number, public code: string, wxMessage: string) {
    super(`微信支付接口错误 [${status}] ${code}: ${wxMessage}`);
    this.name = 'WxpayApiError';
  }
}

/**
 * 读取 PEM 密钥：优先从文件读取（Docker 挂载的 certs 目录），
 * 文件不存在时回退到环境变量（开发环境 / .env 兼容）
 */
function readPem(envKey: string, filePath: string): string {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch {}
  // 回退：环境变量——.env 中 \n 转义存储，还原为真实换行
  return (process.env[envKey] || '').replace(/\\n/g, '\n');
}

/** 商户 API 私钥：优先容器挂载文件（/app/certs/apiclient_key.pem），回退 env 内联 PEM。
 *  供 buildMiniPayParams 等直接拿 key 的场景使用（不能用 requireEnv 取路径字符串当密钥）。 */
export function getWxpayPrivateKey(): string {
  return readPem('WXPAY_PRIVATE_KEY', '/app/certs/apiclient_key.pem');
}

function creds() {
  return {
    mchid: requireEnv('WXPAY_SP_MCHID'),
    serialNo: requireEnv('WXPAY_CERT_SERIAL'),
    privateKey: readPem('WXPAY_PRIVATE_KEY', '/app/certs/apiclient_key.pem'),
  };
}

async function wxpayRequest(method: 'GET' | 'POST', urlPath: string, body?: object): Promise<any> {
  const bodyStr = body ? JSON.stringify(body) : '';
  const auth = buildAuthHeader(method, urlPath, bodyStr, creds());
  const res = await fetch(`${WXPAY_BASE}${urlPath}`, {
    method,
    headers: {
      'Authorization': auth,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'pms-server/1.0',
    },
    body: body ? bodyStr : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WxpayApiError(res.status, (data as any).code || '', (data as any).message || '');
  }
  return data;
}

/** 服务商模式 JSAPI 下单（小程序或公众号），返回 prepay_id。
 *  公众号场景传 subAppid=公众号appid + subOpenid=公众号openid（payer 用 sub_openid）；
 *  小程序场景仅传 openid（payer 用 sp_openid）。 */
export async function jsapiPartnerOrder(params: {
  subMchid: string;
  description: string;
  outTradeNo: string;
  amountFen: number;
  openid: string;
  timeExpire?: string; // RFC3339
  subAppid?: string;
  subOpenid?: string;
}): Promise<string> {
  if (!!params.subAppid !== !!params.subOpenid) {
    throw new Error('subAppid 与 subOpenid 必须成对传递（公众号场景）');
  }
  const spAppid = requireEnv('WX_MINI_APPID');
  const payer = params.subOpenid ? { sub_openid: params.subOpenid } : { sp_openid: params.openid };
  const data = await wxpayRequest('POST', '/v3/pay/partner/transactions/jsapi', {
    sp_appid: spAppid,
    sp_mchid: requireEnv('WXPAY_SP_MCHID'),
    sub_mchid: params.subMchid,
    ...(params.subAppid ? { sub_appid: params.subAppid } : {}),
    description: params.description,
    out_trade_no: params.outTradeNo,
    time_expire: params.timeExpire,
    notify_url: `${requireEnv('WXPAY_NOTIFY_BASE')}/api/mini/pay/notify`,
    amount: { total: params.amountFen, currency: 'CNY' },
    payer,
  });
  return data.prepay_id as string;
}

/** 服务商模式 H5 支付下单（普通浏览器），返回 mweb_url */
export async function mwebPartnerOrder(params: {
  subMchid: string;
  description: string;
  outTradeNo: string;
  amountFen: number;
  timeExpire?: string; // RFC3339
  clientIp?: string;
}): Promise<{ mwebUrl: string }> {
  const spAppid = requireEnv('WX_MINI_APPID');
  const data = await wxpayRequest('POST', '/v3/pay/partner/transactions/h5', {
    sp_appid: spAppid,
    sp_mchid: requireEnv('WXPAY_SP_MCHID'),
    sub_mchid: params.subMchid,
    description: params.description,
    out_trade_no: params.outTradeNo,
    time_expire: params.timeExpire,
    notify_url: `${requireEnv('WXPAY_NOTIFY_BASE')}/api/mini/pay/notify`,
    amount: { total: params.amountFen, currency: 'CNY' },
    scene_info: { payer_client_ip: params.clientIp || '127.0.0.1', h5_info: { type: 'Wap' } },
  });
  return { mwebUrl: (data as any).h5_url as string };
}

/** 申请退款（服务商模式） */
export async function refundOrder(params: {
  subMchid: string;
  outTradeNo: string;
  outRefundNo: string;
  refundFen: number;
  totalFen: number;
  reason?: string;
}): Promise<any> {
  return wxpayRequest('POST', '/v3/refund/domestic/refunds', {
    sub_mchid: params.subMchid,
    out_trade_no: params.outTradeNo,
    out_refund_no: params.outRefundNo,
    reason: params.reason,
    notify_url: `${requireEnv('WXPAY_NOTIFY_BASE')}/api/mini/pay/refund-notify`,
    amount: { refund: params.refundFen, total: params.totalFen, currency: 'CNY' },
  });
}

/** 关闭未支付订单（服务商模式）——本地关单时同步失效微信侧 prepay，防旧单被继续支付。
 *  成功返回 204 无 body（wxpayRequest 里 res.json().catch(() => ({})) 已兜底空 body） */
export async function closeOrder(subMchid: string, outTradeNo: string): Promise<void> {
  await wxpayRequest('POST', `/v3/pay/partner/transactions/out-trade-no/${outTradeNo}/close`, {
    sp_mchid: requireEnv('WXPAY_SP_MCHID'),
    sub_mchid: subMchid,
  });
}

/** 查询单笔退款（服务商模式）——退款申请结果不明（超时/异常）时用于消歧 */
export async function queryRefund(subMchid: string, outRefundNo: string): Promise<any> {
  return wxpayRequest('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}?sub_mchid=${subMchid}`);
}

// ---------- 回调验签（平台证书缓存） ----------

let certCache: { certs: Map<string, string>; expireAt: number } | null = null;

/** 下载并缓存微信支付平台证书（serial → 公钥 PEM） */
export async function getPlatformCerts(): Promise<Map<string, string>> {
  if (certCache && Date.now() < certCache.expireAt) return certCache.certs;
  const data = await wxpayRequest('GET', '/v3/certificates');
  const apiV3Key = requireEnv('WXPAY_APIV3_KEY');
  const certs = new Map<string, string>();
  for (const item of data.data || []) {
    // 平台证书的加密内容是 PEM 文本（非 JSON），不能走 decryptNotifyResource 的 JSON.parse，
    // 这里直接 AES-256-GCM 解密取 UTF-8 文本
    const res = item.encrypt_certificate as { ciphertext: string; nonce: string; associated_data?: string };
    const buf = Buffer.from(res.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', apiV3Key, res.nonce);
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    if (res.associated_data) decipher.setAAD(Buffer.from(res.associated_data));
    const pem = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8');
    const publicKey = crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }) as string;
    certs.set(item.serial_no, publicKey);
  }
  certCache = { certs, expireAt: Date.now() + 12 * 3600 * 1000 };
  return certs;
}

/** 强制刷新节流：伪造 serial 的恶意回调若每次都触发证书下载，会放大为对微信证书接口的 DoS */
let lastForceRefreshAt = 0;
const FORCE_REFRESH_INTERVAL_MS = 60 * 1000;

/** 验证回调签名（验签失败必须拒绝，防伪造回调） */
export async function verifyNotifySignature(headers: {
  serial: string; timestamp: string; nonce: string; signature: string;
}, body: string): Promise<boolean> {
  if (!headers.serial) return false; // 空 serial 必然验签失败，不值得触发刷新

  // 微信支付公钥模式（2024+ 新商户默认）：回调 Wechatpay-Serial 为 PUB_KEY_ID_xxx，
  // 此类商户无平台证书可下载（/v3/certificates 不可用），用商户平台下载的微信支付公钥本地验签
  if (headers.serial.startsWith('PUB_KEY_ID_')) {
    const pubKeyId = process.env.WXPAY_PUBLIC_KEY_ID || '';
    const pubKey = readPem('WXPAY_PUBLIC_KEY', '/app/certs/pub_key.pem');
    if (!pubKeyId || !pubKey || headers.serial !== pubKeyId) return false;
    const message = `${headers.timestamp}\n${headers.nonce}\n${body}\n`;
    return crypto.createVerify('RSA-SHA256').update(message).verify(pubKey, headers.signature, 'base64');
  }

  const certs = await getPlatformCerts();
  let publicKey = certs.get(headers.serial);
  if (!publicKey && Date.now() - lastForceRefreshAt > FORCE_REFRESH_INTERVAL_MS) {
    // 证书轮换场景：未命中强制刷新一次——微信轮换平台证书后，新证书签名的回调
    // 若仍用旧缓存（最长 12h）会被全部误拒，这里清缓存重新下载再查一次（60s 节流）
    lastForceRefreshAt = Date.now();
    certCache = null;
    const freshCerts = await getPlatformCerts();
    publicKey = freshCerts.get(headers.serial);
  }
  if (!publicKey) return false;
  const message = `${headers.timestamp}\n${headers.nonce}\n${body}\n`;
  return crypto.createVerify('RSA-SHA256').update(message).verify(publicKey, headers.signature, 'base64');
}
