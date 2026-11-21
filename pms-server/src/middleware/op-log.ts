import type { Context, Next } from 'hono';
import { db } from '../db/index.js';
import { pmsBuiOpLogs } from '../db/schema/index.js';
import { JWT_SECRET } from '../constants.js';
import { isMiniPath } from './mini-auth.js';

/**
 * 操作日志中间件 - 自动记录所有 POST 请求（写操作）
 * 从 JWT token 中获取操作人信息，写入 pms_bui_op_logs 表
 */
export async function opLogMiddleware(c: Context, next: Next) {
  // C端小程序路径不走 B端租户/日志逻辑
  if (isMiniPath(c.req.path)) return next();

  // 只记录 POST 请求（写操作）
  if (c.req.method !== 'POST') {
    return next();
  }

  await next();

  try {
    // 只记录成功的写操作（2xx 状态码）
    const status = c.res?.status ?? 0;
    if (status < 200 || status >= 300) {
      return;
    }

    // 从 JWT 获取操作人（如果有的话）
    const authHeader = c.req.header('Authorization');
    let staffId = 'system';
    let staffName = '系统';

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const jwt = await import('jsonwebtoken');
        const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { userId: string; phone: string };
        staffId = payload.userId;
        // 查询操作人姓名
        const { pmsBuiStaff } = await import('../db/schema/index.js');
        const { eq } = await import('drizzle-orm');
        const [staff] = await db.select({ name: pmsBuiStaff.name })
          .from(pmsBuiStaff)
          .where(eq(pmsBuiStaff.id, payload.userId))
          .limit(1);
        if (staff) staffName = staff.name;
      } catch {
        // Token 无效，使用默认值
      }
    }

    // 从请求路径推断模块和操作
    const path = new URL(c.req.url).pathname;
    const { moduleLabel, action } = parseAction(path);

    if (moduleLabel && action) {
      await db.insert(pmsBuiOpLogs).values({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        staffId,
        staffName,
        module: path.replace('/api/', '').split('/')[0] || 'unknown',
        moduleLabel,
        action,
        target: '',
        detail: `${staffName} 执行了 ${action}`,
        level: 'info',
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || '127.0.0.1',
        timestamp: new Date(),
      });
    }
  } catch (err) {
    // 日志记录失败不影响业务
    console.error('OpLog error:', err);
  }
}

function parseAction(path: string): { moduleLabel: string; action: string } {
  const parts = path.replace('/api/', '').split('/');

  const moduleMap: Record<string, string> = {
    'orders': '订单管理',
    'stores': '门店管理',
    'brands': '品牌管理',
    'rooms': '房态管理',
    'pricing': '价格管理',
    'channels': '渠道管理',
    'finance': '财务管理',
    'customers': '客户管理',
    'staff': '团队管理',
    'settings': '系统设置',
    'auth': '认证管理',
    'data-center': '数据中心',
    'housekeeping': '客房服务',
    'notifications': '通知管理',
  };

  const moduleLabel = moduleMap[parts[0]] || '';

  const actionMap: Record<string, string> = {
    'orders': '处理订单',
    'stores': '管理门店',
    'brands': '管理品牌',
    'rooms': '管理房态',
    'pricing': '调整价格',
    'channels': '管理渠道',
    'finance': '处理财务',
    'customers': '管理客户',
    'staff': '管理团队',
    'settings': '修改设置',
    'auth': '认证操作',
    'data-center': '使用数据中心',
    'housekeeping': '管理客房服务',
    'notifications': '处理通知',
  };

  const action = actionMap[parts[0]] || '';

  return { moduleLabel, action };
}
