// 端点级「未预期错误 ⇒ 通用文案 + 不泄漏原文」回归。
//
// 与 src/__tests__/no-raw-error-leak.test.ts 的分工：
//   那个文件是**静态闸**（扫源码文本，禁止 `c.json({ error: e.message })` 的写法）；
//   本文件是**端点闸** —— 真把请求打进去，断言响应体里回的是 fallback 而不是原始错误文案。
//   静态闸抓不到「serverError 被换成别的写法但文件里没有裸 e.message」这类回归，端点闸能。
//
// 判别力（为什么不写「多调一次 serverError」）：
//   每条用例都通过 requestCapturingRawError 抓下 serverError 记进 console.error 的**原始错误对象**，
//   再断言 ① 响应体 === fallback 文案，② raw.message !== fallback，③ 响应体不含 raw.message。
//   把实现改成裸回 `e.message`，②③ 立刻红 —— 咬的就是「回通用文案」这件事本身。
//   （被 HttpError 子类原样回文案是**预期**行为，故这些用例一律用**非 HttpError** 的未预期错误触发。）
//
// 鉴权处理：抄 middleware/mini-auth.test.ts 的现成范式 —— 挂 miniAuthMiddleware + 真签一枚 C端 JWT，
//   不自己发明旁路。voice / video-promo 不在 /api/mini/* 下，直接挂裸路由（同 kf.test.ts 的调法）。

process.env.MINI_JWT_SECRET = 'test-mini-secret'; // 必须早于构造 token；requireEnv 惰性读取，请求时取值

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { miniAuthMiddleware, MINI_JWT_AUDIENCE } from '../../../middleware/mini-auth.js';
import payH5Route from '../pay-h5.js';
import payProductRoute from '../pay-product.js';
import payRoute from '../pay.js';
import productOrdersRoute from '../product-orders.js';
import voiceRoute from '../../voice.js';
import videoPromoRoute from '../../video-promo.js';
import { db } from '../../../db/index.js';
import { pmsBuiOrders } from '../../../db/schema/index.js';

const app = new Hono();
app.use('/api/mini/*', miniAuthMiddleware);
app.route('/api/mini/pay', payH5Route);   // /jssdk-config（pay-h5）
app.route('/api/mini/pay', payRoute);     // /dy-jsapi（pay.ts 唯一走 serverError 的下单端点）
app.route('/api/mini/pay-product', payProductRoute);
app.route('/api/mini/product-orders', productOrdersRoute);
app.route('/api/voice', voiceRoute);
app.route('/api/video', videoPromoRoute);

const MINI_USER = 't9-envelope-user';
const token = jwt.sign(
  { miniUserId: MINI_USER, openid: 'o_t9', platform: 'wx_mp' },
  'test-mini-secret',
  { audience: MINI_JWT_AUDIENCE, expiresIn: '1h' },
);
const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/**
 * 真打端点，并把 serverError 记进 console.error 的原始错误对象抓出来。
 * 抓的是 `args[args.length - 1]`（serverError 与各 handler 的日志都把错误对象放最后一个参数）。
 */
async function requestCapturingRawError(
  req: () => Response | Promise<Response>,
): Promise<{ res: Response; raw: Error | undefined }> {
  const seen: unknown[] = [];
  const original = console.error;
  console.error = (...args: any[]) => { seen.push(args[args.length - 1]); };
  try {
    const res = await req();
    return { res, raw: seen.find((x) => x instanceof Error) as Error | undefined };
  } finally {
    console.error = original;
  }
}

