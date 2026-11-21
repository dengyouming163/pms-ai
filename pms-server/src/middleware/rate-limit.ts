import type { Context, Next } from 'hono';

/**
 * 简易内存速率限制中间件。
 * 基于IP的滑动窗口计数器，每个IP每分钟最多maxRequests次请求。
 * 仅对 /api/* POST/PUT/DELETE 写操作生效。
 */

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// 每分钟清理一次过期记录
const CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter(t => now - t < 60_000);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

export function rateLimitMiddleware(maxRequests = 60) {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    // 仅限制写操作；GET 请求不限速
    if (!['POST', 'PUT', 'DELETE'].includes(method)) {
      return next();
    }

    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const now = Date.now();
    const windowMs = 60_000;

    let entry = store.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(ip, entry);
    }

    // 清理窗口外的旧记录
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);

    if (entry.timestamps.length >= maxRequests) {
      return c.json(
        { success: false, error: '请求过于频繁，请稍后重试' },
        429,
      );
    }

    entry.timestamps.push(now);
    return next();
  };
}
