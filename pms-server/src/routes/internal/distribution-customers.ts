// 分销客户聚合内部接口（供管理端客户管理使用）
// 数据源：pms_bui_mini_users（C 端用户）+ pms_bui_customers（门店客户/来源）+ pms_bui_promoters（是否分销员/推广关系）
import { Hono } from 'hono';
import { eq, and, desc, sql, like, or, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiMiniUsers, pmsBuiCustomers, pmsBuiPromoters } from '../../db/schema/index.js';

const route = new Hono();

// GET /api/internal/distribution/customers?page=&limit=&keyword=&source=
route.get('/customers', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const keyword = c.req.query('keyword') || '';
  const source = c.req.query('source') || '';
  const offset = (page - 1) * limit;

  // 以 mini 用户为主体（分销裂变的客户 = C 端下单用户），LEFT JOIN 门店客户表拿来源/来源推广员
  const base = db.select({
    id: pmsBuiMiniUsers.id,
    nickname: pmsBuiMiniUsers.nickname,
    avatar: pmsBuiMiniUsers.avatar,
    phone: pmsBuiMiniUsers.phone,
    guestName: pmsBuiMiniUsers.guestName,
    guestPhone: pmsBuiMiniUsers.guestPhone,
    platform: pmsBuiMiniUsers.platform,
    createdAt: pmsBuiMiniUsers.createdAt,
    source: pmsBuiCustomers.source,
    referrerPromoterId: pmsBuiCustomers.referrerPromoterId,
  })
    .from(pmsBuiMiniUsers)
    .leftJoin(pmsBuiCustomers, eq(pmsBuiCustomers.miniUserId, pmsBuiMiniUsers.id));

  const conditions: any[] = [];
  if (source) conditions.push(eq(pmsBuiCustomers.source, source));
  if (keyword) {
    conditions.push(or(
      like(pmsBuiMiniUsers.nickname, `%${keyword}%`),
      like(pmsBuiMiniUsers.phone, `%${keyword}%`),
      like(pmsBuiMiniUsers.guestPhone, `%${keyword}%`),
    ));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const countRows = await db.select({ count: sql<number>`count(*)` })
    .from(pmsBuiMiniUsers)
    .leftJoin(pmsBuiCustomers, eq(pmsBuiCustomers.miniUserId, pmsBuiMiniUsers.id))
    .where(where);
  const rows = await base.where(where).orderBy(desc(pmsBuiMiniUsers.createdAt)).limit(limit).offset(offset);

  // 批量解析来源推广员（inArray 一次性查询，避免 N+1）
  const promoterIds = [...new Set(rows.map((r: any) => r.referrerPromoterId).filter(Boolean))] as string[];
  const referrers = promoterIds.length
    ? await db.select().from(pmsBuiPromoters).where(inArray(pmsBuiPromoters.id, promoterIds))
    : [];
  const referrerMap = new Map(referrers.map((p) => [p.id, p]));

  const list = rows.map((r: any) => ({
    ...r,
    referrer: r.referrerPromoterId ? referrerMap.get(r.referrerPromoterId) || null : null,
  }));
  return c.json({ success: true, data: { list, pagination: { page, limit, total: Number(countRows[0]?.count || 0) } } });
});

// GET /api/internal/distribution/customers/:id — 客户详情 360
route.get('/customers/:id', async (c) => {
  const id = c.req.param('id');
  const [miniUser] = await db.select().from(pmsBuiMiniUsers).where(eq(pmsBuiMiniUsers.id, id)).limit(1);
  if (!miniUser) return c.json({ success: false, error: '客户不存在' }, 404);

  // 门店客户记录（可能多门店，取全部）
  const customers = await db.select().from(pmsBuiCustomers).where(eq(pmsBuiCustomers.miniUserId, id));

  // 分销关系：本人是否分销员 + 上级
  const promoters = await db.select().from(pmsBuiPromoters).where(eq(pmsBuiPromoters.miniUserId, id));
  let parent = null;
  if (promoters[0]?.parentPromoterId) {
    const [p] = await db.select().from(pmsBuiPromoters).where(eq(pmsBuiPromoters.id, promoters[0].parentPromoterId)).limit(1);
    parent = p || null;
  }

  return c.json({
    success: true,
    data: { miniUser, customers, promoter: promoters[0] || null, parentPromoter: parent },
  });
});

export default route;
