import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { db } from '../db/index';
import { pmsBuiSettings } from '../db/schema';
import { pmsPlatformSubscriptions } from '../db/schema/platform.js';
import { eq, and, desc } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { validateBody } from '../utils/validate';
import { JWT_SECRET } from '../constants.js';

const route = new Hono();

// 腾讯地图搜索代理（避免前端 CORS）
route.get('/map-search', async (c) => {
  const keyword = c.req.query('keyword') || '';
  const key = 'FWEBZ-WHSHV-IRFPO-UNMRL-5EUWV-BFBFW';
  try {
    const url = `https://apis.map.qq.com/ws/place/v1/search?keyword=${encodeURIComponent(keyword)}&key=${key}&boundary=region(全国,0)`;
    const res = await fetch(url);
    const json = await res.json();
    return c.json(json);
  } catch {
    return c.json({ status: -1, message: '搜索失败' });
  }
});

// GET /api/settings/property-profile — 读取民宿档案
route.get('/property-profile', async (c) => {
  const scope = getTenantScope(c);
  const [row] = await db.select().from(pmsBuiSettings)
    .where(and(
      eq(pmsBuiSettings.category, 'property_profile'),
      eq(pmsBuiSettings.key, 'main'),
      ...tenantWhere(scope, pmsBuiSettings),
    )).limit(1);

  return c.json({ success: true, data: row?.value || {} });
});

// PUT /api/settings/property-profile — 保存民宿档案
route.put('/property-profile', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();

  const id = `pf_${scope.storeId}`;
  await db.insert(pmsBuiSettings).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId,
    category: 'property_profile', key: 'main',
    value: body,
  }).onConflictDoUpdate({
    target: pmsBuiSettings.id,
    set: { value: body, updatedAt: new Date() },
  });

  return c.json({ success: true });
});

route.get('/', async (c) => {
  const type = c.req.query('type');

  if (type === 'business') {
    const authHeader = c.req.header('Authorization');
    let merchantId = '';
    if (authHeader?.startsWith('Bearer ')) {
      try { const p = jwt.verify(authHeader.slice(7), JWT_SECRET) as any; merchantId = p.merchantId || ''; } catch {}
    }
    const rows = merchantId
      ? await db.select().from(pmsBuiSettings).where(and(eq(pmsBuiSettings.category, 'business'), eq(pmsBuiSettings.merchantId, merchantId)))
      : [];
    const result: Record<string, any> = {};
    rows.forEach(r => { result[r.key] = r.value; });
    const bp = result.booking_policy || result.booking || {};
    const cp = result.check_in_policy || result.checkIn || {};
    return c.json({
      booking: {
        minAdvanceHours: bp.minAdvanceHours ?? bp.advanceDays ?? 2,
        maxBookingDays: bp.maxBookingDays ?? bp.advanceDays ?? 30,
        freeCancelDeadline: bp.freeCancelDeadline ?? bp.sameDayCutoff ?? '18:00',
        autoCancelTime: bp.autoCancelTime ?? '当日20:00',
        sameDayBooking: bp.sameDayBooking ?? bp.allowCancel ?? true,
        allowOverBooking: bp.allowOverBooking ?? false,
      },
      checkIn: {
        standardCheckIn: cp.standardCheckIn ?? cp.standardTime ?? '14:00',
        standardCheckOut: cp.standardCheckOut ?? '12:00',
        defaultDeposit: cp.defaultDeposit ?? cp.depositAmount ?? 200,
        lateCheckOutFee: cp.lateCheckOutFee ?? 50,
        lateCheckOutMaxHours: cp.lateCheckOutMaxHours ?? 3,
        earlyCheckInFee: cp.earlyCheckInFee ?? 80,
        idRequired: cp.idRequired ?? true,
        allowPet: cp.allowPet ?? false,
        allowSmoking: cp.allowSmoking ?? false,
      },
    });
  }
  if (type === 'subscription') {
    const authHeader = c.req.header('Authorization');
    let merchantId = '';
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as any;
        merchantId = payload.merchantId || '';
      } catch {}
    }
    if (!merchantId) return c.json({ subscriptions: [] });

    const subs = await db.select({
      packageName: pmsPlatformSubscriptions.packageName,
      duration: pmsPlatformSubscriptions.duration,
      endAt: pmsPlatformSubscriptions.endAt,
      amount: pmsPlatformSubscriptions.amount,
    }).from(pmsPlatformSubscriptions)
      .where(eq(pmsPlatformSubscriptions.merchantId, merchantId))
      .orderBy(desc(pmsPlatformSubscriptions.createdAt));
    return c.json({ subscriptions: subs });
  }
  if (type === 'security') {
    const rows = await db.select().from(pmsBuiSettings).where(eq(pmsBuiSettings.category, 'security'));
    const result: Record<string, any> = {};
    rows.forEach(r => { result[r.key] = r.value; });
    return c.json(result);
  }
  if (type === 'notifications') {
    const authHeader = c.req.header('Authorization');
    let merchantId = '';
    if (authHeader?.startsWith('Bearer ')) {
      try { const p = jwt.verify(authHeader.slice(7), JWT_SECRET) as any; merchantId = p.merchantId || ''; } catch {}
    }
    const rows = merchantId
      ? await db.select().from(pmsBuiSettings).where(and(eq(pmsBuiSettings.category, 'notifications'), eq(pmsBuiSettings.merchantId, merchantId)))
      : [];
    const result: Record<string, any> = {};
    rows.forEach(r => { result[r.key] = r.value; });
    return c.json({
      channels: (result.channels as any[]) || [
        { name: '短信通知', desc: '订单确认/取消/提醒', enabled: true },
        { name: '站内消息', desc: '系统通知/审核提醒', enabled: true },
        { name: '邮件通知', desc: '财务报表/对账提醒', enabled: false },
        { name: '微信通知', desc: '实时消息推送', enabled: true },
      ],
      rules: (result.rules as any[]) || [
        { name: '新订单提醒', desc: '收到新订单时通知', enabled: true },
        { name: '取消订单提醒', desc: '订单被取消时通知', enabled: true },
        { name: '入住提醒', desc: '客人入住时通知', enabled: true },
        { name: '退房提醒', desc: '客人退房时通知', enabled: false },
        { name: '支付异常提醒', desc: '支付失败/异常时通知', enabled: true },
        { name: '超时未入住', desc: '预订超时未到店', enabled: true },
      ],
    });
  }

  // Return all settings grouped by category
  const allRows = await db.select().from(pmsBuiSettings);
  const grouped: Record<string, any> = {};
  allRows.forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = {};
    grouped[r.category][r.key] = r.value;
  });
  return c.json(grouped);
});

