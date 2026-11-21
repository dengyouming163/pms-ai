import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../constants.js';
import { isMiniPath } from './mini-auth.js';

const PUBLIC_PATHS = [
  '/health',
  '/api/auth/login',
  '/api/auth/send-sms',
  '/api/auth/reset-password',
  '/api/doc',
  '/api/swagger',
  '/api/video/templates',
  '/api/voice/ims',
  '/api/ota/client/bind',
  '/api/ota/client/config',
  '/api/ota/client/health',
  '/api/ota/devices',
  '/api/settings/map-search',
  // 公众号服务器配置回调（GET 验签 echostr + POST 消息接收；微信服务器无 JWT）
  '/api/wechat/mp/callback',
  // 企微 OAuth 免登（code 换取前无 JWT）
  '/api/kf-staff/oauth/url',
  '/api/kf-staff/oauth/exchange',
  // 绑定企微身份（绑定前无 JWT）
  '/api/kf-staff/bind-wecom',
];

export interface AuthUser {
  userId: string;
  phone: string;
  merchantId?: string;
  homeStoreId?: string;
  accessibleStores?: string[];
  roleId?: string;
  scope?: string;
  name?: string;
  permissions?: string[];
}

export async function authMiddleware(c: Context, next: Next) {
  const path = c.req.path;

  // 公开路径跳过认证
  const isCheckinH5Public =
    path === '/api/checkin-h5/parse' ||
    (path === '/api/checkin-h5/orders' && c.req.method === 'POST') || // H5 员工端 POST 公开（靠 storeId），平台端 GET 需鉴权
    (path === '/api/checkin-h5/stats' && c.req.method === 'GET'); // H5 员工端 GET 统计公开（靠 storeId）
  if (isCheckinH5Public || PUBLIC_PATHS.includes(path) || path.startsWith('/api/swagger') || path.startsWith('/api/internal/') || path.startsWith('/api/admin/') || path.startsWith('/api/voice/ims') || isMiniPath(path)) {
    return next();
  }

  // 仅对 /api/* 路径进行认证
  if (!path.startsWith('/api/')) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ success: false, error: '未登录' }, 401);
  }

  try {
    const token = authHeader.slice(7);
    // OTA 客户端使用 sk- 前缀的 store_key，由 otaAuthMiddleware 处理
    if (token.startsWith('sk-')) {
      return next();
    }
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    c.set('authUser', payload);
    return next();
  } catch {
    return c.json({ success: false, error: 'Token无效或已过期' }, 401);
  }
}
