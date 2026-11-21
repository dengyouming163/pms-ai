/**
 * 阿里云短信服务 — 短信验证码发送
 * 使用 REST API + HMAC-SHA1 签名（与现有 aliyun 服务模式一致）
 */
import crypto from 'crypto';

const ACCESS_KEY = process.env.ALIYUN_ACCESS_KEY_ID || '';
const SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';

/** 短信签名（阿里云控制台已审核通过） */
const SMS_SIGN_NAME = process.env.SMS_SIGN_NAME || '贵州康乐谷数字科技';

/** 验证码模板 Code */
const SMS_TEMPLATE_CODE = process.env.SMS_TEMPLATE_CODE || 'SMS_477500027';

const SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com';

/** 生成 HMAC-SHA1 签名 */
function rpcSign(method: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const query = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signStr = `${method}&${encodeURIComponent('/')}&${encodeURIComponent(query)}`;
  return crypto.createHmac('sha1', `${SECRET}&`).update(signStr).digest('base64');
}

/** 发送短信验证码 */
export async function sendSmsCode(phone: string, code: string): Promise<void> {
  if (!ACCESS_KEY || !SECRET) {
    throw new Error('未配置 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET');
  }

  const nonce = `${Date.now()}${Math.random().toString(36).slice(2, 10)}`;

  const params: Record<string, string> = {
    AccessKeyId: ACCESS_KEY,
    Action: 'SendSms',
    Format: 'JSON',
    OutId: '',
    PhoneNumbers: phone,
    SignName: SMS_SIGN_NAME,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: nonce,
    SignatureVersion: '1.0',
    TemplateCode: SMS_TEMPLATE_CODE,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };

  params.Signature = rpcSign('POST', params);

  const body = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');

  const res = await fetch(SMS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await res.json() as any;
  if (json.Code !== 'OK') {
    throw new Error(json.Message || '短信发送失败');
  }

  console.log(`[SMS] API响应: Code=${json.Code} Message=${json.Message} BizId=${json.BizId}`);
  if (json.Code === 'OK') {
    console.log(`[SMS] 验证码发送成功 ${phone.slice(0, 3)}****${phone.slice(-4)}`);
  }
}