// Zod 请求体验证 schema
const settingsActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update-business'),
    data: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    action: z.literal('update-security'),
    data: z.record(z.string(), z.any()).optional(),
  }),
  z.object({
    action: z.literal('change-password'),
  }),
  z.object({
    action: z.literal('upgrade-plan'),
  }),
  z.object({
    action: z.literal('update-notifications'),
    data: z.record(z.string(), z.any()).optional(),
  }),
]);

route.post('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, settingsActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;
  const action = data.action;

  if (action === 'update-business') {
    let merchantId = '';
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try { const p = jwt.verify(authHeader.slice(7), JWT_SECRET) as any; merchantId = p.merchantId || ''; } catch {}
    }
    const bizData = data.data || {};
    for (const [key, value] of Object.entries(bizData)) {
      if (!merchantId) continue;
      const id = `set-${merchantId}-business-${key}`;
      await db.insert(pmsBuiSettings).values({
        id, merchantId, category: 'business', key,
        value: typeof value === 'string' ? value : JSON.parse(JSON.stringify(value ?? {})),
      }).onConflictDoUpdate({
        target: pmsBuiSettings.id,
        set: { value: typeof value === 'string' ? value : JSON.parse(JSON.stringify(value ?? {})), updatedAt: new Date() },
      });
    }
    return c.json({ ...bizData, updatedAt: new Date().toISOString() });
  }
  if (action === 'update-security') {
    const secData = data.data || {};
    for (const [key, value] of Object.entries(secData)) {
      await db.update(pmsBuiSettings).set({ value: value as any, updatedAt: new Date() })
        .where(and(eq(pmsBuiSettings.category, 'security'), eq(pmsBuiSettings.key, key)));
    }
    return c.json({ ...secData, updatedAt: new Date().toISOString() });
  }
  if (action === 'change-password') {
    return c.json({ success: true, message: '密码修改成功' });
  }
  if (action === 'upgrade-plan') {
    return c.json({ success: true, message: '升级请求已提交' });
  }
  if (action === 'update-notifications') {
    let merchantId = '';
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try { const p = jwt.verify(authHeader.slice(7), JWT_SECRET) as any; merchantId = p.merchantId || ''; } catch {}
    }
    const notiData = data.data || {};
    for (const [key, value] of Object.entries(notiData)) {
      if (!merchantId) continue;
      const id = `set-${merchantId}-notifications-${key}`;
      await db.insert(pmsBuiSettings).values({
        id, merchantId, category: 'notifications', key,
        value: typeof value === 'string' ? value : JSON.parse(JSON.stringify(value ?? {})),
      }).onConflictDoUpdate({
        target: pmsBuiSettings.id,
        set: { value: typeof value === 'string' ? value : JSON.parse(JSON.stringify(value ?? {})), updatedAt: new Date() },
      });
    }
    return c.json({ success: true, message: '通知配置已保存' });
  }

  return c.json({ success: true });
});

export default route;
