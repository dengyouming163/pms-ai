import type { Context, Next } from 'hono';

/**
 * 模式守卫中间件
 * AI 模式已永久开启，此中间件仅注入 systemMode 上下文，不再拦截请求
 */
export async function modeGuardMiddleware(c: Context, next: Next) {
  c.set('systemMode', 'ai_agent');
  return next();
}
