/**
 * 云栖山舍演示种子数据
 *
 * 用法（一条命令灌入，可重复执行，结果幂等）：
 *   pnpm --dir pms-server exec tsx ../deploy/seed/demo-seed.ts
 *
 * 会读取 PG_HOST / PG_PORT / PG_DATABASE / PG_USER / PG_PASSWORD，未设置时回落到本地 compose 默认值。
 * 只按 merchantId = demo-yunqi 先删后插，绝不触碰其他租户数据。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MERCHANT_ID = 'demo-yunqi';
const SEED = 20261121;
const TOTAL_DAYS = 90;
/** 价格日历在历史窗口之外向未来延伸的天数，覆盖「明天」及后续演示 */
const FUTURE_DAYS = 30;

/** 上海时区（UTC+8）的今天，格式 YYYY-MM-DD */
function todayInShanghai(): string {
  const now = new Date();
  const sh = new Date(now.getTime() + 8 * 3600 * 1000);
  return sh.toISOString().slice(0, 10);
}

/** 演示窗口的锚点日：最近 90 天（含当天）的订单，以及历史 + 未来 30 天的价格日历 */
const ANCHOR_DATE = todayInShanghai();
const DEMO_PHONE = '13800000000';
const DEMO_PASSWORD = 'Demo123456';

// pms-server 的依赖（pg / bcryptjs）安装在其自身 node_modules 下，本文件位于 deploy/seed，
// 直接 import 解析不到，因此通过 pms-server/package.json 建立 require 锚点。
const requireFromServer = createRequire(new URL('../../pms-server/package.json', import.meta.url));

// ============================================================
// 静态配置
// ============================================================

interface BrandConfig {
  id: string;
  name: string;
  type: string;
  logo: string;
  color: string;
  description: string;
  contactName: string;
  contactPhone: string;
  facilities: string[];
  standards: Record<string, string>;
  sops: string[];
}

interface StoreConfig {
  id: string;
  name: string;
  shortName: string;
  city: string;
  address: string;
  phone: string;
  roomCount: number;
  manager: string;
  latitude: string;
  longitude: string;
  description: string;
  facilities: string[];
  preferenceTags: string[];
  regionTags: string[];
}

interface RoomTypeConfig {
  id: string;
  storeId: string;
  name: string;
  bedType: string;
  area: string;
  maxGuests: number;
  facilities: string[];
  roomCount: number;
  basePrice: number;
  weekdayPrice: number;
  weekendPrice: number;
  holidayPrice: number;
  minPrice: number;
  description: string;
}

interface CompetitorConfig {
  id: string;
  storeId: string;
  hotelName: string;
  platform: string;
  competitorRoomType: string;
  ourRoomTypeId: string;
  basePrice: number;
}

interface RoomsFile {
  brand: BrandConfig;
  stores: StoreConfig[];
  roomTypes: RoomTypeConfig[];
}

interface CompetitorsFile {
  competitors: CompetitorConfig[];
}

const DATA_DIR = new URL('./data/', import.meta.url);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DATA_DIR), 'utf8')) as T;
}

// ============================================================
// 纯函数构建计划
// ============================================================

export interface SeedBrand {
  id: string;
  name: string;
  type: string;
  logo: string;
  color: string;
  description: string;
  facilities: string[];
  standards: Record<string, string>;
  sops: string[];
  contactName: string;
  contactPhone: string;
}

export interface SeedStore {
  id: string;
  name: string;
  shortName: string;
  city: string;
  address: string;
  phone: string;
  roomCount: number;
  manager: string;
  latitude: string;
  longitude: string;
  description: string;
  facilities: string[];
  preferenceTags: string[];
  regionTags: string[];
  todayOccupancy: number;
  todayRevenue: number;
  monthRevenue: number;
}

export interface SeedRoomType {
  id: string;
  storeId: string;
  name: string;
  bedType: string;
  area: string;
  maxGuests: number;
  facilities: string[];
  roomCount: number;
  basePrice: number;
  weekdayPrice: number;
  weekendPrice: number;
  holidayPrice: number;
  minPrice: number;
  description: string;
}

export interface SeedRoom {
  id: string;
  storeId: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: number;
  status: string;
  price: number;
  guestName: string | null;
  guestPhone: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
}

export interface SeedPricingRule {
  id: string;
  storeId: string;
  roomTypeId: string;
  roomType: string;
  basePrice: number;
  weekdayPrice: number;
  weekendPrice: number;
  holidayPrice: number;
  minPrice: number;
}

export interface SeedCalendarRoom {
  roomTypeId: string;
  name: string;
  price: number;
  available: number;
}

export interface SeedCalendar {
  id: string;
  storeId: string;
  date: string;
  roomTypes: SeedCalendarRoom[];
  isWeekend: boolean;
  isHoliday: boolean;
}

export interface SeedChannel {
  id: string;
  name: string;
  icon: string;
  color: string;
  type: string;
  status: string;
  commissionRate: string;
  account: string;
  balance: number;
  category: string;
  description: string;
  todayOrders: number;
  todayRevenue: number;
  monthOrders: number;
  monthRevenue: number;
}

