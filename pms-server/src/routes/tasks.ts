import { Hono } from 'hono';
import { db } from '../db/index.js';
import { assetTasks, assetTemplates, assetTaskSubmissions, mediaAssets, pmsBuiStaff } from '../db/schema/index.js';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { requirePermission } from '../middleware/permission-guard.js';
import { isTaskCompleted, computeTaskStats } from '../utils/task-completion.js';
import { isAssetsManager } from './assets.js';
import { createAssetTask } from './create-asset-task.js';
import type { AuthUser } from '../middleware/auth.js';

const route = new Hono<{ Variables: { authUser?: AuthUser } }>();

// GET /api/tasks — 任务列表（店长=全部，员工=指派给自己的；支持 status/date 过滤 + limit/offset 分页）
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser');
  const status = c.req.query('status');
  const date = c.req.query('date');
  // 分页：limit 默认 100，上限 200 防止一次拉取过大；offset 默认 0
  const limitRaw = Number(c.req.query('limit') ?? 100);
  const offsetRaw = Number(c.req.query('offset') ?? 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

  const conditions = [...tenantWhere(scope, assetTasks)];
  if (status) conditions.push(eq(assetTasks.status, status));

  // 过滤前总数：仅统计租户 + status 条件的记录数（assignee/date 为后续前端过滤，不计入）
  const [totalRow] = await db.select({ total: sql<number>`count(*)::int` }).from(assetTasks).where(and(...conditions));
  const total = totalRow?.total ?? 0;

  const rows = await db.select().from(assetTasks)
    .where(and(...conditions)).orderBy(desc(assetTasks.taskDate), desc(assetTasks.createdAt));

  const isManager = await isAssetsManager(c);
  const staffId = authUser?.userId || '';
  let tasks = rows;
  if (!isManager) {
    tasks = rows.filter(t =>
      t.assigneeScope === 'all' ||
      ((t.assigneeStaffIds as string[]) || []).includes(staffId)
    );
  }
  if (date) tasks = tasks.filter(t => (t.taskDate || '').startsWith(date));

  // 在 assignee/date 过滤后切片分页
  const paged = tasks.slice(offset, offset + limit);

  return c.json({ list: paged.map(t => ({
    id: t.id, title: t.title, taskDate: t.taskDate, deadline: t.deadline,
    status: t.status, purposeTags: t.purposeTags, roomNames: t.roomNames,
    roomTypeNames: t.roomTypeNames,
    assigneeScope: t.assigneeScope, assigneeStaffIds: t.assigneeStaffIds,
    shotRequirements: t.shotRequirements, guideText: t.guideText,
    publisherName: t.publisherName,
    createdAt: t.createdAt,
  })), total });
});

// GET /api/tasks/:id — 任务详情（展开模板示例）
route.get('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const [task] = await db.select().from(assetTasks)
    .where(and(eq(assetTasks.id, id), ...tenantWhere(scope, assetTasks))).limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);

  // 以存储快照为准（与提交判定一致），仅用模板按 shotType 补充示例字段，不改变 shotType/count
  const templateRows = await db.select().from(assetTemplates).where(and(...tenantWhere(scope, assetTemplates)));
  const snapshot = (task.shotRequirements as any[]) || [];
  const shotRequirements = snapshot.map((r: any) => {
    // 同 shotType 存在图文两个模板，需按 mediaType 精确匹配（旧快照无 mediaType 按 image）
    const mt = r.mediaType || 'image';
    const t = templateRows.find((x: any) => x.shotType === r.shotType && (x.mediaType || 'image') === mt);
    return {
      ...r,
      guideText: r.guideText || t?.guideText || '',
      movementText: r.movementText || t?.movementText || '',
      avoidText: r.avoidText || t?.avoidText || '',
      durationMin: r.durationMin ?? t?.durationMin ?? null,
      durationMax: r.durationMax ?? t?.durationMax ?? null,
      exampleImageUrl: t?.exampleImageUrl || null,
      exampleVideoUrl: t?.exampleVideoUrl || null,
    };
  });

  // 员工视角：自己的提交记录
  const authUser = c.get('authUser');
  const staffId = authUser?.userId;
  let mySubmission: any = null;
  if (staffId) {
    const [sub] = await db.select().from(assetTaskSubmissions)
      .where(and(eq(assetTaskSubmissions.taskId, id), eq(assetTaskSubmissions.staffId, staffId))).limit(1);
    if (sub) mySubmission = { status: sub.status, assetIds: sub.assetIds, assetCount: ((sub.assetIds as any[]) || []).length };
  }

  return c.json({ task: {
    ...task, shotRequirements, mySubmission,
    isManager: await isAssetsManager(c),
  } });
});

// POST /api/tasks — 发布任务（店长）
route.post('/', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser');
  const body = await c.req.json() as any;
  if (!body.title) return c.json({ success: false, error: 'title 为必填' }, 400);
  const id = await createAssetTask(scope, body, authUser?.userId || null, authUser?.name || null);
  return c.json({ success: true, id });
});

