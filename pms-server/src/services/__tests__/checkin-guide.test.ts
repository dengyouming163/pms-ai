import { describe, it, expect } from 'vitest';
import { buildGuideData, buildGuideStore, flattenKbGuide, groupKbGuide, mapGuideRoomTypes, DEFAULT_TIPS } from '../checkin-guide.js';

describe('flattenKbGuide（kb_guide 平铺为 poi 列表）', () => {
  it('多组条目平铺 + 字段映射（id/url/name/thumbnailUrl）', () => {
    const rows = [
      { value: { guide_type: 'scenic', title: '青岩古镇', content: '距民宿3km', metadata: { distance_text: '3km' } } },
      { value: { guide_type: 'food', title: '地道酸汤鱼', content: '步行10分钟' } },
    ];
    const pois = flattenKbGuide(rows as any);
    expect(pois).toEqual([
      { id: 'scenic_青岩古镇', url: '', name: '青岩古镇', thumbnailUrl: undefined },
      { id: 'food_地道酸汤鱼', url: '', name: '地道酸汤鱼', thumbnailUrl: undefined },
    ]);
  });

  it('空数组 → 空 poi 列表', () => {
    expect(flattenKbGuide([])).toEqual([]);
  });

  it('value 为 null/空或 title 为空的行被跳过，不产出 POI', () => {
    const rows = [
      { value: { guide_type: 'scenic', title: '青岩古镇' } },
      { value: null },
      { value: {} },
      { value: { guide_type: 'food' } },
    ];
    const pois = flattenKbGuide(rows);
    expect(pois).toEqual([
      { id: 'scenic_青岩古镇', url: '', name: '青岩古镇', thumbnailUrl: undefined },
    ]);
  });
});

describe('buildGuideData（指南响应组装）', () => {
  const order = {
    id: 'po_1', productId: null, productName: '云上慢日子双人套餐', roomNights: 2,
    reservationDate: '2026-08-14', verifyCode: '123456', status: 'store_accepted',
    mode: 'B', balancePaidAt: null, guestName: '张三', totalAmount: '688.00',
  };

  it('完整数据：order + store + transport + pois + tips(档案优先)', () => {
    const data = buildGuideData({
      order,
      store: { id: 'st_1', name: '云上慢日子', address: '青岩古镇北街', latitude: '26.34', longitude: '106.67', phone: '13900000000' },
      profile: {
        transport_guide: '高铁到贵阳北站，打车约40分钟',
        nearest_airport: '贵阳龙洞堡机场',
        nearest_station: '贵阳北站',
        parking_info: '免费停车',
        check_in_time: '15:00',
        check_out_time: '11:00',
        policy_notes: '不可携带宠物',
      },
      kbRows: [{ value: { guide_type: 'scenic', title: '青岩古镇' } }],
      headerImages: [],
      roomTypes: [],
      routeVideos: [{ id: 'a1', url: 'https://x/v.mp4', name: '实景路线', thumbnailUrl: 'https://x/v.jpg' }],
      voiceAudios: [{ id: 'a2', url: 'https://x/voice.mp3', name: '老板娘语音' }],
    });
    expect(data.order).toEqual(order);
    expect(data.transport).toEqual({
      guide: '高铁到贵阳北站，打车约40分钟', airport: '贵阳龙洞堡机场', station: '贵阳北站', parking: '免费停车',
    });
    expect(data.pois).toEqual([{ id: 'scenic_青岩古镇', url: '', name: '青岩古镇', thumbnailUrl: undefined }]);
    expect(data.tips).toEqual({ checkInTime: '15:00', checkOutTime: '11:00', note: '不可携带宠物' });
    const store = data.store;
    expect(store?.phone).toBe('13900000000');
  });

  it('无档案/无素材 → 降级默认 tips + 空 transport/pois（不抛错）', () => {
    const data = buildGuideData({
      order,
      store: null,
      profile: {},
      kbRows: [],
      headerImages: [],
      roomTypes: [],
      routeVideos: [],
      voiceAudios: [],
    });
    expect(data.store).toBe(null);
    expect(data.transport).toBe(null);
    expect(data.pois).toEqual([]);
    expect(data.tips).toEqual(DEFAULT_TIPS);
  });

  it('档案缺 check_in_time → 单独降级该字段，其他保留', () => {
    const data = buildGuideData({
      order,
      store: null,
      profile: { check_out_time: '11:00', policy_notes: '无' },
      kbRows: [], headerImages: [], roomTypes: [], routeVideos: [], voiceAudios: [],
    });
    expect(data.tips.checkInTime).toBe('14:00 后');
    expect(data.tips.checkOutTime).toBe('11:00');
    expect(data.tips.note).toBe('无');
  });
});

