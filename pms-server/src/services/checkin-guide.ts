// 入住指南数据组装纯函数（路由层只负责拉数据，此处做响应结构拼装，便于单测）
export interface GuideOrderInput {
  id: string;
  productId: string | null;
  productName: string | null;
  roomNights: number | null;
  reservationDate: string | null;
  verifyCode: string | null;
  status: string;
  mode: string | null;
  balancePaidAt: Date | string | null;
  guestName: string | null;
  totalAmount: string | null;
}

export interface GuideStoreInput {
  id: string;
  name: string | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  phone: string | null;
}

/** 门店指南合并后的门店输出（地址/经纬度已按档案优先合并） */
export interface GuideStoreOutput {
  id: string;
  name: string;
  address: string;
  latitude: string;
  longitude: string;
  phone: string;
}

/** 缺省入住提示（民宿档案未配置时降级） */
export const DEFAULT_TIPS = {
  checkInTime: '14:00 后',
  checkOutTime: '12:00 前',
  note: '到店出示核销码即可办理入住，如有疑问请联系前台',
};

/** kb_guide 条目（pms_bui_settings value jsonb）平铺为 poi 列表；value 为 null/空或 title 为空的行跳过，避免产出空 POI */
export function flattenKbGuide(kbRows: Array<{ value: any }>): Array<{ id: string; url: string; name: string; thumbnailUrl?: string }> {
  return kbRows
    .map((r) => {
      const val = r.value || {};
      const type = val.guide_type || val.category || 'other';
      const title = val.title || val.name || '';
      return { id: `${type}_${title}`, url: '', name: title, thumbnailUrl: undefined };
    })
    .filter((poi) => poi.name !== '');
}

/** 套餐可选房型（GuideRoomType） */
export interface GuideRoomType {
  id: string;
  name: string;
  image: string;
  bedType: string;
  area: string | null;   // DB varchar 原样透传（门店详情页同款，前端拼「m²」显示）
  maxGuests: number;
}

/** 门店/套餐房型行 → GuideRoomType（image 取首图；stores 门店指南与 product-orders 订单指南复用） */
export function mapGuideRoomTypes(rows: Array<{
  id: string;
  name: string | null;
  images: string[] | null;
  bedType: string | null;
  area: string | null;
  maxGuests: number | null;
}>): GuideRoomType[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name || '',
    image: (r.images?.[0] as string) || '',
    bedType: r.bedType || '',
    area: r.area ?? null,
    maxGuests: r.maxGuests ?? 0,
  }));
}

/** 周边条目（GuidePoi，kb_guide 分组） */
export interface GuidePoi {
  id: string;
  name: string;
  content: string;
  distance: string;
}

/** guide_type → 分组 key（与 GET /stores/:storeId/nearby 的 TYPE_MAP 对齐） */
const NEARBY_TYPE_MAP: Record<string, string> = {
  scenic: 'scenic', food: 'food', transport: 'transport', climate: 'climate', culture: 'culture',
};

/**
 * kb_guide 条目（pms_bui_settings value jsonb）按 guide_type 分组。
 * 与 flattenKbGuide 平铺不同：保留 content + metadata.distance_text，
 * 供前端「分组 Tab + 横向滑动」周边卡使用。
 */
export function groupKbGuide(kbRows: Array<{ value: any }>): Record<string, GuidePoi[]> {
  const groups: Record<string, GuidePoi[]> = {};
  for (const r of kbRows) {
    const val = r.value || {};
    const type = val.guide_type || val.category || 'other';
    // 交通去重：AI 生成的 transport 分组与档案 transport_guide 重复，仅保留档案交通指引
    if (type === 'transport') continue;
    const group = NEARBY_TYPE_MAP[type] || 'other';
    const title = val.title || val.name || '';
    if (!title) continue;
    if (!groups[group]) groups[group] = [];
    groups[group].push({
      id: `${group}_${title}`,
      name: title,
      content: val.content || '',
      distance: val.metadata?.distance_text || '',
    });
  }
  return groups;
}

/** 民宿档案 profile（property_profile.main 的 value jsonb）→ 交通指引 */
export function buildTransport(profile: Record<string, any>): { guide: string; airport: string; station: string; parking: string } | null {
  const guide = profile.transport_guide || profile.transportGuide || '';
  const airport = profile.nearest_airport || '';
  const station = profile.nearest_station || '';
  const parking = profile.parking_info || '';
  if (!guide && !airport && !station && !parking) return null;
  return { guide, airport, station, parking };
}

