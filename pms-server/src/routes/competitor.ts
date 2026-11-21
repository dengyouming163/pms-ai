import { Hono } from 'hono';
import { db } from '../db/index';
import { pmsBuiSettings } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';

const route = new Hono();

// GET: 获取竞品价格列表
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const rows = await db.select().from(pmsBuiSettings)
    .where(and(eq(pmsBuiSettings.category, 'competitor_prices'), ...tenantWhere(scope, pmsBuiSettings)));
  const prices = rows.map(r => ({ id: r.id, ...((r.value as any) || {}) }));
  return c.json({ competitors: prices });
});

// POST: 手动录入竞品价格
route.post('/', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const { name, platform, roomType, price, notes } = body;
  const id = `compete_${Date.now()}`;
  await db.insert(pmsBuiSettings).values({
    id, category: 'competitor_prices', key: name,
    value: { name, platform, roomType, price, notes, updatedAt: new Date().toISOString() },
    merchantId: scope.merchantId, storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
  } as any);
  return c.json({ success: true, id });
});

// PUT: 更新竞品价格
route.put('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  await db.update(pmsBuiSettings).set({ value: { ...body, updatedAt: new Date().toISOString() } } as any)
    .where(and(eq(pmsBuiSettings.id, id), ...tenantWhere(scope, pmsBuiSettings)));
  return c.json({ success: true });
});

export default route;