describe('groupKbGuide（kb_guide 按 guide_type 分组）', () => {
  it('按 guide_type 分组并映射 name/content/distance', () => {
    const rows = [
      { value: { guide_type: 'scenic', title: '青岩古镇', content: '明清古建筑群', metadata: { distance_text: '3km' } } },
      { value: { guide_type: 'scenic', title: '天河潭', content: '喀斯特地貌', metadata: { distance_text: '12km' } } },
      { value: { guide_type: 'food', title: '地道酸汤鱼', content: '本地特色', metadata: { distance_text: '500m' } } },
    ];
    const groups = groupKbGuide(rows as any);
    expect(groups).toEqual({
      scenic: [
        { id: 'scenic_青岩古镇', name: '青岩古镇', content: '明清古建筑群', distance: '3km' },
        { id: 'scenic_天河潭', name: '天河潭', content: '喀斯特地貌', distance: '12km' },
      ],
      food: [
        { id: 'food_地道酸汤鱼', name: '地道酸汤鱼', content: '本地特色', distance: '500m' },
      ],
    });
  });

  it('未知 guide_type 归 other 组；title 为空跳过', () => {
    const rows = [
      { value: { guide_type: 'weird', title: '未知类型' } },
      { value: { guide_type: 'scenic', title: '' } },
      { value: null },
    ];
    const groups = groupKbGuide(rows as any);
    expect(groups).toEqual({
      other: [{ id: 'other_未知类型', name: '未知类型', content: '', distance: '' }],
    });
  });

  it('空数组 → 空分组对象', () => {
    expect(groupKbGuide([])).toEqual({});
  });
});

