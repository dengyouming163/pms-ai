import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index';
import { pmsBuiBrands } from '../db/schema';
import { eq } from 'drizzle-orm';
import { validateBody } from '../utils/validate';

const route = new Hono();

// GET /api/brands - 获取所有品牌
route.get('/', async (c) => {
  const result = await db.select().from(pmsBuiBrands);
  const enriched = result.map(b => ({
    ...b,
    standards: {
      checkInTime: b.standards?.checkInTime || '14:00',
      checkOutTime: b.standards?.checkOutTime || '12:00',
      cancelPolicy: b.standards?.cancellationPolicy || '提前24小时免费取消',
      depositRule: b.standards?.depositPolicy || '需预付首晚房费',
      identityRequired: true,
      welcomeMsg: '欢迎入住',
      reviewReply: b.standards?.reviewReply || '24小时内回复',
    },
    sops: ['入住登记SOP', '退房结算SOP', '客房清洁SOP'],
  }));
  return c.json(enriched);
});

// Zod 请求体验证 schema
const createBrandSchema = z.object({
  name: z.string().min(1, '品牌名称不能为空'),
  logo: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  facilities: z.array(z.string()).optional(),
}).passthrough();

const updateBrandSchema = z.object({
  id: z.string().min(1, '品牌ID不能为空'),
  name: z.string().optional(),
  logo: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  facilities: z.array(z.string()).optional(),
  status: z.string().optional(),
});

// POST /api/brands - 创建品牌
route.post('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, createBrandSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;
  const newBrand = {
    id: `b${Date.now()}`,
    type: 'custom' as const,
    storeCount: 0,
    totalRooms: 0,
    status: 'active',
    ...data,
  };
  const [inserted] = await db.insert(pmsBuiBrands).values(newBrand).returning();
  return c.json(inserted, 201);
});

// PUT /api/brands - 更新品牌
route.put('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, updateBrandSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { id, ...updateData } = validation.data;
  const [updated] = await db.update(pmsBuiBrands).set(updateData).where(eq(pmsBuiBrands.id, id)).returning();
  if (!updated) return c.json({ error: '品牌不存在' }, 404);
  return c.json(updated);
});

// DELETE /api/brands - 删除品牌
route.delete('/', async (c) => {
  const { id } = c.req.query();
  if (!id) return c.json({ error: '缺少品牌ID' }, 400);
  const [deleted] = await db.delete(pmsBuiBrands).where(eq(pmsBuiBrands.id, id as string)).returning();
  if (!deleted) return c.json({ error: '品牌不存在' }, 404);
  return c.json({ success: true });
});

export default route;