/** 民宿档案 profile → 入住提示（缺省字段单独降级） */
export function buildTips(profile: Record<string, any>): typeof DEFAULT_TIPS {
  return {
    checkInTime: profile.check_in_time || profile.checkInTime || DEFAULT_TIPS.checkInTime,
    checkOutTime: profile.check_out_time || profile.checkOutTime || DEFAULT_TIPS.checkOutTime,
    note: profile.policy_notes || profile.policyNotes || DEFAULT_TIPS.note,
  };
}

/** 门店指南的地址/经纬度合并：民宿档案（property_profile.main）优先，门店表兜底；经纬度含颠倒纠正（对齐门店主页 /api/mini/stores/:storeId 合并逻辑） */
export function buildGuideStore(
  store: GuideStoreInput | null,
  profile: Record<string, any>,
): GuideStoreOutput | null {
  if (!store) return null;
  // 经纬度：档案 geo_lat/geo_lng 优先，门店表列兜底
  // 用 || truthy 判断（空串 '' 脏数据视为缺省，与 stores.ts 门店主页及本函数 address/name/phone 一致）
  // 保留原始字符串输出（避免 Number 归一化吞掉小数尾零，如 '106.70' → '106.7'），同时用 Number 做范围/交换校验
  let latRaw: string = String(profile.geo_lat || store.latitude || '0');
  let lngRaw: string = String(profile.geo_lng || store.longitude || '0');
  let lat = Number(latRaw);
  let lng = Number(lngRaw);
  if (!Number.isFinite(lat)) { lat = 0; latRaw = '0'; }
  if (!Number.isFinite(lng)) { lng = 0; lngRaw = '0'; }
  // 档案填写时经纬度易颠倒：纬度超出 -90~90 且经度合法则交换（输出字符串同步交换）
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) {
    [lat, lng] = [lng, lat];
    [latRaw, lngRaw] = [lngRaw, latRaw];
  }
  // 非法范围（含互换后仍越界）归 0
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    lat = 0; lng = 0;
    latRaw = '0'; lngRaw = '0';
  }
  return {
    id: store.id,
    name: profile.name || store.name || '',
    address: profile.address || store.address || '',
    latitude: latRaw,
    longitude: lngRaw,
    phone: profile.phone || store.phone || '',
  };
}

/** 指南响应组装（路由层调用） */
export function buildGuideData(input: {
  order: GuideOrderInput | null;
  store: GuideStoreInput | null;
  headerImages: string[];                       // 新增
  profile: Record<string, any>;
  kbRows: Array<{ value: any }>;
  roomTypes: GuideRoomType[];                   // 新增
  routeVideos: Array<{ id: string; url: string; name: string | null; thumbnailUrl?: string | null }>;
  voiceAudios: Array<{ id: string; url: string; name: string | null }>;
}) {
  return {
    order: input.order,
    store: (() => {
      const merged = buildGuideStore(input.store, input.profile);
      return merged ? { ...merged, headerImages: input.headerImages } : null;
    })(),
    transport: buildTransport(input.profile),
    routeVideos: input.routeVideos.map((v) => ({ id: v.id, url: v.url, name: v.name || '实景路线', thumbnailUrl: v.thumbnailUrl || '' })),
    voiceAudios: input.voiceAudios.map((a) => ({ id: a.id, url: a.url, name: a.name || '老板娘语音' })),
    pois: flattenKbGuide(input.kbRows),        // 兼容保留（旧缓存）
    nearby: groupKbGuide(input.kbRows),        // v2 分组
    roomTypes: input.roomTypes,                // 新增
    tips: buildTips(input.profile),
    fullDescription: input.profile.full_description || '',
    landmarks: (() => {
      const raw = input.profile.landmarks;
      if (Array.isArray(raw)) return raw;
      return String(raw || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
    })(),
    tags: Array.isArray(input.profile.tags) ? input.profile.tags : [],
    policy: {
      checkInTime: input.profile.check_in_time || input.profile.checkInTime || '',
      checkOutTime: input.profile.check_out_time || input.profile.checkOutTime || '',
      notes: input.profile.policy_notes || input.profile.policyNotes || '',
    },
  };
}
