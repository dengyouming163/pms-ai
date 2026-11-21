import { Hono } from 'hono';
import { and, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { mediaAssets, pmsBuiStores } from '../../db/schema/index.js';

const route = new Hono();

/**
 * GET /api/internal/assets — 跨门店素材查询（平台运营/客服工作台用，绕过租户隔离）
 * 需 internalAuthMiddleware 校验 X-Internal-Service-Token（与 /api/internal/notify 同源，见 index.ts 全局挂载）。
 * 查询参数：store_id(可选) / category(可选) / media_type(可选) / q(关键词，匹配 name/url) / limit / offset
 * 响应：{ success, data: { list, total } }
 */
route.get('/', async (c) => {
  const { store_id, category, media_type, q, limit: limitRaw, offset: offsetRaw } = c.req.query();
  const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
  const offset = Math.max(Number(offsetRaw) || 0, 0);

  const conditions: SQL[] = [eq(mediaAssets.status, 'active')];
  if (store_id) conditions.push(eq(mediaAssets.storeId, store_id));
  if (category) conditions.push(eq(mediaAssets.category, category));
  if (media_type) conditions.push(eq(mediaAssets.mediaType, media_type));
  if (q) conditions.push(or(
    like(mediaAssets.name, `%${q}%`),
    like(mediaAssets.url, `%${q}%`),
  ) as SQL);

  const where = and(...conditions);

  const rows = await db.select({
    id: mediaAssets.id,
    storeId: mediaAssets.storeId,
    url: mediaAssets.url,
    thumbnailUrl: mediaAssets.thumbnailUrl,
    name: mediaAssets.name,
    mediaType: mediaAssets.mediaType,
    category: mediaAssets.category,
    purposeTags: mediaAssets.purposeTags,
  }).from(mediaAssets).where(where)
    .orderBy(desc(mediaAssets.createdAt))
    .limit(limit).offset(offset);

  const [countRow] = await db.select({ count: sql`count(*)::int` }).from(mediaAssets).where(where);

  return c.json({
    success: true,
    data: { list: rows, total: Number(countRow?.count ?? 0) },
  });
});

/**
 * GET /api/internal/assets/stores — 有素材的门店列表（含名称与素材数）
 * 供客服工作台素材抽屉做门店选择：按 media_assets 分组统计，join pmsBuiStores 取门店名。
 * 响应：{ success, data: { list: [{ storeId, storeName, count }], total } }
 */
route.get('/stores', async (c) => {
  const rows = await db.select({
    storeId: mediaAssets.storeId,
    count: sql<number>`count(*)::int`,
  }).from(mediaAssets)
    .where(eq(mediaAssets.status, 'active'))
    .groupBy(mediaAssets.storeId)
    .orderBy(desc(sql`count(*)`));

  const ids = rows.map(r => r.storeId).filter((id): id is string => Boolean(id));
  const nameMap = new Map<string, string>();
  if (ids.length > 0) {
    const stores = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
      .from(pmsBuiStores)
      .where(inArray(pmsBuiStores.id, ids));
    for (const s of stores) nameMap.set(s.id, s.name || '');
  }

  return c.json({
    success: true,
    data: {
      list: rows.map(r => ({ storeId: r.storeId, storeName: nameMap.get(r.storeId) || '', count: r.count })),
      total: rows.length,
    },
  });
});

export default route;
