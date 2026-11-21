import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index';
import { pmsBuiHousekeepingTasks, pmsBuiStaff, pmsBuiRooms } from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';

const route = new Hono();

// ============ GET /api/housekeeping ============
route.get('/', async (c) => {
  const status = c.req.query('status');
  const storeId = c.req.query('storeId');
  const scope = getTenantScope(c);

  // 查询条件（租户隔离 + 可选过滤）
  const conditions: any[] = [...tenantWhere(scope, pmsBuiHousekeepingTasks)];
  if (status) {
    conditions.push(eq(pmsBuiHousekeepingTasks.status, status));
  }
  if (storeId) {
    conditions.push(eq(pmsBuiHousekeepingTasks.storeId, storeId));
  }

  // 任务列表
  const tasks = conditions.length > 0
    ? await db.select().from(pmsBuiHousekeepingTasks).where(and(...conditions))
        .orderBy(sql`CASE
          WHEN ${pmsBuiHousekeepingTasks.priority} = 'urgent' THEN 1
          WHEN ${pmsBuiHousekeepingTasks.priority} = 'high' THEN 2
          WHEN ${pmsBuiHousekeepingTasks.priority} = 'normal' THEN 3
          ELSE 4
        END`, desc(pmsBuiHousekeepingTasks.createdAt))
    : await db.select().from(pmsBuiHousekeepingTasks)
        .orderBy(sql`CASE
          WHEN ${pmsBuiHousekeepingTasks.priority} = 'urgent' THEN 1
          WHEN ${pmsBuiHousekeepingTasks.priority} = 'high' THEN 2
          WHEN ${pmsBuiHousekeepingTasks.priority} = 'normal' THEN 3
          ELSE 4
        END`, desc(pmsBuiHousekeepingTasks.createdAt));

  // 清洁工列表（客房部员工，租户隔离）
  const cleaners = await db.select({
    id: pmsBuiStaff.id,
    name: pmsBuiStaff.name,
    phone: pmsBuiStaff.phone,
  }).from(pmsBuiStaff).where(and(
    sql`(${pmsBuiStaff.department} = '客房部' OR ${pmsBuiStaff.position} = '清洁') AND ${pmsBuiStaff.status} = 'active'`,
    ...tenantWhere(scope, pmsBuiStaff),
  ));

  // 统计摘要（租户隔离）
  const allTasks = await db.select().from(pmsBuiHousekeepingTasks)
    .where(and(...tenantWhere(scope, pmsBuiHousekeepingTasks)));
  const summary = {
    total: allTasks.length,
    pending: allTasks.filter(t => t.status === 'pending').length,
    inProgress: allTasks.filter(t => t.status === 'in_progress' || t.status === 'assigned').length,
    completed: allTasks.filter(t => t.status === 'completed').length,
    inspected: allTasks.filter(t => t.status === 'inspected').length,
    urgentCount: allTasks.filter(t => t.priority === 'urgent').length,
    highCount: allTasks.filter(t => t.priority === 'high').length,
  };

  return c.json({ success: true, data: { tasks, cleaners, summary } });
});

// ============ POST /api/housekeeping ============

// Zod 请求体验证 schema
const housekeepingActionSchema = z.discriminatedUnion('action', [
  // 创建任务
  z.object({
    action: z.literal('create'),
    storeId: z.string().min(1, '门店ID不能为空'),
    roomId: z.string().min(1, '房间ID不能为空'),
    roomNumber: z.string().min(1, '房间号不能为空'),
    roomTypeName: z.string().optional(),
    floor: z.number().optional(),
    taskType: z.enum(['退房清洁', '日常保洁', '维修', '深度清洁', '定期检修']),
    priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
    remark: z.string().optional(),
  }),
  // 分配任务
  z.object({
    action: z.literal('assign'),
    taskId: z.string().min(1, '任务ID不能为空'),
    assigneeId: z.string().min(1, '指派人ID不能为空'),
    assigneeName: z.string().min(1, '指派人姓名不能为空'),
    priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
    estimatedDuration: z.number().optional(),
    remark: z.string().optional(),
  }),
  // 开始执行
  z.object({
    action: z.literal('start'),
    taskId: z.string().min(1, '任务ID不能为空'),
  }),
  // 完成
  z.object({
    action: z.literal('complete'),
    taskId: z.string().min(1, '任务ID不能为空'),
  }),
  // 检查验收
  z.object({
    action: z.literal('inspect'),
    taskId: z.string().min(1, '任务ID不能为空'),
    inspectorId: z.string().min(1, '检查人ID不能为空'),
    inspectorName: z.string().min(1, '检查人姓名不能为空'),
  }),
  // 取消
  z.object({
    action: z.literal('cancel'),
    taskId: z.string().min(1, '任务ID不能为空'),
    reason: z.string().optional(),
  }),
]);

