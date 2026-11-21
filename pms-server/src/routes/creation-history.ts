import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index';
import { pmsBuiCreationRecords } from '../db/schema/promotion';
import { getTenantScope, tenantWhere } from '../utils/tenant';
import { validateBody } from '../utils/validate';

const route = new Hono();

// GET /api/creation-records?type=copy|audio|video&limit=50
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const type = c.req.query('type') || 'all';
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

  const rows = await db
    .select()
    .from(pmsBuiCreationRecords)
    .where(and(...tenantWhere(scope, pmsBuiCreationRecords)))
    .orderBy(desc(pmsBuiCreationRecords.createdAt))
    .limit(limit);

  let items = rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    script: r.script,
    tags: r.tags,
    titles: (r.titles as string[]) || [],
    audioUrl: r.audioUrl,
    taskId: r.taskId,
    taskStatus: r.taskStatus,
    duration: r.duration,
    createdAt: r.createdAt,
  }));

  if (type !== 'all') {
    items = items.filter((i) => i.type === type);
  }
  return c.json({ success: true, data: items });
});

// POST /api/creation-records
const saveSchema = z.object({
  type: z.enum(['copy', 'audio', 'video']),
  title: z.string().optional(),
  script: z.string().optional(),
  tags: z.string().optional(),
  titles: z.array(z.string()).optional(),
  audioUrl: z.string().optional(),
  taskId: z.string().optional(),
  taskStatus: z.string().optional(),
  duration: z.number().optional(),
});

route.post('/', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const validation = await validateBody(body, saveSchema);
  if (!validation.success) {
    return c.json({ success: false, error: validation.error }, 400);
  }
  const d = validation.data;

  // 检查重复：相同 merchant + 相同 type + 相同 script 内容不重复添加
  if (d.script) {
    const [existing] = await db
      .select({ id: pmsBuiCreationRecords.id })
      .from(pmsBuiCreationRecords)
      .where(
        and(
          eq(pmsBuiCreationRecords.merchantId, scope.merchantId),
          eq(pmsBuiCreationRecords.type, d.type),
          eq(pmsBuiCreationRecords.script, d.script),
        ),
      )
      .limit(1);
    if (existing) {
      return c.json(
        { success: false, error: '该内容已存在创作记录中，请勿重复添加' },
        409,
      );
    }
  }

  const id = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(pmsBuiCreationRecords).values({
    id,
    merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    type: d.type,
    title: d.title || null,
    script: d.script || null,
    tags: d.tags || null,
    titles: d.titles || [],
    audioUrl: d.audioUrl || null,
    taskId: d.taskId || null,
    taskStatus: d.taskStatus || 'completed',
    duration: d.duration || null,
  } as any);
  return c.json({ success: true, data: { id } });
});

// PUT /api/creation-records/:id — 更新任务状态
route.put('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  const { taskStatus, audioUrl } = body as { taskStatus?: string; audioUrl?: string };

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (taskStatus) updates.taskStatus = taskStatus;
  if (audioUrl) updates.audioUrl = audioUrl;

  await db
    .update(pmsBuiCreationRecords)
    .set(updates as any)
    .where(
      and(
        eq(pmsBuiCreationRecords.id, id),
        ...tenantWhere(scope, pmsBuiCreationRecords),
      ),
    );
  return c.json({ success: true });
});

// DELETE /api/creation-records/:id
route.delete('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');
  await db
    .delete(pmsBuiCreationRecords)
    .where(
      and(
        eq(pmsBuiCreationRecords.id, id),
        ...tenantWhere(scope, pmsBuiCreationRecords),
      ),
    );
  return c.json({ success: true });
});

export default route;
