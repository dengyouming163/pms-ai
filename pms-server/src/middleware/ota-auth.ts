// OTA 客户端专用鉴权：检测 sk- 前缀的 Bearer token
import type { Context, Next } from 'hono';
import { db } from '../db/index.js';
import { pmsOtaClients } from '../db/schema/ota.js';
import { eq } from 'drizzle-orm';

export async function otaAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '未授权' }, 401);
  }

  const token = authHeader.substring(7);

  // 如果是 sk- 前缀，走 store_key 鉴权
  if (token.startsWith('sk-')) {
    const client = await db
      .select({ storeId: pmsOtaClients.storeId, deviceId: pmsOtaClients.deviceId })
      .from(pmsOtaClients)
      .where(eq(pmsOtaClients.storeKey, token))
      .limit(1);

    if (client.length === 0) {
      return c.json({ error: '无效的 Store Key' }, 401);
    }

    const storeId = client[0].storeId;
    // 注入 storeId 到上下文
    c.set('storeId', storeId);
    c.set('deviceId', client[0].deviceId);
    c.set('authType', 'store_key');

    // 从门店表获取 merchantId 并注入（避免硬编码 default）
    try {
      const { pmsBuiStores } = await import('../db/schema/brands.js');
      const [store] = await db.select({ merchantId: pmsBuiStores.merchantId })
        .from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId)).limit(1);
      if (store?.merchantId) c.set('merchantId', store.merchantId);
    } catch {}
    await next();
    return;
  }

  // 非 sk- 前缀 = 走标准 JWT（由全局 authMiddleware 处理）
  await next();
}
