import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '../db/index';
import { pmsBuiStaff, pmsBuiRoles, pmsBuiOpLogs } from '../db/schema';
import { eq, desc, sql, and, or, like, type SQL } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { JWT_SECRET } from '../constants.js';
import { PERMISSION_TREE, PRESET_ROLE_PERMISSIONS } from '../utils/permissions.js';
import { requirePermission } from '../middleware/permission-guard.js';

const route = new Hono();

const moduleLabels: Record<string, string> = {
  dashboard: '工作台', stores: '门店管理', rooms: '房态管理', orders: '订单管理',
  pricing: '价格管理', channels: '渠道管理', finance: '收支明细', customers: '客户管理',
  staff: '团队管理', settings: '系统设置', 'data-center': 'AI助手',
};

const scopeLabels: Record<string, string> = {
  tenant: '全部门店', brand: '品牌级', store: '门店级',
};

const defaultRoleColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

function getMerchantId(c: any): string {
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    try { const p = jwt.verify(auth.slice(7), JWT_SECRET) as any; return p.merchantId || 'default'; } catch {}
  }
  return 'default';
}

route.get('/', async (c) => {
  const type = c.req.query('type');
  const module = c.req.query('module');
  const operator = c.req.query('operator');
  const mid = getMerchantId(c);

  if (type === 'roles') {
    const roles = await db.select().from(pmsBuiRoles)
      .where(eq(pmsBuiRoles.merchantId, mid))
      .orderBy(desc(pmsBuiRoles.createdAt));
    const formattedRoles = roles.map((r, i) => ({
      ...r, color: defaultRoleColors[i % defaultRoleColors.length],
    }));
    const permissionTree = PERMISSION_TREE;
    return c.json({ roles: formattedRoles, permissionTree });
  }

  if (type === 'logs') {
    const conditions = [eq(pmsBuiOpLogs.merchantId, mid)];
    if (module) conditions.push(eq(pmsBuiOpLogs.module, module));
    if (operator) conditions.push(eq(pmsBuiOpLogs.staffName, operator));
    const logs = await db.select().from(pmsBuiOpLogs)
      .where(and(...conditions))
      .orderBy(desc(pmsBuiOpLogs.timestamp)).limit(200);
    const modules = Object.entries(moduleLabels).map(([key, label]) => ({ key, label }));
    const operators = await db.selectDistinct({ staffName: pmsBuiOpLogs.staffName }).from(pmsBuiOpLogs).where(eq(pmsBuiOpLogs.merchantId, mid));
    return c.json({ logs, modules, operators });
  }

  const keyword = c.req.query('keyword');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(pmsBuiStaff.merchantId, mid)];
  if (keyword) {
    conditions.push(or(
      like(pmsBuiStaff.name, `%${keyword}%`),
      like(pmsBuiStaff.phone, `%${keyword}%`),
      like(pmsBuiStaff.roleName, `%${keyword}%`),
    ) as SQL);
  }
  const whereClause = and(...conditions);

  const countResult = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiStaff).where(whereClause);
  const total = Number(countResult[0].count);
  const staffList = await db.select().from(pmsBuiStaff).where(whereClause)
    .orderBy(desc(pmsBuiStaff.createdAt)).limit(limit).offset(offset);

  // 统计
  const allStaff = await db.select({ status: pmsBuiStaff.status }).from(pmsBuiStaff)
    .where(eq(pmsBuiStaff.merchantId, mid));
  const activeStaff = allStaff.filter(s => s.status === 'active').length;
  const disabledStaff = allStaff.filter(s => s.status === 'disabled').length;

  const formattedStaff = staffList.map(s => ({
    ...s,
    scope: scopeLabels[s.scope as string] || s.scope,
    joinDate: s.createdAt ? new Date(s.createdAt).toISOString().split('T')[0] : '',
  }));

  return c.json({
    staff: formattedStaff,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    stats: { total: allStaff.length, active: activeStaff, disabled: disabledStaff, onlineToday: activeStaff },
  });
});

// Zod schema — 接受前端 snake_case action 名称
const staffActionSchema = z.object({
  action: z.string(),
  data: z.record(z.string(), z.any()).optional(),
  staffId: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  department: z.string().optional(),
  position: z.string().optional(),
  roleId: z.string().optional(),
  roleName: z.string().optional(),
  scope: z.string().optional(),
  stores: z.array(z.string()).optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
  color: z.string().optional(),
});

