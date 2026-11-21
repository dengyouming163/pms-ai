import type { Context, Next } from 'hono';
import { INTERNAL_SERVICE_TOKEN } from '../constants.js';

/**
 * 验证来自 pms-ai-crew 的内部请求
 * 所有 /api/internal/* 路径必须携带有效 Token
 */
export async function internalAuthMiddleware(c: Context, next: Next) {
  const path = c.req.path;

  if (!path.startsWith('/api/internal/')) {
    return next();
  }

  const token = c.req.header('X-Internal-Service-Token');
  if (token !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: '禁止访问：内部服务认证失败' }, 403);
  }

  return next();
}
