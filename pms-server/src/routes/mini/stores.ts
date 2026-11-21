import { Hono } from 'hono';
import { eq, and, like, or, sql, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiStores, pmsBuiMiniStoreConfig, pmsBuiSettings, pmsBuiSatisfactionSurveys, mediaAssets, pmsBuiRoomTypes } from '../../db/schema/index.js';
import { aggregateReviews } from '../../services/store-reviews.js';
import { getUnlimitedQRCode } from '../../services/wechat-mini.js';
import { buildGuideData, mapGuideRoomTypes } from '../../services/checkin-guide.js';

const route = new Hono();

// 聚合发现页：所有已上线门店列表（公开，支持城市/关键词筛选）
route.get('/', async (c) => {
  const city = c.req.query('city') || '';
  const keyword = c.req.query('keyword') || '';
  const region = c.req.query('region') || '';

  const conditions: any[] = [
    eq(pmsBuiMiniStoreConfig.online, true),
    eq(pmsBuiStores.status, 'active'),
  ];
  // 城市筛选：优先精确匹配 city 字段（平台化后由后台配置）；无 city 字段时兜底用 address 文本模糊匹配（兼容历史数据）
  if (city) conditions.push(sql`(${pmsBuiStores.city} = ${city} OR ${pmsBuiStores.address} ILIKE ${'%' + city + '%'})`);
  // 地域筛选（门店级）：region_tags 数组包含该地域标签（jsonb @> 数组包含）
  if (region) conditions.push(sql`${pmsBuiStores.regionTags} @> ${JSON.stringify([region])}::jsonb`);
  if (keyword) conditions.push(or(
    sql`${pmsBuiStores.name} ILIKE ${'%' + keyword + '%'}`,
    sql`${pmsBuiMiniStoreConfig.intro} ILIKE ${'%' + keyword + '%'}`,
  ));

  const stores = await db.select({
    id: pmsBuiStores.id,
    name: pmsBuiStores.name,
    brandName: pmsBuiStores.brandName,
    address: pmsBuiStores.address,
    city: pmsBuiStores.city,
    preferenceTags: pmsBuiStores.preferenceTags,
    regionTags: pmsBuiStores.regionTags,
    phone: pmsBuiStores.phone,
    headerImages: pmsBuiMiniStoreConfig.headerImages,
    intro: pmsBuiMiniStoreConfig.intro,
  }).from(pmsBuiMiniStoreConfig)
    .innerJoin(pmsBuiStores, eq(pmsBuiMiniStoreConfig.storeId, pmsBuiStores.id))
    .where(and(...conditions))
    .limit(50);

  return c.json({
    success: true,
    data: stores.map(s => ({ ...s, headerImage: s.headerImages?.[0] || null })),
  });
});