route.post('/', requirePermission('staff:edit'), async (c) => {
  const body = await c.req.json();
  // 兼容前端 data 包裹和扁平的两种格式
  const actionData = (body.data && typeof body.data === 'object') ? { ...body, ...body.data } : body;
  const action = body.action || '';

  if (action === 'create_staff') {
    const { name, phone, email, department, position, roleId, roleName, stores, scope } = actionData;
    if (!name || !phone) return c.json({ success: false, error: '姓名和手机号为必填' }, 400);
    const mid = getMerchantId(c);
    const id = `staff-${Date.now()}`;
    await db.insert(pmsBuiStaff).values({
      id, merchantId: mid, name, phone, email: email || '',
      department: department || '', position: position || '',
      roleId: roleId || '', roleName: roleName || '',
      stores: stores || [], scope: scope || 'store', status: 'active',
    } as any);
    return c.json({ success: true, id });
  }

  if (action === 'edit_staff') {
    const { staffId, name, phone, roleId, roleName, stores, scope, status } = actionData;
    if (!staffId) return c.json({ success: false, error: 'staffId 为必填' }, 400);
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (roleId !== undefined) updates.roleId = roleId;
    if (roleName !== undefined) updates.roleName = roleName;
    if (stores !== undefined) updates.stores = stores;
    if (scope !== undefined) updates.scope = scope;
    if (status !== undefined) updates.status = status;
    updates.updatedAt = new Date();
    await db.update(pmsBuiStaff).set(updates).where(eq(pmsBuiStaff.id, staffId));
    return c.json({ success: true });
  }

  if (action === 'toggle_staff') {
    const staffId = actionData.staffId || body.staffId;
    if (!staffId) return c.json({ success: false, error: 'staffId 为必填' }, 400);
    const [s] = await db.select({ status: pmsBuiStaff.status }).from(pmsBuiStaff).where(eq(pmsBuiStaff.id, staffId)).limit(1);
    if (!s) return c.json({ success: false, error: '员工不存在' }, 404);
    const newStatus = s.status === 'active' ? 'disabled' : 'active';
    await db.update(pmsBuiStaff).set({ status: newStatus, updatedAt: new Date() } as any).where(eq(pmsBuiStaff.id, staffId));
    return c.json({ success: true, status: newStatus });
  }

  if (action === 'reset_password') {
    const staffId = actionData.staffId || body.staffId;
    if (!staffId) return c.json({ success: false, error: 'staffId 为必填' }, 400);
    const defaultPwd = await bcrypt.hash('123456', 10);
    await db.update(pmsBuiStaff).set({ password: defaultPwd, updatedAt: new Date() } as any).where(eq(pmsBuiStaff.id, staffId));
    return c.json({ success: true, message: '密码已重置为 123456' });
  }

  if (action === 'create_role') {
    const { name, description, scope, permissions } = actionData;
    if (!name) return c.json({ success: false, error: '角色名称为必填' }, 400);
    const mid = getMerchantId(c);
    // 匹配预置权限
    const presetPerms = PRESET_ROLE_PERMISSIONS[name] || null;
    const id = `role-${Date.now()}`;
    await db.insert(pmsBuiRoles).values({
      id, merchantId: mid, name, description: description || '', scope: scope || 'store',
      isPreset: false, staffCount: 0, permissions: permissions || [],
    } as any);
    return c.json({ success: true, id });
  }

  if (action === 'edit_role') {
    const { roleId, name, description, scope, permissions } = actionData;
    if (!roleId) return c.json({ success: false, error: 'roleId 为必填' }, 400);
    const updates: any = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (scope !== undefined) updates.scope = scope;
    if (permissions !== undefined) updates.permissions = permissions;
    await db.update(pmsBuiRoles).set(updates).where(eq(pmsBuiRoles.id, roleId));
    return c.json({ success: true });
  }

  if (action === 'delete_role') {
    const roleId = actionData.roleId || body.roleId;
    if (!roleId) return c.json({ success: false, error: 'roleId 为必填' }, 400);
    await db.delete(pmsBuiRoles).where(eq(pmsBuiRoles.id, roleId));
    return c.json({ success: true });
  }

  return c.json({ success: false, error: '未知操作: ' + action }, 400);
});

export default route;
