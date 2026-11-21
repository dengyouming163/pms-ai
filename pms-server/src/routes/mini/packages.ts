import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiPackages } from '../../db/schema/index.js';

// @deprecated 遗留接口：查询 pms-server 本地 pmsBuiPackages 表，无预订模式（mode）/取消政策（cancelPolicy）字段。
// D1 私域直订的平台套餐池已迁移到平台产品体系（mini/products.ts，含 bookingModes/协议价等），
// 前端已不再调用本接口；保留以便历史版本小程序兼容，勿再扩展。后续确认无调用方可整体移除。
const route = new Hono();
const today = () => new Date().toISOString().slice(0, 10);

route.get('/', async (c) => {
  const storeId = c.req.query('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);
  const pkgs = await db.select().from(pmsBuiPackages).where(and(
    eq(pmsBuiPackages.storeId, storeId),
    eq(pmsBuiPackages.status, 'active'),
  ));
  return c.json({ success: true, data: pkgs });
});

route.get('/:id', async (c) => {
  const [pkg] = await db.select().from(pmsBuiPackages)
    .where(and(eq(pmsBuiPackages.id, c.req.param('id')), eq(pmsBuiPackages.status, 'active'))).limit(1);
  if (!pkg) return c.json({ success: false, error: '套餐不存在或已下架' }, 404);
  return c.json({ success: true, data: pkg });
});

export default route;
