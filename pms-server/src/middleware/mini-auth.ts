import type { Context, Next } from 'hono';
import jwt from 'jsonwebtoken';
import { requireEnv } from '../constants.js';

/** C端 JWT 载荷 */
export interface MiniAuthUser {
  miniUserId: string;
  openid: string;
  /** 登录平台：wx=微信小程序, douyin=抖音小程序, wx_mp=公众号, h5=手机号验证码 */
  platform?: string;
}

/** C端 JWT audience — 签发与校验双向约束，即使两把密钥被误配成相同值，员工 token（无 audience）也过不了 C端 */
export const MINI_JWT_AUDIENCE = 'mini';

/** 是否为 C端小程序路径（B端全局中间件据此分流跳过） */
export function isMiniPath(path: string): boolean {
  return path.startsWith('/api/mini/');
}

// C端公开路径前缀（未登录可访问：登录、支付回调、门店/房型/套餐浏览）
// 注意：stores/rooms/packages 前缀整体公开，该前缀下只允许挂 GET 只读路由
const MINI_PUBLIC_PREFIXES = [
  '/api/mini/auth/login',
  '/api/mini/auth/send-code',
  '/api/mini/auth/phone-login',
  '/api/mini/pay/notify',
  '/api/mini/pay/refund-notify',
  '/api/mini/pay/dy-notify',
  '/api/mini/pay/dy-refund-notify',
  '/api/mini/stores',
  '/api/mini/rooms',
  '/api/mini/packages',
  '/api/mini/products',
  '/api/mini/wenlv',
  '/api/mini/wenlv-trade',
  '/api/mini/regions',
  '/api/mini/kf',  // 联系客服（免登录公开，仅 GET 只读）
];

// 精确匹配的公开路径（前缀下有需登录的子路由，不能整体放行）
// coupons 列表公开可浏览，但 /my 和 /:id/claim 需登录
const MINI_PUBLIC_EXACT = ['/api/mini/coupons'];

export function isMiniPublicPath(path: string): boolean {
  if (MINI_PUBLIC_EXACT.includes(path)) return true;
  return MINI_PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

/** C端认证中间件（独立密钥，与员工 JWT 完全隔离） */
export async function miniAuthMiddleware(c: Context, next: Next) {
  if (isMiniPublicPath(c.req.path)) return next();

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ success: false, error: '未登录' }, 401);
  }
  // 配置缺失属部署错误：放在 try 外，让 FATAL 显性抛出，而不是被 catch 吞成"登录已过期"
  const secret = requireEnv('MINI_JWT_SECRET');
  try {
    const payload = jwt.verify(authHeader.slice(7), secret, { audience: MINI_JWT_AUDIENCE }) as MiniAuthUser;
    c.set('miniUser', payload);
    return next();
  } catch {
    return c.json({ success: false, error: '登录已过期' }, 401);
  }
}

/** 从上下文取 C端用户（路由 handler 用） */
export function getMiniUser(c: Context): MiniAuthUser {
  const user = c.get('miniUser') as MiniAuthUser | undefined;
  if (!user) throw new Error('未登录'); // 受保护路径下不应发生
  return user;
}

/**
 * 手动解析 C端 JWT（供「公开前缀下的需登录子路由」使用，如 /api/mini/products/recommend）。
 * 与 miniAuthMiddleware 共用同一把密钥 + audience；解析失败返回 null，由调用方决定返回 401。
 * 注意：仅用于从 Authorization 头取用户身份，不做任何状态写入。
 */
export function parseMiniToken(authHeader: string | undefined): MiniAuthUser | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const secret = requireEnv('MINI_JWT_SECRET');
  try {
    return jwt.verify(authHeader.slice(7), secret, { audience: MINI_JWT_AUDIENCE }) as MiniAuthUser;
  } catch {
    return null;
  }
}
