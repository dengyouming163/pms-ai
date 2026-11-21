// OTA 客户端路由 — 配置下发 + 心跳上报（RPA 客户端）+ 设备状态/抓取日志查询（Web 端）
import { Hono } from 'hono';
import type { Context } from 'hono';
import { db } from '../../db/index.js';
import { pmsOtaClients, pmsOtaCaptureLogs, pmsOtaOrders } from '../../db/schema/ota.js';
import { otaHeartbeatSchema } from '../../schemas/ota.schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getTenantScope } from '../../utils/tenant.js';
import { serverError } from '../../lib/http-error.js';

const clientRoute = new Hono();

// 从上下文解析门店 ID（query 参数优先，通配符 '*' 回退到 'default'）
function resolveStoreId(c: Context): string {
  const scope = getTenantScope(c);
  const storeId = c.req.query('storeId') || scope.storeId;
  return storeId === '*' ? 'default' : (storeId || 'default');
}

// POST /bind — 客户端用 store_key 完成绑定
clientRoute.post('/bind', async (c) => {
  const body = await c.req.json();
  const { storeKey } = body || {};

  if (!storeKey || !storeKey.startsWith('sk-')) {
    return c.json({ error: '无效的 Store Key 格式' }, 400);
  }

  // 查找该 key 对应的客户端记录
  const client = await db
    .select()
    .from(pmsOtaClients)
    .where(eq(pmsOtaClients.storeKey, storeKey))
    .limit(1);

  if (client.length === 0) {
    return c.json({ error: 'Store Key 不存在，请先在 Web 端生成' }, 404);
  }

  // 标记为已绑定
  await db
    .update(pmsOtaClients)
    .set({ status: 'online', updatedAt: new Date() })
    .where(eq(pmsOtaClients.id, client[0].id));

  return c.json({
    ok: true,
    storeId: client[0].storeId,
    platform: client[0].platform,
    deviceId: client[0].deviceId,
  });
});

// GET /key — Web 端获取或生成 store_key（通用 Key，不区分平台）
clientRoute.get('/key', async (c) => {
  const storeId = c.req.query('storeId') || 'default';
  const platform = c.req.query('platform') || 'rpa';

  // 查找已有记录
  const existing = await db
    .select()
    .from(pmsOtaClients)
    .where(and(eq(pmsOtaClients.storeId, storeId), eq(pmsOtaClients.platform, platform)))
    .limit(1);

  // 已有 storeKey 直接返回
  if (existing.length > 0 && existing[0].storeKey) {
    return c.json({ storeKey: existing[0].storeKey, storeId: existing[0].storeId, platform: existing[0].platform });
  }

  // 生成新的 store_key
  const newKey = 'sk-' + randomUUID().replace(/-/g, '').slice(0, 32);

  if (existing.length > 0) {
    await db
      .update(pmsOtaClients)
      .set({ storeKey: newKey, updatedAt: new Date() })
      .where(eq(pmsOtaClients.id, existing[0].id));
  } else {
    await db.insert(pmsOtaClients).values({
      id: randomUUID(),
      storeId,
      platform,
      deviceId: 'pending',
      storeKey: newKey,
      status: 'offline',
    } as typeof pmsOtaClients.$inferInsert);
  }

  return c.json({ storeKey: newKey, storeId, platform });
});

// GET /config — 客户端拉取配置
clientRoute.get('/config', async (c) => {
  const storeId = resolveStoreId(c);
  return c.json({
    storeId,
    platform: 'meituan',
    capture: {
      minIntervalMin: 5,
      maxIntervalMin: 25,
      enabled: true,
    },
    meituan: {
      merchantId: '',
      loginUrl: 'https://e.meituan.com/',
    },
  });
});

// POST /heartbeat — 客户端心跳上报（upsert 设备记录）
clientRoute.post('/heartbeat', async (c) => {
  const body = await c.req.json();
  const parsed = otaHeartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: '参数校验失败', details: parsed.error.issues }, 400);
  }

  const { storeId, platform, deviceId, clientVersion, sessionValid, lastCaptureAt, status } = parsed.data;

  // 查找已注册的设备记录（storeId + platform + deviceId 唯一）
  const existing = await db
    .select({ id: pmsOtaClients.id })
    .from(pmsOtaClients)
    .where(
      and(
        eq(pmsOtaClients.storeId, storeId),
        eq(pmsOtaClients.platform, platform),
        eq(pmsOtaClients.deviceId, deviceId),
      )
    )
    .limit(1);

  const now = new Date();
  // 客户端自报状态（ok/error/session_expired）映射到 DB 状态（online/offline/error）
  // session_expired 视为在线（设备存活但需重新登录）
  const dbStatus = status === 'error' ? 'error' : 'online';

  if (existing.length > 0) {
    // lastCaptureAt 为可选字段：仅在客户端上报时才更新，避免用 null 覆盖已存储的值
    const updateData: Record<string, any> = {
      clientVersion,
      sessionValid,
      lastHeartbeatAt: now,
      status: dbStatus,
      updatedAt: now,
    };
    if (lastCaptureAt) {
      updateData.lastCaptureAt = new Date(lastCaptureAt);
    }
    await db
      .update(pmsOtaClients)
      .set(updateData)
      .where(eq(pmsOtaClients.id, existing[0].id));
  } else {
    // 未找到精确匹配 → 检查是否有同 store+platform 的旧记录（如 bind 创建的 pending）
    const samePlatform = await db.select({ id: pmsOtaClients.id })
      .from(pmsOtaClients)
      .where(and(eq(pmsOtaClients.storeId, storeId), eq(pmsOtaClients.platform, platform)))
      .limit(1);
    if (samePlatform.length > 0) {
      // 更新旧记录的 deviceId（合并 pending → 真实设备）
      await db.update(pmsOtaClients).set({
        deviceId, clientVersion, sessionValid,
        lastHeartbeatAt: now, status: dbStatus, updatedAt: now,
        ...(lastCaptureAt ? { lastCaptureAt: new Date(lastCaptureAt) } : {}),
      }).where(eq(pmsOtaClients.id, samePlatform[0].id));
    } else {
    // 插入路径同理：仅在提供 lastCaptureAt 时才写入
    const insertData: Record<string, any> = {
      id: randomUUID(),
      storeId,
      platform,
      deviceId,
      clientVersion,
      sessionValid,
      lastHeartbeatAt: now,
      status: dbStatus,
    };
    if (lastCaptureAt) {
      insertData.lastCaptureAt = new Date(lastCaptureAt);
    }
    await db.insert(pmsOtaClients).values(insertData as typeof pmsOtaClients.$inferInsert);
    } // end inner else
  }

  return c.json({
    ok: true,
    serverTime: now.toISOString(),
    capture: {
      minIntervalMin: 5,
      maxIntervalMin: 25,
      enabled: true,
    },
  });
});

