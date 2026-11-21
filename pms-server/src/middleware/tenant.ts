import type { Context, Next } from 'hono';
import { getTenantScope, verifyStoreAccess } from '../utils/tenant.js';
import { isMiniPath } from './mini-auth.js';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * 跨门店访问白名单 — 这些路径不做门店级别的过滤
 * - auth: 认证流程（登录前无 JWT）
 * - stores: 门店列表（用户需要看到自己有权限的所有门店）
 * - brands: 品牌管理（商户级别）
 * - settings: 系统设置（商户级别，storeId='*'）
 * - dashboard: 仪表盘（聚合多门店数据）
 * - data-center: 数据中心（跨门店数据分析）
 * - swagger/doc: API 文档（无需认证）
 * - health: 健康检查
 */
const CROSS_STORE_PATHS = [
  '/api/auth',
  '/api/stores',
  '/api/brands',
  '/api/settings',
  '/api/dashboard',
  '/api/data-center',
  '/api/swagger',
  '/api/doc',
  '/health',
  '/api/notifications',
  '/api/ota/client/health',
  '/api/ota/client/devices',
  '/api/kf-staff',
];

function isCrossStorePath(path: string): boolean {
  return CROSS_STORE_PATHS.some(prefix => path.startsWith(prefix));
}

/**
 * 租户隔离中间件
 * 必须在 authMiddleware 之后注册（依赖 c.get('authUser')）
 *
 * 职责：
 * 1. 从 JWT + Headers 提取商户/门店上下文 → c.set('tenantScope')
 * 2. 验证当前门店在用户授权列表中 → 403 拒绝
 * 3. 跨门店路径跳过门店验证（白名单机制）
 */
export async function tenantMiddleware(c: Context, next: Next) {
  // C端小程序路径不走 B端租户/日志逻辑
  if (isMiniPath(c.req.path)) return next();

  const path = c.req.path;

  // 非 API 路径放行
  if (!path.startsWith('/api/')) {
    return next();
  }

  // 跨门店路径放行（路由 handler 自行处理多门店逻辑）
  if (isCrossStorePath(path)) {
    const scope = getTenantScope(c);
    c.set('tenantScope', scope);
    // 自动补齐 merchantId：storeId 有效时从门店表查询
    await resolveMerchantId(c, scope);
    return next();
  }

  // 门店级路径 — 必须验证门店权限
  const scope = getTenantScope(c);
  c.set('tenantScope', scope);
  await resolveMerchantId(c, scope);

  const accessDenied = verifyStoreAccess(c, scope);
  if (accessDenied) {
    return accessDenied;
  }

  return next();
}

// 从门店表获取 merchantId 并注入上下文
async function resolveMerchantId(c: Context, scope: { storeId: string; merchantId?: string }) {
  if (scope.merchantId && scope.merchantId !== 'default') return;
  const sid = scope.storeId;
  if (!sid || sid === '*') return;
  try {
    const { pmsBuiStores } = await import('../db/schema/brands.js');
    const [store] = await db.select({ merchantId: pmsBuiStores.merchantId })
      .from(pmsBuiStores).where(eq(pmsBuiStores.id, sid)).limit(1);
    if (store?.merchantId && store.merchantId !== 'default') {
      c.set('merchantId', store.merchantId);
    }
  } catch { /* 静默失败，路由层兜底 */ }
}
