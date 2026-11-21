import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { queryRefund, buildSignStr, verifyWithRsa } from './douyin-pay.js';

// 测试用 RSA 密钥对（与 wechat-pay.test 同法）
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

describe('queryRefund（抖音退款查询）', () => {
  beforeEach(() => {
    vi.stubEnv('TT_MINI_APPID', 'tt_test_appid');
    vi.stubEnv('DY_PAY_MERCHANT_ID', 'test_merchant');
    vi.stubEnv('DY_PAY_PRIVATE_KEY', privatePem.replace(/\n/g, '\\n'));
    vi.stubEnv('DY_PAY_PLATFORM_PUBLIC_KEY', publicPem.replace(/\n/g, '\\n'));
    vi.stubEnv('DY_PAY_ENV', 'sandbox');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('构造 query_refund 请求：路径含 query_refund、body 含 out_refund_no、签名可验', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ err_no: 0, data: { refund_status: 'SUCCESS' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await queryRefund('RFMINI123');
    expect(result.data.refund_status).toBe('SUCCESS');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/apps/ecpay/v1/query_refund');
    const body = JSON.parse(String(init.body));
    expect(body.out_refund_no).toBe('RFMINI123');
    expect(body.app_id).toBe('tt_test_appid');
    expect(verifyWithRsa(buildSignStr(body), body.sign, publicPem)).toBe(true);
  });

  it('err_no !== 0 → 抛 DyPayApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ err_no: 1, err_tips: 'not found' }),
    }));
    await expect(queryRefund('RFMINI123')).rejects.toThrow(/抖音支付接口错误/);
  });
});