// 门店主页（公开：民宿档案 + 门店基本信息）
// 数据优先级：property_profile（民宿档案）> pmsBuiStores（门店表）> 默认值
route.get('/:storeId', async (c) => {
  const storeId = c.req.param('storeId');
  const [store] = await db.select().from(pmsBuiStores)
    .where(and(eq(pmsBuiStores.id, storeId), eq(pmsBuiStores.status, 'active'))).limit(1);
  if (!store) return c.json({ success: false, error: '门店不存在' }, 404);

  // 并行加载四份数据（门店配置 + 民宿档案 + 口碑评分 + 相册图片素材）
  const [configRows, profileRows, ratingRows, galleryRows] = await Promise.all([
    db.select().from(pmsBuiMiniStoreConfig)
      .where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1),
    db.select({ key: pmsBuiSettings.key, value: pmsBuiSettings.value })
      .from(pmsBuiSettings)
      .where(and(
        eq(pmsBuiSettings.storeId, storeId),
        eq(pmsBuiSettings.category, 'property_profile'),
      )),
    db.select({ score: pmsBuiSatisfactionSurveys.score, createdAt: pmsBuiSatisfactionSurveys.createdAt })
      .from(pmsBuiSatisfactionSurveys)
      .where(eq(pmsBuiSatisfactionSurveys.storeId, storeId)),
    // 相册：直接取素材库图片（mini_store_config.gallery 已弃用）
    db.select({ url: mediaAssets.url })
      .from(mediaAssets)
      .where(and(
        eq(mediaAssets.storeId, storeId),
        eq(mediaAssets.status, 'active'),
        eq(mediaAssets.mediaType, 'image'),
      ))
      .orderBy(desc(mediaAssets.createdAt))
      .limit(30),
  ]);
  const config = configRows[0];
  // 门店口碑：平均分 + 评价数
  const { avgScore, reviewCount } = aggregateReviews(ratingRows);

  // 民宿档案数据（property_profile 的 main key）
  let profile: Record<string, any> = {};
  for (const r of profileRows) {
    if (r.key === 'main') {
      profile = (r.value as Record<string, any>) || {};
    }
  }

  // 经纬度校验 + 自动纠正（民宿档案填写时易颠倒）
  // 统一用 Number() 转换：geo_lat/geo_lng 可能为 string，store.latitude/longitude 为 varchar(string|null)
  let lat = profile.geo_lat ? Number(profile.geo_lat) : Number(store.latitude ?? 0);
  let lng = profile.geo_lng ? Number(profile.geo_lng) : Number(store.longitude ?? 0);
  if (!Number.isFinite(lat)) lat = 0;
  if (!Number.isFinite(lng)) lng = 0;
  // 如果纬度超出范围（-90~90），说明填反了，交换
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    [lat, lng] = [lng, lat];
  }
  // 最终校验
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    lat = 0; lng = 0;
  }

  // 合并：民宿档案优先 → 门店表兜底
  const data = {
    id: store.id,
    name: profile.name || store.name || '',
    brandName: profile.short_name || store.brandName || '',
    address: profile.address || store.address || '',
    phone: profile.phone || store.phone || '',
    latitude: lat,
    longitude: lng,
    facilities: store.facilities || [],
    description: profile.description || '',
    headerImages: config?.headerImages || [],
    intro: config?.intro || profile.full_description || '',
    gallery: galleryRows.map((r) => r.url),
    cancelPolicy: config?.cancelPolicy || { freeHours: 24, feeRate: 20 },
    // 平台化需求匹配字段
    city: store.city || null,
    preferenceTags: store.preferenceTags || [],
    regionTags: store.regionTags || [],
    // 门店口碑：平均分 + 评价数（无评价时为 0）
    rating: { avgScore, reviewCount },
  };

  return c.json({ success: true, data });
});

// 门店口碑：评分聚合 + 评价样本列表
route.get('/:storeId/reviews', async (c) => {
  const storeId = c.req.param('storeId');
  const rows = await db.select({
    score: pmsBuiSatisfactionSurveys.score,
    complaints: pmsBuiSatisfactionSurveys.complaints,
    comment: pmsBuiSatisfactionSurveys.comment,
    createdAt: pmsBuiSatisfactionSurveys.createdAt,
  }).from(pmsBuiSatisfactionSurveys)
    .where(eq(pmsBuiSatisfactionSurveys.storeId, storeId));
  return c.json({ success: true, data: aggregateReviews(rows) });
});

// 民宿档案
route.get('/:storeId/profile', async (c) => {
  const storeId = c.req.param('storeId');
  const rows = await db.select({ key: pmsBuiSettings.key, value: pmsBuiSettings.value })
    .from(pmsBuiSettings)
    .where(and(eq(pmsBuiSettings.storeId, storeId), eq(pmsBuiSettings.category, 'property_profile')));
  const profile: Record<string, any> = {};
  for (const r of rows) { profile[r.key] = r.value; }
  return c.json({ success: true, data: profile });
});

// 周边推荐
route.get('/:storeId/nearby', async (c) => {
  const storeId = c.req.param('storeId');
  const rows = await db.select({ key: pmsBuiSettings.key, value: pmsBuiSettings.value })
    .from(pmsBuiSettings)
    .where(and(eq(pmsBuiSettings.storeId, storeId), eq(pmsBuiSettings.category, 'kb_guide')));
  // 按 guide_type 分组，映射为中文简写
  const TYPE_MAP: Record<string, string> = {
    scenic: 'scenic', food: 'food', transport: 'transport', climate: 'climate', culture: 'culture',
  };
  const groups: Record<string, any[]> = {};
  for (const r of rows) {
    const val = r.value as any;
    const type = val?.guide_type || val?.category || 'other';
    const group = TYPE_MAP[type] || type;
    if (!groups[group]) groups[group] = [];
    groups[group].push(val);
  }
  return c.json({ success: true, data: groups });
});