// GET /health — 运维看板：查询设备健康状态
clientRoute.get('/health', async (c) => {
  try {
    const storeId = c.req.query('storeId');
    if (!storeId) return c.json({ error: 'storeId required' }, 400);
    const devices = await db.select().from(pmsOtaClients).where(eq(pmsOtaClients.storeId, storeId));
    return c.json({ devices: devices.map(d => ({ deviceId: d.deviceId, platform: d.platform, status: d.status, sessionValid: d.sessionValid })) });
  } catch (e: any) { return serverError(c, e, '查询设备状态失败'); }
});

// GET /status — Web 端查询客户端设备状态
clientRoute.get('/devices', async (c) => {
  try {
    const storeId = c.req.query('storeId');
    const queryAll = !storeId || storeId === 'all';

    const clients = queryAll
      ? await db.select().from(pmsOtaClients).orderBy(desc(pmsOtaClients.lastHeartbeatAt))
      : await db.select().from(pmsOtaClients).where(eq(pmsOtaClients.storeId, storeId)).orderBy(desc(pmsOtaClients.lastHeartbeatAt));

    return c.json({ clients: clients.map(cl => ({
      id: cl.id, storeId: cl.storeId, platform: cl.platform, deviceId: cl.deviceId,
      clientVersion: cl.clientVersion, sessionValid: cl.sessionValid,
      lastCaptureAt: cl.lastCaptureAt?.toISOString() || null,
      lastHeartbeatAt: cl.lastHeartbeatAt?.toISOString() || null,
      status: cl.status,
    })) });
  } catch (e: any) { return serverError(c, e, '查询设备列表失败'); }
});

// GET /logs — Web 端查询抓取日志
clientRoute.get('/logs', async (c) => {
  const storeId = resolveStoreId(c);
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20') || 20));

  const logs = await db
    .select()
    .from(pmsOtaCaptureLogs)
    .where(eq(pmsOtaCaptureLogs.storeId, storeId))
    .orderBy(desc(pmsOtaCaptureLogs.capturedAt))
    .limit(limit);

  return c.json({
    logs: logs.map(l => ({
      id: l.id,
      storeId: l.storeId,
      platform: l.platform,
      deviceId: l.deviceId,
      result: l.result,
      newCount: l.newCount,
      changeCount: l.changeCount,
      errorMessage: l.errorMessage,
      capturedAt: l.capturedAt?.toISOString() || '',
    })),
  });
});

// GET /keys — Web端获取门店所有API Key
clientRoute.get('/keys', async (c) => {
  const storeId = resolveStoreId(c);
  const rows = await db.select({
    id: pmsOtaClients.id,
    storeId: pmsOtaClients.storeId,
    platform: pmsOtaClients.platform,
    storeKey: pmsOtaClients.storeKey,
    status: pmsOtaClients.status,
    lastHeartbeatAt: pmsOtaClients.lastHeartbeatAt,
    lastCaptureAt: pmsOtaClients.lastCaptureAt,
    createdAt: pmsOtaClients.createdAt,
  }).from(pmsOtaClients).where(eq(pmsOtaClients.storeId, storeId)).orderBy(desc(pmsOtaClients.createdAt));
  return c.json({ keys: rows.map(r => ({ ...r, storeKey: r.storeKey ? r.storeKey.slice(0,8)+'***'+r.storeKey.slice(-6) : null })) });
});

// POST /keys — 生成/重新生成 store_key（通用 Key）
clientRoute.post('/keys', async (c) => {
  const body = await c.req.json();
  const storeId = body.storeId || resolveStoreId(c);
  const platform = body.platform === 'all' ? 'rpa' : (body.platform || 'rpa');
  const newKey = 'sk-' + randomUUID().replace(/-/g, '').slice(0, 32);

  const existing = await db.select().from(pmsOtaClients)
    .where(and(eq(pmsOtaClients.storeId, storeId), eq(pmsOtaClients.platform, platform))).limit(1);

  if (existing.length > 0) {
    await db.update(pmsOtaClients).set({ storeKey: newKey, updatedAt: new Date() }).where(eq(pmsOtaClients.id, existing[0].id));
  } else {
    await db.insert(pmsOtaClients).values({ id: randomUUID(), storeId, platform, deviceId: 'pending', storeKey: newKey, status: 'offline' } as any);
  }
  return c.json({ storeKey: newKey, storeId, platform });
});

export default clientRoute;
