import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiCoupons, pmsBuiCouponRecords, pmsBuiStores, mediaAssets } from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { calcCouponDiscount } from '../../utils/coupon-calc.js';
import { refundPlatformProductOrder, RefundError } from '../../services/product-refund.js';
import { getPlatformProductOrder } from '../../services/platform-client.js';
import { pmsBuiSettings, pmsBuiMiniStoreConfig, pmsBuiRoomTypes } from '../../db/schema/index.js';
import { buildGuideData, mapGuideRoomTypes } from '../../services/checkin-guide.js';
import { handleProductJsapi, handleProductDyJsapi } from './pay-product.js';
import { bindByPromoCode } from '../../services/distribution-engine.js';
import { serverError } from '../../lib/http-error.js';

// ============================================================
// 产品订单代理路由 — 转发到 pms-platform-server
// ============================================================

const route = new Hono();
const PLATFORM_URL = 'http://pms-platform-server:9092';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';

/** 代理请求到 pms-platform（支持 GET/POST） */
async function platformFetch(path: string, options?: { method?: string; body?: any }): Promise<any> {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    method: options?.method || 'GET',
    headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json();
  return json;
}

/**
 * 计算套餐订单总额（元）+ 关联房型：平台商品最低售价 × 数量。
 * 与平台创建订单的算价口径一致（bestPrice = min(sellingPrice)，rawTotal = bestPrice * quantity，
 * 见 pms-platform product-orders POST /），保证 pms-server 算出的 couponDiscount 恒 < 平台算出的订单总额，
 * 不会触发平台「券抵扣 ≥ 订单额」拒绝。roomTypeIds 供券 scope（适用房型/商品范围）校验使用。
 */