/** 断言「未预期错误 ⇒ status + 通用文案」，并用运行时抓到的原始错误自证判别力。 */
async function expectGenericEnvelope(
  req: () => Response | Promise<Response>,
  status: number,
  fallback: string,
): Promise<{ body: any; raw: Error }> {
  const { res, raw } = await requestCapturingRawError(req);
  const body = await res.json();
  expect(res.status).toBe(status);
  expect(body).toEqual({ success: false, error: fallback });
  // —— 判别力自证（三段缺一不可）——
  expect(raw).toBeDefined();
  expect(raw!.message).not.toBe(fallback);      // 原始文案 ≠ 通用文案 ⇒ 裸回原文会改掉响应体
  expect(body.error).not.toContain(raw!.message); // 原始文案确实没出现在响应里
  return { body, raw: raw! };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('端点级：未预期错误 ⇒ 通用文案（不泄漏原文）', () => {
  it('pay-h5 GET /jssdk-config：取 jsapi_ticket 的上游 fetch 抛错 → 502 + 「签名失败」', async () => {
    vi.stubEnv('WX_MP_APPID', 'wx_stub_appid');
    vi.stubEnv('WX_MP_SECRET', 'wx_stub_secret');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('LEAK-JSSDK-e41c')));

    const { raw } = await expectGenericEnvelope(
      () => app.request('/api/mini/pay/jssdk-config?url=abc', { headers: authHeaders() }),
      502,
      '签名失败',
    );
    // 原始错误确实是那条带哨兵的上游失败（证明上一条断言比的是真东西）
    expect(raw.message).toBe('LEAK-JSSDK-e41c');
  });

  it('product-orders GET /my：平台代理 fetch 抛错 → 500 + 「加载失败」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('LEAK-PO-5a7d')));

    const { raw } = await expectGenericEnvelope(
      () => app.request('/api/mini/product-orders/my', { headers: authHeaders() }),
      500,
      '加载失败',
    );
    expect(raw.message).toBe('LEAK-PO-5a7d');
  });

  it('pay-product POST /jsapi：平台订单取回正常但 WXPAY_SUB_MCHID 缺失（未预期错误）→ 500 + 「下单失败」', async () => {
    vi.stubEnv('WXPAY_SUB_MCHID', ''); // requireEnv 对空串同样抛（失败方向与「未配置」一致）
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          id: 'po_t9', miniUserId: MINI_USER, status: 'pending', paymentStatus: 'unpaid',
          mode: 'B', totalAmount: '100', storeId: 's_t9', orderNo: 'PO-T9', merchantId: 'default',
        },
      }),
    }));

    const { raw } = await expectGenericEnvelope(
      () => app.request('/api/mini/pay-product/jsapi', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ orderId: 'po_t9' }),
      }),
      500,
      '下单失败',
    );
    // requireEnv 的 FATAL 文案里带环境变量名 —— 正是最不该回给客户端的那类文本
    expect(raw.message).toContain('WXPAY_SUB_MCHID');
  });

  it('voice POST /tts：TTS 合成不可用（未预期错误）→ 500 + 「TTS 合成失败」', async () => {
    // 本地/CI 均未配置百炼 Key ⇒ checkConfig() 先抛（文案含 DASHSCOPE_API_KEY）；
    // 若环境里恰好配了 Key，则落到下面的 fetch 桩上抛哨兵。
    // 两种情形 raw.message 都不是 fallback，判别力不受影响。
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('LEAK-TTS-2f90')));

    const { raw } = await expectGenericEnvelope(
      () => app.request('/api/voice/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: 'longxing_v3', text: '你好' }),
      }),
      500,
      'TTS 合成失败',
    );
    expect(raw.message.length).toBeGreaterThan(0);
  });

  it('video-promo POST /optimize-script：AI 服务 fetch 抛错（未预期错误）→ 500 + 「文案优化失败」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('LEAK-AI-77b3')));

    const { raw } = await expectGenericEnvelope(
      () => app.request('/api/video/optimize-script', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: '你好，欢迎入住' }),
      }),
      500,
      '文案优化失败',
    );
    expect(raw.message).toBe('LEAK-AI-77b3');
  });
});

// ============================================================
// pay.ts 的 /dy-jsapi 是**唯一**走 serverError 的下单端点（/jsapi 无 try/catch，不在此列），
// 且它要求预订单行真实存在才能走到 try 块。
//
// ⚠️ 为什么这里用 db 查询桩而不是真库：本机 local dev 库（aipms）的 pms_bui_orders **缺列**
//    （无 platform_order_id / platform_order_no / verify_code，drizzle/0017 未落到本机），
//    drizzle 的 select 会把这几个列全带上 ⇒ 真库路径在该库上必然 42703。
//    这是本机环境既存问题（与 Task B 记的是同一回事），**不改环境**，故只把 db 查询这一层钉死，
//    **端点本身仍真调**（route.request 走完整 handler，断言的是 catch → serverError 这一路）。
// ============================================================
describe('端点级：pay POST /dy-jsapi 未预期错误 ⇒ 502 + 「下单失败」', () => {
  const ORDER_ID = 't9-envelope-order';
  const orderRow = {
    id: ORDER_ID, guestId: MINI_USER, status: 'pending', paymentStatus: 'unpaid',
    otaTimeout: null, totalPrice: 100, merchantId: 'default', storeId: 't9-store',
    orderNo: 'T9ENV', roomType: 'T9 测试房', checkIn: '2026-10-01', nights: 1,
  };
  const paymentRow = { id: 'pay_t9', outTradeNo: 'T9ENVX', amount: 10000 };
  let spySelect: any;
  let spyInsert: any;

  beforeAll(() => {
    // 查询桩只实现本端点用到的链：select().from(t).where().limit(1) 与 insert().values().onConflictDoNothing().returning()
    spySelect = vi.spyOn(db, 'select').mockImplementation((): any => {
      let rows: any[] = [];
      const q: any = {
        from: (table: any) => { rows = table === pmsBuiOrders ? [orderRow] : []; return q; },
        where: () => q,
        orderBy: () => q,
        limit: () => Promise.resolve(rows),
      };
      return q;
    });
    spyInsert = vi.spyOn(db, 'insert').mockImplementation((): any => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([paymentRow]) }) }),
    }));
  });

  afterAll(() => {
    spySelect.mockRestore();
    spyInsert.mockRestore();
  });

  it('抖音下单前置 env 缺失（未预期错误，非 HttpError）→ 502 通用文案，不泄漏 FATAL 原文', async () => {
    vi.stubEnv('DY_PAY_NOTIFY_BASE', '');

    const { raw } = await expectGenericEnvelope(
      () => app.request('/api/mini/pay/dy-jsapi', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ orderId: ORDER_ID }),
      }),
      502,
      '下单失败',
    );
    expect(raw.message).toContain('DY_PAY_NOTIFY_BASE');
  });
});