describe('buildGuideData（v2 扩展：roomTypes/nearby/headerImages/productId）', () => {
  it('透传 roomTypes + nearby 分组 + store.headerImages + order.productId', () => {
    const data = buildGuideData({
      order: {
        id: 'po_1', productId: 'prod_1', productName: '云上慢日子双人套餐', roomNights: 2,
        reservationDate: '2026-08-14', verifyCode: '123456', status: 'store_accepted',
        mode: 'B', balancePaidAt: null, guestName: '张三', totalAmount: '688.00',
      },
      store: { id: 'st_1', name: '云上慢日子', address: '青岩古镇北街', latitude: '26.34', longitude: '106.67', phone: '13900000000' },
      headerImages: ['https://img/cover.jpg'],
      profile: {},
      kbRows: [
        { value: { guide_type: 'scenic', title: '青岩古镇', content: '明清古建筑群', metadata: { distance_text: '3km' } } },
        { value: { guide_type: 'food', title: '地道酸汤鱼', content: '本地特色' } },
      ],
      roomTypes: [
        { id: 'rt_1', name: '山景大床房', image: 'https://img/room.jpg', bedType: '大床 1.8m', area: '28', maxGuests: 2 },
      ],
      routeVideos: [],
      voiceAudios: [],
    });
    expect(data.order?.productId).toBe('prod_1');
    expect(data.store?.headerImages).toEqual(['https://img/cover.jpg']);
    expect(data.roomTypes).toEqual([
      { id: 'rt_1', name: '山景大床房', image: 'https://img/room.jpg', bedType: '大床 1.8m', area: '28', maxGuests: 2 },
    ]);
    expect(data.nearby).toEqual({
      scenic: [{ id: 'scenic_青岩古镇', name: '青岩古镇', content: '明清古建筑群', distance: '3km' }],
      food: [{ id: 'food_地道酸汤鱼', name: '地道酸汤鱼', content: '本地特色', distance: '' }],
    });
    // 兼容：pois 平铺字段保留
    expect(data.pois).toEqual([
      { id: 'scenic_青岩古镇', url: '', name: '青岩古镇', thumbnailUrl: undefined },
      { id: 'food_地道酸汤鱼', url: '', name: '地道酸汤鱼', thumbnailUrl: undefined },
    ]);
    expect(data.tips).toEqual(DEFAULT_TIPS);
  });

  it('roomTypes 为空 + 无 headerImages + 无 kb 数据 → 空数组/空分组，不抛错', () => {
    const data = buildGuideData({
      order: {
        id: 'po_1', productId: null, productName: null, roomNights: null,
        reservationDate: null, verifyCode: null, status: '', mode: null,
        balancePaidAt: null, guestName: null, totalAmount: null,
      },
      store: null,
      headerImages: [],
      profile: {},
      kbRows: [],
      roomTypes: [],
      routeVideos: [],
      voiceAudios: [],
    });
    expect(data.store).toBe(null);
    expect(data.roomTypes).toEqual([]);
    expect(data.nearby).toEqual({});
    expect(data.pois).toEqual([]);
  });

  it('order 为 null（门店模式）→ 响应 order 为 null，其余字段正常', () => {
    const data = buildGuideData({
      order: null,
      store: { id: 'st_1', name: '云上慢日子', address: '青岩古镇北街', latitude: '26.34', longitude: '106.67', phone: '13900000000' },
      headerImages: ['https://img/cover.jpg'],
      profile: {},
      kbRows: [],
      roomTypes: [],
      routeVideos: [],
      voiceAudios: [],
    });
    expect(data.order).toBe(null);
    expect(data.store?.name).toBe('云上慢日子');
    expect(data.store?.headerImages).toEqual(['https://img/cover.jpg']);
    expect(data.roomTypes).toEqual([]);
    expect(data.nearby).toEqual({});
    expect(data.tips).toEqual(DEFAULT_TIPS);
  });
});

describe('mapGuideRoomTypes（门店/套餐房型映射）', () => {
  it('多房型映射：image 取首图、bedType/area/maxGuests 透传、null 兜底', () => {
    const rows = [
      { id: 'r1', name: '山景大床房', images: ['https://img/1.jpg', 'https://img/2.jpg'], bedType: '1.8m 大床', area: '30', maxGuests: 2 },
      { id: 'r2', name: '亲子双床房', images: null, bedType: null, area: null, maxGuests: null },
    ];
    expect(mapGuideRoomTypes(rows)).toEqual([
      { id: 'r1', name: '山景大床房', image: 'https://img/1.jpg', bedType: '1.8m 大床', area: '30', maxGuests: 2 },
      { id: 'r2', name: '亲子双床房', image: '', bedType: '', area: null, maxGuests: 0 },
    ]);
  });

  it('空数组 → 空列表', () => {
    expect(mapGuideRoomTypes([])).toEqual([]);
  });
});

