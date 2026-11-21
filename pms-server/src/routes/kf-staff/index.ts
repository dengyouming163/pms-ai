import { Hono } from 'hono';
import { and, eq, inArray, sql, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiStaff, pmsBuiStores, mediaAssets, pmsBuiRoomTypes } from '../../db/schema/index.js';
import { getUserIdByCode } from '../../services/wecom-agent.js';
import { JWT_SECRET } from '../../constants.js';
import { isAllStoresScope } from '../../utils/scope.js';
import jwt from 'jsonwebtoken';

const route = new Hono();

/**
 * 从 authUser 取员工 + 校验 storeId 归属（返回门店列表）；未绑定或越权返回 null
 * 可见门店规则（客服工作台定位为跨店工具，区别于 B 端 auth.ts 按商户隔离的 tenant 逻辑）：
 *   - 全部门店（tenant）→ 全部 active 门店（跨商户，客服需服务全平台各门店）
 *   - store 级 → 员工绑定门店（staff.stores）
 */
async function resolveStaff(c: any, storeId?: string) {
  const authUser = c.get('authUser');
  if (!authUser?.userId) return null;
  const [staff] = await db.select().from(pmsBuiStaff)
    .where(eq(pmsBuiStaff.id, authUser.userId)).limit(1);
  if (!staff) return null;

  let stores: string[] = [];
  if (isAllStoresScope(staff.scope)) {
    // 全部门店：返回全部 active 门店（跨商户），员工可切换任一门店服务客户
    const rows = await db.select({ id: pmsBuiStores.id })
      .from(pmsBuiStores)
      .where(eq(pmsBuiStores.status, 'active'));
    stores = rows.map(r => r.id);
  } else {
    stores = ((staff.stores || []) as string[]).filter(Boolean);
  }

  if (storeId && !stores.includes(storeId)) return null;
  return { staff, stores };
}

// GET /api/kf-staff/me — 员工信息 + 绑定门店列表（含门店名）
route.get('/me', async (c) => {
  const ctx = await resolveStaff(c);
  if (!ctx) return c.json({ success: false, error: '未登录或员工不存在' }, 401);
  const { staff, stores } = ctx;

  const nameMap = new Map<string, string>();
  if (stores.length > 0) {
    const rows = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
      .from(pmsBuiStores).where(inArray(pmsBuiStores.id, stores));
    for (const s of rows) nameMap.set(s.id, s.name || '');
  }

  return c.json({
    success: true,
    data: {
      id: staff.id,
      name: staff.name,
      phone: staff.phone,
      avatar: staff.avatar,
      stores: stores.map(sid => ({ id: sid, name: nameMap.get(sid) || sid })),
    },
  });
});

// GET /api/kf-staff/customers — 可发送客户列表（客服会话 + 外部联系人）
route.get('/customers', async (c) => {
  const ctx = await resolveStaff(c);
  if (!ctx) return c.json({ success: false, error: '未登录或员工不存在' }, 401);
  const { staff, stores } = ctx;

  // 1) 客服会话客户：按员工门店过滤（无门店则返回空数组）
  const fetchKf = async (): Promise<any[]> => {
    try {
      const qs = new URLSearchParams({ storeIds: stores.join(',') });
      const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/internal/kf-staff/customers?${qs.toString()}`, {
        headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({ success: false }));
      if (!res.ok && !data.success) console.error('[kf-staff] customers 内部接口非 2xx:', res.status, data);
      if (data.success) return (data.data || []).map((d: any) => ({ ...d, channel: 'kf' }));
      return [];
    } catch (err) {
      console.error('[kf-staff] customers 客服会话代理失败:', err);
      return [];
    }
  };

  // 2) 外部联系人：需员工已绑定企微身份（未绑定则返回空数组）
  const fetchExt = async (): Promise<any[]> => {
    try {
      const qs = new URLSearchParams({ wecomUserid: staff.wecomUserid as string });
      const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/internal/kf-staff/external-contacts?${qs.toString()}`, {
        headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({ success: false }));
      if (!res.ok && !data.success) console.error('[kf-staff] customers 内部接口非 2xx:', res.status, data);
      if (data.success) return (data.data || []).map((d: any) => ({ ...d, channel: 'external' }));
      return [];
    } catch (err) {
      console.error('[kf-staff] customers 外部联系人代理失败:', err);
      return [];
    }
  };

  // 两路内部代理互不依赖，并行拉取避免延迟翻倍（最坏 10s 而非 20s）
  const [kfList, extList] = await Promise.all([
    stores.length > 0 ? fetchKf() : Promise.resolve([]),
    staff.wecomUserid ? fetchExt() : Promise.resolve([]),
  ]);

  return c.json({ success: true, data: mergeCustomers(kfList, extList) });
});

