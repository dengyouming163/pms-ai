import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiStores } from '../../db/schema/index.js';
import { fetchWeatherDescription } from '../../services/pricing-engine.js';

const route = new Hono();

/**
 * GET /api/internal/store-guide?storeId=xxx
 * C1 入住指引包：预约确认触发时，平台端需目的地门店名称/地址 + 未来 1 天天气来组装「入住指引」文案。
 * 需 internalAuthMiddleware 校验 X-Internal-Service-Token（与 /api/internal/notify 同源）。
 *
 * 返回：
 *   data.storeName  门店名称（用 storeName 而非 name，规避 dataMask 对 name 的脱敏）
 *   data.address    门店地址
 *   data.weather    未来 1 天天气中文描述（如「晴」「小雨」）；坐标缺失/查询失败为 null → 调用方降级为不含天气文案
 *
 * 天气查询为 best-effort，失败不阻断：仅 weather 为 null，接口本身仍 200 返回门店信息。
 */
route.get('/', async (c) => {
  const storeId = c.req.query('storeId') || '';
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);

  const [store] = await db.select().from(pmsBuiStores)
    .where(eq(pmsBuiStores.id, storeId)).limit(1);
  if (!store) return c.json({ success: false, error: '门店不存在' }, 404);

  // 天气 best-effort：坐标缺失/查询失败 → null（调用方降级为「不含天气」文案）
  const weather = await fetchWeatherDescription(store.latitude || '', store.longitude || '');

  return c.json({
    success: true,
    data: {
      storeName: store.name || '',
      address: store.address || '',
      weather,
    },
  });
});

export default route;
