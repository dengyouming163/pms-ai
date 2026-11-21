import { Hono } from 'hono';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiCoupons, pmsBuiCouponRecords } from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';

const route = new Hono();
// 东八区（北京）今天：new Date(now+8h).toISOString() 的 UTC 日期即北京日历日期（券过期判断统一用北京时间）
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// 可领券列表（公开）
route.get('/', async (c) => {
  const storeId = c.req.query('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);
  const t = today();
  const coupons = await db.select().from(pmsBuiCoupons).where(and(
    eq(pmsBuiCoupons.storeId, storeId),
    eq(pmsBuiCoupons.status, 'active'),
    sql`(${pmsBuiCoupons.total} = -1 OR ${pmsBuiCoupons.claimed} < ${pmsBuiCoupons.total})`,
    sql`(${pmsBuiCoupons.startDate} IS NULL OR ${pmsBuiCoupons.startDate} <= ${t})`,
    sql`(${pmsBuiCoupons.endDate} IS NULL OR ${pmsBuiCoupons.endDate} >= ${t})`,
  ));
  return c.json({ success: true, data: coupons });
});

// 领券（需登录）
route.post('/:id/claim', async (c) => {
  const miniUser = getMiniUser(c);
  const couponId = c.req.param('id');
  const [coupon] = await db.select().from(pmsBuiCoupons).where(eq(pmsBuiCoupons.id, couponId)).limit(1);
  if (!coupon || coupon.status !== 'active') return c.json({ success: false, error: '券不存在或已下线' }, 404);
  if (coupon.total > 0 && coupon.claimed >= coupon.total) return c.json({ success: false, error: '已领完' }, 400);
  if (coupon.perUser > 0) {
    const myCount = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiCouponRecords)
      .where(and(eq(pmsBuiCouponRecords.couponId, couponId), eq(pmsBuiCouponRecords.miniUserId, miniUser.miniUserId)));
    if (Number(myCount[0]?.count) >= coupon.perUser) return c.json({ success: false, error: '已达领取上限' }, 400);
  }

  const expireAt = new Date(Date.now() + 8 * 3600 * 1000 + coupon.validDays * 86400000).toISOString().slice(0, 10);
  await db.transaction(async (tx) => {
    await tx.insert(pmsBuiCouponRecords).values({
      id: `cr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      couponId: coupon.id, miniUserId: miniUser.miniUserId, storeId: coupon.storeId, expireAt,
    });
    await tx.update(pmsBuiCoupons).set({ claimed: coupon.claimed + 1, updatedAt: new Date() })
      .where(eq(pmsBuiCoupons.id, coupon.id));
  });
  return c.json({ success: true, message: '领取成功', data: { expireAt } });
});

// 我的券（需登录）— D4 钱包三态分组：status=pending（待使用）/ used（已使用）/ expired（已过期，按 expireAt 判断）
// 不传 status 返回全部（每张券带推导后的有效状态，兼容旧客户端字段）。
route.get('/my', async (c) => {
  const miniUser = getMiniUser(c);
  const storeId = c.req.query('storeId');
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);
  const status = c.req.query('status') || '';
  const t = today();

  const rows = await db.select({
    id: pmsBuiCouponRecords.id,
    couponId: pmsBuiCouponRecords.couponId,
    status: pmsBuiCouponRecords.status,
    expireAt: pmsBuiCouponRecords.expireAt,
    usedAt: pmsBuiCouponRecords.usedAt,
    usedOrderId: pmsBuiCouponRecords.usedOrderId,
    couponName: pmsBuiCoupons.name,
    couponType: pmsBuiCoupons.type,
    couponValue: pmsBuiCoupons.value,
    couponMinAmount: pmsBuiCoupons.minAmount,
    couponScope: pmsBuiCoupons.scope,
  }).from(pmsBuiCouponRecords)
    .innerJoin(pmsBuiCoupons, eq(pmsBuiCouponRecords.couponId, pmsBuiCoupons.id))
    .where(and(
      eq(pmsBuiCouponRecords.miniUserId, miniUser.miniUserId),
      eq(pmsBuiCouponRecords.storeId, storeId),
    )).orderBy(sql`${pmsBuiCouponRecords.createdAt} DESC`);

  // 有效状态推导：已使用（status='used'）优先；其余按 expireAt 判断 expired 已过期 / pending 待使用
  const effectiveStatus = (r: { status: string; expireAt: string }) =>
    r.status === 'used' ? 'used' : (r.expireAt < t ? 'expired' : 'pending');

  const data = rows
    .map((r) => ({ ...r, status: effectiveStatus(r) }))
    .filter((r) => !status || r.status === status);

  return c.json({ success: true, data });
});

export default route;