export interface SeedOrder {
  id: string;
  orderNo: string;
  channel: string;
  channelColor: string;
  icon: string;
  guestName: string;
  guestPhone: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  roomTypeId: string;
  nights: number;
  totalPrice: number;
  originalAmount: number;
  discount: string | null;
  source: string;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  otaTimeout: Date | null;
  storeId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeedChannelOrder {
  id: string;
  storeId: string;
  orderNo: string;
  channel: string;
  channelColor: string;
  icon: string;
  channelOrderId: string;
  guestName: string;
  guestPhone: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  roomTypeId: string;
  nights: number;
  totalPrice: number;
  source: string;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  otaTimeout: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SeedReview {
  id: string;
  channelId: string;
  channelName: string;
  channelIcon: string;
  guestName: string;
  rating: number;
  content: string;
  roomType: string;
  stayDate: string;
  replyContent: string | null;
  replyStatus: string;
  reviewTime: string;
  storeId: string;
}

export interface SeedCompetitor {
  id: string;
  storeId: string;
  hotelName: string;
  platform: string;
  competitorRoomType: string;
  ourRoomTypeId: string;
  lastPrice: number;
  lastCrawledAt: Date;
  status: string;
}

export interface SeedKbGuide {
  id: string;
  storeId: string;
  key: string;
  guideType: string;
  title: string;
  content: string;
  status: string;
}

export interface SeedSnapshot {
  id: string;
  competitorId: string;
  price: number;
  crawledAt: Date;
  source: string;
}

export interface SeedRole {
  id: string;
  name: string;
  description: string;
  staffCount: number;
  scope: string;
  isPreset: boolean;
  permissions: string[];
}

export interface SeedStaff {
  id: string;
  name: string;
  phone: string;
  email: string;
  department: string;
  position: string;
  roleName: string;
  roleId: string;
  stores: string[];
  scope: string;
  status: string;
}

export interface SeedStaffStorePermission {
  id: string;
  staffId: string;
  storeId: string;
}

export interface SeedDay {
  date: string;
  isWeekend: boolean;
  isHoliday: boolean;
  occupancyRate: number;
}

export interface SeedPlan {
  merchantId: string;
  brand: SeedBrand;
  stores: SeedStore[];
  roomTypes: SeedRoomType[];
  rooms: SeedRoom[];
  pricingRules: SeedPricingRule[];
  pricingCalendar: SeedCalendar[];
  channels: SeedChannel[];
  orders: SeedOrder[];
  channelOrders: SeedChannelOrder[];
  reviews: SeedReview[];
  competitors: SeedCompetitor[];
  competitorSnapshots: SeedSnapshot[];
  kbGuides: SeedKbGuide[];
  roles: SeedRole[];
  staff: SeedStaff[];
  staffStorePermissions: SeedStaffStorePermission[];
  days: SeedDay[];
  stats: {
    dayCount: number;
    orderCount: number;
    weekendOccupancy: number;
    weekdayOccupancy: number;
    reviewCount: number;
    lowScoreCount: number;
  };
}

/** mulberry32：小巧的可复现伪随机数生成器 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekendDate(date: string): boolean {
  const day = parseDate(date).getUTCDay();
  return day === 0 || day === 6;
}

/** 演示窗口内的法定节假日（国庆） */
function isHolidayDate(date: string): boolean {
  return date >= '2026-10-01' && date <= '2026-10-07';
}

function roundTo(value: number, digits: number): number {
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

const CHANNEL_META = [
  { id: 'ch-yq-ctrip', name: '携程', icon: '✈️', color: '#0086f6', type: 'ota', commissionRate: '15.00', account: 'yunqi_ctrip', category: 'domestic_ota', description: '携程旅行网' },
  { id: 'ch-yq-meituan', name: '美团', icon: '🍜', color: '#ffcd00', type: 'ota', commissionRate: '12.00', account: 'yunqi_meituan', category: 'domestic_ota', description: '美团酒店' },
  { id: 'ch-yq-fliggy', name: '飞猪', icon: '🐷', color: '#ff6600', type: 'ota', commissionRate: '10.00', account: 'yunqi_fliggy', category: 'domestic_ota', description: '飞猪旅行' },
  { id: 'ch-yq-direct', name: '直客', icon: '🏠', color: '#0f766e', type: 'direct', commissionRate: '0.00', account: 'direct', category: 'direct', description: '民宿直销' },
] as const;

const GUEST_NAMES = [
  '陈知远', '李思瑶', '王一鸣', '赵清浅', '刘行舟', '周望舒', '吴予安', '徐听澜',
  '孙南枫', '马晓月', '胡书言', '朱与川', '高星野', '林未晞', '何昭昭', '郭则明',
  '罗镜湖', '梁浅予', '宋南乔', '唐亦舟', '许青禾', '冯遥', '曹知微', '邓临溪',
];

const REVIEW_POOL = {
  good: [
    '位置很好，出门就是古镇主街，晚上很安静。',
    '房间干净，床品舒服，前台帮忙提行李很贴心。',
    'view 很棒，早上在露台喝茶看山，体验拉满。',
    '早餐是当地小吃，分量足，老板还送了自酿米酒。',
    '亲子房空间大，小朋友很喜欢儿童帐篷。',
    '停车方便，房间隔音不错，睡得很踏实。',
  ],
  mid: [
    '整体不错，就是周末价格略高，性价比一般。',
    '房间稍小，但设施齐全，位置弥补了一切。',
    '热水来得有点慢，其他都挺好的。',
  ],
  low: [
    '房间有异味，反映后换房处理不及时，体验不好。',
    '临街房间晚上很吵，隔音和描述不符，不会再来。',
    '前台态度冷淡，入住等了四十分钟，服务需要改进。',
    '卫生细节不到位，浴室角落有污渍，比较失望。',
  ],
};

const LOW_SCORE_INDEXES = new Set([4, 21, 39, 63, 88, 112]);

/**
 * 住中客服知识库（FAQ）模板：每个门店各生成一份已发布条目，
 * 供 pms-agent 的 guest 子图经 /api/internal/agent-tools/kb-search 检索。
 */
const KB_FAQ_TEMPLATES: Array<{
  key: string;
  title: string;
  content: (store: StoreConfig) => string;
}> = [
  {
    key: 'wifi',
    title: 'WiFi 与网络',
    content: (store) => `WiFi 名称：Yunqi-${store.shortName}，密码：yunqi2026；网络故障可拨打前台 ${store.phone}。`,
  },
  {
    key: 'breakfast',
    title: '早餐时间与地点',
    content: (store) => `自助早餐 07:30-09:30，在${store.shortName}一楼庭院茶座供应，含本地小吃。`,
  },
  {
    key: 'checkout',
    title: '退房与延迟退房',
    content: () => '标准退房时间 12:00；视房态可免费延迟至 14:00，请提前告知前台。',
  },
  {
    key: 'pet',
    title: '宠物入住',
    content: () => '本店暂不接受携带宠物入住，导盲犬除外。',
  },
  {
    key: 'parking',
    title: '停车与车位',
    content: (store) => `住客可免费使用${store.shortName}院内停车位，车位有限，先到先得。`,
  },
  {
    key: 'checkin',
    title: '入住时间与证件',
    content: () => '入住时间 14:00 后，请携带本人身份证办理登记。',
  },
  {
    key: 'pickup',
    title: '接送与交通',
    content: (store) => `可预约高铁站/古镇接送，费用另计，请提前一天联系前台 ${store.phone}。`,
  },
  {
    key: 'deposit',
    title: '押金与支付',
    content: () => '入住需预付首晚房费作为押金，离店时原路退还。',
  },
];

/**
 * 构建演示种子计划（纯函数，固定随机种子，重复调用结果完全一致）。
 */
export function buildSeedPlan(): SeedPlan {
  const roomsFile = readJson<RoomsFile>('rooms.json');
  const competitorsFile = readJson<CompetitorsFile>('competitors.json');
  const rnd = mulberry32(SEED);

  const brand: SeedBrand = { ...roomsFile.brand };
  const roomTypes: SeedRoomType[] = roomsFile.roomTypes.map((rt) => ({ ...rt }));

  const windowStart = addDays(ANCHOR_DATE, -(TOTAL_DAYS - 1));
  const dates: string[] = Array.from({ length: TOTAL_DAYS }, (_, i) => addDays(windowStart, i));
  // 价格日历覆盖历史 90 天 + 未来 30 天（未来日期不生成订单，仅保证「明天」等演示可查询到房价）
  const futureDates: string[] = Array.from({ length: FUTURE_DAYS }, (_, i) => addDays(ANCHOR_DATE, i + 1));
  const calendarDates: string[] = [...dates, ...futureDates];

  const channels: SeedChannel[] = CHANNEL_META.map((c) => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
    color: c.color,
    type: c.type,
    status: 'connected',
    commissionRate: c.commissionRate,
    account: c.account,
    balance: 0,
    category: c.category,
    description: c.description,
    todayOrders: 0,
    todayRevenue: 0,
    monthOrders: 0,
    monthRevenue: 0,
  }));

  const orders: SeedOrder[] = [];
  const channelOrders: SeedChannelOrder[] = [];
  const storeOccupied: Record<string, number[]> = {};
  let orderSeq = 0;

  roomsFile.stores.forEach((store, storeIndex) => {
    const typeList = roomTypes.filter((rt) => rt.storeId === store.id);
    const occupied = new Array<number>(TOTAL_DAYS).fill(0);
    storeOccupied[store.id] = occupied;

    for (let dayIndex = 0; dayIndex < TOTAL_DAYS; dayIndex++) {
      const date = dates[dayIndex];
      const weekend = isWeekendDate(date);
      const holiday = isHolidayDate(date);
      // 周末目标入住率显著高于工作日，保证演示数据呈现清晰的周末溢价
      const targetRate = weekend ? 0.72 + rnd() * 0.14 : 0.46 + rnd() * 0.12;
      const targetRooms = Math.round(store.roomCount * targetRate);
      const ongoing = occupied[dayIndex];
      const toStart = Math.max(0, Math.min(targetRooms - ongoing, store.roomCount - ongoing));

      for (let k = 0; k < toStart; k++) {
        let nights = rnd() < 0.3 ? 2 : 1;
        if (weekend && rnd() < 0.25) nights += 1;
        if (holiday && rnd() < 0.4) nights += 1;
        nights = Math.max(1, Math.min(nights, TOTAL_DAYS - dayIndex));

        const roomType = typeList[Math.floor(rnd() * typeList.length)];
        const channel = channels[Math.floor(rnd() * channels.length)];
        const checkIn = date;
        const checkOut = addDays(date, nights);
        const nightlyPrice = holiday
          ? roomType.holidayPrice
          : weekend
            ? roomType.weekendPrice
            : roomType.weekdayPrice;
        const totalPrice = nightlyPrice * nights;
        const isOta = channel.type === 'ota';
        const originalAmount = isOta ? totalPrice + Math.round(totalPrice * 0.08) : totalPrice;
        const guest = GUEST_NAMES[(storeIndex * 7 + dayIndex + k) % GUEST_NAMES.length];
        const createdAt = new Date(
          `${checkIn}T${String(8 + (k % 12)).padStart(2, '0')}:${String((k * 7) % 60).padStart(2, '0')}:00+08:00`,
        );
        orderSeq += 1;

        orders.push({
          id: `ord-yq-${storeIndex + 1}-${dayIndex}-${k}`,
          orderNo: `YQ${checkIn.replace(/-/g, '')}${storeIndex + 1}${String(k + 1).padStart(2, '0')}`,
          channel: channel.name,
          channelColor: channel.color,
          icon: channel.icon,
          guestName: guest,
          guestPhone: `13${String(800000000 + orderSeq).slice(-9)}`,
          checkIn,
          checkOut,
          roomType: roomType.name,
          roomTypeId: roomType.id,
          nights,
          totalPrice,
          originalAmount,
          discount: isOta ? `渠道活动立减¥${originalAmount - totalPrice}` : null,
          source: isOta ? 'ota' : 'direct',
          paymentMethod: isOta ? '在线支付' : '微信支付',
          paymentStatus: 'paid',
          status: checkOut <= ANCHOR_DATE ? 'completed' : 'confirmed',
          otaTimeout: null,
          storeId: store.id,
          createdAt,
          updatedAt: createdAt,
        });

        for (let n = 0; n < nights; n++) {
          occupied[dayIndex + n] = Math.min(store.roomCount, occupied[dayIndex + n] + 1);
        }
      }
    }

    // 超时样本：当天仍待确认且已超过 OTA 确认时限的订单（另有 1 单未超时作为对照）
    for (let j = 0; j < 3; j++) {
      const roomType = typeList[j % typeList.length];
      const overdue = j < 2;
      const otaTimeout = new Date(
        overdue ? `${ANCHOR_DATE}T09:00:00+08:00` : `${ANCHOR_DATE}T23:59:00+08:00`,
      );
      const createdAt = new Date(`${ANCHOR_DATE}T07:${String(30 + j * 10).padStart(2, '0')}:00+08:00`);
      const channel = channels[j % 3];

      orders.push({
        id: `ord-yq-pending-${storeIndex + 1}-${j + 1}`,
        orderNo: `YQP${storeIndex + 1}${j + 1}${ANCHOR_DATE.replace(/-/g, '')}`,
        channel: channel.name,
        channelColor: channel.color,
        icon: channel.icon,
        guestName: GUEST_NAMES[(storeIndex * 3 + j) % GUEST_NAMES.length],
        guestPhone: `139${String(100000000 + storeIndex * 10 + j).slice(-9)}`,
        checkIn: ANCHOR_DATE,
        checkOut: addDays(ANCHOR_DATE, 1 + (j % 2)),
        roomType: roomType.name,
        roomTypeId: roomType.id,
        nights: 1 + (j % 2),
        totalPrice: roomType.weekdayPrice * (1 + (j % 2)),
        originalAmount: roomType.weekdayPrice * (1 + (j % 2)),
        discount: null,
        source: 'ota',
        paymentMethod: '在线支付',
        paymentStatus: 'unpaid',
        status: 'pending_confirm',
        otaTimeout,
        storeId: store.id,
        createdAt,
        updatedAt: createdAt,
      });

      channelOrders.push({
        id: `co-yq-${storeIndex + 1}-${j + 1}`,
        storeId: store.id,
        orderNo: `YQC${storeIndex + 1}${j + 1}${ANCHOR_DATE.replace(/-/g, '')}`,
        channel: channel.name,
        channelColor: channel.color,
        icon: channel.icon,
        channelOrderId: `OTA${storeIndex + 1}${j + 1}20261121`,
        guestName: GUEST_NAMES[(storeIndex * 5 + j + 2) % GUEST_NAMES.length],
        guestPhone: `137${String(200000000 + storeIndex * 10 + j).slice(-9)}`,
        checkIn: ANCHOR_DATE,
        checkOut: addDays(ANCHOR_DATE, 1 + (j % 2)),
        roomType: roomType.name,
        roomTypeId: roomType.id,
        nights: 1 + (j % 2),
        totalPrice: roomType.weekdayPrice * (1 + (j % 2)),
        source: 'ota',
        paymentMethod: '在线支付',
        paymentStatus: 'unpaid',
        status: j === 2 ? 'confirmed' : 'pending_confirm',
        otaTimeout,
        createdAt,
        updatedAt: createdAt,
      });
    }
  });

  // 门店今日/本月经营指标（由订单汇总，保证演示口径自洽）
  const stores: SeedStore[] = roomsFile.stores.map((store) => {
    const storeOrders = orders.filter((o) => o.storeId === store.id);
    const todayOrders = storeOrders.filter((o) => o.checkIn === ANCHOR_DATE && o.status !== 'cancelled');
    const monthOrders = storeOrders.filter((o) => o.checkIn >= addDays(ANCHOR_DATE, -29));
    const occupiedToday = storeOccupied[store.id][TOTAL_DAYS - 1] ?? 0;
    return {
      ...store,
      todayOccupancy: Math.round((occupiedToday / store.roomCount) * 100),
      todayRevenue: todayOrders.reduce((sum, o) => sum + o.totalPrice, 0),
      monthRevenue: monthOrders.reduce((sum, o) => sum + o.totalPrice, 0),
    };
  });

  // 渠道统计
  for (const channel of channels) {
    const channelOrdersAll = orders.filter((o) => o.channel === channel.name);
    const today = channelOrdersAll.filter((o) => o.checkIn === ANCHOR_DATE);
    const month = channelOrdersAll.filter((o) => o.checkIn >= addDays(ANCHOR_DATE, -29));
    channel.todayOrders = today.length;
    channel.todayRevenue = today.reduce((sum, o) => sum + o.totalPrice, 0);
    channel.monthOrders = month.length;
    channel.monthRevenue = month.reduce((sum, o) => sum + o.totalPrice, 0);
  }

  // 房间
  const rooms: SeedRoom[] = [];
  roomsFile.stores.forEach((store, storeIndex) => {
    const typeList = roomTypes.filter((rt) => rt.storeId === store.id);
    typeList.forEach((rt, typeIndex) => {
      for (let n = 1; n <= rt.roomCount; n++) {
        const occupiedRoom = n % 6 === 0;
        const dirtyRoom = !occupiedRoom && n % 7 === 0;
        rooms.push({
          id: `room-yq-${storeIndex + 1}-${typeIndex + 1}-${String(n).padStart(2, '0')}`,
          storeId: store.id,
          roomTypeId: rt.id,
          roomTypeName: rt.name,
          roomNumber: `${typeIndex + 2}${String(n).padStart(3, '0')}`,
          floor: typeIndex + 2,
          status: occupiedRoom ? 'occupied' : dirtyRoom ? 'dirty' : 'available',
          price: rt.weekdayPrice,
          guestName: occupiedRoom ? GUEST_NAMES[(n + storeIndex) % GUEST_NAMES.length] : null,
          guestPhone: occupiedRoom ? `136${String(300000000 + storeIndex * 100 + n).slice(-9)}` : null,
          checkInDate: occupiedRoom ? ANCHOR_DATE : null,
          checkOutDate: occupiedRoom ? addDays(ANCHOR_DATE, 1 + (n % 2)) : null,
        });
      }
    });
  });

  // 价格规则
  const pricingRules: SeedPricingRule[] = roomTypes.map((rt) => ({
    id: `pr-${rt.id}`,
    storeId: rt.storeId,
    roomTypeId: rt.id,
    roomType: rt.name,
    basePrice: rt.basePrice,
    weekdayPrice: rt.weekdayPrice,
    weekendPrice: rt.weekendPrice,
    holidayPrice: rt.holidayPrice,
    minPrice: rt.minPrice,
  }));

  // 价格日历：历史 90 天 + 未来 30 天
  const pricingCalendar: SeedCalendar[] = [];
  for (const store of roomsFile.stores) {
    const typeList = roomTypes.filter((rt) => rt.storeId === store.id);
    for (let dayIndex = 0; dayIndex < calendarDates.length; dayIndex++) {
      const date = calendarDates[dayIndex];
      const weekend = isWeekendDate(date);
      const holiday = isHolidayDate(date);
      // 未来日期没有历史入住数据，按全空处理
      const occupied = dayIndex < TOTAL_DAYS ? (storeOccupied[store.id][dayIndex] ?? 0) : 0;
      pricingCalendar.push({
        id: `pc-yq-${store.id}-${date}`,
        storeId: store.id,
        date,
        roomTypes: typeList.map((rt) => ({
          roomTypeId: rt.id,
          name: rt.name,
          price: holiday ? rt.holidayPrice : weekend ? rt.weekendPrice : rt.weekdayPrice,
          available: Math.max(0, rt.roomCount - Math.round((occupied * rt.roomCount) / store.roomCount)),
        })),
        isWeekend: weekend,
        isHoliday: holiday,
      });
    }
  }

  // 120 条评价（6 条低分）
  const reviews: SeedReview[] = [];
  for (let i = 0; i < 120; i++) {
    const store = roomsFile.stores[i % roomsFile.stores.length];
    const typeList = roomTypes.filter((rt) => rt.storeId === store.id);
    const roomType = typeList[i % typeList.length];
    const channel = channels[i % channels.length];
    const low = LOW_SCORE_INDEXES.has(i);
    let rating: number;
    if (low) {
      rating = i % 2 === 0 ? 2 : 1;
    } else {
      const r = rnd();
      rating = r < 0.58 ? 5 : r < 0.9 ? 4 : 3;
    }
    const pool = low ? REVIEW_POOL.low : rating === 5 ? REVIEW_POOL.good : REVIEW_POOL.mid;
    const stayDate = addDays(ANCHOR_DATE, -(14 + (i % 60)));
    const replied = !low && i % 5 !== 0;
    reviews.push({
      id: `rev-yq-${String(i + 1).padStart(3, '0')}`,
      channelId: channel.id,
      channelName: channel.name,
      channelIcon: channel.icon,
      guestName: GUEST_NAMES[(i * 3) % GUEST_NAMES.length],
      rating,
      content: pool[i % pool.length],
      roomType: roomType.name,
      stayDate,
      replyContent: replied ? '感谢您的入住与反馈，期待下次再会！' : null,
      replyStatus: replied ? 'replied' : 'pending',
      reviewTime: `${stayDate} ${String(10 + (i % 10)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
      storeId: store.id,
    });
  }

  // 竞对配置与价格快照
  const competitors: SeedCompetitor[] = competitorsFile.competitors.map((cmp) => ({
    id: cmp.id,
    storeId: cmp.storeId,
    hotelName: cmp.hotelName,
    platform: cmp.platform,
    competitorRoomType: cmp.competitorRoomType,
    ourRoomTypeId: cmp.ourRoomTypeId,
    lastPrice: cmp.basePrice + Math.round((rnd() - 0.5) * 40),
    lastCrawledAt: new Date(`${ANCHOR_DATE}T07:30:00+08:00`),
    status: 'active',
  }));

  const competitorSnapshots: SeedSnapshot[] = [];
  for (const cmp of competitorsFile.competitors) {
    for (let s = 0; s < 15; s++) {
      const date = addDays(ANCHOR_DATE, -(s * 6));
      const price = cmp.basePrice + Math.round((rnd() - 0.5) * 60);
      competitorSnapshots.push({
        id: `snap-yq-${cmp.id}-${s + 1}`,
        competitorId: cmp.id,
        price: Math.max(120, price),
        crawledAt: new Date(`${date}T07:30:00+08:00`),
        source: 'crawler',
      });
    }
  }

  // 每个门店一份住中客服知识库（已发布，供 guest 子图检索）
  const kbGuides: SeedKbGuide[] = [];
  roomsFile.stores.forEach((store, storeIndex) => {
    for (const faq of KB_FAQ_TEMPLATES) {
      kbGuides.push({
        id: `kb-yq-${storeIndex + 1}-${faq.key}`,
        storeId: store.id,
        key: `guide_faq_${faq.key}`,
        guideType: 'faq',
        title: faq.title,
        content: faq.content(store),
        status: 'published',
      });
    }
  });

  // 演示管理员：商户管理员，绑定 3 家门店
  const role: SeedRole = {
    id: 'role-yunqi-admin',
    name: '商户管理员',
    description: '云栖山舍演示商户管理员，可管理品牌下全部门店',
    staffCount: 1,
    scope: 'tenant',
    isPreset: true,
    permissions: ['all'],
  };
  const staff: SeedStaff = {
    id: 'staff-yunqi-admin',
    name: '林清和',
    phone: DEMO_PHONE,
    email: 'demo@yunqi.example',
    department: '管理层',
    position: '总经理',
    roleName: '商户管理员',
    roleId: role.id,
    stores: stores.map((s) => s.id),
    scope: 'tenant',
    status: 'active',
  };
  const staffStorePermissions: SeedStaffStorePermission[] = stores.map((s, i) => ({
    id: `ssp-yq-${i + 1}`,
    staffId: staff.id,
    storeId: s.id,
  }));

  // 每日入住率（跨门店加权，由订单间夜推导）
  const days: SeedDay[] = dates.map((date, dayIndex) => {
    const totalRooms = roomsFile.stores.reduce((sum, s) => sum + s.roomCount, 0);
    const occupied = roomsFile.stores.reduce(
      (sum, s) => sum + (storeOccupied[s.id][dayIndex] ?? 0),
      0,
    );
    return {
      date,
      isWeekend: isWeekendDate(date),
      isHoliday: isHolidayDate(date),
      occupancyRate: roundTo(occupied / totalRooms, 4),
    };
  });

  const avgOccupancy = (rows: SeedDay[]) =>
    roundTo(rows.reduce((sum, d) => sum + d.occupancyRate, 0) / rows.length, 4);
  const weekendOccupancy = avgOccupancy(days.filter((d) => d.isWeekend));
  const weekdayOccupancy = avgOccupancy(days.filter((d) => !d.isWeekend));

  return {
    merchantId: MERCHANT_ID,
    brand,
    stores,
    roomTypes,
    rooms,
    pricingRules,
    pricingCalendar,
    channels,
    orders,
    channelOrders,
    reviews,
    competitors,
    competitorSnapshots,
    kbGuides,
    roles: [role],
    staff: [staff],
    staffStorePermissions,
    days,
    stats: {
      dayCount: TOTAL_DAYS,
      orderCount: orders.length,
      weekendOccupancy,
      weekdayOccupancy,
      reviewCount: reviews.length,
      lowScoreCount: reviews.filter((r) => r.rating <= 2).length,
    },
  };
}

// ============================================================
// 落库
// ============================================================

export interface SqlClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function chunk<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    result.push(rows.slice(i, i + size));
  }
  return result;
}

async function insertRows(
  client: SqlClient,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
): Promise<number> {
  for (const batch of chunk(rows, 150)) {
    const params: unknown[] = [];
    const placeholders = batch.map(
      (row) => `(${columns.map((column) => `$${params.push(row[column] ?? null)}`).join(', ')})`,
    );
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`,
      params,
    );
  }
  return rows.length;
}

/**
 * 按 merchantId 先删后插，事务内完成；只清理 demo-yunqi 租户的数据。
 * @returns 各表实际写入行数
 */
export async function applySeed(client: SqlClient): Promise<Record<string, number>> {
  const plan = buildSeedPlan();
  const merchantId = plan.merchantId;
  const bcrypt = requireFromServer('bcryptjs') as { hashSync: (value: string, rounds: number) => string };

  const brandCreatedAt = new Date('2025-03-01T02:00:00+08:00');
  const staffCreatedAt = new Date('2025-03-01T02:30:00+08:00');
  const storeIds = plan.stores.map((s) => s.id);

  await client.query('BEGIN');
  try {
    // 竞对快照没有 merchant_id，只能通过 demo 租户的竞对配置间接定位
    await client.query(
      'DELETE FROM pms_bui_competitor_snapshots WHERE competitor_id IN (SELECT id FROM pms_bui_competitor_config WHERE merchant_id = $1)',
      [merchantId],
    );
    // 仅删除 demo 租户数据，其他租户不受影响
    const deleteOrder = [
      'pms_bui_orders',
      'pms_bui_channel_orders',
      'pms_bui_reviews',
      'pms_bui_pricing_calendar',
      'pms_bui_pricing_rules',
      'pms_bui_rooms',
      'pms_bui_room_types',
      'pms_bui_channels',
      'pms_bui_competitor_config',
      'pms_bui_stores',
      'pms_bui_staff_store_permissions',
      'pms_bui_staff',
      'pms_bui_roles',
      'pms_bui_brands',
    ];
    for (const table of deleteOrder) {
      await client.query(`DELETE FROM ${table} WHERE merchant_id = $1`, [merchantId]);
    }
    // 知识库 FAQ 存放在 settings 表（category='kb_guide'），按租户先清后灌保证幂等
    await client.query(
      "DELETE FROM pms_bui_settings WHERE merchant_id = $1 AND category IN ('kb_guide', 'property_profile')",
      [merchantId],
    );

    const counts: Record<string, number> = {};

    counts.pms_bui_brands = await insertRows(
      client,
      'pms_bui_brands',
      ['id', 'merchant_id', 'name', 'type', 'logo', 'color', 'description', 'store_count', 'total_rooms', 'contact_name', 'contact_phone', 'status', 'facilities', 'standards', 'sops', 'created_at', 'updated_at'],
      [
        {
          id: plan.brand.id,
          merchant_id: merchantId,
          name: plan.brand.name,
          type: plan.brand.type,
          logo: plan.brand.logo,
          color: plan.brand.color,
          description: plan.brand.description,
          store_count: plan.stores.length,
          total_rooms: plan.stores.reduce((sum, s) => sum + s.roomCount, 0),
          contact_name: plan.brand.contactName,
          contact_phone: plan.brand.contactPhone,
          status: 'active',
          facilities: json(plan.brand.facilities),
          standards: json(plan.brand.standards),
          sops: json(plan.brand.sops),
          created_at: brandCreatedAt,
          updated_at: brandCreatedAt,
        },
      ],
    );

    counts.pms_bui_stores = await insertRows(
      client,
      'pms_bui_stores',
      ['id', 'merchant_id', 'brand_id', 'brand_name', 'name', 'address', 'phone', 'room_count', 'manager', 'status', 'facilities', 'today_occupancy', 'today_revenue', 'month_revenue', 'short_name', 'email', 'description', 'latitude', 'longitude', 'city', 'preference_tags', 'region_tags', 'created_at', 'updated_at'],
      plan.stores.map((store) => ({
        id: store.id,
        merchant_id: merchantId,
        brand_id: plan.brand.id,
        brand_name: plan.brand.name,
        name: store.name,
        address: store.address,
        phone: store.phone,
        room_count: store.roomCount,
        manager: store.manager,
        status: 'active',
        facilities: json(store.facilities),
        today_occupancy: store.todayOccupancy,
        today_revenue: store.todayRevenue,
        month_revenue: store.monthRevenue,
        short_name: store.shortName,
        email: null,
        description: store.description,
        latitude: store.latitude,
        longitude: store.longitude,
        city: store.city,
        preference_tags: json(store.preferenceTags),
        region_tags: json(store.regionTags),
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_room_types = await insertRows(
      client,
      'pms_bui_room_types',
      ['id', 'merchant_id', 'store_id', 'name', 'bed_type', 'area', 'max_guests', 'facilities', 'room_count', 'base_price', 'weekday_price', 'weekend_price', 'holiday_price', 'min_price', 'description', 'images', 'status', 'created_at', 'updated_at'],
      plan.roomTypes.map((rt) => ({
        id: rt.id,
        merchant_id: merchantId,
        store_id: rt.storeId,
        name: rt.name,
        bed_type: rt.bedType,
        area: rt.area,
        max_guests: rt.maxGuests,
        facilities: json(rt.facilities),
        room_count: rt.roomCount,
        base_price: rt.basePrice,
        weekday_price: rt.weekdayPrice,
        weekend_price: rt.weekendPrice,
        holiday_price: rt.holidayPrice,
        min_price: rt.minPrice,
        description: rt.description,
        images: json([]),
        status: 'active',
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_rooms = await insertRows(
      client,
      'pms_bui_rooms',
      ['id', 'merchant_id', 'store_id', 'room_type_id', 'room_type_name', 'room_number', 'floor', 'status', 'price', 'guest_name', 'guest_phone', 'check_in_date', 'check_out_date', 'created_at', 'updated_at'],
      plan.rooms.map((room) => ({
        id: room.id,
        merchant_id: merchantId,
        store_id: room.storeId,
        room_type_id: room.roomTypeId,
        room_type_name: room.roomTypeName,
        room_number: room.roomNumber,
        floor: room.floor,
        status: room.status,
        price: room.price,
        guest_name: room.guestName,
        guest_phone: room.guestPhone,
        check_in_date: room.checkInDate,
        check_out_date: room.checkOutDate,
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_pricing_rules = await insertRows(
      client,
      'pms_bui_pricing_rules',
      ['id', 'merchant_id', 'store_id', 'room_type_id', 'room_type', 'base_price', 'weekday_price', 'weekend_price', 'holiday_price', 'min_price', 'price_history', 'status', 'created_at', 'updated_at'],
      plan.pricingRules.map((rule) => ({
        id: rule.id,
        merchant_id: merchantId,
        store_id: rule.storeId,
        room_type_id: rule.roomTypeId,
        room_type: rule.roomType,
        base_price: rule.basePrice,
        weekday_price: rule.weekdayPrice,
        weekend_price: rule.weekendPrice,
        holiday_price: rule.holidayPrice,
        min_price: rule.minPrice,
        price_history: json([]),
        status: 'active',
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_pricing_calendar = await insertRows(
      client,
      'pms_bui_pricing_calendar',
      ['id', 'merchant_id', 'store_id', 'date', 'room_types', 'is_weekend', 'is_holiday', 'created_at', 'updated_at'],
      plan.pricingCalendar.map((calendar) => ({
        id: calendar.id,
        merchant_id: merchantId,
        store_id: calendar.storeId,
        date: calendar.date,
        room_types: json(calendar.roomTypes),
        is_weekend: calendar.isWeekend,
        is_holiday: calendar.isHoliday,
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_channels = await insertRows(
      client,
      'pms_bui_channels',
      ['id', 'merchant_id', 'store_id', 'name', 'icon', 'color', 'type', 'status', 'today_orders', 'today_revenue', 'month_orders', 'month_revenue', 'account', 'balance', 'commission_rate', 'category', 'auto_sync', 'auto_price', 'sync_interval', 'last_sync_at', 'features', 'description', 'connected_at', 'created_at', 'updated_at'],
      plan.channels.map((channel) => ({
        id: channel.id,
        merchant_id: merchantId,
        store_id: null,
        name: channel.name,
        icon: channel.icon,
        color: channel.color,
        type: channel.type,
        status: channel.status,
        today_orders: channel.todayOrders,
        today_revenue: channel.todayRevenue,
        month_orders: channel.monthOrders,
        month_revenue: channel.monthRevenue,
        account: channel.account,
        balance: channel.balance,
        commission_rate: channel.commissionRate,
        category: channel.category,
        auto_sync: true,
        auto_price: false,
        sync_interval: 30,
        last_sync_at: new Date(`${ANCHOR_DATE}T07:00:00+08:00`),
        features: json([]),
        description: channel.description,
        connected_at: brandCreatedAt,
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_orders = await insertRows(
      client,
      'pms_bui_orders',
      ['id', 'merchant_id', 'order_no', 'channel', 'channel_color', 'icon', 'guest_name', 'guest_phone', 'check_in', 'check_out', 'room_type', 'room_type_id', 'nights', 'total_price', 'original_amount', 'discount', 'source', 'payment_method', 'payment_status', 'status', 'ota_timeout', 'store_id', 'created_at', 'updated_at'],
      plan.orders.map((order) => ({
        id: order.id,
        merchant_id: merchantId,
        order_no: order.orderNo,
        channel: order.channel,
        channel_color: order.channelColor,
        icon: order.icon,
        guest_name: order.guestName,
        guest_phone: order.guestPhone,
        check_in: order.checkIn,
        check_out: order.checkOut,
        room_type: order.roomType,
        room_type_id: order.roomTypeId,
        nights: order.nights,
        total_price: order.totalPrice,
        original_amount: order.originalAmount,
        discount: order.discount,
        source: order.source,
        payment_method: order.paymentMethod,
        payment_status: order.paymentStatus,
        status: order.status,
        ota_timeout: order.otaTimeout,
        store_id: order.storeId,
        created_at: order.createdAt,
        updated_at: order.updatedAt,
      })),
    );

    counts.pms_bui_channel_orders = await insertRows(
      client,
      'pms_bui_channel_orders',
      ['id', 'merchant_id', 'store_id', 'order_no', 'channel', 'channel_color', 'icon', 'channel_order_id', 'guest_name', 'guest_phone', 'check_in', 'check_out', 'room_type', 'room_type_id', 'nights', 'total_price', 'source', 'payment_method', 'payment_status', 'status', 'ota_timeout', 'created_at', 'updated_at'],
      plan.channelOrders.map((order) => ({
        id: order.id,
        merchant_id: merchantId,
        store_id: order.storeId,
        order_no: order.orderNo,
        channel: order.channel,
        channel_color: order.channelColor,
        icon: order.icon,
        channel_order_id: order.channelOrderId,
        guest_name: order.guestName,
        guest_phone: order.guestPhone,
        check_in: order.checkIn,
        check_out: order.checkOut,
        room_type: order.roomType,
        room_type_id: order.roomTypeId,
        nights: order.nights,
        total_price: order.totalPrice,
        source: order.source,
        payment_method: order.paymentMethod,
        payment_status: order.paymentStatus,
        status: order.status,
        ota_timeout: order.otaTimeout,
        created_at: order.createdAt,
        updated_at: order.updatedAt,
      })),
    );

    counts.pms_bui_reviews = await insertRows(
      client,
      'pms_bui_reviews',
      ['id', 'merchant_id', 'channel_id', 'channel_name', 'channel_icon', 'guest_name', 'rating', 'content', 'room_type', 'stay_date', 'reply_content', 'reply_status', 'review_time', 'store_id', 'created_at', 'updated_at'],
      plan.reviews.map((review) => ({
        id: review.id,
        merchant_id: merchantId,
        channel_id: review.channelId,
        channel_name: review.channelName,
        channel_icon: review.channelIcon,
        guest_name: review.guestName,
        rating: review.rating,
        content: review.content,
        room_type: review.roomType,
        stay_date: review.stayDate,
        reply_content: review.replyContent,
        reply_status: review.replyStatus,
        review_time: review.reviewTime,
        store_id: review.storeId,
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_competitor_config = await insertRows(
      client,
      'pms_bui_competitor_config',
      ['id', 'merchant_id', 'store_id', 'hotel_name', 'platform', 'competitor_room_type', 'our_room_type_id', 'last_price', 'last_crawled_at', 'status', 'created_at', 'updated_at'],
      plan.competitors.map((competitor) => ({
        id: competitor.id,
        merchant_id: merchantId,
        store_id: competitor.storeId,
        hotel_name: competitor.hotelName,
        platform: competitor.platform,
        competitor_room_type: competitor.competitorRoomType,
        our_room_type_id: competitor.ourRoomTypeId,
        last_price: competitor.lastPrice,
        last_crawled_at: competitor.lastCrawledAt,
        status: competitor.status,
        created_at: brandCreatedAt,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_competitor_snapshots = await insertRows(
      client,
      'pms_bui_competitor_snapshots',
      ['id', 'competitor_id', 'price', 'crawled_at', 'source'],
      plan.competitorSnapshots.map((snapshot) => ({
        id: snapshot.id,
        competitor_id: snapshot.competitorId,
        price: snapshot.price,
        crawled_at: snapshot.crawledAt,
        source: snapshot.source,
      })),
    );

    counts.pms_bui_settings = await insertRows(
      client,
      'pms_bui_settings',
      ['id', 'merchant_id', 'store_id', 'category', 'key', 'value', 'description', 'updated_at'],
      plan.kbGuides.map((guide) => ({
        id: guide.id,
        merchant_id: merchantId,
        store_id: guide.storeId,
        category: 'kb_guide',
        key: guide.key,
        value: json({
          guide_type: guide.guideType,
          title: guide.title,
          content: guide.content,
          metadata: { tags: ['faq'], source: 'demo-seed' },
          // 仅 published 会被 kb-search 检索到，草稿不对外答复
          status: guide.status,
          ai_generated: false,
          version: 1,
        }),
        description: null,
        updated_at: brandCreatedAt,
      })),
    );

    counts.pms_bui_roles = await insertRows(
      client,
      'pms_bui_roles',
      ['id', 'merchant_id', 'name', 'description', 'staff_count', 'scope', 'is_preset', 'permissions', 'created_at', 'updated_at'],
      plan.roles.map((role) => ({
        id: role.id,
        merchant_id: merchantId,
        name: role.name,
        description: role.description,
        staff_count: role.staffCount,
        scope: role.scope,
        is_preset: role.isPreset,
        permissions: json(role.permissions),
        created_at: staffCreatedAt,
        updated_at: staffCreatedAt,
      })),
    );

    counts.pms_bui_staff = await insertRows(
      client,
      'pms_bui_staff',
      ['id', 'merchant_id', 'name', 'phone', 'email', 'department', 'position', 'role_name', 'role_id', 'stores', 'scope', 'password', 'status', 'created_at', 'updated_at'],
      plan.staff.map((staff) => ({
        id: staff.id,
        merchant_id: merchantId,
        name: staff.name,
        phone: staff.phone,
        email: staff.email,
        department: staff.department,
        position: staff.position,
        role_name: staff.roleName,
        role_id: staff.roleId,
        stores: json(staff.stores),
        scope: staff.scope,
        // 与 routes/auth.ts 的 bcrypt.compare 对齐
        password: bcrypt.hashSync(DEMO_PASSWORD, 10),
        status: staff.status,
        created_at: staffCreatedAt,
        updated_at: staffCreatedAt,
      })),
    );

    counts.pms_bui_staff_store_permissions = await insertRows(
      client,
      'pms_bui_staff_store_permissions',
      ['id', 'merchant_id', 'staff_id', 'store_id', 'created_at'],
      plan.staffStorePermissions.map((permission) => ({
        id: permission.id,
        merchant_id: merchantId,
        staff_id: permission.staffId,
        store_id: permission.storeId,
        created_at: staffCreatedAt,
      })),
    );

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// ============================================================
// CLI
// ============================================================

async function main(): Promise<void> {
  const { Client } = requireFromServer('pg') as {
    Client: new (config: Record<string, unknown>) => SqlClient & { connect: () => Promise<void>; end: () => Promise<void> };
  };

  const client = new Client({
    host: process.env.PG_HOST ?? '127.0.0.1',
    port: Number(process.env.PG_PORT ?? 15433),
    database: process.env.PG_DATABASE ?? 'pms_ai',
    user: process.env.PG_USER ?? 'pms',
    password: process.env.PG_PASSWORD ?? 'pms_local_dev',
  });

  await client.connect();
  try {
    const counts = await applySeed(client);
    console.log(`云栖山舍演示数据写入完成（merchantId=${MERCHANT_ID}）`);
    for (const [table, rows] of Object.entries(counts)) {
      console.log(`  ${table}: ${rows}`);
    }
    console.log(`  演示账号: ${DEMO_PHONE} / ${DEMO_PASSWORD}`);
  } finally {
    await client.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === pathToFileURL(fileURLToPath(import.meta.url)).href) {
  main().catch((error) => {
    console.error('[demo-seed] 执行失败:', error);
    process.exitCode = 1;
  });
}
