import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiMiniStoreConfig, pmsBuiMerchantApplications, pmsBuiPackages, pmsBuiCoupons, pmsBuiPromoters } from '../db/schema/index.js';
import { getTenantScope } from '../utils/tenant.js';
import { canTransition } from '../services/merchant-apply.js';

const route = new Hono();

// ---------- 门店装修配置 ----------

// 获取当前门店私域配置（无则返回默认值）
route.get('/store-config', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const [config] = await db.select().from(pmsBuiMiniStoreConfig)
    .where(eq(pmsBuiMiniStoreConfig.storeId, scope.storeId)).limit(1);
  return c.json({
    success: true,
    data: config || {
      storeId: scope.storeId, online: false, headerImages: [], intro: '', gallery: [],
      cancelPolicy: { freeHours: 24, feeRate: 20 },
    },
  });
});

const configSchema = z.object({
  headerImages: z.array(z.string()).max(9).optional(),
  intro: z.string().max(2000).optional(),
  gallery: z.array(z.string()).max(30).optional(),
  cancelPolicy: z.object({ freeHours: z.number().min(0).max(720), feeRate: z.number().min(0).max(100) }).optional(),
  memberDiscounts: z.record(z.string(), z.number()).optional(),
  online: z.boolean().optional(),
});

// 保存门店私域配置（upsert）；上线开关校验进件状态
route.put('/store-config', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const parsed = configSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);

  // 上线前必须完成进件
  if (parsed.data.online === true) {
    const [application] = await db.select().from(pmsBuiMerchantApplications)
      .where(eq(pmsBuiMerchantApplications.storeId, scope.storeId)).limit(1);
    if (application?.status !== 'finished') {
      return c.json({ success: false, error: '收款进件未完成，暂不能上线。请先在「进件与收款」提交资料' }, 400);
    }
  }

  const [existing] = await db.select().from(pmsBuiMiniStoreConfig)
    .where(eq(pmsBuiMiniStoreConfig.storeId, scope.storeId)).limit(1);
  if (existing) {
    await db.update(pmsBuiMiniStoreConfig).set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(pmsBuiMiniStoreConfig.id, existing.id));
  } else {
    await db.insert(pmsBuiMiniStoreConfig).values({
      id: `msc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      ...parsed.data,
    });
  }
  return c.json({ success: true, message: '配置已保存' });
});

// ---------- 进件 ----------

// 查询本门店进件状态
route.get('/application', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const [application] = await db.select().from(pmsBuiMerchantApplications)
    .where(eq(pmsBuiMerchantApplications.storeId, scope.storeId)).limit(1);
  return c.json({ success: true, data: application || { storeId: scope.storeId, status: 'draft' } });
});

const applySchema = z.object({
  businessLicense: z.object({ number: z.string().min(1), name: z.string().min(1), imageUrl: z.string().min(1) }),
  legalPerson: z.object({ name: z.string().min(1), idNumber: z.string().min(1), idFrontUrl: z.string().min(1), idBackUrl: z.string().min(1) }),
  settlementAccount: z.object({ bankName: z.string().min(1), accountName: z.string().min(1), accountNumber: z.string().min(1) }),
  contact: z.object({ name: z.string().min(1), phone: z.string().regex(/^1\d{10}$/) }),
});

// 提交进件资料（draft/rejected/wx_rejected → reviewing）
route.post('/application', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const parsed = applySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);

  const [existing] = await db.select().from(pmsBuiMerchantApplications)
    .where(eq(pmsBuiMerchantApplications.storeId, scope.storeId)).limit(1);
  const currentStatus = existing?.status || 'draft';
  if (!canTransition(currentStatus, 'reviewing')) {
    return c.json({ success: false, error: `当前状态（${currentStatus}）不可提交` }, 400);
  }

  if (existing) {
    await db.update(pmsBuiMerchantApplications).set({
      ...parsed.data, status: 'reviewing', rejectReason: null, updatedAt: new Date(),
    }).where(eq(pmsBuiMerchantApplications.id, existing.id));
  } else {
    await db.insert(pmsBuiMerchantApplications).values({
      id: `mca_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: scope.merchantId,
      storeId: scope.storeId,
      status: 'reviewing',
      ...parsed.data,
    });
  }
  return c.json({ success: true, message: '已提交，等待平台审核' });
});

// ---------- 套餐管理 ----------

const packageSchema = z.object({
  name: z.string().min(1, '套餐名称不能为空').max(100),
  description: z.string().max(2000).optional(),
  roomTypeIds: z.array(z.string()).min(1, '至少选择一个房型'),
  benefits: z.array(z.string()).optional(),
  price: z.number().int().min(1, '价格必须大于0'),
  stock: z.number().int().min(-1).optional(),
  sellStart: z.string().optional(),
  sellEnd: z.string().optional(),
  useStart: z.string().optional(),
  useEnd: z.string().optional(),
  images: z.array(z.string()).optional(),
});

// 套餐列表
route.get('/packages', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const pkgs = await db.select().from(pmsBuiPackages).where(
    and(eq(pmsBuiPackages.merchantId, scope.merchantId), eq(pmsBuiPackages.storeId, scope.storeId)),
  );
  return c.json({ success: true, data: pkgs });
});

