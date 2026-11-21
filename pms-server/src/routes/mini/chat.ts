import { Hono } from 'hono';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { AGENT_API_URL, INTERNAL_SERVICE_TOKEN } from '../../constants.js';

const chat = new Hono();

chat.post('/', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const { message } = await c.req.json();
    const storeId = c.req.query('storeId') || '';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(`${AGENT_API_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN,
        'X-Mini-User-Id': miniUser.miniUserId,
        'X-Store-Id': storeId,
      },
      body: JSON.stringify({ message, context: 'mini' }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      return c.json({ success: false, error: 'AI 服务暂不可用' }, 502);
    }

    // 直接透传 SSE 流到小程序——保留 agent_start/progress 事件
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err: any) {
    console.error('[mini/chat] error:', err.message);
    return c.json({ success: false, error: 'AI 服务暂不可用' }, 502);
  }
});

export default chat;