// GET /api/kf-staff/assets — 素材列表（按门店）
route.get('/assets', async (c) => {
  const storeId = c.req.query('storeId') || '';
  const ctx = await resolveStaff(c, storeId);
  if (!ctx) return c.json({ success: false, error: '无权限访问该门店' }, 403);
  const rows = await db.select({
    id: mediaAssets.id,
    url: mediaAssets.url,
    thumbnailUrl: mediaAssets.thumbnailUrl,
    name: mediaAssets.name,
    mediaType: mediaAssets.mediaType,
  }).from(mediaAssets)
    .where(and(eq(mediaAssets.storeId, storeId), eq(mediaAssets.status, 'active')))
    .orderBy(desc(mediaAssets.createdAt))
    .limit(200);
  return c.json({ success: true, data: rows });
});

// GET /api/kf-staff/rooms — 房型列表（按门店，生成卡片链接用）
route.get('/rooms', async (c) => {
  const storeId = c.req.query('storeId') || '';
  const ctx = await resolveStaff(c, storeId);
  if (!ctx) return c.json({ success: false, error: '无权限访问该门店' }, 403);
  const rows = await db.select({
    id: pmsBuiRoomTypes.id,
    storeId: pmsBuiRoomTypes.storeId,
    name: pmsBuiRoomTypes.name,
    bedType: pmsBuiRoomTypes.bedType,
    basePrice: pmsBuiRoomTypes.basePrice,
    minPrice: pmsBuiRoomTypes.minPrice,
    images: pmsBuiRoomTypes.images,
  }).from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')))
    .limit(200);
  return c.json({ success: true, data: rows });
});

// GET /api/kf-staff/kb — 知识库条目（内部代理 platform-server，storeId→property 转换在 platform-server 内）
route.get('/kb', async (c) => {
  const storeId = c.req.query('storeId') || '';
  const ctx = await resolveStaff(c, storeId);
  if (!ctx) return c.json({ success: false, error: '无权限访问该门店' }, 403);
  try {
    const qs = new URLSearchParams({ storeId, limit: '100' });
    const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/internal/kb/documents?${qs.toString()}`, {
      headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({ success: false, data: { list: [] } }));
    return c.json({ success: true, data: (data?.data?.list || []).map((d: any) => ({
      id: d.id, title: d.title, content: d.content, chunkType: d.chunkType, updatedAt: d.updatedAt,
    })) });
  } catch (err) {
    console.error('[kf-staff] kb 代理失败:', err);
    return c.json({ success: false, error: '知识库服务暂不可用' }, 502);
  }
});

// GET /api/kf-staff/packages — 套餐列表（内部代理 pms-platform-server）
route.get('/packages', async (c) => {
  const storeId = c.req.query('storeId') || '';
  const ctx = await resolveStaff(c, storeId);
  if (!ctx) return c.json({ success: false, error: '无权限访问该门店' }, 403);
  try {
    const qs = new URLSearchParams({ storeId, status: 'approved', limit: '100' });
    const res = await fetch(`http://pms-platform-server:9092/api/internal/products?${qs.toString()}`, {
      headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({ success: false, data: { list: [] } }));
    return c.json({ success: true, data: (data?.data?.list || []) });
  } catch (err) {
    console.error('[kf-staff] packages 代理失败:', err);
    return c.json({ success: false, error: '套餐服务暂不可用' }, 502);
  }
});