// 门店入住指南（公开：无订单上下文，纯指南信息——交通/视频/语音/周边/入住提示 + 门店 active 房型）
// 数据源与 product-orders/:id/guide 对齐，去掉 order/product；order 置 null 供前端判门店模式
route.get('/:storeId/guide', async (c) => {
  const storeId = c.req.param('storeId');
  const [store] = await db.select({
    id: pmsBuiStores.id, name: pmsBuiStores.name, address: pmsBuiStores.address,
    latitude: pmsBuiStores.latitude, longitude: pmsBuiStores.longitude, phone: pmsBuiStores.phone,
  }).from(pmsBuiStores)
    .where(and(eq(pmsBuiStores.id, storeId), eq(pmsBuiStores.status, 'active'))).limit(1);
  if (!store) return c.json({ success: false, error: '门店不存在' }, 404);

  const [profileRows, kbRows, routeRows, voiceRows, configRows, roomTypeRows] = await Promise.all([
    db.select({ key: pmsBuiSettings.key, value: pmsBuiSettings.value })
      .from(pmsBuiSettings)
      .where(and(eq(pmsBuiSettings.storeId, storeId), eq(pmsBuiSettings.category, 'property_profile'))),
    db.select({ value: pmsBuiSettings.value })
      .from(pmsBuiSettings)
      .where(and(eq(pmsBuiSettings.storeId, storeId), eq(pmsBuiSettings.category, 'kb_guide')))
      .orderBy(desc(pmsBuiSettings.updatedAt)),
    db.select({ id: mediaAssets.id, url: mediaAssets.url, name: mediaAssets.name, thumbnailUrl: mediaAssets.thumbnailUrl })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.storeId, storeId), eq(mediaAssets.status, 'active'), eq(mediaAssets.category, 'route'), eq(mediaAssets.mediaType, 'video')))
      .orderBy(desc(mediaAssets.createdAt)).limit(1),
    db.select({ id: mediaAssets.id, url: mediaAssets.url, name: mediaAssets.name })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.storeId, storeId), eq(mediaAssets.status, 'active'), eq(mediaAssets.category, 'voice'), eq(mediaAssets.mediaType, 'audio')))
      .orderBy(desc(mediaAssets.createdAt)).limit(1),
    db.select({ headerImages: pmsBuiMiniStoreConfig.headerImages })
      .from(pmsBuiMiniStoreConfig)
      .where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1),
    // 新增：门店全部 active 房型（与门店首页「房型一览」同源，rooms/list 同条件）
    db.select().from(pmsBuiRoomTypes)
      .where(and(eq(pmsBuiRoomTypes.storeId, storeId), eq(pmsBuiRoomTypes.status, 'active'))),
  ]);

  // 民宿档案：取 main key 的 jsonb 主体
  let profile: Record<string, any> = {};
  for (const r of profileRows) if (r.key === 'main') profile = (r.value as Record<string, any>) || {};

  const headerImages = (configRows[0]?.headerImages as string[] | undefined) || [];
  const roomTypes = mapGuideRoomTypes(roomTypeRows);

  const data = buildGuideData({
    order: null,
    store,
    profile,
    kbRows,
    headerImages,
    roomTypes,
    routeVideos: routeRows,
    voiceAudios: voiceRows,
  });

  return c.json({ success: true, data });
});

// 门店小程序码（返回 PNG 图片）
route.get('/:storeId/qrcode', async (c) => {
  const storeId = c.req.param('storeId');
  // 校验门店存在且状态为 active（二维码仅需门店存在，不强制要求已开通线上预订）
  const [store] = await db.select().from(pmsBuiStores)
    .where(and(eq(pmsBuiStores.id, storeId), eq(pmsBuiStores.status, 'active'))).limit(1);
  if (!store) return c.json({ error: '门店不存在' }, 404);

  // 兜底：如果 mini_store_config 无记录，自动创建一条默认记录
  const [config] = await db.select({ id: pmsBuiMiniStoreConfig.id })
    .from(pmsBuiMiniStoreConfig)
    .where(eq(pmsBuiMiniStoreConfig.storeId, storeId)).limit(1);
  if (!config) {
    await db.insert(pmsBuiMiniStoreConfig).values({
      id: `msc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: store.merchantId || 'default',
      storeId,
      online: false,
      headerImages: [],
      intro: '',
      gallery: [],
    }).onConflictDoNothing();
  }

  try {
    const buf = await getUnlimitedQRCode(`storeId=${storeId}`);
    // Buffer 转 Uint8Array：Response body 需要 BodyInit（Buffer<ArrayBufferLike> 不在其联合类型内）
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',  // 缓存 24 小时
      },
    });
  } catch (err: any) {
    console.error('[qrcode] 生成失败:', err.message);
    return c.json({ error: '小程序码生成失败，请稍后重试' }, 500);
  }
});

export default route;
