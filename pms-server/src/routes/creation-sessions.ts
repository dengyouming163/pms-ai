import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index';
import { pmsBuiCreationSessions } from '../db/schema/promotion';
import { pmsBuiAiChatHistory } from '../db/schema/ai';
import { getTenantScope, tenantWhere } from '../utils/tenant';
import { validateBody } from '../utils/validate';

const route = new Hono();

// GET /api/creation-sessions — 会话列表
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');

  const sessions = await db
    .select()
    .from(pmsBuiCreationSessions)
    .where(and(...tenantWhere(scope, pmsBuiCreationSessions)))
    .orderBy(desc(pmsBuiCreationSessions.updatedAt))
    .limit(limit)
    .offset(offset);

  return c.json({ success: true, data: sessions });
});

// POST /api/creation-sessions — 创建会话
const createSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  scene: z.string().default('short_video'),
  style: z.string().default('story'),
  duration: z.number().default(30),
  platform: z.string().default('抖音'),
});

route.post('/', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const validation = await validateBody(body, createSchema);
  if (!validation.success) {
    return c.json({ success: false, error: validation.error }, 400);
  }
  const d = validation.data;

  const id = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(pmsBuiCreationSessions).values({
    id,
    merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    title: d.title || '新对话',
    scene: d.scene,
    style: d.style,
    duration: d.duration,
    platform: d.platform,
    messageCount: 0,
  } as any);

  return c.json({ success: true, data: { id, title: d.title || '新对话' } });
});

// GET /api/creation-sessions/:id — 会话详情（含消息）
route.get('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');

  const [session] = await db
    .select()
    .from(pmsBuiCreationSessions)
    .where(and(eq(pmsBuiCreationSessions.id, id), ...tenantWhere(scope, pmsBuiCreationSessions)))
    .limit(1);

  if (!session) return c.json({ success: false, error: '会话不存在' }, 404);

  // 加载该会话的消息历史
  const messages = await db
    .select()
    .from(pmsBuiAiChatHistory)
    .where(eq(pmsBuiAiChatHistory.sessionId, id))
    .orderBy(pmsBuiAiChatHistory.createdAt)
    .limit(200);

  return c.json({
    success: true,
    data: {
      ...session,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    },
  });
});

// PUT /api/creation-sessions/:id — 更新会话（重命名）
const updateSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  scene: z.string().optional(),
  style: z.string().optional(),
  duration: z.number().optional(),
  platform: z.string().optional(),
});

route.put('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');
  const body = await c.req.json();
  const validation = await validateBody(body, updateSchema);
  if (!validation.success) {
    return c.json({ success: false, error: validation.error }, 400);
  }

  const [session] = await db
    .select()
    .from(pmsBuiCreationSessions)
    .where(and(eq(pmsBuiCreationSessions.id, id), ...tenantWhere(scope, pmsBuiCreationSessions)))
    .limit(1);

  if (!session) return c.json({ success: false, error: '会话不存在' }, 404);

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (validation.data.title) updates.title = validation.data.title;
  if (validation.data.scene) updates.scene = validation.data.scene;
  if (validation.data.style) updates.style = validation.data.style;
  if (validation.data.duration !== undefined) updates.duration = validation.data.duration;
  if (validation.data.platform) updates.platform = validation.data.platform;

  await db
    .update(pmsBuiCreationSessions)
    .set(updates as any)
    .where(and(eq(pmsBuiCreationSessions.id, id), ...tenantWhere(scope, pmsBuiCreationSessions)));

  return c.json({ success: true, message: '更新成功' });
});

// POST /api/creation-sessions/:id/messages — 保存消息
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

route.post('/:id/messages', async (c) => {
  const scope = getTenantScope(c);
  const sessionId = c.req.param('id');
  const body = await c.req.json();
  const validation = await validateBody(body, messageSchema);
  if (!validation.success) {
    return c.json({ success: false, error: validation.error }, 400);
  }

  // 验证会话存在
  const [session] = await db
    .select()
    .from(pmsBuiCreationSessions)
    .where(and(eq(pmsBuiCreationSessions.id, sessionId), ...tenantWhere(scope, pmsBuiCreationSessions)))
    .limit(1);
  if (!session) return c.json({ success: false, error: '会话不存在' }, 404);

  const { role, content } = validation.data;
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  await db.insert(pmsBuiAiChatHistory).values({
    id: msgId,
    merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    userId: 'creation_user',
    sessionId,
    role,
    content,
    sessionType: 'creation',
    agentsInvolved: role === 'assistant' ? ['creation_ai'] : [],
  } as any);

  // 更新会话消息计数
  await db
    .update(pmsBuiCreationSessions)
    .set({ messageCount: (session.messageCount || 0) + 1, updatedAt: new Date() } as any)
    .where(eq(pmsBuiCreationSessions.id, sessionId));

  return c.json({ success: true, data: { id: msgId } });
});

// DELETE /api/creation-sessions/:id — 删除会话（级联删除消息）
route.delete('/:id', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');

  const [session] = await db
    .select()
    .from(pmsBuiCreationSessions)
    .where(and(eq(pmsBuiCreationSessions.id, id), ...tenantWhere(scope, pmsBuiCreationSessions)))
    .limit(1);

  if (!session) return c.json({ success: false, error: '会话不存在' }, 404);

  // 级联删除该会话下的所有消息
  await db.delete(pmsBuiAiChatHistory).where(eq(pmsBuiAiChatHistory.sessionId, id));
  // 删除会话本身
  await db
    .delete(pmsBuiCreationSessions)
    .where(and(eq(pmsBuiCreationSessions.id, id), ...tenantWhere(scope, pmsBuiCreationSessions)));

  return c.json({ success: true, message: '会话已删除' });
});

export default route;
