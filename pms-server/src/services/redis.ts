import Redis from 'ioredis';
import { REDIS_URL } from '../constants.js';

let redis: Redis | null = null;
let redisAvailable = false;

export function getRedis(): Redis | null {
  return redis;
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export async function initRedis(): Promise<void> {
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 2) return null; // 放弃重试
        return 500;
      },
      lazyConnect: true,
    });

    redis.on('error', () => {
      redisAvailable = false;
      redis = null;
    });

    await redis.connect();
    redisAvailable = true;
    console.log('[redis] 连接成功');
  } catch {
    console.warn('[redis] 不可用 — 继续运行（SSE 缓冲/缓存已禁用）');
    redisAvailable = false;
    redis = null;
  }
}
