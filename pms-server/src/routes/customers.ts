import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index';
import {
  pmsBuiCustomers, pmsBuiTags, pmsBuiAutoTagRules, pmsBuiCareReminders
} from '../db/schema';
import { eq, desc, sql, and, or, like } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { getTenantScope, tenantWhere } from '../utils/tenant';

const route = new Hono();

// Member level config mapping
const memberLevelMap: Record<string, { key: string; name: string; discount: number; icon: string }> = {
  diamond: { key: 'diamond', name: '钻石会员', discount: 75, icon: '💎' },
  gold: { key: 'gold', name: '金卡会员', discount: 85, icon: '🥇' },
  silver: { key: 'silver', name: '银卡会员', discount: 92, icon: '🥈' },
  regular: { key: 'regular', name: '普通会员', discount: 100, icon: '🎫' },
};

// Build tag ID→name map
async function getTagNameMap(scope?: any): Promise<Record<string, string>> {
  const conditions = scope ? and(...tenantWhere(scope, pmsBuiTags)) : undefined;
  const tags = await db.select().from(pmsBuiTags).where(conditions);
  const map: Record<string, string> = {};
  for (const t of tags) {
    map[t.id] = t.name;
  }
  return map;
}

// Format a customer row for frontend
function formatCustomer(c: any, tagNameMap: Record<string, string>) {
  const level = memberLevelMap[c.memberLevel] || memberLevelMap.regular;
  // Convert tag IDs to tag names
  let tagNames: string[] = [];
  if (c.tags && Array.isArray(c.tags)) {
    tagNames = c.tags.map((t: string) => tagNameMap[t] || t);
  }
  return {
    ...c,
    memberLevel: level,
    tags: tagNames,
  };
}

