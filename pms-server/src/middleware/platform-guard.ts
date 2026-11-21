import type { Context, Next } from 'hono';
import { eq, and, or, isNull, gt, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  pmsPlatformMerchants,
  pmsPlatformPackages,
  pmsPlatformSubscriptions,
} from '../db/schema/platform.js';

/** 大模块 → 功能模块展开映射 */
const MODULE_MAP: Record<string, string[]> = {
  basic_saas: ['dashboard','rooms','orders','customers','staff','finance','stores','housekeeping','settings'],
  ota_sync: ['channels'],
  ai_workspace: ['ai','ai-pricing','competitor-prices','video','voice','xhs','content','creation-records','creation-sessions','hot-topics','competitor'],
};

/** 平台状态守卫：校验商户状态 + 从活跃订阅聚合套餐权限 */
export async function platformGuard(c: Context, next: Next) {
  const path = c.req.path;

  // 仅对 /api/* 路径校验
  if (!path.startsWith('/api/')) return next();

  // 跳过公开路径和内部路径
  const skipPaths = ['/api/auth/login', '/api/auth/send-sms', '/api/auth/me'];
  if (skipPaths.includes(path) || path.startsWith('/api/internal/')) return next();

  // 从 authMiddleware 注入的 authUser 或 Header 获取 merchantId
  const authUser = c.get('authUser') as any;
  const merchantId = authUser?.merchantId || c.req.header('X-Merchant-Id') || 'default';

  // default 商户无平台记录 → 放行（存量数据兼容）
  if (merchantId === 'default') return next();

  // 查询商户状态
  const [merchant] = await db.select({
    status: pmsPlatformMerchants.status,
  }).from(pmsPlatformMerchants).where(eq(pmsPlatformMerchants.id, merchantId)).limit(1);

  // 无平台记录 → 放行
  if (!merchant) return next();

  // 冻结或注销 → 403
  if (merchant.status === 'frozen' || merchant.status === 'cancelled') {
    return c.json({ success: false, error: '账号已冻结或注销，请联系平台客服' }, 403);
  }

  // 查询该商户所有活跃订阅（永久 OR 未到期）
  const now = new Date();
  const activeSubs = await db.select({
    packageId: pmsPlatformSubscriptions.packageId,
    endAt: pmsPlatformSubscriptions.endAt,
  }).from(pmsPlatformSubscriptions).where(and(
    eq(pmsPlatformSubscriptions.merchantId, merchantId),
    or(
      isNull(pmsPlatformSubscriptions.endAt),
      gt(pmsPlatformSubscriptions.endAt, now),
    ),
  ));

  // 从活跃订阅聚合所有模块 key，展开为功能权限
  const allModuleKeys = new Set<string>();
  for (const sub of activeSubs) {
    const [pkg] = await db.select({ permissions: pmsPlatformPackages.permissions })
      .from(pmsPlatformPackages).where(eq(pmsPlatformPackages.id, sub.packageId)).limit(1);
    for (const key of (pkg?.permissions || [])) {
      allModuleKeys.add(key);
    }
  }

  // 大模块 key → 展开为功能模块 key 列表（不在映射中的原样保留）
  const expanded: string[] = [];
  for (const key of allModuleKeys) {
    if (MODULE_MAP[key]) {
      expanded.push(...MODULE_MAP[key]);
    } else {
      expanded.push(key);  // 自定义模块 key 直接使用
    }
  }
  c.set('platformPermissions', expanded);

  // 到期提醒：检查是否有非永久订阅在 3 天内到期
  const expiringSoon = activeSubs.some(s => {
    if (!s.endAt) return false;
    const daysLeft = Math.ceil((new Date(s.endAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return daysLeft <= 3 && daysLeft > 0;
  });
  c.set('expiringSoon', expiringSoon);

  return next();
}

/** 路由中按需校验功能权限 */
export function requirePermission(c: Context, perm: string): boolean {
  const permissions = c.get('platformPermissions') || [];
  // 无权限列表 = 放行（存量兼容 + default 商户）
  if (permissions.length === 0) return true;
  return permissions.includes(perm);
}