/**
 * 会话是否属于员工门店（session → openKfid → wecom_kf_accounts.store_id）
 * 返回布尔表示确认归属/不归属；返回 null 表示平台故障无法确认（网络异常/非 2xx/响应无法解析）
 */
export async function isSessionInStores(sessionId: number, stores: string[]): Promise<boolean | null> {
  try {
    const qs = new URLSearchParams({ sessionId: String(sessionId), storeIds: stores.join(',') });
    const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/internal/kf-staff/session-owned?${qs.toString()}`, {
      headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[kf-staff] session-owned 代理失败: 非 2xx ${res.status}`, body);
      return null;
    }
    const data = await res.json().catch(() => null);
    if (typeof data?.success !== 'boolean') {
      console.error('[kf-staff] session-owned 代理失败: 响应无法解析', data);
      return null;
    }
    return data.success;
  } catch (err) {
    console.error('[kf-staff] session-owned 代理失败:', err);
    return null;
  }
}

// 通用发送代理：校验员工 + session 归属 → 转发 platform-server chat
async function proxySend(c: any, type: 'text' | 'media' | 'room-card' | 'package' | 'miniprogram' | 'guide', extraRequired: string[] = []) {
  const body = await c.req.json().catch(() => ({}));
  const params = validateSessionParams(body);
  if (!params) return c.json({ success: false, error: 'sessionId 必填' }, 400);
  for (const k of extraRequired) {
    if (!(params as any)[k]) return c.json({ success: false, error: `${k} 必填` }, 400);
  }
  // session 归属校验：该会话所属客服账号的门店必须在员工门店内
  const ctx = await resolveStaff(c);
  if (!ctx) return c.json({ success: false, error: '未登录或员工不存在' }, 401);
  const owned = await isSessionInStores(Number(params.sessionId), ctx.stores);
  // 归属无法确认（平台故障）→ 502；明确不归属 → 403 权限拒绝
  if (owned === null) return c.json({ success: false, error: '发送服务暂不可用' }, 502);
  if (!owned) return c.json({ success: false, error: '无权向该会话发送消息' }, 403);

  try {
    const target = buildProxyTarget(type, params.sessionId);
    const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}${target}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
        'Authorization': `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || ''}`,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({ success: false, error: '平台服务响应异常' }));
    return c.json(data, res.status as any);
  } catch (err: any) {
    console.error(`[kf-staff] ${type} 代理失败:`, err);
    return c.json({ success: false, error: '发送服务暂不可用' }, 502);
  }
}

// POST /api/kf-staff/send-text — 文本直发
route.post('/send-text', (c) => proxySend(c, 'text', ['content']));
// POST /api/kf-staff/send-media — 媒体直发
route.post('/send-media', (c) => proxySend(c, 'media', ['mediaUrl', 'mediaType']));
// POST /api/kf-staff/send-room-card — 房型卡片
route.post('/send-room-card', (c) => proxySend(c, 'room-card', ['roomTypeId', 'storeId']));
// POST /api/kf-staff/send-package — 套餐卡片
route.post('/send-package', (c) => proxySend(c, 'package', ['packageId', 'storeId']));
// POST /api/kf-staff/send-miniprogram — 小程序卡片直发（客服会话客户）
route.post('/send-miniprogram', (c) => proxySend(c, 'miniprogram', ['appid', 'pagepath']));
// POST /api/kf-staff/send-guide — 入住指南小程序卡片直发（客服会话客户）
route.post('/send-guide', (c) => proxySend(c, 'guide', ['storeId']));