route.get('/', async (c) => {
  const type = c.req.query('type');
  const keyword = c.req.query('keyword');
  const tag = c.req.query('tag');
  const level = c.req.query('level');
  const id = c.req.query('id');
  const scope = getTenantScope(c);

  if (type === 'stats') {
    const customers = await db.select().from(pmsBuiCustomers).where(and(...tenantWhere(scope, pmsBuiCustomers)));
    const tags = await db.select().from(pmsBuiTags).where(and(...tenantWhere(scope, pmsBuiTags)));
    const reminders = await db.select().from(pmsBuiCareReminders).where(and(...tenantWhere(scope, pmsBuiCareReminders)));
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const dormantCount = customers.filter(c => {
      if (!c.lastStayDate) return true;
      return c.lastStayDate < ninetyDaysAgo;
    }).length;

    return c.json({
      total: customers.length,
      newThisMonth: customers.filter(c => {
        const d = new Date(c.createdAt);
        const now = new Date();
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }).length,
      vipCount: customers.filter(c => c.memberLevel === 'diamond' || c.memberLevel === 'gold').length,
      regularCount: customers.filter(c => c.memberLevel === 'silver' || c.memberLevel === 'regular').length,
      carePending: reminders.filter(r => r.status === 'pending').length,
      avgValueScore: customers.length > 0
        ? Math.round(customers.reduce((s, c) => s + (c.valueScore || 0), 0) / customers.length)
        : 0,
      tagCount: tags.length,
      dormantCount,
    });
  }

  if (type === 'tags') {
    const tags = await db.select().from(pmsBuiTags).where(and(...tenantWhere(scope, pmsBuiTags))).orderBy(desc(pmsBuiTags.createdAt));
    return c.json({ tags });
  }

  if (type === 'auto-rules') {
    const rules = await db.select().from(pmsBuiAutoTagRules).where(and(...tenantWhere(scope, pmsBuiAutoTagRules))).orderBy(desc(pmsBuiAutoTagRules.createdAt));
    const tagNameMap = await getTagNameMap(scope);
    // Field name mapping for Chinese display
    const fieldLabels: Record<string, string> = {
      totalSpent: '累计消费',
      stayCount: '入住次数',
      nights: '入住间夜',
      avgPrice: '平均房价',
      lastStayDate: '最近入住日期',
      memberLevel: '会员等级',
      valueScore: '价值评分',
    };
    const formattedRules = rules.map(r => ({
      ...r,
      tag: tagNameMap[r.tag] || r.tag,
      field: fieldLabels[r.field] || r.field,
    }));
    return c.json({ rules: formattedRules });
  }

  if (type === 'care') {
    const reminders = await db.select().from(pmsBuiCareReminders).where(and(...tenantWhere(scope, pmsBuiCareReminders))).orderBy(desc(pmsBuiCareReminders.dueDate));
    // Map DB type to frontend-known type if needed
    const typeMapping: Record<string, string> = {
      inactive: 'rebuy',     // 沉默客户→复购提醒
      contract: 'upgrade',   // 合同续约→升级促活
    };
    const formattedReminders = reminders.map(r => ({
      id: r.id,
      customerId: r.customerId,
      customerName: r.customerName,
      type: typeMapping[r.type] || r.type,  // Remap unknown types
      message: r.content,      // content → message
      date: r.dueDate,         // dueDate → date
      priority: r.priority,
      status: r.status,
      completedAt: r.completedAt,
      note: r.note,
    }));
    return c.json({ reminders: formattedReminders });
  }

  if (type === 'detail' && id) {
    const customer = await db.select().from(pmsBuiCustomers).where(and(eq(pmsBuiCustomers.id, id), ...tenantWhere(scope, pmsBuiCustomers))).limit(1);
    if (customer.length === 0) return c.json({ error: '客户不存在' }, 404);
    const tagNameMap = await getTagNameMap(scope);
    return c.json(formatCustomer(customer[0], tagNameMap));
  }

  // 解析分页参数
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const offset = (page - 1) * limit;

  // 构建查询条件（加上租户隔离 + keyword 和 level 走数据库过滤，tag 走内存过滤）
  const conditions: any[] = [...tenantWhere(scope, pmsBuiCustomers)];
  if (keyword) {
    conditions.push(
      or(
        like(pmsBuiCustomers.name, `%${keyword}%`),
        like(pmsBuiCustomers.phone, `%${keyword}%`),
      )
    );
  }
  if (level) {
    conditions.push(eq(pmsBuiCustomers.memberLevel, level));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const tagNameMap = await getTagNameMap(scope);
  let customers: any[];
  let total: number;

  if (tag) {
    // tag 过滤需要先解析标签名，走全量查询后内存过滤再分页
    const allFiltered = await db.select().from(pmsBuiCustomers).where(whereClause);
    const filteredByTag = allFiltered.filter(c => {
      const tagNames = (c.tags && Array.isArray(c.tags))
        ? c.tags.map((t: string) => tagNameMap[t] || t)
        : [];
      return tagNames.includes(tag) || (c.tags as string[])?.includes(tag);
    });
    total = filteredByTag.length;
    customers = filteredByTag.slice(offset, offset + limit);
  } else {
    // 统计符合条件的总数
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiCustomers).where(whereClause);
    total = Number(countResult[0].count);

    // 分页查询
    customers = await db.select().from(pmsBuiCustomers)
      .where(whereClause)
      .limit(limit)
      .offset(offset);
  }

  // Format customers
  const formattedCustomers = customers.map(c => formatCustomer(c, tagNameMap));

  // Build stats（基于全量数据，不受分页影响）
  const allCustomers = await db.select().from(pmsBuiCustomers).where(and(...tenantWhere(scope, pmsBuiCustomers)));
  const allReminders = await db.select().from(pmsBuiCareReminders).where(and(...tenantWhere(scope, pmsBuiCareReminders)));
  const stats = {
    total: allCustomers.length,
    newThisMonth: allCustomers.filter(c => {
      const d = new Date(c.createdAt);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length,
    vipCount: allCustomers.filter(c => c.memberLevel === 'diamond' || c.memberLevel === 'gold').length,
    regularCount: allCustomers.filter(c => c.memberLevel === 'silver' || c.memberLevel === 'regular').length,
    carePending: allReminders.filter(r => r.status === 'pending').length,
    avgValueScore: allCustomers.length > 0
      ? Math.round(allCustomers.reduce((s, c) => s + (c.valueScore || 0), 0) / allCustomers.length)
      : 0,
  };

  return c.json({ customers: formattedCustomers, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, stats });
});

// Zod 请求体验证 schema
const customersActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('addTag'),
    name: z.string().min(1, '标签名称不能为空'),
    color: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    action: z.literal('editTag'),
    tagId: z.string().min(1, '标签ID不能为空'),
    name: z.string().optional(),
    color: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    action: z.literal('deleteTag'),
    tagId: z.string().min(1, '标签ID不能为空'),
  }),
  z.object({
    action: z.literal('addAutoRule'),
    name: z.string().min(1, '规则名称不能为空'),
    rule: z.string().min(1, '规则表达式不能为空'),
    field: z.string().min(1, '规则字段不能为空'),
    tag: z.string().min(1, '标签不能为空'),
  }),
  z.object({
    action: z.literal('toggleAutoRule'),
    ruleId: z.string().min(1, '规则ID不能为空'),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal('sendCare'),
    customerId: z.string().min(1, '客户ID不能为空'),
    customerName: z.string().min(1, '客户姓名不能为空'),
    type: z.string().optional(),
    content: z.string().min(1, '关怀内容不能为空'),
    dueDate: z.string().optional(),
  }),
  z.object({
    action: z.literal('markCareDone'),
    reminderId: z.string().min(1, '提醒ID不能为空'),
  }),
  z.object({
    action: z.literal('addCustomer'),
    name: z.string().min(1),
    phone: z.string().optional(),
    gender: z.string().optional(),
    birthday: z.string().optional(),
    source: z.string().optional(),
    tags: z.array(z.string()).optional(),
    remark: z.string().optional(),
  }),
  z.object({
    action: z.literal('editCustomer'),
    customerId: z.string().min(1),
    name: z.string().optional(),
    phone: z.string().optional(),
    gender: z.string().optional(),
    birthday: z.string().optional(),
    memberLevel: z.string().optional(),
    remark: z.string().optional(),
  }),
  z.object({
    action: z.literal('tagCustomer'),
    customerId: z.string().min(1, '客户ID不能为空'),
    tagName: z.string().min(1, '标签名不能为空'),
  }),
]);

