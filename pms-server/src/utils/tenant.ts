import type { Context } from 'hono';
import { eq, and, SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { AuthUser } from '../middleware/auth.js';

/** 租户上下文（从 JWT + Header 解析） */
export interface TenantScope {
  merchantId: string;
  storeId: string;
  accessibleStores: string[];
}

/** 需要门店上下文的表（任意 PgTable 均可，tenantWhere 内运行时检测字段是否存在） */
export interface TenantFields {
  merchantId?: any;
  storeId?: any;
}

/**
 * 从请求上下文提取租户范围
 * storeId 来源优先级：X-Store-Id Header > JWT homeStoreId
 */
export function getTenantScope(c: Context): TenantScope {
  const authUser = c.get('authUser') as AuthUser | undefined;

  const merchantId = authUser?.merchantId || c.req.header('X-Merchant-Id') || 'default';
  const accessibleStores = authUser?.accessibleStores || [];

  // storeId 优先从 Header 获取（前端 StoreSelector 选择），fallback 到 JWT homeStoreId
  // 'default_store' 表示未分配具体门店 → 用 '*' 跳过门店过滤（仅按商户隔离）
  const rawStoreId = c.req.header('X-Store-Id') || authUser?.homeStoreId || 'default_store';
  const storeId = rawStoreId === 'default_store' ? '*' : rawStoreId;

  return { merchantId, storeId, accessibleStores };
}

/**
 * 为 Drizzle 查询生成商户+门店过滤条件
 * 如果提供了 storeId，同时过滤门店；如果 storeId 为 '*'（通配），仅过滤商户
 */
export function tenantWhere(
  scope: TenantScope,
  table: TenantFields & PgTable,
): SQL[] {
  const conditions: SQL[] = [];

  // 商户过滤
  if ('merchantId' in table) {
    conditions.push(eq(table.merchantId as any, scope.merchantId));
  }

  // 门店过滤（仅在 storeId 明确且不是通配符时）
  if (scope.storeId && scope.storeId !== '*' && 'storeId' in table) {
    conditions.push(eq(table.storeId as any, scope.storeId));
  }

  return conditions;
}

/**
 * 验证当前请求的门店是否在用户的授权门店列表中
 * 返回 null 表示验证通过，返回 Response 表示拒绝
 */
export function verifyStoreAccess(c: Context, scope: TenantScope): Response | null {
  // 通配符 storeId 表示全局访问（仅超级管理员）
  if (scope.storeId === '*') return null;

  // 如果用户没有授权门店列表，跳过验证（未认证请求由 auth 中间件处理）
  if (scope.accessibleStores.length === 0) return null;

  if (!scope.accessibleStores.includes(scope.storeId)) {
    return new Response(JSON.stringify({
      success: false,
      error: '您没有权限访问该门店的数据',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
