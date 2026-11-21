// 在 import 业务模块前设置公众号服务器配置 Token（requireEnv 为惰性读取，调用时才校验）
process.env.WX_MP_TOKEN = 'test-mp-token';

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import mpCallbackRoute, { verifyMpSignature } from '../mp-callback.js';

// 固定验签输入：token='test-mp-token'，sort 后拼接 = '1234567890abcdeftest-mp-token'
const TS = '1234567890';
const NONCE = 'abcdef';
const SIGN = '77f65a6f5b70769d08d14fe327866caa5d3f2c57';

describe('verifyMpSignature', () => {
  it('正确签名返回 true', () => {
    expect(verifyMpSignature(SIGN, TS, NONCE)).toBe(true);
  });
  it('错误签名返回 false', () => {
    expect(verifyMpSignature('deadbeef', TS, NONCE)).toBe(false);
  });
  it('空签名返回 false', () => {
    expect(verifyMpSignature('', TS, NONCE)).toBe(false);
  });
});

describe('公众号消息回调端点', () => {
  // 挂载与 index.ts 一致的路径
  const app = new Hono();
  app.route('/api/wechat/mp', mpCallbackRoute);

  it('GET 验签通过 → 200 返回 echostr', async () => {
    const res = await app.request(`/api/wechat/mp/callback?signature=${SIGN}&timestamp=${TS}&nonce=${NONCE}&echostr=hello_wx`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello_wx');
  });

  it('GET 验签失败 → 403 forbidden', async () => {
    const res = await app.request(`/api/wechat/mp/callback?signature=bad&timestamp=${TS}&nonce=${NONCE}&echostr=hello_wx`);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('forbidden');
  });

  it('GET 缺少参数 → 400 invalid', async () => {
    const res = await app.request(`/api/wechat/mp/callback?signature=${SIGN}&timestamp=${TS}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('invalid');
  });

  it('POST 文本消息（命中关键词）→ 返回被动回复 XML', async () => {
    const xml = '<xml><ToUserName>gh_xxx</ToUserName><FromUserName>openid_1</FromUserName><MsgType>text</MsgType><Content>你好</Content></xml>';
    const res = await app.request('/api/wechat/mp/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    expect(await res.text()).toContain('<Content>');
  });

  it('POST 无回复的消息类型（如取消关注事件）→ 返回 success', async () => {
    const xml = '<xml><ToUserName>gh_xxx</ToUserName><FromUserName>openid_1</FromUserName><MsgType>event</MsgType><Event>unsubscribe</Event></xml>';
    const res = await app.request('/api/wechat/mp/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('success');
  });
});
