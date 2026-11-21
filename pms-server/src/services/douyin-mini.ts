import { requireEnv } from '../constants.js';

// 抖音小程序（字节跳动开放平台）服务
// 注意：抖音与微信协议不同，appid/secret 拼接在 URL 查询参数中，
// 切勿添加会记录完整 URL 的全局 fetch 日志。

/** 抖音 code2session 返回 */
export interface DouyinSession {
  openid: string;
  anonymous_openid?: string;
  session_key?: string;
  unionid?: string;
}

/**
 * 抖音小程序登录凭证换取 openid
 * 接口：GET https://developer.toutiao.com/api/apps/v2/jscode2session
 * tt.login 的 code 换取真实 openid；未授权时可能仅返回 anonymous_openid，
 * 这里优先真实 openid，缺失时回退匿名 openid（用户完成手机号绑定后再升级）。
 */
export async function code2Session(code: string): Promise<DouyinSession> {
  const appid = requireEnv('TT_MINI_APPID');
  const secret = requireEnv('TT_MINI_SECRET');
  const url = `https://developer.toutiao.com/api/apps/v2/jscode2session?appid=${appid}&secret=${secret}&code=${encodeURIComponent(code)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const data = (await res.json()) as any;
  if (data.err_no !== 0) {
    throw new Error(`抖音登录失败: ${data.err_no} ${data.err_tips || data.err_msg || ''}`);
  }
  const d = data.data || {};
  const openid = d.openid || d.anonymous_openid;
  if (!openid) {
    throw new Error('抖音登录失败: 未获取到 openid');
  }
  return {
    openid,
    anonymous_openid: d.anonymous_openid,
    session_key: d.session_key,
    unionid: d.unionid,
  };
}

/**
 * 抖音手机号授权 code 换取手机号
 * 接口：POST https://developer.toutiao.com/api/apps/v2/phone_code
 * 抖音 getPhoneNumber 按钮 e.detail 返回 code（新版）或 encryptedData+iv（旧版）；
 * 当前实现 code 通道，旧版 encryptedData 通道（走 /api/apps/v2/decrypt）待有真实设备后补充。
 */
export async function getPhoneNumber(code: string): Promise<string> {
  const appid = requireEnv('TT_MINI_APPID');
  const secret = requireEnv('TT_MINI_SECRET');
  const res = await fetch(`https://developer.toutiao.com/api/apps/v2/phone_code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appid, secret, code }),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json()) as any;
  if (data.err_no !== 0) {
    throw new Error(`获取手机号失败: ${data.err_no} ${data.err_tips || data.err_msg || ''}`);
  }
  const phone = data.data?.phone_number || data.data?.pure_phone_number || '';
  if (!phone) {
    throw new Error('获取手机号失败: 未获取到手机号');
  }
  return phone;
}
