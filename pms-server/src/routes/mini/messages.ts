import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiInboxMessages } from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

// ============================================================
// GET /api/mini/messages — 我的站内消息列表（需登录）
//   可选查询参数：isRead=true|false 按已读/未读筛选，缺省返回全部
// ============================================================
route.get('/', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const isReadParam = c.req.query('isRead');

    const conditions = [eq(pmsBuiInboxMessages.miniUserId, miniUser.miniUserId)];
    if (isReadParam === 'true') conditions.push(eq(pmsBuiInboxMessages.isRead, true));
    if (isReadParam === 'false') conditions.push(eq(pmsBuiInboxMessages.isRead, false));

    const rows = await db.select().from(pmsBuiInboxMessages)
      .where(and(...conditions))
      .orderBy(desc(pmsBuiInboxMessages.createdAt));

    return c.json({ success: true, data: rows });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// ============================================================
// POST /api/mini/messages/:id/read — 标记消息已读（需登录）
//   归属校验：仅消息本人可标记。404=不存在，403=非本人（隔离存在性探测）
// ============================================================
route.post('/:id/read', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const id = c.req.param('id');

    // 先按 id 查存在性（只取归属字段），区分 404 与 403
    const [msg] = await db.select({
      id: pmsBuiInboxMessages.id,
      miniUserId: pmsBuiInboxMessages.miniUserId,
    }).from(pmsBuiInboxMessages).where(eq(pmsBuiInboxMessages.id, id)).limit(1);
    if (!msg) {
      return c.json({ success: false, error: '消息不存在' }, 404);
    }
    if (msg.miniUserId !== miniUser.miniUserId) {
      return c.json({ success: false, error: '无权操作该消息' }, 403);
    }

    await db.update(pmsBuiInboxMessages)
      .set({ isRead: true })
      .where(eq(pmsBuiInboxMessages.id, id));

    return c.json({ success: true });
  } catch (e: any) {
    return serverError(c, e, '操作失败');
  }
});

export default route;
