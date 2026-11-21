// 在 import 业务模块前设置 C端测试密钥（requireEnv 为惰性读取，请求时才取值）
process.env.MINI_JWT_SECRET = 'test-mini-secret';

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { isMiniPublicPath, miniAuthMiddleware, getMiniUser, MINI_JWT_AUDIENCE } from './mini-auth.js';

describe('isMiniPublicPath', () => {
  it('登录与支付回调路径公开', () => {
    expect(isMiniPublicPath('/api/mini/auth/login')).toBe(true);
    expect(isMiniPublicPath('/api/mini/pay/notify')).toBe(true);
    expect(isMiniPublicPath('/api/mini/pay/refund-notify')).toBe(true);
  });
  it('门店与房型浏览公开（未登录可浏览）', () => {
    expect(isMiniPublicPath('/api/mini/stores/st_1')).toBe(true);
    expect(isMiniPublicPath('/api/mini/rooms')).toBe(true);
    expect(isMiniPublicPath('/api/mini/regions')).toBe(true);
  });
  it('下单、个人中心需要登录', () => {
    expect(isMiniPublicPath('/api/mini/orders')).toBe(false);
    expect(isMiniPublicPath('/api/mini/auth/bind-phone')).toBe(false);
    expect(isMiniPublicPath('/api/mini/auth/bind-phone-code')).toBe(false);
    expect(isMiniPublicPath('/api/mini/pay/jsapi')).toBe(false);
  });
  it('套餐浏览公开，券列表精确公开但领取/我的券需登录', () => {
    expect(isMiniPublicPath('/api/mini/packages')).toBe(true);
    expect(isMiniPublicPath('/api/mini/packages/pkg_1')).toBe(true);
    expect(isMiniPublicPath('/api/mini/coupons')).toBe(true);
    expect(isMiniPublicPath('/api/mini/coupons/my')).toBe(false);
    expect(isMiniPublicPath('/api/mini/coupons/co_1/claim')).toBe(false);
    expect(isMiniPublicPath('/api/mini/promoter/me')).toBe(false);
  });
  it('场地列表公开（⑤-A：游客未登录也要能看到场地）', () => {
    expect(isMiniPublicPath('/api/mini/wenlv/venues')).toBe(true);
    expect(isMiniPublicPath('/api/mini/wenlv')).toBe(true);
    // 阴性对照：判据必须是「前缀 + 斜杠边界」而不是裸子串 ——
    // `/api/mini/wenlv-venues` 不共享 `/api/mini/wenlv/` 这个前缀，必须是 false。
    // 缺了这条，把规则写成 `path.includes(p)` 也能让上面两条全绿。
    expect(isMiniPublicPath('/api/mini/wenlv-venues')).toBe(false);
  });
});

describe('miniAuthMiddleware 行为', () => {
  // 挂载 C端认证中间件的测试 app
  const app = new Hono();
  app.use('/api/mini/*', miniAuthMiddleware);
  app.get('/api/mini/orders', (c) => c.json({ success: true, user: getMiniUser(c) }));

  const payload = { miniUserId: 'mu_1', openid: 'openid_abc' };

  it('合法 token（正确密钥 + mini audience）→ 200 且能取到用户', async () => {
    const token = jwt.sign(payload, 'test-mini-secret', { audience: MINI_JWT_AUDIENCE });
    const res = await app.request('/api/mini/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.miniUserId).toBe('mu_1');
    expect(body.user.openid).toBe('openid_abc');
  });

  it('另一把密钥签的 token（模拟员工 JWT_SECRET）→ 401', async () => {
    const token = jwt.sign(payload, 'staff-jwt-secret', { audience: MINI_JWT_AUDIENCE });
    const res = await app.request('/api/mini/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('相同密钥但不带 audience 的 token → 401（audience 纵深防御生效）', async () => {
    const token = jwt.sign(payload, 'test-mini-secret');
    const res = await app.request('/api/mini/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('无 token → 401，返回未登录', async () => {
    const res = await app.request('/api/mini/orders');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: '未登录' });
  });
});
