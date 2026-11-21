import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { pmsBuiStores, pmsBuiRoomTypes } from '../../db/schema/index.js';
import { eq, inArray, sql } from 'drizzle-orm';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { getDistConfig } from '../../services/distribution-engine.js';
import { serverError } from '../../lib/http-error.js';

// ============================================================
// 类型定义
// ============================================================

/** 平台产品列表项 */
interface PlatformProduct {
  id: string;
  name: string;
  storeId: string;
  status: string;
  productType: string;
  extraAttrs: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

/** 平台产品详情（含 images / pricing / storeIds） */
interface PlatformProductDetail extends PlatformProduct {
  images?: { id: string; url: string; sortOrder: number }[];
  pricing?: {
    season: string;
    seasonLabel: string;
    originalPrice: string;
    sellingPrice: string;
    costPrice: string;
    status: string;
  }[];
  storeIds?: string[];
}

/** 返回给小程序的产品结构 */
interface MiniProduct {
  id: string;
  name: string;
  storeId: string;
  coverImage: string | null;
  images: string[];
  storeName: string;
  roomTypeNames: string[];
  roomNights: number;
  pricing: { season: string; seasonLabel: string; originalPrice: number; sellingPrice: number }[];
  diningItems: any[];
  stockMode: string;
  stock: number;
  saleEnd: string | null;
  consumerProtections: string[];
  // 偏好标签（前端优先匹配排序用，来自 extraAttrs.preferenceTags）
  tags: string[];
  // 预订模式配置（D1 私信直订）：modes 开放模式集合 + 订金金额（元）
  bookingModes?: { modes: string[]; depositAmount?: number } | null;
  // 分销裂变：已解析的佣金配置（套餐 distributionConfig 合并全局默认，万分比）
  distributionConfig?: { enabled: boolean; lv1Rate: number; lv2Rate: number } | null;
}

/** 产品补充信息（门店名称 + 房型名称） */
interface ProductEnrichment {
  storeName: string;
  roomTypeNames: string[];
}

// ============================================================
// 常量与工具
// ============================================================

const route = new Hono();
const PLATFORM_URL = 'http://pms-platform-server:9092';
const INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || '';

/** 代理请求到 pms-platform */
async function platformFetch(path: string): Promise<any> {
  const res = await fetch(`${PLATFORM_URL}${path}`, {
    headers: { 'X-Internal-Token': INTERNAL_TOKEN, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Platform API error: ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'Platform API error');
  return json.data;
}

/** 批量查询门店名称 */
async function batchFetchStoreNames(storeIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (storeIds.length === 0) return map;

  try {
    const rows = await db
      .select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
      .from(pmsBuiStores)
      .where(inArray(pmsBuiStores.id, storeIds));
    for (const r of rows) {
      map.set(r.id, r.name);
    }
  } catch (e) {
    console.warn('[mini-products] 批量查询门店名称失败', e);
  }

  return map;
}

/** 批量查询房型名称 */
async function batchFetchRoomTypeNames(roomTypeIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (roomTypeIds.length === 0) return map;

  try {
    const rows = await db
      .select({ id: pmsBuiRoomTypes.id, name: pmsBuiRoomTypes.name })
      .from(pmsBuiRoomTypes)
      .where(inArray(pmsBuiRoomTypes.id, roomTypeIds));
    for (const r of rows) {
      map.set(r.id, r.name);
    }
  } catch (e) {
    console.warn('[mini-products] 批量查询房型名称失败', e);
  }

  return map;
}

/** 用 pms-server 本地数据补充门店名称和房型名称（单个产品，用于详情接口） */
async function enrichProduct(
  p: PlatformProduct | PlatformProductDetail,
  storeNameMap?: Map<string, string>,
  roomTypeNameMap?: Map<string, string>,
): Promise<ProductEnrichment> {
  const storeId = p.storeId;
  const attrs = p.extraAttrs || {};
  const roomTypeIds: string[] = attrs.roomTypeIds || [];

  // 优先使用批量查询的结果
  const storeName = storeNameMap?.get(storeId) ?? (await fetchSingleStoreName(storeId));
  const roomTypeNames: string[] = [];

  if (roomTypeIds.length > 0) {
    if (roomTypeNameMap) {
      for (const id of roomTypeIds) {
        const name = roomTypeNameMap.get(id);
        if (name) roomTypeNames.push(name);
      }
    } else {
      // 回退到单次查询
      const names = await fetchSingleRoomTypeNames(roomTypeIds);
      roomTypeNames.push(...names);
    }
  }

  return { storeName, roomTypeNames };
}

/** 查询单个门店名称（回退方案） */
async function fetchSingleStoreName(storeId: string): Promise<string> {
  try {
    const [store] = await db
      .select({ name: pmsBuiStores.name })
      .from(pmsBuiStores)
      .where(eq(pmsBuiStores.id, storeId))
      .limit(1);
    return store?.name || '';
  } catch (e) {
    console.warn('[mini-products] 查询门店名称失败', { storeId }, e);
    return '';
  }
}

/** 查询房型名称（回退方案） */
async function fetchSingleRoomTypeNames(roomTypeIds: string[]): Promise<string[]> {
  try {
    const types = await db
      .select({ name: pmsBuiRoomTypes.name })
      .from(pmsBuiRoomTypes)
      .where(inArray(pmsBuiRoomTypes.id, roomTypeIds));
    return types.map((t) => t.name);
  } catch (e) {
    console.warn('[mini-products] 查询房型名称失败', { roomTypeIds }, e);
    return [];
  }
}

/** 将平台数据转换为小程序 API 响应格式（排除成本价，精简字段） */
function toMiniProduct(
  p: PlatformProduct | PlatformProductDetail,
  pricing: PlatformProductDetail['pricing'],
  images: PlatformProductDetail['images'],
  enriched: ProductEnrichment,
  globalDist: { enabled: boolean; defaultLv1Rate: number; defaultLv2Rate: number },
): MiniProduct {
  const attrs = p.extraAttrs || {};
  // 分销配置：套餐级优先，缺失回落全局默认；套餐 enabled=false 时整单关闭
  const dc = (attrs.distributionConfig as any) || {};
  const distributionConfig = {
    enabled: dc.enabled ?? globalDist.enabled,
    lv1Rate: dc.lv1Rate ?? globalDist.defaultLv1Rate,
    lv2Rate: dc.lv2Rate ?? globalDist.defaultLv2Rate,
  };

  return {
    id: p.id,
    name: p.name,
    storeId: p.storeId,
    coverImage: (attrs.coverImage as string) || null,
    images: (images || []).map((i) => i.url),
    storeName: enriched.storeName,
    roomTypeNames: enriched.roomTypeNames,
    roomNights: Number(attrs.roomNights) || 1,
    pricing: (pricing || []).map((pr) => ({
      season: pr.season,
      seasonLabel: pr.seasonLabel,
      originalPrice: Number(pr.originalPrice),
      sellingPrice: Number(pr.sellingPrice),
    })),
    diningItems: attrs.diningItems || [],
    stockMode: (attrs.stockMode as string) || 'unlimited',
    stock: Number(attrs.stock) || 0,
    saleEnd: (attrs.saleTimeRange as string[])?.[1] || null,
    consumerProtections: attrs.consumerProtections || [],
    // 偏好标签（前端优先匹配排序用，来自 extraAttrs.preferenceTags）
    tags: (attrs.preferenceTags as string[]) || [],
    // 预订模式配置（D1 私信直订）：透传商品 openBookingModes 配置
    bookingModes: attrs.bookingModes || null,
    distributionConfig,
  };
}

// ============================================================
// GET /api/mini/products — 旅居套餐列表
// ============================================================
route.get('/', async (c) => {
  try {
    const storeId = c.req.query('storeId') || '';
    const typeParam = c.req.query('type') || ''; // 空 = 不按类型拦截，查询所有类型（travel/group_buy/presale 等）
    const category = c.req.query('category') || '';
    const city = c.req.query('city') || '';
    const tag = c.req.query('tag') || '';
    const scene = c.req.query('scene') || '';
    const mood = c.req.query('mood') || '';
    const region = c.req.query('region') || '';
    const page = Number(c.req.query('page')) || 1;
    const limit = Number(c.req.query('limit')) || 10;

    // 平台化需求匹配：city/tag/scene/mood 透传平台端筛选（冗余在商品 extraAttrs；scene/mood 二期双维标签）
    const filterQs = `${city ? `&city=${encodeURIComponent(city)}` : ''}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}${scene ? `&scene=${encodeURIComponent(scene)}` : ''}${mood ? `&mood=${encodeURIComponent(mood)}` : ''}`;

    // 类型查询：不传 type 时不做类型拦截，单次查询平台端所有类型（首页「所有类型都查询出来」）。
    // 传 type 时支持逗号分隔多类型（平台 API 不支持逗号分隔，拆为多次请求）；
    // 多类型时每类型拉取 page*limit 条（而非固定 limit）：多类型合并后在本地切片分页，
    // 本页窗口 [(page-1)*limit, page*limit) 内的数据必落在各类型各自的前 page*limit 条内，
    // 否则 type=travel,group_buy 双类型时超过单类型单页上限（如 2*10=20 条）load-more 拉不到更多
    const fetchLimit = page * limit;
    const types = typeParam.split(',').map(t => t.trim()).filter(Boolean);
    const allProducts: PlatformProduct[] = [];
    if (types.length === 0) {
      // 不追加 productType 过滤：平台端返回所有类型
      try {
        const qs = `?status=approved&storeId=${encodeURIComponent(storeId)}&page=1&limit=${fetchLimit}${filterQs}`;
        const data = await platformFetch(`/api/products${qs}`);
        const list = data.list || data || [];
        allProducts.push(...list);
      } catch { /* 查询失败跳过 */ }
    } else {
      for (const t of types) {
        try {
          const qs = `?productType=${encodeURIComponent(t)}&status=approved&storeId=${encodeURIComponent(storeId)}&page=1&limit=${fetchLimit}${filterQs}`;
          const data = await platformFetch(`/api/products${qs}`);
          const list = data.list || data || [];
          allProducts.push(...list);
        } catch { /* 某类型查询失败跳过 */ }
      }
    }

    // 类目筛选（匹配 categoryPath 中第二个元素）
    let filtered = allProducts;
    if (category && category !== 'all') {
      filtered = allProducts.filter((p) => {
        const catPath = (p.extraAttrs as any)?.categoryPath || [];
        return catPath.includes(category);
      });
    }

    // 地域筛选（门店级）：查绑定该地域标签的门店集合 → 本地按 storeId 过滤（与 category 同模式）
    if (region) {
      const regionStores = await db.select({ id: pmsBuiStores.id })
        .from(pmsBuiStores)
        .where(sql`${pmsBuiStores.regionTags} @> ${JSON.stringify([region])}::jsonb`);
      const regionStoreIds = new Set(regionStores.map((r) => r.id));
      filtered = filtered.filter((p) => regionStoreIds.has(p.storeId));
    }

    // 分页截取
    const start = (page - 1) * limit;
    const products = filtered.slice(start, start + limit);

    if (products.length === 0) {
      return c.json({ success: true, data: { list: [], total: 0 } });
    }

    // 1) 收集所有需要查询的 storeId 和 roomTypeId
    const storeIds = [...new Set(products.map((p) => p.storeId).filter(Boolean))];
    const allRoomTypeIds = products.flatMap((p) => {
      const attrs = p.extraAttrs || {};
      return (attrs.roomTypeIds as string[]) || [];
    });
    const roomTypeIds = [...new Set(allRoomTypeIds).values()];

    // 2) 批量查询
    const storeNameMap = await batchFetchStoreNames(storeIds);
    const roomTypeNameMap = await batchFetchRoomTypeNames(roomTypeIds);

    // 分销裂变：读取平台级分销默认配置（一次），附加到每款商品
    const globalDist = await getDistConfig().catch(() => ({ enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200 }));

    // 3) 并行获取产品详情 + 本地补充信息
    const enriched = await Promise.all(
      products.map(async (p) => {
        try {
          const detail = await platformFetch(`/api/products/${p.id}`);
          const enrichedMeta = await enrichProduct(p, storeNameMap, roomTypeNameMap);
          return toMiniProduct(p, detail.pricing || [], detail.images || [], enrichedMeta, globalDist);
        } catch (e) {
          console.warn('[mini-products] 获取产品详情失败', { productId: p.id }, e);
          return null;
        }
      }),
    );

    return c.json({
      success: true,
      data: { list: enriched.filter(Boolean), total: filtered.length },
    });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// 商品类目（酒店二级类目）
route.get('/categories', (c) => {
  return c.json({ success: true, data: [
    { key: 'all', label: '全部' },
    { key: 'hotel_boutique', label: '精品民宿' },
    { key: 'hotel_resort', label: '度假酒店' },
    { key: 'hotel_business', label: '商务酒店' },
  ]});
});

// ============================================================
// GET /api/mini/products/recommend — 复购推荐（D5 规则 banner，需登录）
//   /api/mini/products 前缀整体公开（列表/详情/类目无需登录），miniAuthMiddleware 不会
//   为其写入 miniUser，故此处用 parseMiniToken 手动解析 Authorization 取当前用户，
//   再带 miniUserId 转发平台（防越权）。平台端按「离店30天老客 + 同门店偏好 + 淡季底价」
//   推荐 3 款 travel 套餐；无历史/无商品返回空数组，前端不显示 banner。
//   注意：必须注册在 /:id 之前，否则 /recommend 会被当成商品 id 匹配
// ============================================================
route.get('/recommend', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const data = await platformFetch(`/api/products/recommend?miniUserId=${encodeURIComponent(miniUser.miniUserId)}`);
    return c.json({ success: true, data });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// ============================================================
// GET /api/mini/products/:id — 旅居套餐详情
// ============================================================
route.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const detail: PlatformProductDetail = await platformFetch(`/api/products/${id}`);

    // 已下架（offline）/已软删（deleted）的套餐，C 端详情一律按「不存在」处理：本端点自己不带
    // status 入参，平台详情口（pms-platform-server/src/routes/products.ts:299）也只按 id 查、
    // 不过滤 status —— 不在这里挡，下架商品仍能被 C 端用旧链接直接打开。
    // ⚠️ 闸只放这一个 handler 内，绝不能搬去共用层或列表路径（:324）：那里对每个商品也调同一个
    //    平台详情口，而列表查平台时**已带** `status=approved`（:263/:271）；搬过去会让
    //    mini/__tests__/products-region.test.ts:27 的详情桩（无 status 字段）触发
    //    `undefined !== 'approved'`，列表整体清空、该文件由绿转红。
    if (detail.status !== 'approved') {
      return c.json({ success: false, error: '套餐已下架或不存在' }, 404);
    }

    const enrichedMeta = await enrichProduct(detail);
    const attrs = detail.extraAttrs || {};

    const globalDist = await getDistConfig().catch(() => ({ enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200 }));
    const result = toMiniProduct(detail, detail.pricing || [], detail.images || [], enrichedMeta, globalDist);
    return c.json({
      success: true,
      data: {
        ...result,
        richTextHtml: (attrs.richTextHtml as string) || '',
        bookingValidityDays: Number(attrs.bookingValidityDays) || 360,
        checkinDays: Number(attrs.checkinDays) || 360,
        cancelRule: (attrs.cancelRule as string) || 'free',
        cancelFreeHours: Number(attrs.cancelFreeHours) || 24,
        earliestCheckinTime: (attrs.earliestCheckinTime as string) || '14:00',
        latestCheckoutTime: (attrs.latestCheckoutTime as string) || '12:00',
        purchaseLimitPerOrder: Number(attrs.purchaseLimitPerOrder) || 1,
      },
    });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

export default route;
