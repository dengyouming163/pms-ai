/**
 * pms-nimi 开发测试数据
 * 用法: npx tsx --env-file=.env src/db/seed-mini.ts
 *
 * 先确保已执行 mini-m1.sql 建表迁移
 */
import { eq } from 'drizzle-orm';
import { db, pool } from './index';
import {
  pmsBuiStores, pmsBuiRoomTypes, pmsBuiRooms,
  pmsBuiPricingRules, pmsBuiPricingCalendar,
  pmsBuiMiniStoreConfig, pmsBuiPackages, pmsBuiCoupons,
} from './schema';

const MINI_STORE_ID = 'store-1784696167091';
const MERCHANT_ID = 'default';

async function seedMini() {
  console.log('🌱 填充 pms-nimi 开发数据...');

  // 1. 创建测试门店
  console.log('  [1/5] 测试门店...');
  const storeExists = await db.select({ id: pmsBuiStores.id })
    .from(pmsBuiStores).where(eq(pmsBuiStores.id, MINI_STORE_ID)).limit(1);
  if (storeExists.length === 0) {
    await db.insert(pmsBuiStores).values({
      id: MINI_STORE_ID, brandId: 'b1', brandName: '翡翠酒店集团',
      name: '翡翠酒店(国贸店)', address: '北京市朝阳区建国门外大街1号',
      phone: '010-65001234', roomCount: 4, manager: '张明远',
      status: 'active', facilities: ['WiFi', '健身房', '停车场'],
      todayOccupancy: 0, todayRevenue: 0, monthRevenue: 0,
    }).onConflictDoNothing();
  }

  // 2. 房型
  console.log('  [2/5] 房型...');
  const rt1 = 'rt_mini_1', rt2 = 'rt_mini_2';
  await db.insert(pmsBuiRoomTypes).values([
    { id: rt1, storeId: MINI_STORE_ID, name: '豪华大床房', bedType: '大床1.8m', area: '35', maxGuests: 2, facilities: ['WiFi','空调','电视','独立卫浴','迷你吧'], roomCount: 20, basePrice: 398, weekdayPrice: 428, weekendPrice: 498, holidayPrice: 598, minPrice: 358, status: 'active' },
    { id: rt2, storeId: MINI_STORE_ID, name: '行政套房', bedType: '大床2.0m', area: '55', maxGuests: 3, facilities: ['WiFi','空调','电视','独立卫浴','浴缸','客厅'], roomCount: 5, basePrice: 828, weekdayPrice: 888, weekendPrice: 998, holidayPrice: 1288, minPrice: 758, status: 'active' },
  ]).onConflictDoNothing();

  // 3. 房间
  console.log('  [3/5] 房间...');
  const existingRooms = await db.select({ id: pmsBuiRooms.id })
    .from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, MINI_STORE_ID));
  if (existingRooms.length === 0) {
    const roomInserts: any[] = [];
    for (let i = 1; i <= 20; i++) {
      roomInserts.push({ id: `rm_mini_${i}`, storeId: MINI_STORE_ID, roomTypeId: rt1, roomNumber: String(300 + i), floor: 3, status: 'available' });
    }
    for (let i = 1; i <= 5; i++) {
      roomInserts.push({ id: `rm_mini_s_${i}`, storeId: MINI_STORE_ID, roomTypeId: rt2, roomNumber: String(500 + i), floor: 5, status: 'available' });
    }
    await db.insert(pmsBuiRooms).values(roomInserts);
  }

  // 4. 定价日历（未来30天）
  console.log('  [4/5] 定价日历...');
  const existingPricing = await db.select({ date: pmsBuiPricingCalendar.date })
    .from(pmsBuiPricingCalendar).where(eq(pmsBuiPricingCalendar.storeId, MINI_STORE_ID));
  if (existingPricing.length === 0) {
    const today = new Date();
    const pricingRows: any[] = [];
    for (let d = 0; d < 30; d++) {
      const date = new Date(today.getTime() + d * 86400000);
      const dateStr = date.toISOString().slice(0, 10);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      pricingRows.push({
        id: `pc_mini_${dateStr}`, storeId: MINI_STORE_ID, date: dateStr,
        roomTypes: {
          [rt1]: isWeekend ? 498 : 428,
          [rt2]: isWeekend ? 998 : 888,
        },
      });
    }
    await db.insert(pmsBuiPricingCalendar).values(pricingRows);
  }

  // 5. Mini 门店上线配置
  console.log('  [5/5] Mini 门店配置...');
  await db.insert(pmsBuiMiniStoreConfig).values({
    id: `msc_${MINI_STORE_ID}`, storeId: MINI_STORE_ID, online: true,
    headerImages: ['https://picsum.photos/800/400?random=1', 'https://picsum.photos/800/400?random=2'],
    intro: '翡翠酒店国贸店位于北京CBD核心区，毗邻国贸商圈，交通便利，商务出行首选。',
    gallery: ['https://picsum.photos/400/300?random=10', 'https://picsum.photos/400/300?random=11', 'https://picsum.photos/400/300?random=12'],
    cancelPolicy: { freeHours: 24, feeRate: 20 },
    memberDiscounts: { gold: 95, diamond: 90 },
    commissionRate: 500,
  }).onConflictDoNothing();

  // 优惠券
  const existingCoupons = await db.select({ id: pmsBuiCoupons.id })
    .from(pmsBuiCoupons).where(eq(pmsBuiCoupons.storeId, MINI_STORE_ID));
  if (existingCoupons.length === 0) {
    await db.insert(pmsBuiCoupons).values([
      { id: 'cp_mini_1', storeId: MINI_STORE_ID, name: '新用户立减券', type: 'fixed', value: 50, minAmount: 300, total: 100, claimed: 0, perUser: 1, validDays: 30, status: 'active' },
      { id: 'cp_mini_2', storeId: MINI_STORE_ID, name: '周末特惠券', type: 'discount', value: 88, minAmount: 500, total: 50, claimed: 0, perUser: 1, validDays: 14, status: 'active' },
      { id: 'cp_mini_3', storeId: MINI_STORE_ID, name: '豪华套房专享', type: 'fixed', value: 100, minAmount: 800, total: 30, claimed: 0, perUser: 1, validDays: 7, status: 'active' },
    ]);
  }

  // 套餐
  const existingPkgs = await db.select({ id: pmsBuiPackages.id })
    .from(pmsBuiPackages).where(eq(pmsBuiPackages.storeId, MINI_STORE_ID));
  if (existingPkgs.length === 0) {
    await db.insert(pmsBuiPackages).values([
      { id: 'pkg_mini_1', storeId: MINI_STORE_ID, name: '商务出行套餐', description: '豪华大床房 + 双早 + 接送机', roomTypeIds: [rt1], benefits: ['双人早餐','接送机服务','延迟退房至14:00','欢迎水果'], price: 498, stock: 20, images: ['https://picsum.photos/400/300?random=20'], status: 'active' },
      { id: 'pkg_mini_2', storeId: MINI_STORE_ID, name: '行政奢享套餐', description: '行政套房 + 行政酒廊 + SPA', roomTypeIds: [rt2], benefits: ['双人早餐','行政酒廊权益','60分钟SPA','免费minibar'], price: 1288, stock: 10, images: ['https://picsum.photos/400/300?random=21'], status: 'active' },
    ]);
  }

  console.log('✅ pms-nimi 开发数据填充完成！');
  console.log(`   门店 ID: ${MINI_STORE_ID}`);
  console.log('   房型: 豪华大床房(20间) + 行政套房(5间)');
  console.log('   优惠券: 3张');
  console.log('   套餐: 2个');
  await pool.end();
}

seedMini().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
