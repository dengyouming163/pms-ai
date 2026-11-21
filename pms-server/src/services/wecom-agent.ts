/**
 * 企微自建应用 OAuth 服务
 * 用自建应用 secret 换取 access_token → getuserinfo 拿 userid（与客服 API 的 corp secret 独立）。
 */

let cachedToken: { token: string; expiresAt: number } | null = null;

/** 获取企微自建应用 access_token（带 100 分钟缓存，与 token.ts 同思路） */
export async function getAgentAccessToken(): Promise<string> {
  const corpId = process.env.WECOM_CORP_ID || '';
  const agentSecret = process.env.WECOM_AGENT_SECRET || '';
  if (!corpId || !agentSecret) throw new Error('缺少 WECOM_CORP_ID / WECOM_AGENT_SECRET');

  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${agentSecret}`,
  );
  const data = await res.json() as any;
  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`企微 agent token 获取失败: ${data.errmsg} (code=${data.errcode})`);
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

/** 用 OAuth code 换企微成员 userid（GET /cgi-bin/auth/getuserinfo） */
export async function getUserIdByCode(code: string): Promise<{ userid: string }> {
  const token = await getAgentAccessToken();
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${token}&code=${encodeURIComponent(code)}`,
  );
  const data = await res.json() as any;
  if (data.errcode !== 0 || !data.userid) {
    throw new Error(`企微 OAuth 免登失败: ${data.errmsg} (code=${data.errcode})`);
  }
  return { userid: data.userid };
}