async function fetchProductInfo(productId: string, quantity: number): Promise<{ rawTotal: number; roomTypeIds: string[] } | null> {
  if (!productId) return null;
  try {
    const res = await fetch(`${PLATFORM_URL}/api/products/${productId}`, {
      headers: { 'X-Internal-Token': INTERNAL_TOKEN },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.success) return null;
    const data = json.data || {};
    const pricing = (data.pricing || []) as { sellingPrice: string | number }[];
    if (pricing.length === 0) return null;
    const bestPrice = pricing.reduce((min, p) => {
      const sp = Number(p.sellingPrice) || 0;
      return sp < min ? sp : min;
    }, Number(pricing[0].sellingPrice) || 0);
    if (!bestPrice || bestPrice <= 0) return null;
    const attrs = (data.extraAttrs || {}) as Record<string, any>;
    const roomTypeIds = Array.isArray(attrs.roomTypeIds) ? (attrs.roomTypeIds as string[]) : [];
    return { rawTotal: bestPrice * quantity, roomTypeIds }; // 元（不取整，与平台算价口径一致）
  } catch {
    return null;
  }
}

/**
 * 券校验 + 算折扣（D4，Task2，信任边界 I-2 的兑现点：平台不查券，券校验/核销必须在此层完成）。
 * 校验（仅读，原子占券由 POST handler 在建单前完成）：
 *  - 券记录属于该 miniUserId + status='pending'
 *  - 未过期（东八区当天判断；套餐订单无入住日期，按当天判断）
 *  - 券记录所属门店与下单门店一致（record.storeId === body.storeId，防跨店用券）
 *  - 券模板 scope 非空时须包含所购商品或商品关联房型（scope 为空 = 不限）
 * 通过 → 读券模板 → calcCouponDiscount（金额 = 订单总额）→ 返回 { couponRecordId, couponDiscount }。
 * 不通过 / 取价失败 / 折扣为 0 或全额（平台禁「抵扣 ≥ 订单额」的 0 元单）→ 忽略券
 * （couponRecordId=undefined，couponDiscount=0），不阻断下单。
 */
async function resolveCoupon(
  body: { couponRecordId?: string; productId?: string; quantity?: number; storeId?: string },
  miniUserId: string,
): Promise<{ couponRecordId?: string; couponDiscount: number }> {
  const couponRecordId = body.couponRecordId;
  if (!couponRecordId) return { couponRecordId: undefined, couponDiscount: 0 };

  const [record] = await db.select().from(pmsBuiCouponRecords)
    .where(and(
      eq(pmsBuiCouponRecords.id, couponRecordId),
      eq(pmsBuiCouponRecords.miniUserId, miniUserId),
      eq(pmsBuiCouponRecords.status, 'pending'),
    ))
    .limit(1);
  if (!record) return { couponRecordId: undefined, couponDiscount: 0 };

  // 东八区（北京）今天：new Date(now+8h).toISOString() 的 UTC 日期即北京日历日期
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (record.expireAt < today) return { couponRecordId: undefined, couponDiscount: 0 };

  // 归属：券记录必须属于下单门店（防跨店使用）
  if (body.storeId && record.storeId !== body.storeId) return { couponRecordId: undefined, couponDiscount: 0 };

  const [coupon] = await db.select().from(pmsBuiCoupons)
    .where(eq(pmsBuiCoupons.id, record.couponId)).limit(1);
  if (!coupon) return { couponRecordId: undefined, couponDiscount: 0 };

  const product = await fetchProductInfo(body.productId || '', Number(body.quantity) || 1);
  if (!product || product.rawTotal <= 0) return { couponRecordId: undefined, couponDiscount: 0 };

  // scope（券适用范围）：非空时须含所购商品或商品关联房型
  const scope = (coupon.scope || []) as string[];
  if (scope.length > 0) {
    const inScope = scope.includes(body.productId || '') || product.roomTypeIds.some((rid) => scope.includes(rid));
    if (!inScope) return { couponRecordId: undefined, couponDiscount: 0 };
  }

  const result = calcCouponDiscount(
    { originalTotal: product.rawTotal, memberTotal: product.rawTotal, nights: 1 },
    { type: coupon.type, value: coupon.value, minAmount: coupon.minAmount },
  );
  if (result.discount <= 0) return { couponRecordId: undefined, couponDiscount: 0 };
  // 平台禁止「券抵扣 ≥ 订单额」的 0 元单（couponDiscount >= rawTotal 直接 400 拒绝）：全免场景忽略券
  if (result.discount >= product.rawTotal) return { couponRecordId: undefined, couponDiscount: 0 };

  const discount = Math.round(result.discount * 100) / 100; // 元，2位小数
  return { couponRecordId, couponDiscount: discount };
}

// ============================================================
// POST /api/mini/product-orders — 创建订单（需登录）
// ============================================================
route.post('/', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const body = await c.req.json();

    // 下单即分销：若 body 携带 promoCode（来自分享链接），则绑定上级推广员（先到先得，建立 referral_bindings，不覆盖）。
    // promoCode 仅 pms-server 侧消费，转发平台建单时需从 payload 剥离（平台端无此字段）。
    const promoCode = typeof body.promoCode === 'string' ? body.promoCode : '';
    if (promoCode) {
      await bindByPromoCode(miniUser.miniUserId, body.storeId, promoCode);
    }

    // 预订模式显式校验（D1 双模式）：合法值 A（订金）/ B（全款），缺省默认 B 全款。
    // 转发层先拦截非法值，避免直接透传给平台端导致间接报错；平台端仍做二次校验。
    if (body.mode != null && body.mode !== 'A' && body.mode !== 'B') {
      return c.json({ success: false, error: '预订模式不合法，仅支持 A（订金）/ B（全款）' }, 400);
    }
    if (body.mode == null) body.mode = 'B';

    // 券抵扣（D4，Task2，Critical#1 并发修复）：「先原子占券，再建单」。
    // 1) resolveCoupon 只做读侧校验 + 算折扣（信任边界：折扣只能由本层算出，body 中的 couponRecordId/couponDiscount 会被覆盖）。
    // 2) 转发平台建单前，先原子 UPDATE 占券（status='pending' → 'used' + 临时 orderId）：
    //    0 行 = 券已被并发请求占用 / 已失效 → 忽略券（不下折扣，不阻断下单）；双击只可能有一单拿到折扣。
    // 3) 平台建单成功后把临时 orderId 换成平台正式 orderId；建单失败则回滚为 pending，券可再次使用。
    const coupon = await resolveCoupon(body, miniUser.miniUserId);
    let couponRecordId = coupon.couponRecordId;
    let couponDiscount = coupon.couponDiscount;
    let tempOrderId = '';

    if (couponRecordId && couponDiscount > 0) {
      tempOrderId = `reserve_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const [reserved] = await db.update(pmsBuiCouponRecords)
        .set({ status: 'used', usedOrderId: tempOrderId, usedAt: new Date() })
        .where(and(
          eq(pmsBuiCouponRecords.id, couponRecordId),
          eq(pmsBuiCouponRecords.miniUserId, miniUser.miniUserId),
          eq(pmsBuiCouponRecords.status, 'pending'),
        ))
        .returning({ id: pmsBuiCouponRecords.id });
      if (!reserved) {
        couponRecordId = undefined;
        couponDiscount = 0;
      }
    }

    // 剥离 promoCode 后转发平台建单（避免平台端因未知字段报错 / 污染数据）
    const platformBody = { ...body };
    delete platformBody.promoCode;
    const result = await platformFetch('/api/product-orders', {
      method: 'POST',
      body: { ...platformBody, miniUserId: miniUser.miniUserId, couponRecordId, couponDiscount },
    });

    const orderOk = Boolean(result?.success && result?.data?.orderId);
    if (couponRecordId && couponDiscount > 0 && tempOrderId) {
      if (orderOk) {
        // 建单成功 → 占券已生效，把临时 orderId 换成平台正式 orderId（状态保持 used）
        await db.update(pmsBuiCouponRecords)
          .set({ usedOrderId: result.data.orderId })
          .where(and(
            eq(pmsBuiCouponRecords.id, couponRecordId),
            eq(pmsBuiCouponRecords.usedOrderId, tempOrderId),
          ));
      } else {
        // 建单失败 → 回滚占券为 pending（仅回滚本次临时 orderId 的占用，防误回滚他单）
        await db.update(pmsBuiCouponRecords)
          .set({ status: 'pending', usedOrderId: null, usedAt: null })
          .where(and(
            eq(pmsBuiCouponRecords.id, couponRecordId),
            eq(pmsBuiCouponRecords.status, 'used'),
            eq(pmsBuiCouponRecords.usedOrderId, tempOrderId),
          ));
      }
    }

    return c.json(result);
  } catch (e: any) {
    return serverError(c, e, '创建订单失败');
  }
});

// ============================================================
// GET /api/mini/product-orders — 我的订单列表（需登录）
// ============================================================
route.get('/', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const result = await platformFetch(`/api/product-orders?miniUserId=${miniUser.miniUserId}`);
    return c.json(result);
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// ============================================================
// GET /api/mini/product-orders/my — 我的订单三Tab聚合（需登录）
//   tab：待入住 / 入住中 / 已离店（转发平台端按状态分组过滤）
//   注意：必须注册在 /:id 之前，否则 /my 会被当成订单id匹配
// ============================================================
route.get('/my', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const tab = c.req.query('tab') || '';
    const tabQ = tab ? `&tab=${encodeURIComponent(tab)}` : '';
    const result = await platformFetch(`/api/product-orders?miniUserId=${miniUser.miniUserId}${tabQ}`);
    return c.json(result);
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// ============================================================
// GET /api/mini/product-orders/:id — 订单详情（需登录，代理带 miniUserId 供平台归属校验，防 IDOR）
// ============================================================
route.get('/:id', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const result = await platformFetch(`/api/product-orders/${c.req.param('id')}?miniUserId=${miniUser.miniUserId}`);
    return c.json(result);
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// ============================================================
// GET /api/mini/product-orders/:id/guide — 入住指南（需登录，代理带 miniUserId 防 IDOR）
//   数据源：代理取订单（含订单卡 productName/roomNights/verifyCode 等）→ pms_bui_settings
//   （property_profile.main 民宿档案 → 交通/入住提示，kb_guide 周边 → pois）→ media_assets
//   （category=route AND mediaType=video 实景路线 + category=voice AND mediaType=audio 老板娘语音）
//   → buildGuideData 组装响应
// ============================================================
route.get('/:id/guide', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    // 先经平台校验订单归属（防 IDOR），返回完整订单行（含订单卡数据）
    const result = await platformFetch(`/api/product-orders/${c.req.param('id')}?miniUserId=${miniUser.miniUserId}`);
    const order = result?.data as {
      storeId?: string; id?: string; productId?: string | null; productName?: string | null; roomNights?: number | null;
      quantity?: number | null; reservationDate?: string | null; verifyCode?: string | null; status?: string; mode?: string | null;
      balancePaidAt?: Date | string | null; guestName?: string | null; totalAmount?: string | null;
    } | undefined;
    const storeId = order?.storeId || '';

    // 民宿档案（property_profile.main）+ 周边（kb_guide）+ 门店 + 实景路线视频 + 老板娘语音
    const [profileRows, kbRows, storeRows, routeRows, voiceRows, configRows, roomTypeRows] = await Promise.all([
      db.select({ key: pmsBuiSettings.key, value: pmsBuiSettings.value })
        .from(pmsBuiSettings)
        .where(and(eq(pmsBuiSettings.storeId, storeId), eq(pmsBuiSettings.category, 'property_profile'))),
      db.select({ value: pmsBuiSettings.value })
        .from(pmsBuiSettings)
        .where(and(eq(pmsBuiSettings.storeId, storeId), eq(pmsBuiSettings.category, 'kb_guide')))
        .orderBy(desc(pmsBuiSettings.updatedAt)),
      storeId ? db.select({
        id: pmsBuiStores.id, name: pmsBuiStores.name, address: pmsBuiStores.address,
        latitude: pmsBuiStores.latitude, longitude: pmsBuiStores.longitude, phone: pmsBuiStores.phone,
      }).from(pmsBuiStores).where(and(eq(pmsBuiStores.id, storeId), eq(pmsBuiStores.status, 'active'))).limit(1)
        : Promise.resolve([] as any[]),
      storeId ? db.select({ id: mediaAssets.id, url: mediaAssets.url, name: mediaAssets.name, thumbnailUrl: mediaAssets.thumbnailUrl })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.storeId, storeId), eq(mediaAssets.status, 'active'), eq(mediaAssets.category, 'route'), eq(mediaAssets.mediaType, 'video')))
        .orderBy(desc(mediaAssets.createdAt)).limit(1)
        : Promise.resolve([] as any[]),
      storeId ? db.select({ id: mediaAssets.id, url: mediaAssets.url, name: mediaAssets.name })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.storeId, storeId), eq(mediaAssets.status, 'active'), eq(mediaAssets.category, 'voice'), eq(mediaAssets.mediaType, 'audio')))
        .orderBy(desc(mediaAssets.createdAt)).limit(1)
        : Promise.resolve([] as any[]),
      storeId ? db.select({ headerImages: pmsBuiMiniStoreConfig.headerImages })
        .from(pmsBuiMiniStoreConfig)
        .where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1)
        : Promise.resolve([] as any[]),
      // 平台级优化：订单模式也展示门店全部在售房型（与门店指南同源，pms_bui_room_types 门店 active）
      storeId
        ? db.select().from(pmsBuiRoomTypes)
            .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active')))
        : Promise.resolve([] as any[]),
    ]);

    // 民宿档案：取 main key 的 jsonb 主体
    let profile: Record<string, any> = {};
    for (const r of profileRows) if (r.key === 'main') profile = (r.value as Record<string, any>) || {};

    const headerImages = (configRows[0]?.headerImages as string[] | undefined) || [];

    const roomTypes = mapGuideRoomTypes(roomTypeRows);

    const data = buildGuideData({
      order: order ? {
        id: order.id || '', productId: order.productId ?? null, productName: order.productName ?? null, roomNights: order.roomNights ?? null,
        reservationDate: order.reservationDate ?? null, verifyCode: order.verifyCode ?? null,
        status: order.status || '', mode: order.mode ?? null, balancePaidAt: order.balancePaidAt ?? null,
        guestName: order.guestName ?? null, totalAmount: order.totalAmount ?? null,
      } : {
        id: '', productId: null, productName: null, roomNights: null, reservationDate: null, verifyCode: null,
        status: '', mode: null, balancePaidAt: null, guestName: null, totalAmount: null,
      },
      store: storeRows[0] || null,
      profile,
      kbRows,
      headerImages,
      roomTypes,
      routeVideos: routeRows,
      voiceAudios: voiceRows,
    });

    return c.json({ success: true, data });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// ============================================================
// POST /api/mini/product-orders/:id/pay — 支付（套餐订单）
//   复用 pms-server mini/pay 支付基础设施：由 pms-server 创建 pmsBuiMiniPayments
//   支付单（orderId=平台 po_ 订单 id, orderNo=平台订单号），再调微信/抖音 jsapi。
//   按来源端路由：?platform=douyin 走抖音支付，否则微信支付。
// ============================================================
route.post('/:id/pay', async (c) => {
  try {
    const orderId = c.req.param('id');
    const isDouyin = c.req.query('platform') === 'douyin';
    return isDouyin
      ? await handleProductDyJsapi(c, orderId)
      : await handleProductJsapi(c, orderId);
  } catch (e: any) {
    return serverError(c, e, '支付失败');
  }
});

// ============================================================
// POST /api/mini/product-orders/:id/reserve — 提交预约（需登录，购买≠预约）
//   转发到平台端 /api/product-orders/:id/reserve（带入住日期 reservationDate + miniUserId 归属校验）
// ============================================================
route.post('/:id/reserve', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const body = await c.req.json();
    const result = await platformFetch(`/api/product-orders/${c.req.param('id')}/reserve`, {
      method: 'POST',
      body: { ...body, miniUserId: miniUser.miniUserId },
    });
    return c.json(result);
  } catch (e: any) {
    return serverError(c, e, '预约失败');
  }
});

// ============================================================
// POST /api/mini/product-orders/:id/cancel — 取消未支付订单（需登录，代理带 miniUserId 供平台归属校验）
// ============================================================
route.post('/:id/cancel', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await platformFetch(`/api/product-orders/${c.req.param('id')}/cancel`, {
      method: 'POST',
      body: { ...body, miniUserId: miniUser.miniUserId },
    });
    return c.json(result);
  } catch (e: any) {
    return serverError(c, e, '取消失败');
  }
});

// ============================================================
// PUT /api/mini/product-orders/:id/refund — 已支付订单退款（需登录，money-first：先退钱再落定平台订单）
//   先经平台校验归属（防 IDOR），再执行真实退款：平台试算 → 查支付单 → 金额封顶 →
//   标记 refunding → 调微信/抖音退款。资金最终态由退款回调确认（refund-confirm）。
// ============================================================
route.put('/:id/refund', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const body = await c.req.json().catch(() => ({}));
    const orderId = c.req.param('id');
    // 先经平台校验归属（防 IDOR），再执行 money-first 退款。
    // 归属校验走 platform-client 的 fetcher，以便拿到真实 status 区分传输失败（0）与平台业务错误（>=400）。
    const result = await getPlatformProductOrder(orderId, miniUser.miniUserId);
    if (!result.ok) {
      if (result.status === 0) return c.json({ success: false, error: '平台服务不可用' }, 502);
      const status: ContentfulStatusCode = result.status >= 400 ? (result.status as ContentfulStatusCode) : 404;
      return c.json(result.data || { success: false, error: '订单不存在' }, status);
    }
    const data = await refundPlatformProductOrder(orderId, (body.reason || '用户主动退款').slice(0, 80));
    return c.json({ success: true, data });
  } catch (e: any) {
    if (e instanceof RefundError) return c.json({ success: false, error: e.message }, e.status as ContentfulStatusCode);
    return serverError(c, e, '退款失败');
  }
});

export default route;