// POST /api/tasks/:id/submit — 员工提交打卡（后端校验达标）
route.post('/:id/submit', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const authUser = c.get('authUser');
  const staffId = authUser?.userId || '';
  const staffName = authUser?.name || null;
  const body = await c.req.json() as any;
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds : [];
  const note = body.note || '';

  const [task] = await db.select().from(assetTasks)
    .where(and(eq(assetTasks.id, id), ...tenantWhere(scope, assetTasks))).limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);

  // 校验员工是否被指派（selected 任务）
  if (task.assigneeScope === 'selected') {
    const assignedIds = (task.assigneeStaffIds as string[]) || [];
    if (!assignedIds.includes(staffId)) {
      return c.json({ success: false, error: '你未被指派到该任务' }, 403);
    }
  }

  // 截止后禁止提交
  if (task.deadline && new Date(task.deadline).getTime() < Date.now()) {
    return c.json({ success: false, error: '任务已截止，无法打卡' }, 400);
  }

  // 查本次 + 历史素材（合并去重后判定达标，支持补足）
  const [existing] = await db.select().from(assetTaskSubmissions)
    .where(and(eq(assetTaskSubmissions.taskId, id), eq(assetTaskSubmissions.staffId, staffId))).limit(1);
  const prevIds = (existing?.assetIds as string[]) || [];
  const allIds = Array.from(new Set([...prevIds, ...assetIds]));
  // 仅统计提交员工本人上传的素材，防止借他人素材凑数达标
  const assetConditions = [...tenantWhere(scope, mediaAssets), eq(mediaAssets.status, 'active'), eq(mediaAssets.uploaderStaffId, staffId)];
  const assets = allIds.length
    ? await db.select({ id: mediaAssets.id, shotType: mediaAssets.shotType, mediaType: mediaAssets.mediaType })
        .from(mediaAssets).where(and(...assetConditions, inArray(mediaAssets.id, allIds)))
    : [];
  const requirements = (task.shotRequirements as any[]) || [];
  const completed = isTaskCompleted(requirements, assets);

  const status = completed ? 'completed' : 'submitted';
  if (existing) {
    await db.update(assetTaskSubmissions).set({
      status, assetIds: allIds, note,
      submittedAt: new Date(),
      completedAt: completed ? new Date() : null,
    }).where(eq(assetTaskSubmissions.id, existing.id));
  } else {
    const sid = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await db.insert(assetTaskSubmissions).values({
      id: sid, merchantId: scope.merchantId,
      storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
      taskId: id, staffId, staffName, status, assetIds: allIds, note,
      submittedAt: new Date(), completedAt: completed ? new Date() : null,
    } as any);
  }
  return c.json({ success: true, status });
});

// GET /api/tasks/:id/statistics — 完成率统计（店长）
route.get('/:id/statistics', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const [task] = await db.select().from(assetTasks)
    .where(and(eq(assetTasks.id, id), ...tenantWhere(scope, assetTasks))).limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);

  const subs = await db.select().from(assetTaskSubmissions)
    .where(eq(assetTaskSubmissions.taskId, id));

  // 应执行员工：all → 本店 active 员工（商户级任务=本商户所有 active 员工）；selected → 指定 active 员工
  let staff: Array<{ id: string; name: string }> = [];
  const active = eq(pmsBuiStaff.status, 'active');
  if (task.assigneeScope === 'all') {
    if (task.storeId === 'default_store' || task.storeId === '*') {
      // 商户级任务：本商户所有 active 员工（不含其它门店员工）
      staff = await db.select({ id: pmsBuiStaff.id, name: pmsBuiStaff.name })
        .from(pmsBuiStaff).where(and(eq(pmsBuiStaff.merchantId, scope.merchantId), active));
    } else {
      // 门店级任务：仅该门店的 active 员工（stores jsonb 数组包含任务 storeId）
      staff = await db.select({ id: pmsBuiStaff.id, name: pmsBuiStaff.name })
        .from(pmsBuiStaff).where(and(
          eq(pmsBuiStaff.merchantId, scope.merchantId),
          active,
          sql`${pmsBuiStaff.stores} ?| ARRAY[${task.storeId}]::text[]`,
        ));
    }
  } else {
    const ids = (task.assigneeStaffIds as string[]) || [];
    if (ids.length) {
      const rows = await db.select({ id: pmsBuiStaff.id, name: pmsBuiStaff.name })
        .from(pmsBuiStaff).where(and(
          eq(pmsBuiStaff.merchantId, scope.merchantId),
          eq(pmsBuiStaff.status, 'active'),
        ));
      staff = rows.filter(r => ids.includes(r.id));
    }
  }

  const rows = computeTaskStats(staff, subs as any);
  const total = rows.length;
  const completed = rows.filter(r => r.status === 'completed').length;
  const submitted = rows.filter(r => r.status === 'submitted').length;
  // 逾期仅统计「未提交(pending)且过截止」——submitted 已计入「已提交」行，二者互斥不重叠
  const overdue = rows.filter(r =>
    r.status === 'pending' && task.deadline && new Date(task.deadline).getTime() < Date.now()
  ).length;

  return c.json({
    statistics: { total, submitted, completed, overdue, rows },
  });
});

export default route;
