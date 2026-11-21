/**
 * 权限守卫中间件 — 路由级权限校验
 * 用法：app.get('/api/orders', requirePermission('orders:view'), handler)
 * 支持多个权限（满足任一即可）：requirePermission('orders:view', 'orders:edit')
 *
 * 权限来源优先级：JWT.permissions → 实时查 pms_bui_roles → 拒绝（未配置）
 */
import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiRoles } from '../db/schema/index.js';
import { hasPermission } from '../utils/permissions.js';

/** 创建权限校验中间件 */
export function requirePermission(...required: string[]) {
  return async (c: Context, next: Next) => {
    const authUser = c.get('authUser') as any;
    let userPerms: string[] = authUser?.permissions || [];

    // JWT 中无权限 → 从数据库实时加载
    if (userPerms.length === 0 && authUser?.roleId) {
      try {
        const [role] = await db.select({ permissions: pmsBuiRoles.permissions })
          .from(pmsBuiRoles).where(eq(pmsBuiRoles.id, authUser.roleId)).limit(1);
        userPerms = (role?.permissions as string[]) || [];
      } catch { /* DB unavailable → skip check */ }
    }

    // 无任何权限配置 → 拒绝（严格权限；种子角色均已配置权限，空权限视为未授权）
    if (userPerms.length === 0) return c.json({ success: false, error: '权限不足' }, 403);

    if (hasPermission(userPerms, ...required)) {
      return next();
    }

    return c.json({ success: false, error: '权限不足' }, 403);
  };
}
