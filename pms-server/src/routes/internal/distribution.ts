// 分销管理内部接口（供 pms-platform-server 转发，平台管理员使用）
// 经 internalAuthMiddleware（index.ts 全局挂载 /api/internal/*）+ dataMask 豁免（见 data-mask.ts）
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql, like, or } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiPromoters, pmsBuiCommissionRecords, pmsBuiWithdrawals, pmsBuiDistributionConfig,
} from '../../db/schema/index.js';

const route = new Hono();

// ---------- 配置 ----------
// GET /api/internal/distribution/config
route.get('/config', async (c) => {
  const [cfg] = await db.select().from(pmsBuiDistributionConfig).where(eq(pmsBuiDistributionConfig.id, 'default')).limit(1);
  if (!cfg) return c.json({ success: true, data: { enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200, minWithdrawAmount: 100 } });
  return c.json({ success: true, data: cfg });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  defaultLv1Rate: z.number().int().min(0).max(10000).optional(),
  defaultLv2Rate: z.number().int().min(0).max(10000).optional(),
  minWithdrawAmount: z.number().int().min(0).optional(),
});
// PUT /api/internal/distribution/config
route.put('/config', async (c) => {
  const parsed = configSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数校验失败：' + parsed.error.issues[0].message }, 400);
  const vals = { ...parsed.data, updatedAt: new Date() } as any;
  const [existing] = await db.select().from(pmsBuiDistributionConfig).where(eq(pmsBuiDistributionConfig.id, 'default')).limit(1);
  if (existing) {
    const [updated] = await db.update(pmsBuiDistributionConfig).set(vals)
      .where(eq(pmsBuiDistributionConfig.id, 'default')).returning();
    return c.json({ success: true, data: updated });
  }
  const [created] = await db.insert(pmsBuiDistributionConfig).values({ id: 'default', ...vals }).returning();
  return c.json({ success: true, data: created });
});

// ---------- 报表 ----------
// GET /api/internal/distribution/stats
route.get('/stats', async (c) => {
  const [total] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiPromoters);
  const [lv1] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiPromoters).where(eq(pmsBuiPromoters.level, 1));
  const [lv2] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiPromoters).where(eq(pmsBuiPromoters.level, 2));
  const [commission] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords).where(or(eq(pmsBuiCommissionRecords.status, 'released'), eq(pmsBuiCommissionRecords.status, 'withdrawn')));
  const [frozen] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords).where(eq(pmsBuiCommissionRecords.status, 'frozen'));
  const [orders] = await db.select({ count: sql<number>`count(DISTINCT order_id)` }).from(pmsBuiCommissionRecords);
  return c.json({
    success: true,
    data: {
      promoterTotal: Number(total?.count || 0),
      lv1Count: Number(lv1?.count || 0),
      lv2Count: Number(lv2?.count || 0),
      commissionTotal: Number(commission?.total || 0),
      frozenTotal: Number(frozen?.total || 0),
      orderCount: Number(orders?.count || 0),
    },
  });
});

// ---------- 分销员 ----------
// GET /api/internal/distribution/promoters?page=&limit=&keyword=&level=&status=
route.get('/promoters', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const keyword = c.req.query('keyword') || '';
  const level = c.req.query('level') || '';
  const status = c.req.query('status') || '';
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (level) conditions.push(eq(pmsBuiPromoters.level, parseInt(level, 10)));
  if (status) conditions.push(eq(pmsBuiPromoters.status, status));
  if (keyword) {
    conditions.push(or(
      like(pmsBuiPromoters.promoCode, `%${keyword}%`),
      like(pmsBuiPromoters.miniUserId, `%${keyword}%`),
    ));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiPromoters).where(where);
  const list = await db.select().from(pmsBuiPromoters).where(where)
    .orderBy(desc(pmsBuiPromoters.createdAt)).limit(limit).offset(offset);

  return c.json({
    success: true,
    data: { list, pagination: { page, limit, total: Number(countRow?.count || 0) } },
  });
});

// GET /api/internal/distribution/promoters/:id
route.get('/promoters/:id', async (c) => {
  const [promoter] = await db.select().from(pmsBuiPromoters).where(eq(pmsBuiPromoters.id, c.req.param('id'))).limit(1);
  if (!promoter) return c.json({ success: false, error: '推广员不存在' }, 404);
  const team = await db.select().from(pmsBuiPromoters).where(eq(pmsBuiPromoters.parentPromoterId, promoter.id));
  const [directTotal] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords).where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.type, 'direct')));
  const [teamTotal] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords).where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.type, 'team')));
  return c.json({
    success: true,
    data: {
      ...promoter,
      team,
      directTotal: Number(directTotal?.total || 0),
      teamTotal: Number(teamTotal?.total || 0),
    },
  });
});