// 创建套餐
route.post('/packages', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const parsed = packageSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const id = `pkg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(pmsBuiPackages).values({
    id,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    ...parsed.data,
    status: 'active',
  });
  return c.json({ success: true, data: { id } });
});

// 编辑套餐
route.put('/packages/:id', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const parsed = packageSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const [existing] = await db.select().from(pmsBuiPackages).where(
    and(eq(pmsBuiPackages.id, c.req.param('id')), eq(pmsBuiPackages.merchantId, scope.merchantId)),
  ).limit(1);
  if (!existing) return c.json({ success: false, error: '套餐不存在' }, 404);
  await db.update(pmsBuiPackages).set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pmsBuiPackages.id, existing.id));
  return c.json({ success: true, message: '套餐已更新' });
});

// 上架/下架切换
route.post('/packages/:id/toggle', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const [existing] = await db.select().from(pmsBuiPackages).where(
    and(eq(pmsBuiPackages.id, c.req.param('id')), eq(pmsBuiPackages.merchantId, scope.merchantId)),
  ).limit(1);
  if (!existing) return c.json({ success: false, error: '套餐不存在' }, 404);
  const newStatus = existing.status === 'active' ? 'inactive' : 'active';
  await db.update(pmsBuiPackages).set({ status: newStatus, updatedAt: new Date() })
    .where(eq(pmsBuiPackages.id, existing.id));
  return c.json({ success: true, data: { status: newStatus } });
});

// ---------- 券模板管理 ----------

const couponSchema = z.object({
  name: z.string().min(1, '券名称不能为空').max(100),
  type: z.enum(['full_reduce', 'discount', 'newcomer']),
  value: z.number().int().min(1, '面额/折扣必须大于0'),
  minAmount: z.number().int().optional(),
  scope: z.array(z.string()).optional(),
  total: z.number().int().optional(),
  perUser: z.number().int().optional(),
  validDays: z.number().int().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// 券模板列表
route.get('/coupons', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const coupons = await db.select().from(pmsBuiCoupons).where(
    and(eq(pmsBuiCoupons.merchantId, scope.merchantId), eq(pmsBuiCoupons.storeId, scope.storeId)),
  );
  return c.json({ success: true, data: coupons });
});

// 创建券模板
route.post('/coupons', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const parsed = couponSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const id = `co_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db.insert(pmsBuiCoupons).values({
    id,
    merchantId: scope.merchantId,
    storeId: scope.storeId,
    ...parsed.data,
    status: 'active',
  });
  return c.json({ success: true, data: { id } });
});

// 编辑券模板（partial 校验）
route.put('/coupons/:id', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const parsed = couponSchema.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const [existing] = await db.select().from(pmsBuiCoupons).where(
    and(eq(pmsBuiCoupons.id, c.req.param('id')), eq(pmsBuiCoupons.merchantId, scope.merchantId)),
  ).limit(1);
  if (!existing) return c.json({ success: false, error: '券模板不存在' }, 404);
  await db.update(pmsBuiCoupons).set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(pmsBuiCoupons.id, existing.id));
  return c.json({ success: true, message: '券模板已更新' });
});

// 启用/停用切换
route.post('/coupons/:id/toggle', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const [existing] = await db.select().from(pmsBuiCoupons).where(
    and(eq(pmsBuiCoupons.id, c.req.param('id')), eq(pmsBuiCoupons.merchantId, scope.merchantId)),
  ).limit(1);
  if (!existing) return c.json({ success: false, error: '券模板不存在' }, 404);
  const newStatus = existing.status === 'active' ? 'inactive' : 'active';
  await db.update(pmsBuiCoupons).set({ status: newStatus, updatedAt: new Date() })
    .where(eq(pmsBuiCoupons.id, existing.id));
  return c.json({ success: true, data: { status: newStatus } });
});

// ---------- 推广员审核 ----------
route.get('/promoters', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const status = c.req.query('status');
  const q = status
    ? db.select().from(pmsBuiPromoters).where(and(eq(pmsBuiPromoters.storeId, scope.storeId), eq(pmsBuiPromoters.status, status)))
    : db.select().from(pmsBuiPromoters).where(eq(pmsBuiPromoters.storeId, scope.storeId));
  const rows = await q.orderBy(desc(pmsBuiPromoters.createdAt));
  return c.json({ success: true, data: rows });
});

route.post('/promoters/:id/review', async (c) => {
  const scope = getTenantScope(c);
  if (scope.storeId === '*') return c.json({ success: false, error: '请先选择门店' }, 400);
  const { action, reason } = await c.req.json().catch(() => ({})); // approve | reject
  if (!['approve', 'reject'].includes(action)) return c.json({ success: false, error: 'action 必须是 approve 或 reject' }, 400);

  const newStatus = action === 'approve' ? 'active' : 'disabled';
  await db.update(pmsBuiPromoters).set({ status: newStatus, updatedAt: new Date() })
    .where(and(eq(pmsBuiPromoters.id, c.req.param('id')), eq(pmsBuiPromoters.storeId, scope.storeId)));
  return c.json({ success: true, message: action === 'approve' ? '已通过' : '已驳回' });
});

export default route;
