import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiAiChatHistory } from '../../db/schema/ai.js';
import { aiChatStream } from '../../services/ai-client.js';
import { getTenantScope } from '../../utils/tenant.js';

const chat = new Hono();

// SSE 流式对话
chat.post('/', async (c) => {
  try {
    const scope = getTenantScope(c);
    const { message, history } = await c.req.json();
    const res = await aiChatStream({
      message,
      history,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
    });
    // 返回流式响应
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: any) {
    console.error('[ai/chat] 对话失败:', err.message);
    return c.json({ success: false, error: 'AI 服务暂不可用，请稍后重试' }, 502);
  }
});

// 获取对话历史
chat.get('/history', async (c) => {
  const scope = getTenantScope(c);
  const authUser = (c as any).get('authUser');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');

  const history = await db.select().from(pmsBuiAiChatHistory)
    .where(eq(pmsBuiAiChatHistory.userId, authUser?.userId || ''))
    .orderBy(desc(pmsBuiAiChatHistory.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);

  return c.json({ history, page, limit });
});

// 快捷提示
chat.get('/prompts', async (c) => {
  return c.json({
    prompts: [
      { id: 'daily', label: '今天怎么样？', message: '今天酒店整体经营情况怎么样？' },
      { id: 'revenue', label: '最近收益如何？', message: '帮我分析一下最近的收益情况' },
      { id: 'pricing', label: '帮我看看定价', message: '目前的定价策略有什么优化建议吗？' },
      { id: 'anomaly', label: '有没有异常？', message: '最近有什么需要我关注的异常情况吗？' },
      { id: 'weekly', label: '本周总结', message: '帮我做一下本周的经营总结' },
    ],
  });
});

export default chat;
