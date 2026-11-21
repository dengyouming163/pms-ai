import { Hono } from 'hono';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiRoomTypes } from '../../db/schema/index.js';

const route = new Hono();

/**
 * GET /api/internal/room-types — 跨门店房型查询（客服/员工工作台用，绕过租户隔离）
 * 需 internalAuthMiddleware 校验 X-Internal-Service-Token（index.ts 全局挂载）。
 * 查询参数：store_id(必填) / status(可选, 默认 active) / limit / offset
 * 响应：{ success, data: { list, total } }
 */
route.get('/', async (c) => {
  const { store_id, status, limit: limitRaw, offset: offsetRaw } = c.req.query();
  if (!store_id) return c.json({ success: false, error: 'store_id 必填' }, 400);
  const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
  const offset = Math.max(Number(offsetRaw) || 0, 0);

  const conditions: SQL[] = [eq(pmsBuiRoomTypes.storeId, store_id)];
  if (status) conditions.push(eq(pmsBuiRoomTypes.status, status));
  else conditions.push(eq(pmsBuiRoomTypes.status, 'active'));
  const where = and(...conditions);

  const rows = await db.select({
    id: pmsBuiRoomTypes.id,
    storeId: pmsBuiRoomTypes.storeId,
    name: pmsBuiRoomTypes.name,
    bedType: pmsBuiRoomTypes.bedType,
    images: pmsBuiRoomTypes.images,
    basePrice: pmsBuiRoomTypes.basePrice,
    minPrice: pmsBuiRoomTypes.minPrice,
    status: pmsBuiRoomTypes.status,
  }).from(pmsBuiRoomTypes).where(where)
    .limit(limit).offset(offset);

  // 计数用 sql 聚合（与 internal/assets.ts 一致；drizzle $count 此版本不可用）
  const [countRow] = await db.select({ count: sql`count(*)::int` }).from(pmsBuiRoomTypes).where(where);

  return c.json({
    success: true,
    data: { list: rows, total: Number(countRow?.count ?? 0) },
  });
});

export default route;
