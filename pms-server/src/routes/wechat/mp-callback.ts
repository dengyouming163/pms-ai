import { Hono } from 'hono';
import crypto from 'node:crypto';
import { requireEnv } from '../../constants.js';
import { handleMpMessage } from '../../services/mp-reply.js';

const route = new Hono();

/** 公众号服务器配置验签：signature = sha1(sort([token, timestamp, nonce]).join('')) */
export function verifyMpSignature(signature: string, timestamp: string, nonce: string): boolean {
  const token = requireEnv('WX_MP_TOKEN');
  const sorted = [token, timestamp, nonce].sort().join('');
  const hash = crypto.createHash('sha1').update(sorted).digest('hex');
  return hash === signature;
}

// GET：服务器配置验证（返回 echostr）
route.get('/callback', async (c) => {
  const { signature, timestamp, nonce, echostr } = c.req.query();
  if (!signature || !timestamp || !nonce || !echostr) return c.text('invalid', 400);
  if (!verifyMpSignature(signature, timestamp, nonce)) return c.text('forbidden', 403);
  return c.text(echostr);
});

// POST：接收消息/事件 → 被动回复 XML（无回复时返回 success 空串）
route.post('/callback', async (c) => {
  const xml = await c.req.text();
  const replyXml = await handleMpMessage(xml);
  if (replyXml) {
    return c.text(replyXml, 200, { 'Content-Type': 'text/xml; charset=utf-8' });
  }
  return c.text('success');
});

export default route;
