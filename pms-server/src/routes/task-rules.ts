// src/routes/task-rules.ts
import { Hono } from 'hono';
import { db } from '../db/index.js';
import { assetTaskRules } from '../db/schema/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { requirePermission } from '../middleware/permission-guard.js';
import { calcNextRunAt } from '../utils/rule-schedule.js';
import type { AuthUser } from '../middleware/auth.js';

const route = new Hono<{ Variables: { authUser?: AuthUser } }>();

// GET /api/task-rules — 规则列表（店长）
route.get('/', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const rows = await db.select().from(assetTaskRules)
    .where(and(...tenantWhere(scope, assetTaskRules)))
    .orderBy(desc(assetTaskRules.createdAt));
  return c.json({ list: rows });
});

// POST /api/task-rules — 创建规则
route.post('/', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser');
  const body = await c.req.json() as any;
  if (!body.name) return c.json({ success: false, error: 'name 为必填' }, 400);
  if (body.publishTime !== undefined && body.publishTime !== '' && !/^\d{1,2}:\d{2}$/.test(body.publishTime)) {
    return c.json({ success: false, error: 'publishTime 格式应为 HH:MM' }, 400);
  }
  const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  await db.insert(assetTaskRules).values({
    id, merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    name: body.name, templateRefs: body.templateRefs || [],
    roomTypeIds: body.roomTypeIds || [], roomTypeNames: body.roomTypeNames || [],
    purposeTags: body.purposeTags || [], guideText: body.guideText || '',
    assigneeScope: body.assigneeScope || 'all', assigneeStaffIds: body.assigneeStaffIds || [],
    publishTime: body.publishTime || '09:00',
    status: body.status === 'enabled' ? 'enabled' : 'disabled',
    nextRunAt: calcNextRunAt(body.publishTime || '09:00'),
    publisherId: authUser?.userId || null, publisherName: authUser?.name || null,
  } as any);
  return c.json({ success: true, id });
});

// PUT /api/task-rules/:id/status — 启停（注册在 /:id 之前避免歧义）
route.put('/:id/status', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const { status } = await c.req.json() as any;
  const [rule] = await db.select({ publishTime: assetTaskRules.publishTime }).from(assetTaskRules)
    .where(and(eq(assetTaskRules.id, id), ...tenantWhere(scope, assetTaskRules))).limit(1);
  if (!rule) return c.json({ success: false, error: '规则不存在' }, 404);
  const enabled = status === 'enabled';
  const updates: any = { status: enabled ? 'enabled' : 'disabled', updatedAt: new Date() };
  if (enabled) updates.nextRunAt = calcNextRunAt(rule.publishTime || '09:00'); // 开启时按规则自身 publishTime 重算
  await db.update(assetTaskRules).set(updates)
    .where(and(eq(assetTaskRules.id, id), ...tenantWhere(scope, assetTaskRules)));
  return c.json({ success: true });
});

// PUT /api/task-rules/:id — 更新规则
route.put('/:id', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const body = await c.req.json() as any;
  if (body.publishTime !== undefined && body.publishTime !== '' && !/^\d{1,2}:\d{2}$/.test(body.publishTime)) {
    return c.json({ success: false, error: 'publishTime 格式应为 HH:MM' }, 400);
  }
  const updates: any = {};
  // status 走 /:id/status 专用接口，此处不更新
  ['name', 'templateRefs', 'roomTypeIds', 'roomTypeNames', 'purposeTags', 'guideText',
    'assigneeScope', 'assigneeStaffIds'].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (body.publishTime !== undefined) {
    updates.publishTime = body.publishTime;
    updates.nextRunAt = calcNextRunAt(body.publishTime);
  }
  updates.updatedAt = new Date();
  const result = await db.update(assetTaskRules).set(updates)
    .where(and(eq(assetTaskRules.id, id), ...tenantWhere(scope, assetTaskRules)));
  if (result.rowCount === 0) return c.json({ success: false, error: '规则不存在' }, 404);
  return c.json({ success: true });
});

// DELETE /api/task-rules/:id — 删除规则
route.delete('/:id', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const result = await db.delete(assetTaskRules)
    .where(and(eq(assetTaskRules.id, id), ...tenantWhere(scope, assetTaskRules)));
  if (result.rowCount === 0) return c.json({ success: false, error: '规则不存在' }, 404);
  return c.json({ success: true });
});

export default route;