route.post('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, customersActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;
  const scope = getTenantScope(c);

  if (data.action === 'addTag') {
    const { name, color, description } = data;
    const id = `tag-${Date.now()}`;
    const result = await db.insert(pmsBuiTags).values({
      id, name, color: color || '#10b981', description: description || '',
      isAuto: false, count: 0,
    } as any).returning();
    return c.json(result[0], 201);
  }

  if (data.action === 'editTag') {
    const { tagId, name, color, description } = data;
    const result = await db.update(pmsBuiTags)
      .set({ name, color, description } as any)
      .where(and(eq(pmsBuiTags.id, tagId), ...tenantWhere(scope, pmsBuiTags)))
      .returning();
    return c.json(result[0]);
  }

  if (data.action === 'deleteTag') {
    const { tagId } = data;
    await db.delete(pmsBuiTags).where(and(eq(pmsBuiTags.id, tagId), ...tenantWhere(scope, pmsBuiTags)));
    return c.json({ success: true });
  }

  if (data.action === 'addAutoRule') {
    const { name, rule, field, tag } = data;
    const id = `rule-${Date.now()}`;
    const result = await db.insert(pmsBuiAutoTagRules).values({
      id, name, rule, field, tag, enabled: true,
    } as any).returning();
    return c.json(result[0], 201);
  }

  if (data.action === 'toggleAutoRule') {
    const { ruleId, enabled } = data;
    await db.update(pmsBuiAutoTagRules)
      .set({ enabled } as any)
      .where(and(eq(pmsBuiAutoTagRules.id, ruleId), ...tenantWhere(scope, pmsBuiAutoTagRules)));
    return c.json({ success: true });
  }

  if (data.action === 'sendCare') {
    const { customerId, customerName, type, content, dueDate } = data;
    const id = `care-${Date.now()}`;
    const result = await db.insert(pmsBuiCareReminders).values({
      id, customerId, customerName, type: type || 'rebuy',
      content, priority: 'medium', status: 'pending',
      dueDate: dueDate || new Date().toISOString().split('T')[0],
    } as any).returning();
    return c.json(result[0], 201);
  }

  if (data.action === 'markCareDone') {
    const { reminderId } = data;
    await db.update(pmsBuiCareReminders)
      .set({ status: 'done', completedAt: new Date() } as any)
      .where(and(eq(pmsBuiCareReminders.id, reminderId), ...tenantWhere(scope, pmsBuiCareReminders)));
    return c.json({ success: true });
  }

  if (data.action === 'addCustomer') {
    const id = `cust_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const now = new Date();
    await db.insert(pmsBuiCustomers).values({
      id,
      name: data.name,
      phone: data.phone || '',
      gender: data.gender || '',
      birthday: data.birthday || '',
      source: data.source || 'manual',
      memberLevel: 'regular',
      tags: data.tags || [],
      remark: data.remark || '',
      totalSpent: 0,
      stayCount: 0,
      valueScore: 20,
      merchantId: scope.merchantId,
      storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
      createdAt: now,
      updatedAt: now,
    } as any);
    return c.json({ success: true, id });
  }

  if (data.action === 'editCustomer') {
    const { customerId, action, ...updates } = data;
    await db.update(pmsBuiCustomers).set({ ...updates } as any)
      .where(and(eq(pmsBuiCustomers.id, customerId), ...tenantWhere(scope, pmsBuiCustomers)));
    return c.json({ success: true });
  }

  if (data.action === 'tagCustomer') {
    const { customerId, tagName } = data;
    const customer = await db.select().from(pmsBuiCustomers).where(and(eq(pmsBuiCustomers.id, customerId), ...tenantWhere(scope, pmsBuiCustomers))).limit(1);
    if (customer.length > 0) {
      const currentTags: string[] = Array.isArray(customer[0].tags) ? customer[0].tags as string[] : [];
      // Store tag name instead of tag ID
      if (!currentTags.includes(tagName)) {
        currentTags.push(tagName);
        await db.update(pmsBuiCustomers).set({ tags: currentTags } as any)
          .where(and(eq(pmsBuiCustomers.id, customerId), ...tenantWhere(scope, pmsBuiCustomers)));
        // Update tag count
        const tagRecord = await db.select().from(pmsBuiTags).where(and(eq(pmsBuiTags.name, tagName), ...tenantWhere(scope, pmsBuiTags))).limit(1);
        if (tagRecord.length > 0) {
          await db.update(pmsBuiTags).set({ count: tagRecord[0].count + 1 })
            .where(and(eq(pmsBuiTags.id, tagRecord[0].id), ...tenantWhere(scope, pmsBuiTags)));
        }
      }
    }
    return c.json({ success: true });
  }

  return c.json({ success: true });
});

export default route;
