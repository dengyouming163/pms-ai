import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiPromoters, pmsBuiReferralBindings, pmsBuiCommissionRecords,
  pmsBuiWithdrawals,
} from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { calcWithdrawable } from '../../utils/commission.js';

const route = new Hono();

// 申请成为推广员
route.post('/apply', async (c) => {
  const miniUser = getMiniUser(c);
  const { storeId } = await c.req.json().catch(() => ({}));
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);

  const [existing] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUser.miniUserId))).limit(1);
  if (existing) {
    if (existing.status === 'disabled') return c.json({ success: false, error: '已禁用，无法重新申请' }, 400);
    return c.json({ success: false, error: '已申请，请等待审核' }, 400);
  }

  const promoCode = `P${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const [promoter] = await db.insert(pmsBuiPromoters).values({
    id: `pro_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    merchantId: 'default',
    storeId,
    miniUserId: miniUser.miniUserId,
    promoCode,
  }).returning();
  return c.json({ success: true, data: { id: promoter.id, promoCode, status: promoter.status } });
});

// 我的推广员信息
route.get('/me', async (c) => {
  const miniUser = getMiniUser(c);
  const storeId = c.req.query('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);

  const [promoter] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUser.miniUserId))).limit(1);
  if (!promoter) return c.json({ success: true, data: null }); // 未申请

  // 统计
  const [released] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords)
    .where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.status, 'released')));
  const [withdrawn] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords)
    .where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.status, 'withdrawn')));
  const [processing] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiWithdrawals)
    .where(and(eq(pmsBuiWithdrawals.promoterId, promoter.id), eq(pmsBuiWithdrawals.status, 'pending')));

  const [bindingCount] = await db.select({ count: sql<number>`count(*)` })
    .from(pmsBuiReferralBindings).where(eq(pmsBuiReferralBindings.promoterId, promoter.id));

  // 团队统计（二级分销）：下级分销员数（parentPromoterId 指向我的 promoter）+ 团队佣金（type='team' 的 released 累计）
  const [teamCount] = await db.select({ count: sql<number>`count(*)` })
    .from(pmsBuiPromoters).where(eq(pmsBuiPromoters.parentPromoterId, promoter.id));
  const [teamReleased] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords)
    .where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.type, 'team'), eq(pmsBuiCommissionRecords.status, 'released')));

  return c.json({
    success: true,
    data: {
      ...promoter,
      releasedTotal: Number(released?.total || 0),
      withdrawnTotal: Number(withdrawn?.total || 0),
      processingTotal: Number(processing?.total || 0),
      withdrawable: calcWithdrawable(Number(released?.total || 0), Number(withdrawn?.total || 0), Number(processing?.total || 0)),
      bindingCount: Number(bindingCount?.count || 0),
      teamCount: Number(teamCount?.count || 0),
      teamReleasedTotal: Number(teamReleased?.total || 0),
    },
  });
});

// 我的团队（二级分销员列表 + 团队业绩）
route.get('/team', async (c) => {
  const miniUser = getMiniUser(c);
  const storeId = c.req.query('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);
  const [promoter] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUser.miniUserId))).limit(1);
  if (!promoter) return c.json({ success: true, data: { members: [], teamCommission: 0 } });

  const members = await db.select().from(pmsBuiPromoters).where(eq(pmsBuiPromoters.parentPromoterId, promoter.id));
  const [teamCommission] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords)
    .where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.type, 'team')));
  return c.json({ success: true, data: { members, teamCommission: Number(teamCommission?.total || 0) } });
});

// 佣金明细
route.get('/earnings', async (c) => {
  const miniUser = getMiniUser(c);
  const storeId = c.req.query('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);
  const [promoter] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUser.miniUserId))).limit(1);
  if (!promoter) return c.json({ success: true, data: [] });

  const records = await db.select().from(pmsBuiCommissionRecords)
    .where(eq(pmsBuiCommissionRecords.promoterId, promoter.id))
    .orderBy(desc(pmsBuiCommissionRecords.createdAt)).limit(100);
  return c.json({ success: true, data: records });
});

// 分享绑定（进店时携带 promoterId → 建立绑定关系）
route.post('/bind', async (c) => {
  const miniUser = getMiniUser(c);
  const { promoterId, storeId } = await c.req.json().catch(() => ({}));
  if (!promoterId || !storeId) return c.json({ success: false, error: '参数错误' }, 400);

  const [promoter] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.id, promoterId), eq(pmsBuiPromoters.status, 'active'))).limit(1);
  if (!promoter) return c.json({ success: false, error: '推广员不存在' }, 404);

  // 先到先得不覆盖：已有绑定则跳过
  const [existing] = await db.select().from(pmsBuiReferralBindings)
    .where(and(eq(pmsBuiReferralBindings.storeId, storeId), eq(pmsBuiReferralBindings.miniUserId, miniUser.miniUserId))).limit(1);
  if (existing) return c.json({ success: true, message: '已绑定', data: { bindingId: existing.id } });

  const protectedUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [binding] = await db.insert(pmsBuiReferralBindings).values({
    id: `rb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    promoterId: promoter.id,
    miniUserId: miniUser.miniUserId,
    storeId,
    protectedUntil,
  }).returning();
  return c.json({ success: true, data: { bindingId: binding.id, protectedUntil } });
});

// 提现申请
const withdrawSchema = z.object({ storeId: z.string().min(1), amount: z.number().int().min(100) });
route.post('/withdraw', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = withdrawSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：提现金额至少 1 元(100 分)' }, 400);
  const { storeId, amount } = parsed.data;

  const [promoter] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUser.miniUserId), eq(pmsBuiPromoters.status, 'active'))).limit(1);
  if (!promoter) return c.json({ success: false, error: '推广员不存在或未审核通过' }, 400);

  // 计算可提现余额
  const [released] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords)
    .where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.status, 'released')));
  const [withdrawn] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiCommissionRecords)
    .where(and(eq(pmsBuiCommissionRecords.promoterId, promoter.id), eq(pmsBuiCommissionRecords.status, 'withdrawn')));
  const [processing] = await db.select({ total: sql<number>`COALESCE(SUM(amount), 0)` })
    .from(pmsBuiWithdrawals)
    .where(and(eq(pmsBuiWithdrawals.promoterId, promoter.id), eq(pmsBuiWithdrawals.status, 'pending')));
  const withdrawable = calcWithdrawable(Number(released?.total || 0), Number(withdrawn?.total || 0), Number(processing?.total || 0));
  if (amount > withdrawable) return c.json({ success: false, error: `可提现余额不足（当前可提 ¥${(withdrawable / 100).toFixed(2)}）` }, 400);

  const [withdrawal] = await db.insert(pmsBuiWithdrawals).values({
    id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    promoterId: promoter.id,
    amount,
    status: 'pending', // M3 MVP: 人工转账
  }).returning();
  return c.json({ success: true, data: { withdrawalId: withdrawal.id, amount, message: '提现申请已提交，预计 1-3 个工作日内到账' } });
});

export default route;
