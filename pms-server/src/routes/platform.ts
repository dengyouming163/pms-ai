import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiMerchantApplications, pmsBuiStores } from '../db/schema/index.js';
import type { AuthUser } from '../middleware/auth.js';
import { canTransition } from '../services/merchant-apply.js';

const route = new Hono<{ Variables: { authUser?: AuthUser } }>();

// 平台运营权限校验：JWT scope === 'tenant'（超级管理员级）
// M1 平台运营即运营方自己；后续如需独立"平台运营"角色，在此扩展
// ⚠️ 刻意不用 isAllStoresScope：全部门店（如客服，DB 值为「全部门店」）≠ 平台运营方，
//    进件审核/跨平台管理是敏感权限，不应因「全部门店」自动授予。
route.use('*', async (c, next) => {
  const user = c.get('authUser');
  if (user?.scope !== 'tenant') {
    return c.json({ success: false, error: '需要平台运营权限' }, 403);
  }
  return next();
});

// 进件申请列表（全平台）
// 平台运营跨门店视角，不做租户过滤
route.get('/applications', async (c) => {
  const status = c.req.query('status');
  const base = db.select({
    application: pmsBuiMerchantApplications,
    storeName: pmsBuiStores.name,
  }).from(pmsBuiMerchantApplications)
    .leftJoin(pmsBuiStores, eq(pmsBuiMerchantApplications.storeId, pmsBuiStores.id));
  const rows = status
    ? await base.where(eq(pmsBuiMerchantApplications.status, status)).orderBy(desc(pmsBuiMerchantApplications.updatedAt))
    : await base.orderBy(desc(pmsBuiMerchantApplications.updatedAt));
  return c.json({ success: true, data: rows.map((r) => ({ ...r.application, storeName: r.storeName })) });
});

const reviewSchema = z.object({
  id: z.string().min(1),
  // approve → wx_submitted（平台人工去微信服务商后台进件）
  // reject → rejected；finish → finished（回填 sub_mchid）
  action: z.enum(['approve', 'reject', 'finish', 'wx_reject']),
  rejectReason: z.string().max(500).optional(),
  subMchid: z.string().max(32).optional(),
});

// 审核/推进进件状态
route.post('/applications/review', async (c) => {
  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const { id, action, rejectReason, subMchid } = parsed.data;

  const [application] = await db.select().from(pmsBuiMerchantApplications)
    .where(eq(pmsBuiMerchantApplications.id, id)).limit(1);
  if (!application) return c.json({ success: false, error: '申请不存在' }, 404);

  const targetMap = { approve: 'wx_submitted', reject: 'rejected', finish: 'finished', wx_reject: 'wx_rejected' } as const;
  const target = targetMap[action];
  if (!canTransition(application.status, target)) {
    return c.json({ success: false, error: `状态 ${application.status} 不可执行 ${action}` }, 400);
  }
  if (action === 'finish' && !subMchid) {
    return c.json({ success: false, error: '完成进件必须回填 subMchid' }, 400);
  }
  if ((action === 'reject' || action === 'wx_reject') && !rejectReason) {
    return c.json({ success: false, error: '驳回必须填写原因' }, 400);
  }

  await db.update(pmsBuiMerchantApplications).set({
    status: target,
    rejectReason: rejectReason ?? null,
    subMchid: subMchid ?? application.subMchid,
    updatedAt: new Date(),
  }).where(eq(pmsBuiMerchantApplications.id, id));

  return c.json({ success: true, message: '状态已更新' });
});

export default route;
