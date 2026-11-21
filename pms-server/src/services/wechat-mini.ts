import { requireEnv } from '../constants.js';

// 安全提醒：微信协议要求 appid/secret 拼在 URL 查询参数中，切勿添加会记录完整 URL 的全局 fetch 日志

/** code2session 返回 */
export interface WxSession {
  openid: string;
  unionid?: string;
  /** 仅小程序 jscode2session 返回；公众号 OAuth 无此字段 */
  session_key?: string;
}

/** 小程序登录凭证换取 openid */
export async function code2Session(code: string): Promise<WxSession> {
  const appid = requireEnv('WX_MINI_APPID');
  const secret = requireEnv('WX_MINI_SECRET');
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = (await res.json()) as any;
  if (data.errcode) {
    throw new Error(`微信登录失败: ${data.errcode} ${data.errmsg}`);
  }
  return data as WxSession;
}

/** 公众号网页授权登录凭证换取 openid（sns/oauth2/access_token） */
export async function code2SessionMp(code: string): Promise<WxSession> {
  const appid = requireEnv('WX_MP_APPID');
  const secret = requireEnv('WX_MP_SECRET');
  const url = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appid}&secret=${secret}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) }).then((r) => r.json() as any);
  if (!res?.openid) throw new Error(`公众号登录失败: ${res?.errmsg || ''}`);
  return { openid: res.openid, unionid: res.unionid || null };
}

// access_token 内存缓存（提前 5 分钟过期）
let tokenCache: { token: string; expireAt: number } | null = null;

/** 获取小程序全局 access_token（带缓存） */
export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expireAt) return tokenCache.token;
  const appid = requireEnv('WX_MINI_APPID');
  const secret = requireEnv('WX_MINI_SECRET');
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = (await res.json()) as any;
  if (!data.access_token) {
    throw new Error(`获取微信 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }
  tokenCache = { token: data.access_token, expireAt: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

/** 手机号授权 code 换取手机号 */
export async function getPhoneNumber(code: string): Promise<string> {
  const token = await getAccessToken();
  const res = await fetch(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json()) as any;
  if (data.errcode !== 0) {
    throw new Error(`获取手机号失败: ${data.errcode} ${data.errmsg}`);
  }
  return data.phone_info.purePhoneNumber as string;
}

/** 微信订阅消息发送结果（不抛错，由调用方据 success/errcode 决定降级） */
export interface SubscribeSendResult {
  success: boolean;
  errcode?: number;
  errmsg?: string;
}

/**
 * 发送微信订阅消息（一次性模板：用户须先通过小程序 wx.requestSubscribeMessage 授权）
 * @param openid     接收用户 openid（touser）
 * @param templateId 模板 id；缺省用 WX_SUBSCRIBE_TEMPLATE_ID
 * @param data       模板字段数据 { 字段名: { value } }，键须与微信后台模板定义一致
 * @param page       点击消息跳转的小程序页面，缺省由微信使用模板配置的页面
 *
 * 注意：WX_SUBSCRIBE_TEMPLATE_ID 未配置时不抛错，返回 success=false 的未配置状态，
 * 由调用方（如入住提醒调度器）降级到站内消息。
 */
export async function sendSubscribeMessage(
  openid: string,
  templateId: string,
  data: Record<string, { value: string }>,
  page?: string,
): Promise<SubscribeSendResult> {
  const configuredTemplateId = process.env.WX_SUBSCRIBE_TEMPLATE_ID;
  if (!configuredTemplateId) {
    return { success: false, errcode: 0, errmsg: 'WX_SUBSCRIBE_TEMPLATE_ID 未配置' };
  }
  const token = await getAccessToken();
  const res = await fetch('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser: openid,
      template_id: templateId || configuredTemplateId,
      ...(page ? { page } : {}),
      data,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return { success: json.errcode === 0, errcode: json.errcode, errmsg: json.errmsg };
}

/**
 * 生成微信小程序码（无限量，适用于门店二维码场景）
 * @param scene — 场景值，最大 32 字符，如 "storeId=xxx"
 * @param page  — 小程序页面路径，默认首页
 * @returns PNG 图片 Buffer
 */
export async function getUnlimitedQRCode(scene: string, page = 'pages/store/home'): Promise<Buffer> {
  if (scene.length > 32) {
    throw new Error(`scene 参数过长（${scene.length}>32）：${scene}`);
  }
  const token = await getAccessToken();
  const res = await fetch(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene, page, width: 430, check_path: false }),
    signal: AbortSignal.timeout(15000),
  });
  // 成功返回图片，失败返回 JSON
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('image')) {
    return Buffer.from(await res.arrayBuffer());
  }
  const err = (await res.json().catch(() => ({}))) as any;
  throw new Error(`生成小程序码失败: ${err.errcode || 'unknown'} ${err.errmsg || ''}`);
}
