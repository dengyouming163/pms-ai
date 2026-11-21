import crypto from 'node:crypto';
import { requireEnv } from '../constants.js';

/** 公众号 access_token（缓存 7000s，公众号接口频控严格）。
 *  并发场景缓存 in-flight Promise，避免缓存击穿导致重复请求公众号接口。 */
let atCache: { token: string; expireAt: number } | null = null;
let atPromise: Promise<string> | null = null;
export function getMpAccessToken(): Promise<string> {
  if (atCache && Date.now() < atCache.expireAt) return Promise.resolve(atCache.token);
  if (!atPromise) {
    atPromise = (async () => {
      const appid = requireEnv('WX_MP_APPID'), secret = requireEnv('WX_MP_SECRET');
      const res = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`, { signal: AbortSignal.timeout(10000) })
        .then((r) => r.json() as any);
      if (!res?.access_token) throw new Error(`公众号 access_token 获取失败: ${res?.errmsg || ''}`);
      atCache = { token: res.access_token, expireAt: Date.now() + 7000 * 1000 };
      return res.access_token;
    })().finally(() => { atPromise = null; });
  }
  return atPromise;
}

let ticketCache: { ticket: string; expireAt: number } | null = null;
let ticketPromise: Promise<string> | null = null;
export function getMpJsapiTicket(): Promise<string> {
  if (ticketCache && Date.now() < ticketCache.expireAt) return Promise.resolve(ticketCache.ticket);
  if (!ticketPromise) {
    ticketPromise = (async () => {
      const token = await getMpAccessToken();
      const res = await fetch(`https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${token}&type=jsapi`, { signal: AbortSignal.timeout(10000) })
        .then((r) => r.json() as any);
      if (!res?.ticket) throw new Error(`jsapi_ticket 获取失败: ${res?.errmsg || ''}`);
      ticketCache = { ticket: res.ticket, expireAt: Date.now() + 7000 * 1000 };
      return res.ticket;
    })().finally(() => { ticketPromise = null; });
  }
  return ticketPromise;
}

/** 公众号 JS-SDK config 签名（wx.config / wx.chooseWXPay 前置） */
export async function buildJsSdkConfig(url: string): Promise<{ appId: string; timestamp: number; nonceStr: string; signature: string }> {
  const ticket = await getMpJsapiTicket();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = crypto.randomBytes(16).toString('hex');
  const signStr = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = crypto.createHash('sha1').update(signStr).digest('hex');
  return { appId: requireEnv('WX_MP_APPID'), timestamp, nonceStr, signature };
}

// ==================== 自定义菜单 ====================

/** 公众号自定义菜单按钮。
 *  - view 类型：跳 H5（url）；
 *  - miniprogram 类型：跳小程序（appid + pagepath，url 保留作为老版本微信降级打开）。 */
export interface MpMenuButton {
  type?: string;
  name: string;
  url?: string;
  /** miniprogram 类型：目标小程序 appid */
  appid?: string;
  /** miniprogram 类型：目标小程序页面路径 */
  pagepath?: string;
  sub_button?: MpMenuButton[];
}

/** 公众号自定义菜单结构：{ button: MpMenuButton[] } */
export interface MpMenu {
  button: MpMenuButton[];
}

/** 微信 API 返回的通用结构（errcode 非 0 表示失败） */
interface WxApiResp {
  errcode?: number;
  errmsg?: string;
}

/**
 * 校验微信 API 返回码：errcode 非 0 抛错（0 或缺失视为成功）。
 * 菜单接口全部走同一校验逻辑。
 */
function assertWxOk(res: WxApiResp, action: string): void {
  if (res.errcode !== undefined && res.errcode !== 0) {
    throw new Error(`公众号菜单 ${action}失败: [${res.errcode}] ${res.errmsg || ''}`);
  }
}

/** 创建自定义菜单（覆盖式：旧菜单整体替换为新结构） */
export async function createMenu(menu: MpMenu): Promise<void> {
  const token = await getMpAccessToken();
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/menu/create?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(menu),
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json() as Promise<WxApiResp>);
  assertWxOk(res, '创建');
}

/** 获取当前自定义菜单（含默认菜单，菜单结构数组） */
export async function getMenu(): Promise<{ menu: MpMenu }> {
  const token = await getMpAccessToken();
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/menu/get?access_token=${token}`, {
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json() as any);
  if (res?.errcode !== undefined && res.errcode !== 0) {
    throw new Error(`公众号菜单获取失败: [${res.errcode}] ${res.errmsg || ''}`);
  }
  return { menu: res.menu };
}

/** 删除自定义菜单（微信同时支持 GET/POST，这里用 GET） */
export async function deleteMenu(): Promise<void> {
  const token = await getMpAccessToken();
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/menu/delete?access_token=${token}`, {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json() as Promise<WxApiResp>);
  assertWxOk(res, '删除');
}
