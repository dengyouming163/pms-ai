import type { Context, Next } from 'hono';

const MASK_RULES: Record<string, (value: any) => any> = {
  guestName: (v: string) => {
    if (!v || v.length < 2) return v;
    return v[0] + (v.length === 2 ? '*' : '先生/女士');
  },
  name: (v: string) => {
    if (!v || v.length < 2) return v;
    return v[0] + (v.length === 2 ? '*' : '先生/女士');
  },
  guestPhone: (v: string) => {
    if (!v || v.length < 11) return v;
    return v.slice(0, 3) + '****' + v.slice(-4);
  },
  phone: (v: string) => {
    if (!v || v.length < 11) return v;
    return v.slice(0, 3) + '****' + v.slice(-4);
  },
};

function deepMask(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(deepMask);
  if (typeof obj === 'object' && obj.constructor === Object) {
    const masked: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (MASK_RULES[key] && typeof val === 'string') {
        masked[key] = MASK_RULES[key](val);
      } else {
        masked[key] = deepMask(val);
      }
    }
    return masked;
  }
  return obj;
}

/**
 * 数据脱敏中间件
 * 拦截 /api/internal/* 的 JSON 响应，自动脱敏敏感字段
 */
export async function dataMaskMiddleware(c: Context, next: Next) {
  await next();
  // 素材接口的 name 是素材名（非 PII），跳过脱敏，避免素材名被误脱敏。
  // 该接口仅返回素材元数据（id/storeId/url/thumbnailUrl/name/mediaType/category/purposeTags），无 PII 字段，故整条响应豁免脱敏
  if (c.req.path === '/api/internal/assets') return;
  // 分销/客户管理接口：平台管理员需查看真实姓名/手机号，豁免脱敏
  if (c.req.path.startsWith('/api/internal/distribution')) return;
  const path = c.req.path;
  if (!path.startsWith('/api/internal/')) return;
  const contentType = c.res.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) return;
  if (c.res.status < 200 || c.res.status >= 300) return;
  try {
    const original = await c.res.clone().json();
    const masked = deepMask(original);
    c.res = new Response(JSON.stringify(masked), {
      status: c.res.status,
      headers: c.res.headers,
    });
  } catch {
    // 非 JSON 响应跳过
  }
}
