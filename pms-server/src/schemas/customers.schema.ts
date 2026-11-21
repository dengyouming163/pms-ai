import { z } from 'zod';

// ============ 子模型 ============

export const MemberLevelSchema = z.object({
  key: z.string(),
  name: z.string(),
  icon: z.string(),
  discount: z.number(),
}).describe('会员等级');

export const CustomerSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string(),
  memberLevel: MemberLevelSchema,
  valueScore: z.number(),
  stayCount: z.number(),
  lastStay: z.string(),
  totalSpent: z.number(),
  tags: z.array(z.string()),
  preferences: z.array(z.string()).optional(),
  source: z.string(),
  createdAt: z.string(),
}).describe('客户');

export const CustomerStatsSchema = z.object({
  total: z.number(),
  newThisMonth: z.number(),
  vipCount: z.number(),
  regularCount: z.number(),
  carePending: z.number(),
  avgValueScore: z.number(),
}).describe('客户统计');

export const TagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  count: z.number(),
  isAuto: z.boolean(),
  description: z.string().optional(),
}).describe('标签');

export const AutoRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  rule: z.string(),
  field: z.string(),
  tag: z.string(),
  enabled: z.boolean(),
}).describe('自动打标规则');

export const CareReminderSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  type: z.enum(['birthday', 'rebuy', 'vip_upgrade', 'inactive']),
  priority: z.enum(['high', 'medium', 'low']),
  content: z.string(),
  status: z.enum(['pending', 'done']),
  date: z.string(),
}).describe('关怀提醒');

// ============ 查询参数 ============

export const CustomerQuerySchema = z.object({
  type: z.enum(['list', 'tags', 'stats', 'detail', 'care', 'auto-rules']).optional().describe('查询类型'),
  id: z.string().optional().describe('客户ID'),
  keyword: z.string().optional().describe('关键词搜索'),
  tag: z.string().optional().describe('标签筛选'),
  level: z.string().optional().describe('等级筛选'),
}).describe('客户查询参数');

// ============ 请求 ============

export const EditTagRequestSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
}).describe('编辑标签请求');

export const DeleteTagRequestSchema = z.object({
  id: z.string(),
}).describe('删除标签请求');

export const AddAutoRuleRequestSchema = z.object({
  name: z.string(),
  rule: z.string(),
  field: z.string(),
  tag: z.string(),
}).describe('添加自动规则请求');

// ============ 路由定义 ============

export const getCustomers = {
  method: 'get' as const,
  path: '/',
  summary: '获取客户数据',
  description: '返回客户列表/标签/统计/详情/关怀/自动规则',
  tags: ['客户管理'],
  request: { query: CustomerQuerySchema },
  responses: {
    200: { description: '客户数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const postCustomers = {
  method: 'post' as const,
  path: '/',
  summary: '客户操作',
  description: '编辑标签/删除标签/添加规则/发送关怀等',
  tags: ['客户管理'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '操作成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};
