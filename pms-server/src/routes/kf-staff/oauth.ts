import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { db } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { pmsBuiStaff } from '../../db/schema/index.js';
import { JWT_SECRET } from '../../constants.js';
import { getUserIdByCode } from '../../services/wecom-agent.js';
import type { AuthUser } from '../../middleware/auth.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

/** 企微 OAuth 授权链接（导出供单测） */
export function buildOauthAuthorizeUrl(opts: { corpId: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    appid: opts.corpId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: 'snsapi_base',
    state: 'kf_staff',
  });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

/** 员工记录 → 员工 JWT 载荷；wecom_userid 不匹配返回 null（导出供单测） */
export function resolveStaffJwtPayload(opts: {
  staff: { id: string; name: string; phone: string; merchantId: string; roleId: string; scope: string; stores: string[]; wecomUserid?: string | null };
  wecomUserid: string;
}): Omit<AuthUser, 'permissions'> | null {
  const { staff, wecomUserid } = opts;
  const stores = Array.isArray(staff.stores) ? staff.stores : [];
  // 员工已绑定 wecom_userid 但与本 OAuth userid 不匹配 → 视为未绑定（走绑定流程）
  if (staff.wecomUserid && staff.wecomUserid !== wecomUserid) return null;
  return {
    userId: staff.id,
    name: staff.name,
    phone: staff.phone,
    merchantId: staff.merchantId || 'default',
    roleId: staff.roleId,
    scope: staff.scope || 'store',
    homeStoreId: stores[0] || '',
    accessibleStores: stores,
  };
}

// GET /api/kf-staff/oauth/url — 生成企微授权链接
route.get('/url', (c) => {
  const corpId = process.env.WECOM_CORP_ID || '';
  const redirectUri = process.env.WECOM_OAUTH_REDIRECT || '';
  if (!corpId || !redirectUri) {
    return c.json({ success: false, error: '服务未配置 WECOM_CORP_ID / WECOM_OAUTH_REDIRECT' }, 500);
  }
  return c.json({ success: true, data: { url: buildOauthAuthorizeUrl({ corpId, redirectUri }) } });
});

// POST /api/kf-staff/oauth/exchange — code 换 userid → 查员工 → 签 JWT
route.post('/exchange', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = String(body?.code || '').trim();
  if (!code) return c.json({ success: false, error: '缺少 code' }, 400);

  // 企微 getuserinfo
  let wecomUserid = '';
  try {
    const r = await getUserIdByCode(code);
    wecomUserid = r.userid;
  } catch (err: any) {
    return serverError(c, err, '免登失败', 502);
  }

  // 查员工绑定映射
  const [staff] = await db.select().from(pmsBuiStaff)
    .where(eq(pmsBuiStaff.wecomUserid, wecomUserid))
    .limit(1);
  if (!staff) {
    return c.json({ success: false, data: { bound: false, wecomUserid } });
  }

  const payload = resolveStaffJwtPayload({
    staff: {
      id: staff.id, name: staff.name, phone: staff.phone,
      merchantId: staff.merchantId, roleId: staff.roleId, scope: staff.scope || 'store',
      stores: (staff.stores || []) as string[],
      wecomUserid: staff.wecomUserid,
    },
    wecomUserid,
  });
  if (!payload) {
    return c.json({ success: false, data: { bound: false, wecomUserid } });
  }
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
  return c.json({ success: true, data: { bound: true, token, user: payload } });
});

export default route;
