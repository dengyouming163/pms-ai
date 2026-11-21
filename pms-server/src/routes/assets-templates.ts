import { Hono } from 'hono';
import { db } from '../db/index.js';
import { assetTemplates } from '../db/schema/index.js';
import { eq, and, asc } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { requirePermission } from '../middleware/permission-guard.js';

const route = new Hono();

// GET /api/assets/templates — 门店模板列表（登录即可，员工打卡需看 SOP）
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const rows = await db.select().from(assetTemplates)
    .where(and(...tenantWhere(scope, assetTemplates), eq(assetTemplates.source, 'store')))
    .orderBy(asc(assetTemplates.sortOrder));
  return c.json({ list: rows });
});

// GET /api/assets/templates/system — 系统模板库（只读）
route.get('/system', async (c) => {
  const rows = await db.select().from(assetTemplates)
    .where(and(eq(assetTemplates.merchantId, 'default'), eq(assetTemplates.source, 'system')))
    .orderBy(asc(assetTemplates.sortOrder));
  return c.json({ list: rows });
});

// POST /api/assets/templates — 新增（店长）
route.post('/', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json() as any;
  if (!body.name) return c.json({ success: false, error: 'name 为必填' }, 400);
  const id = `tmpl_${Date.now()}`;
  await db.insert(assetTemplates).values({
    id, merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    name: body.name, shotType: body.shotType || body.name,
    mediaType: body.mediaType || 'image', category: body.category || 'room',
    purposeTags: body.purposeTags || [], exampleImageUrl: body.exampleImageUrl || null,
    exampleVideoUrl: body.exampleVideoUrl || null, guideText: body.guideText || '',
    movementText: body.movementText || null, avoidText: body.avoidText || null,
    durationMin: body.durationMin ?? null, durationMax: body.durationMax ?? null,
    sortOrder: body.sortOrder || 0, source: 'store',
  } as any);
  return c.json({ success: true, id });
});

// POST /api/assets/templates/import — 导入系统模板（复制为门店模板）
route.post('/import', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const { systemTemplateId } = await c.req.json() as any;
  if (!systemTemplateId) return c.json({ success: false, error: 'systemTemplateId 为必填' }, 400);
  const [src] = await db.select().from(assetTemplates)
    .where(and(eq(assetTemplates.id, systemTemplateId), eq(assetTemplates.source, 'system'))).limit(1);
  if (!src) return c.json({ success: false, error: '系统模板不存在' }, 404);
  // 去重：同门店已有同名模板则返回已有
  const [dup] = await db.select({ id: assetTemplates.id }).from(assetTemplates)
    .where(and(...tenantWhere(scope, assetTemplates), eq(assetTemplates.source, 'store'), eq(assetTemplates.name, src.name))).limit(1);
  if (dup) return c.json({ success: true, id: dup.id, duplicated: true });
  const id = `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  await db.insert(assetTemplates).values({
    id, merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    name: src.name, shotType: src.shotType, mediaType: src.mediaType,
    category: src.category, purposeTags: src.purposeTags,
    exampleImageUrl: src.exampleImageUrl, exampleVideoUrl: src.exampleVideoUrl,
    guideText: src.guideText, movementText: src.movementText, avoidText: src.avoidText,
    durationMin: src.durationMin, durationMax: src.durationMax, sortOrder: src.sortOrder, source: 'store',
  } as any);
  return c.json({ success: true, id });
});

// PUT /api/assets/templates/:id — 更新（店长，前端 request.ts 的 put 走 PUT 动词）
route.put('/:id', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const body = await c.req.json() as any;
  const updates: any = {};
  // 字段归一化与 POST 路由对齐：文本字段 '' → null，数字字段 '' → null；字段未提供（undefined）则不更新
  const textFields = ['movementText', 'avoidText', 'guideText'];
  const numFields = ['durationMin', 'durationMax'];
  ['name', 'shotType', 'mediaType', 'category', 'exampleImageUrl', 'exampleVideoUrl', 'guideText',
   'movementText', 'avoidText', 'durationMin', 'durationMax', 'sortOrder'].forEach(k => {
    if (body[k] === undefined) return;
    if (textFields.includes(k)) updates[k] = body[k] || null;
    else if (numFields.includes(k)) updates[k] = body[k] === '' ? null : body[k];
    else updates[k] = body[k];
  });
  if (body.purposeTags !== undefined) updates.purposeTags = body.purposeTags;
  updates.updatedAt = new Date();
  await db.update(assetTemplates).set(updates)
    .where(and(eq(assetTemplates.id, id), ...tenantWhere(scope, assetTemplates)));
  return c.json({ success: true });
});

// DELETE /api/assets/templates/:id — 删除（店长）
route.delete('/:id', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  await db.delete(assetTemplates)
    .where(and(eq(assetTemplates.id, id), ...tenantWhere(scope, assetTemplates)));
  return c.json({ success: true });
});

export default route;