// POST /api/kf-staff/group-send — 群发任务（外部联系人，需员工企微确认）
route.post('/group-send', async (c) => {
  const ctx = await resolveStaff(c);
  if (!ctx) return c.json({ success: false, error: '未登录或员工不存在' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const params = buildGroupSendBody(body);
  if (!params) return c.json({ success: false, error: 'externalUserids 必填' }, 400);
  // 后端强制用登录员工身份群发（前端不可注入他人身份）
  params.wecomUserid = ctx.staff.wecomUserid;
  if (!params.wecomUserid) return c.json({ success: false, error: '当前员工未绑定企微身份' }, 400);

  try {
    const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/internal/kf-staff/group-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({ success: false, error: '平台服务响应异常' }));
    return c.json(data, res.status as any);
  } catch (err: any) {
    console.error('[kf-staff] group-send 代理失败:', err);
    return c.json({ success: false, error: '群发服务暂不可用' }, 502);
  }
});

// GET /api/kf-staff/session-messages/:sessionId — 会话历史消息（H5 会话页；员工门店归属校验后代理）
route.get('/session-messages/:sessionId', async (c) => {
  const sessionId = Number(c.req.param('sessionId'));
  const ctx = await resolveStaff(c);
  if (!ctx) return c.json({ success: false, error: '未登录或员工不存在' }, 401);
  if (!sessionId) return c.json({ success: false, error: 'sessionId 必填' }, 400);
  const owned = await isSessionInStores(sessionId, ctx.stores);
  if (owned === null) return c.json({ success: false, error: '会话消息服务暂不可用' }, 502);
  if (!owned) return c.json({ success: false, error: '无权查看该会话' }, 403);
  try {
    const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/chat/session/${sessionId}`, {
      headers: {
        'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
        'Authorization': `Bearer ${process.env.INTERNAL_SERVICE_TOKEN || ''}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({ success: false, error: '平台服务响应异常' }));
    return c.json(data, res.status as any);
  } catch (err) {
    console.error('[kf-staff] session-messages 代理失败:', err);
    return c.json({ success: false, error: '会话消息服务暂不可用' }, 502);
  }
});