describe('buildGuideData 档案扩展字段（平台级优化）', () => {
  const baseInput = {
    order: null,
    store: { id: 's1', name: '测试民宿', address: '', latitude: '', longitude: '', phone: '' },
    headerImages: [] as string[],
    kbRows: [] as any[],
    roomTypes: [] as any[],
    routeVideos: [] as any[],
    voiceAudios: [] as any[],
  };

  it('返回 fullDescription/landmarks/tags/policy，landmarks 多行拆数组', () => {
    const data = buildGuideData({
      ...baseInput,
      profile: {
        full_description: '隐居山林的竹木小院',
        landmarks: '灵隐寺\n白乐桥',
        tags: ['亲子友好', '庭院'],
        check_in_time: '15:00',
        check_out_time: '11:00',
        policy_notes: '全屋禁烟',
      },
    });
    expect(data.fullDescription).toBe('隐居山林的竹木小院');
    expect(data.landmarks).toEqual(['灵隐寺', '白乐桥']);
    expect(data.tags).toEqual(['亲子友好', '庭院']);
    expect(data.policy).toEqual({ checkInTime: '15:00', checkOutTime: '11:00', notes: '全屋禁烟' });
  });

  it('缺省字段兜底：fullDescription 空串、landmarks 空数组、tags 空数组、policy 空串', () => {
    const data = buildGuideData({ ...baseInput, profile: {} });
    expect(data.fullDescription).toBe('');
    expect(data.landmarks).toEqual([]);
    expect(data.tags).toEqual([]);
    expect(data.policy).toEqual({ checkInTime: '', checkOutTime: '', notes: '' });
  });

  it('landmarks 为数组时原样透传（兼容老数据直接存数组）', () => {
    const data = buildGuideData({ ...baseInput, profile: { landmarks: ['法喜寺'] } });
    expect(data.landmarks).toEqual(['法喜寺']);
  });

  it('groupKbGuide 跳过 transport 分组（交通去重：以档案 transport_guide 为准）', () => {
    const data = buildGuideData({
      ...baseInput,
      profile: {},
      kbRows: [
        { value: { guide_type: 'scenic', title: '灵隐寺', content: '', metadata: { distance_text: '1km' } } },
        { value: { guide_type: 'transport', title: '杭州东站乘车指南', content: 'xx', metadata: {} } },
      ],
    });
    expect(data.nearby).toEqual({ scenic: [{ id: 'scenic_灵隐寺', name: '灵隐寺', content: '', distance: '1km' }] });
  });
});

describe('buildGuideStore（档案优先合并地址/经纬度）', () => {
  const baseStore = { id: 's1', name: '门店', address: null, latitude: null, longitude: null, phone: null };

  it('档案有 address/geo_lat/geo_lng → 优先取档案值', () => {
    const s = buildGuideStore(baseStore as any, { address: '青岩古镇北门', geo_lat: '26.34', geo_lng: '106.70' });
    expect(s).toMatchObject({ address: '青岩古镇北门', latitude: '26.34', longitude: '106.70' });
  });

  it('档案为空 → 门店表兜底', () => {
    const s = buildGuideStore({ id: 's1', name: '门店', address: '老地址', latitude: '30.5', longitude: '114.3', phone: '138' } as any, {});
    expect(s).toMatchObject({ address: '老地址', latitude: '30.5', longitude: '114.3', phone: '138' });
  });

  it('经纬度颠倒纠正（|lat|>90 且 |lng|<=90 交换）', () => {
    const s = buildGuideStore(baseStore as any, { geo_lat: '106.70', geo_lng: '26.34' });
    expect(s).toMatchObject({ latitude: '26.34', longitude: '106.70' });
  });

  it('非法经纬度归 0', () => {
    const s = buildGuideStore(baseStore as any, { geo_lat: '999', geo_lng: 'abc' });
    expect(s).toMatchObject({ latitude: '0', longitude: '0' });
  });

  it('store 为 null → 返回 null', () => {
    expect(buildGuideStore(null, {})).toBeNull();
  });

  it('档案 geo_lat 为空串 → 落门店表兜底', () => {
    const s = buildGuideStore({ id: 's1', name: '门店', address: '老地址', latitude: '30.5', longitude: '114.3', phone: null } as any, { geo_lat: '', geo_lng: '' });
    expect(s).toMatchObject({ latitude: '30.5', longitude: '114.3' });
  });

  it('档案有 geo 时 name/phone 也档案优先', () => {
    const s = buildGuideStore(baseStore as any, { name: '档案名', phone: '139', geo_lat: '26.34', geo_lng: '106.70' });
    expect(s).toMatchObject({ name: '档案名', phone: '139', latitude: '26.34', longitude: '106.70' });
  });
});
