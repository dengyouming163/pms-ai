import { describe, it, expect, vi, beforeEach } from 'vitest';
import miniKfRoute from '../kf.js';

describe('GET /api/mini/kf/contact', () => {
  const originalFetch = global.fetch;
  const originalError = console.error;

  // 每例先复位全局 fetch + console.error，避免用例间 mock 泄漏。
  // 本项目 tsc 下 afterEach / vi.restoreAllMocks / vi.spyOn 类型均不可用，改用 beforeEach 手动复位（同 global.fetch 处理）。
  beforeEach(() => {
    global.fetch = originalFetch;
    console.error = originalError;
  });

  it('代理成功：返回企微客服 url', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { openKfid: 'kf_a', name: '客服', state: 'conv_prop_s1', url: 'https://work.weixin.qq.com/kf/kf_a' } }),
    });
    const res = await miniKfRoute.request('/contact?storeId=s1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.openKfid).toBe('kf_a');
    expect(body.data.name).toBe('客服');
    expect(body.data.state).toBe('conv_prop_s1');
    expect(body.data.url).toContain('work.weixin.qq.com/kf/kf_a');
  });

  it('platform-server 返回 404 → 透传 404 + 提示', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404,
      json: async () => ({ success: false, error: '客服暂未配置，请先在「客服账号」页配置' }),
    });
    const res = await miniKfRoute.request('/contact?storeId=s1');
    expect(res.status).toBe(404);
  });

  it('缺 storeId → 400', async () => {
    const res = await miniKfRoute.request('/contact');
    expect(res.status).toBe(400);
  });

  it('fetch 失败（无法连接上游）→ 502 且记录服务端日志', async () => {
    let logged = false;
    console.error = () => { logged = true; };
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await miniKfRoute.request('/contact?storeId=s1');
    expect(res.status).toBe(502);
    expect(logged).toBe(true);
  });

  it('上游 5xx → 透传 502 + error 文案且记录服务端日志', async () => {
    let logged = false;
    console.error = () => { logged = true; };
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500,
      json: async () => ({ success: false, error: '客服服务异常' }),
    });
    const res = await miniKfRoute.request('/contact?storeId=s1');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('客服服务异常');
    expect(logged).toBe(true);
  });
});