route.post('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, housekeepingActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;
  const scope = getTenantScope(c);
  const now = new Date();

  // 创建任务
  if (data.action === 'create') {
    const taskId = `hkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // 获取房间信息以填充缺失字段（租户隔离）
    const [room] = await db.select().from(pmsBuiRooms)
      .where(and(eq(pmsBuiRooms.id, data.roomId), ...tenantWhere(scope, pmsBuiRooms)));

    await db.insert(pmsBuiHousekeepingTasks).values({
      id: taskId,
      storeId: data.storeId,
      roomId: data.roomId,
      roomNumber: data.roomNumber,
      roomTypeName: data.roomTypeName || room?.roomTypeName || '',
      floor: data.floor ?? room?.floor ?? 1,
      status: 'pending',
      taskType: data.taskType,
      priority: data.priority || 'normal',
      remark: data.remark || null,
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ success: true, message: '任务已创建', taskId });
  }

  // 分配任务
  if (data.action === 'assign') {
    await db.update(pmsBuiHousekeepingTasks).set({
      status: 'assigned',
      assigneeId: data.assigneeId,
      assigneeName: data.assigneeName,
      priority: data.priority,
      estimatedDuration: data.estimatedDuration,
      remark: data.remark,
      updatedAt: now,
    }).where(and(eq(pmsBuiHousekeepingTasks.id, data.taskId), ...tenantWhere(scope, pmsBuiHousekeepingTasks)));

    return c.json({ success: true, message: '任务已分配' });
  }

  // 开始执行
  if (data.action === 'start') {
    await db.update(pmsBuiHousekeepingTasks).set({
      status: 'in_progress',
      startedAt: now,
      updatedAt: now,
    }).where(and(eq(pmsBuiHousekeepingTasks.id, data.taskId), ...tenantWhere(scope, pmsBuiHousekeepingTasks)));

    return c.json({ success: true, message: '任务已开始' });
  }

  // 完成
  if (data.action === 'complete') {
    await db.update(pmsBuiHousekeepingTasks).set({
      status: 'completed',
      completedAt: now,
      updatedAt: now,
    }).where(and(eq(pmsBuiHousekeepingTasks.id, data.taskId), ...tenantWhere(scope, pmsBuiHousekeepingTasks)));

    // 同时将房间标记为干净（租户隔离）
    const [task] = await db.select().from(pmsBuiHousekeepingTasks)
      .where(and(eq(pmsBuiHousekeepingTasks.id, data.taskId), ...tenantWhere(scope, pmsBuiHousekeepingTasks)));
    if (task && task.roomId) {
      await db.update(pmsBuiRooms).set({
        status: 'available',
        guestName: null,
        guestPhone: null,
        checkInDate: null,
        checkOutDate: null,
        bookingId: null,
        dirtyType: null,
        updatedAt: now,
      }).where(and(eq(pmsBuiRooms.id, task.roomId), ...tenantWhere(scope, pmsBuiRooms)));
    }

    return c.json({ success: true, message: '任务已完成，房间已标记为干净' });
  }

  // 检查验收
  if (data.action === 'inspect') {
    await db.update(pmsBuiHousekeepingTasks).set({
      status: 'inspected',
      inspectedAt: now,
      inspectorId: data.inspectorId,
      inspectorName: data.inspectorName,
      updatedAt: now,
    }).where(and(eq(pmsBuiHousekeepingTasks.id, data.taskId), ...tenantWhere(scope, pmsBuiHousekeepingTasks)));

    return c.json({ success: true, message: '检查验收通过' });
  }

  // 取消
  if (data.action === 'cancel') {
    await db.update(pmsBuiHousekeepingTasks).set({
      status: 'cancelled',
      remark: data.reason ? `取消原因: ${data.reason}` : null,
      updatedAt: now,
    }).where(and(eq(pmsBuiHousekeepingTasks.id, data.taskId), ...tenantWhere(scope, pmsBuiHousekeepingTasks)));

    return c.json({ success: true, message: '任务已取消' });
  }

  return c.json({ success: false, error: '无效操作' }, 400);
});

export default route;