const statusSchema = z.object({ status: z.enum(['active', 'disabled']) });
// PATCH /api/internal/distribution/promoters/:id/status
route.patch('/promoters/:id/status', async (c) => {
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: 'status 仅支持 active/disabled' }, 400);
  const [updated] = await db.update(pmsBuiPromoters)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(eq(pmsBuiPromoters.id, c.req.param('id'))).returning();
  if (!updated) return c.json({ success: false, error: '推广员不存在' }, 404);
  return c.json({ success: true, data: updated });
});

// ---------- 佣金 ----------
// GET /api/internal/distribution/commissions?page=&limit=&status=&type=&promoterId=
route.get('/commissions', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const status = c.req.query('status') || '';
  const type = c.req.query('type') || '';
  const promoterId = c.req.query('promoterId') || '';
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (status) conditions.push(eq(pmsBuiCommissionRecords.status, status));
  if (type) conditions.push(eq(pmsBuiCommissionRecords.type, type));
  if (promoterId) conditions.push(eq(pmsBuiCommissionRecords.promoterId, promoterId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiCommissionRecords).where(where);
  const list = await db.select().from(pmsBuiCommissionRecords).where(where)
    .orderBy(desc(pmsBuiCommissionRecords.createdAt)).limit(limit).offset(offset);
  return c.json({ success: true, data: { list, pagination: { page, limit, total: Number(countRow?.count || 0) } } });
});

// PATCH /api/internal/distribution/commissions/:id/settle — 手动解冻
route.patch('/commissions/:id/settle', async (c) => {
  const [updated] = await db.update(pmsBuiCommissionRecords)
    .set({ status: 'released', releasedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(pmsBuiCommissionRecords.id, c.req.param('id')), eq(pmsBuiCommissionRecords.status, 'frozen')))
    .returning();
  if (!updated) return c.json({ success: false, error: '记录不存在或已解冻' }, 400);
  return c.json({ success: true, data: updated });
});

// PATCH /api/internal/distribution/commissions/:id/cancel — 作废
route.patch('/commissions/:id/cancel', async (c) => {
  const [updated] = await db.update(pmsBuiCommissionRecords)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(pmsBuiCommissionRecords.id, c.req.param('id')), or(eq(pmsBuiCommissionRecords.status, 'frozen'), eq(pmsBuiCommissionRecords.status, 'released'))))
    .returning();
  if (!updated) return c.json({ success: false, error: '记录不存在或不可作废' }, 400);
  return c.json({ success: true, data: updated });
});

// ---------- 提现 ----------
// GET /api/internal/distribution/withdrawals?page=&limit=&status=
route.get('/withdrawals', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const status = c.req.query('status') || '';
  const offset = (page - 1) * limit;
  const conditions = status ? [eq(pmsBuiWithdrawals.status, status)] : [];
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiWithdrawals).where(where);
  const list = await db.select().from(pmsBuiWithdrawals).where(where)
    .orderBy(desc(pmsBuiWithdrawals.createdAt)).limit(limit).offset(offset);
  return c.json({ success: true, data: { list, pagination: { page, limit, total: Number(countRow?.count || 0) } } });
});

const withdrawActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('paid'), wxTransferNo: z.string().min(1, '请填写微信转账单号') }),
  z.object({ action: z.literal('reject'), failReason: z.string().min(1, '请填写驳回原因') }),
]);
// PATCH /api/internal/distribution/withdrawals/:id — 打款 / 驳回
route.patch('/withdrawals/:id', async (c) => {
  const parsed = withdrawActionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数校验失败：' + parsed.error.issues[0].message }, 400);
  const data = parsed.data;

  if (data.action === 'paid') {
    const [updated] = await db.update(pmsBuiWithdrawals)
      .set({ status: 'paid', wxTransferNo: data.wxTransferNo, updatedAt: new Date() })
      .where(and(eq(pmsBuiWithdrawals.id, c.req.param('id')), eq(pmsBuiWithdrawals.status, 'pending')))
      .returning();
    if (!updated) return c.json({ success: false, error: '提现单不存在或已处理' }, 400);
    return c.json({ success: true, data: updated });
  }
  const [updated] = await db.update(pmsBuiWithdrawals)
    .set({ status: 'rejected', failReason: data.failReason, updatedAt: new Date() })
    .where(and(eq(pmsBuiWithdrawals.id, c.req.param('id')), eq(pmsBuiWithdrawals.status, 'pending')))
    .returning();
  if (!updated) return c.json({ success: false, error: '提现单不存在或已处理' }, 400);
  return c.json({ success: true, data: updated });
});

export default route;
