import { z } from 'zod';

// ============ 子模型 ============

export const StaffMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  email: z.string().optional(),
  role: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  stores: z.array(z.string()),
  scope: z.string(),
  status: z.enum(['active', 'disabled']),
  lastLoginAt: z.string().optional(),
  createdAt: z.string(),
}).describe('员工');

export const StaffStatsSchema = z.object({
  total: z.number(),
  active: z.number(),
  disabled: z.number(),
  onlineToday: z.number(),
}).describe('员工统计');

export const RoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  staffCount: z.number(),
  isPreset: z.boolean(),
  scope: z.string(),
  permissions: z.array(z.string()),
}).describe('角色');

export const PermissionNodeSchema = z.object({
  key: z.string(),
  label: z.string(),
  children: z.array(z.object({
    key: z.string(),
    label: z.string(),
  })).optional(),
}).describe('权限节点');

export const OpLogSchema = z.object({
  id: z.string(),
  staffId: z.string(),
  staffName: z.string(),
  action: z.string(),
  module: z.string(),
  detail: z.string(),
  timestamp: z.string(),
  ip: z.string(),
  level: z.enum(['info', 'warning']),
}).describe('操作日志');

export const ModuleSchema = z.object({
  key: z.string(),
  label: z.string(),
}).describe('日志模块');

// ============ 查询参数 ============

export const StaffQuerySchema = z.object({
  type: z.enum(['roles', 'logs']).optional().describe('查询类型'),
  module: z.string().optional().describe('模块筛选'),
  operator: z.string().optional().describe('操作人筛选'),
}).describe('团队查询参数');

// ============ 路由定义 ============

export const getStaff = {
  method: 'get' as const,
  path: '/',
  summary: '获取团队数据',
  description: '返回员工列表/角色/操作日志',
  tags: ['团队管理'],
  request: { query: StaffQuerySchema },
  responses: {
    200: { description: '团队数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const postStaff = {
  method: 'post' as const,
  path: '/',
  summary: '团队操作',
  description: '添加员工/角色等',
  tags: ['团队管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '操作成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};

export const putStaff = {
  method: 'put' as const,
  path: '/',
  summary: '更新团队数据',
  description: '编辑员工/角色等',
  tags: ['团队管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '更新成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};

export const deleteStaff = {
  method: 'delete' as const,
  path: '/',
  summary: '删除团队数据',
  description: '删除员工/角色等',
  tags: ['团队管理'],
  request: {
    body: { content: { 'application/json': { schema: z.object({ id: z.string() }) } } },
  },
  responses: {
    200: { description: '删除成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};