// POST /api/kf-staff/convert-session — 外部联系人转化直发（生成专属客服链接）
route.post('/convert-session', async (c) => {
  const ctx = await resolveStaff(c);
  if (!ctx) return c.json({ success: false, error: '未登录或员工不存在' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const params = validateConvertSessionBody(body);
  if (!params) return c.json({ success: false, error: 'externalUserid/storeId 必填' }, 400);
  // 员工只能为归属门店生成转化链接
  if (!ctx.stores.includes(params.storeId)) return c.json({ success: false, error: '无权为该门店生成转化链接' }, 403);

  try {
    const res = await fetch(`${process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092'}/api/internal/kf-staff/convert-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({ success: false, error: '平台服务响应异常' }));
    return c.json(data, res.status as any);
  } catch (err: any) {
    console.error('[kf-staff] convert-session 代理失败:', err);
    return c.json({ success: false, error: '转化服务暂不可用' }, 502);
  }
});

// POST /api/kf-staff/bind-wecom — 绑定企微身份（手机号 + 验证码）
route.post('/bind-wecom', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { phone, wecomUserid } = body || {};
  const phoneStr = String(phone || '').trim();
  const uidStr = String(wecomUserid || '').trim();
  if (!phoneStr || !uidStr) return c.json({ success: false, error: 'phone/wecomUserid 必填' }, 400);

  // 手机号校验（复用 pms-server 短信登录用户表 pms_bui_staff.phone）
  const [staff] = await db.select().from(pmsBuiStaff)
    .where(eq(pmsBuiStaff.phone, phoneStr)).limit(1);
  if (!staff) return c.json({ success: false, error: '手机号未注册' }, 404);

  // 唯一冲突检查：wecom_userid 已被其它员工绑定
  const [dup] = await db.select({ id: pmsBuiStaff.id }).from(pmsBuiStaff)
    .where(and(eq(pmsBuiStaff.wecomUserid, uidStr), sql`${pmsBuiStaff.id} <> ${staff.id}`))
    .limit(1);
  if (dup) return c.json({ success: false, error: '该企微身份已绑定其他账号' }, 409);

  await db.update(pmsBuiStaff).set({ wecomUserid: uidStr, updatedAt: new Date() })
    .where(eq(pmsBuiStaff.id, staff.id));

  // 绑定成功后直接签发 JWT（免二次登录）
  const stores = ((staff.stores || []) as string[]).filter(Boolean);
  const token = jwt.sign({
    userId: staff.id, name: staff.name, phone: staff.phone,
    roleId: staff.roleId, scope: staff.scope, merchantId: staff.merchantId,
    homeStoreId: stores[0] || '', accessibleStores: stores,
  }, JWT_SECRET, { expiresIn: '7d' });

  return c.json({ success: true, data: { token } });
});

/** 合并客服会话客户与外部联系人（客服会话在前） */
export function mergeCustomers(kfList: any[], extList: any[]): any[] {
  return [...kfList, ...extList];
}

/** 校验发送必填参数：sessionId 必填且至少携带一个载荷字段，其余字段按需透传 */
export function validateSessionParams(body: any): { sessionId: string; content?: string; mediaUrl?: string; mediaType?: string; roomTypeId?: string; packageId?: string; storeId?: string; title?: string; sender?: string; appid?: string; pagepath?: string; thumbMediaId?: string; thumbImageUrl?: string } | null {
  const sessionId = String(body?.sessionId || '').trim();
  if (!sessionId) return null;
  const out: any = { sessionId };
  let hasPayload = false;
  if (body?.content !== undefined) { out.content = body.content; hasPayload = true; }
  if (body?.mediaUrl !== undefined) { out.mediaUrl = body.mediaUrl; hasPayload = true; }
  if (body?.mediaType !== undefined) { out.mediaType = body.mediaType; hasPayload = true; }
  if (body?.roomTypeId !== undefined) { out.roomTypeId = body.roomTypeId; hasPayload = true; }
  if (body?.packageId !== undefined) { out.packageId = body.packageId; hasPayload = true; }
  if (body?.storeId !== undefined) { out.storeId = body.storeId; hasPayload = true; }
  // title（素材名，send-media 下游读）/ sender（标记人工发送，send-text 下游读）
  if (body?.title !== undefined) { out.title = body.title; hasPayload = true; }
  if (body?.sender !== undefined) { out.sender = body.sender; hasPayload = true; }
  // miniprogram 字段（send-miniprogram 下游读；thumbMediaId/thumbImageUrl 供 platform-server 端兜底上传缩略图用）
  if (body?.appid !== undefined) { out.appid = body.appid; hasPayload = true; }
  if (body?.pagepath !== undefined) { out.pagepath = body.pagepath; hasPayload = true; }
  if (body?.thumbMediaId !== undefined) { out.thumbMediaId = body.thumbMediaId; hasPayload = true; }
  if (body?.thumbImageUrl !== undefined) { out.thumbImageUrl = body.thumbImageUrl; hasPayload = true; }
  if (!hasPayload) return null;
  return out;
}

/** 发送类型 → platform-server chat 路径 */
export function buildProxyTarget(type: 'text' | 'media' | 'room-card' | 'package' | 'miniprogram' | 'guide', sessionId: string): string {
  switch (type) {
    case 'text': return '/api/chat/send';
    case 'media': return '/api/chat/send-media';
    case 'room-card': return `/api/chat/session/${sessionId}/send-room-card`;
    case 'package': return `/api/chat/session/${sessionId}/send-package`;
    case 'miniprogram': return `/api/chat/session/${sessionId}/send-miniprogram`;
    case 'guide': return `/api/chat/session/${sessionId}/send-guide`;
  }
}

/** 校验群发参数并返回代理 body（externalUserids 至少 1 个；wecomUserid 由路由后端强制回填） */
export function buildGroupSendBody(body: any): any {
  const externalUserids = Array.isArray(body?.externalUserids) ? body.externalUserids.filter((e: any) => typeof e === 'string' && e.trim()) : [];
  if (externalUserids.length === 0) return null;
  const out: any = { externalUserids, contentType: body?.contentType };
  if (body?.content !== undefined) out.content = body.content;
  if (body?.link !== undefined) out.link = body.link;
  if (body?.mediaUrl !== undefined) out.mediaUrl = body.mediaUrl;
  return out;
}

/** 校验转化直发参数：externalUserid + storeId 必填（导出供单测） */
export function validateConvertSessionBody(body: any): { externalUserid: string; storeId: string } | null {
  const externalUserid = String(body?.externalUserid || '').trim();
  const storeId = String(body?.storeId || '').trim();
  if (!externalUserid || !storeId) return null;
  return { externalUserid, storeId };
}

export default route;
