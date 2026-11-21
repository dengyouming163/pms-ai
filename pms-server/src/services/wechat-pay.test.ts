import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { buildSignMessage, signWithRsa, buildAuthHeader, decryptNotifyResource, buildMiniPayParams, toRfc3339Cst, effectiveProductAmountFen } from './wechat-pay.js';

// 测试用 RSA 密钥对
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

describe('buildSignMessage', () => {
  it('按 APIv3 规范拼接：方法\\n路径\\n时间戳\\n随机串\\n报文\\n', () => {
    const msg = buildSignMessage('POST', '/v3/pay/partner/transactions/jsapi', 1700000000, 'nonce123', '{"a":1}');
    expect(msg).toBe('POST\n/v3/pay/partner/transactions/jsapi\n1700000000\nnonce123\n{"a":1}\n');
  });
});

describe('signWithRsa', () => {
  it('SHA256withRSA 签名可用公钥验证', () => {
    const message = 'hello\nworld\n';
    const signature = signWithRsa(message, privatePem);
    const ok = crypto.createVerify('RSA-SHA256').update(message).verify(publicKey, signature, 'base64');
    expect(ok).toBe(true);
  });
});

describe('buildAuthHeader', () => {
  it('包含 mchid/nonce_str/signature/timestamp/serial_no 五要素', () => {
    const header = buildAuthHeader('GET', '/v3/certificates', '', {
      mchid: '1900000001', serialNo: 'SERIAL1', privateKey: privatePem,
    });
    expect(header).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
    expect(header).toContain('mchid="1900000001"');
    expect(header).toContain('serial_no="SERIAL1"');
    expect(header).toMatch(/signature="[A-Za-z0-9+/=]+"/);
  });
});

describe('decryptNotifyResource', () => {
  it('AES-256-GCM 解密回调资源', () => {
    const apiV3Key = '0123456789abcdef0123456789abcdef'; // 32字节
    const plaintext = JSON.stringify({ out_trade_no: 'MINI123', trade_state: 'SUCCESS' });
    const nonce = 'abcdef123456';
    const aad = 'transaction';
    const cipher = crypto.createCipheriv('aes-256-gcm', apiV3Key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const result = decryptNotifyResource(apiV3Key, {
      ciphertext: encrypted.toString('base64'), nonce, associated_data: aad,
    });
    expect(result.out_trade_no).toBe('MINI123');
    expect(result.trade_state).toBe('SUCCESS');
  });
});

describe('buildMiniPayParams', () => {
  it('生成小程序调起支付五参数且签名可验', () => {
    const params = buildMiniPayParams('wxappid123', 'prepay_id_xyz', privatePem);
    expect(params.package).toBe('prepay_id=prepay_id_xyz');
    expect(params.signType).toBe('RSA');
    const message = `wxappid123\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
    const ok = crypto.createVerify('RSA-SHA256').update(message).verify(publicKey, params.paySign, 'base64');
    expect(ok).toBe(true);
  });
});

describe('toRfc3339Cst', () => {
  it('UTC 时间转为东八区 RFC3339 带 +08:00 时区（跨日进位）', () => {
    expect(toRfc3339Cst(new Date('2026-07-15T18:30:00.000Z'))).toBe('2026-07-16T02:30:00+08:00');
  });
  it('毫秒被截断，输出秒级精度', () => {
    expect(toRfc3339Cst(new Date('2026-01-01T00:00:00.987Z'))).toBe('2026-01-01T08:00:00+08:00');
  });
});

describe('verifyNotifySignature 公钥模式', () => {
  it('PUB_KEY_ID serial 用本地公钥验签成功', async () => {
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    process.env.WXPAY_PUBLIC_KEY_ID = 'PUB_KEY_ID_TEST123';
    process.env.WXPAY_PUBLIC_KEY = pubPem.replace(/\n/g, '\n');
    const { verifyNotifySignature } = await import('./wechat-pay.js');
    const timestamp = '1700000000'; const nonce = 'n1'; const body = '{"a":1}';
    const message = `${timestamp}\n${nonce}\n${body}\n`;
    const signature = crypto.createSign('RSA-SHA256').update(message).sign(privatePem, 'base64');
    expect(await verifyNotifySignature({ serial: 'PUB_KEY_ID_TEST123', timestamp, nonce, signature }, body)).toBe(true);
    // serial 不匹配 → 拒绝
    expect(await verifyNotifySignature({ serial: 'PUB_KEY_ID_OTHER', timestamp, nonce, signature }, body)).toBe(false);
  });
});

describe('effectiveProductAmountFen（套餐测试金额）', () => {
  it('未配置 PRODUCT_PAY_TEST_AMOUNT_FEN → 用真实金额', () => {
    const before = process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
    delete process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
    try { expect(effectiveProductAmountFen(128000)).toBe(128000); }
    finally {
      if (before === undefined) delete process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
      else process.env.PRODUCT_PAY_TEST_AMOUNT_FEN = before;
    }
  });
  it('配置为 1 → 强制 1 分', () => {
    const before = process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
    process.env.PRODUCT_PAY_TEST_AMOUNT_FEN = '1';
    try { expect(effectiveProductAmountFen(128000)).toBe(1); }
    finally {
      if (before === undefined) delete process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
      else process.env.PRODUCT_PAY_TEST_AMOUNT_FEN = before;
    }
  });
  it('配置为 0 → 用真实金额', () => {
    const before = process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
    process.env.PRODUCT_PAY_TEST_AMOUNT_FEN = '0';
    try { expect(effectiveProductAmountFen(128000)).toBe(128000); }
    finally {
      if (before === undefined) delete process.env.PRODUCT_PAY_TEST_AMOUNT_FEN;
      else process.env.PRODUCT_PAY_TEST_AMOUNT_FEN = before;
    }
  });
});
