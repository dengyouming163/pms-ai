/**
 * Seed script - 填充初始数据到 PostgreSQL
 * 使用方式: npx tsx src/db/seed.ts
 */
import { db } from './index';
import {
  pmsBuiBrands, pmsBuiStores, pmsBuiRoomTypes, pmsBuiRooms, pmsBuiRoomDevices,
  pmsBuiOrders, pmsBuiChannelOrders,
  pmsBuiPricingRules, pmsBuiPricingCalendar, pmsBuiPromotions,
  pmsBuiChannels, pmsBuiReviews,
  pmsBuiTransactions, pmsBuiReconciliationAlerts, pmsBuiReconciliationDetails,
  pmsBuiCustomers, pmsBuiTags, pmsBuiAutoTagRules, pmsBuiCareReminders,
  pmsBuiStaff, pmsBuiRoles, pmsBuiOpLogs,
  pmsBuiSettings,
  pmsBuiAiSuggestions, pmsBuiAiChatHistory,
} from './schema';

async function seed() {
  console.log('🌱 开始填充数据...');

  // 1. 品牌
  console.log('  填充 brands...');
  await db.insert(pmsBuiBrands).values([
    { id: 'b1', name: '翡翠酒店集团', type: 'platform', logo: '🏨', color: '#059669', storeCount: 3, totalRooms: 308, contactName: '张明远', contactPhone: '010-65001234', status: 'active', description: '高端商务酒店品牌', facilities: ['WiFi', '健身房', '停车场', '会议室'], standards: { checkInTime: '14:00', checkOutTime: '12:00', cancellationPolicy: '提前24小时免费取消', depositPolicy: '需预付首晚房费', childPolicy: '6岁以下免费', reviewReply: '24小时内回复' }, sops: ['入住登记SOP', '退房结算SOP', '客房清洁SOP'] },
    { id: 'b2', name: '云栖度假', type: 'brand', logo: '🌊', color: '#0284c7', storeCount: 1, totalRooms: 200, contactName: '王海涛', contactPhone: '0898-88601234', status: 'active', description: '精品度假酒店品牌', facilities: ['WiFi', '泳池', 'SPA', '餐厅'], standards: { checkInTime: '15:00', checkOutTime: '11:00', cancellationPolicy: '提前48小时免费取消', depositPolicy: '需预付50%房费', childPolicy: '12岁以下免费', reviewReply: '12小时内回复' }, sops: ['度假入住SOP', 'SPA服务SOP'] },
    { id: 'b3', name: '悦途商旅', type: 'brand', logo: '✈️', color: '#d97706', storeCount: 2, totalRooms: 120, contactName: '赵晓敏', contactPhone: '010-59001234', status: 'active', description: '商务快捷酒店品牌', facilities: ['WiFi', '停车场', '自助洗衣'], standards: { checkInTime: '14:00', checkOutTime: '12:00', cancellationPolicy: '当天免费取消', depositPolicy: '无需预付', childPolicy: '6岁以下免费', reviewReply: '48小时内回复' }, sops: ['快速入住SOP'] },
  ]).onConflictDoNothing();

  // 2. 门店
  console.log('  填充 stores...');
  await db.insert(pmsBuiStores).values([
    { id: 's1', brandId: 'b1', brandName: '翡翠酒店集团', name: '翡翠酒店(国贸店)', address: '北京市朝阳区建国门外大街1号', phone: '010-65001234', roomCount: 120, manager: '张明远', status: 'active', facilities: ['WiFi', '健身房', '停车场', '会议室', '餐厅'], todayOccupancy: 85, todayRevenue: 45600, monthRevenue: 1250000 },
    { id: 's2', brandId: 'b1', brandName: '翡翠酒店集团', name: '翡翠酒店(中关村店)', address: '北京市海淀区中关村大街22号', phone: '010-82001234', roomCount: 88, manager: '李婉清', status: 'active', facilities: ['WiFi', '停车场', '会议室'], todayOccupancy: 72, todayRevenue: 28900, monthRevenue: 890000 },
    { id: 's3', brandId: 'b2', brandName: '云栖度假', name: '云栖度假酒店(三亚湾店)', address: '海南省三亚市三亚湾路168号', phone: '0898-88601234', roomCount: 200, manager: '王海涛', status: 'active', facilities: ['WiFi', '泳池', 'SPA', '餐厅', '私人海滩'], todayOccupancy: 90, todayRevenue: 88000, monthRevenue: 2800000 },
    { id: 's4', brandId: 'b3', brandName: '悦途商旅', name: '悦途商旅酒店(望京店)', address: '北京市朝阳区望京SOHO T2', phone: '010-59001234', roomCount: 65, manager: '赵晓敏', status: 'active', facilities: ['WiFi', '停车场', '自助洗衣'], todayOccupancy: 65, todayRevenue: 15200, monthRevenue: 480000 },
    { id: 's5', brandId: 'b1', brandName: '翡翠酒店集团', name: '翡翠酒店(西单店)', address: '北京市西城区西单北大街120号', phone: '010-66001234', roomCount: 100, manager: '陈文博', status: 'renovation', facilities: ['WiFi', '健身房', '停车场'], todayOccupancy: 0, todayRevenue: 0, monthRevenue: 0 },
    { id: 's6', brandId: 'b3', brandName: '悦途商旅', name: '悦途商旅酒店(亦庄店)', address: '北京市大兴区亦庄经济开发区荣华路8号', phone: '010-58001234', roomCount: 55, manager: '孙雨萱', status: 'pending', facilities: ['WiFi', '停车场'], todayOccupancy: 0, todayRevenue: 0, monthRevenue: 0 },
  ]).onConflictDoNothing();

  // 3. 房型
  console.log('  填充 room_types...');
  await db.insert(pmsBuiRoomTypes).values([
    { id: 'rt1', storeId: 's1', name: '标准大床房', bedType: '大床1.8m', area: '28', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴'], roomCount: 40, basePrice: 298, weekdayPrice: 328, weekendPrice: 398, holidayPrice: 498, minPrice: 268, status: 'active' },
    { id: 'rt2', storeId: 's1', name: '豪华双床房', bedType: '双床1.2m', area: '35', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴', '迷你吧'], roomCount: 30, basePrice: 398, weekdayPrice: 428, weekendPrice: 498, holidayPrice: 598, minPrice: 358, status: 'active' },
    { id: 'rt3', storeId: 's1', name: '行政套房', bedType: '大床2.0m', area: '55', maxGuests: 3, facilities: ['WiFi', '空调', '电视', '独立卫浴', '迷你吧', '浴缸', '客厅'], roomCount: 10, basePrice: 828, weekdayPrice: 888, weekendPrice: 998, holidayPrice: 1288, minPrice: 758, status: 'active' },
    { id: 'rt4', storeId: 's1', name: '总统套房', bedType: '大床2.2m', area: '120', maxGuests: 4, facilities: ['WiFi', '空调', '电视', '独立卫浴', '迷你吧', '浴缸', '客厅', '厨房', '管家服务'], roomCount: 2, basePrice: 2888, weekdayPrice: 2888, weekendPrice: 3288, holidayPrice: 3888, minPrice: 2588, status: 'active' },
    { id: 'rt5', storeId: 's3', name: '海景大床房', bedType: '大床1.8m', area: '38', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴', '阳台'], roomCount: 80, basePrice: 598, weekdayPrice: 628, weekendPrice: 798, holidayPrice: 998, minPrice: 498, status: 'active' },
    { id: 'rt6', storeId: 's3', name: '亲子主题房', bedType: '大床1.5m+儿童床', area: '42', maxGuests: 3, facilities: ['WiFi', '空调', '电视', '独立卫浴', '儿童设施'], roomCount: 30, basePrice: 698, weekdayPrice: 698, weekendPrice: 898, holidayPrice: 1098, minPrice: 598, status: 'active' },
    { id: 'rt7', storeId: 's2', name: '商务大床房', bedType: '大床1.8m', area: '30', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴'], roomCount: 45, basePrice: 358, weekdayPrice: 388, weekendPrice: 428, holidayPrice: 528, minPrice: 318, status: 'active' },
    { id: 'rt8', storeId: 's2', name: '标准双床房', bedType: '双床1.2m', area: '28', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴'], roomCount: 35, basePrice: 328, weekdayPrice: 348, weekendPrice: 398, holidayPrice: 498, minPrice: 288, status: 'active' },
    { id: 'rt9', storeId: 's4', name: '快捷大床房', bedType: '大床1.5m', area: '22', maxGuests: 2, facilities: ['WiFi', '空调', '独立卫浴'], roomCount: 35, basePrice: 198, weekdayPrice: 218, weekendPrice: 258, holidayPrice: 298, minPrice: 168, status: 'active' },
    { id: 'rt10', storeId: 's4', name: '快捷双床房', bedType: '双床1.0m', area: '22', maxGuests: 2, facilities: ['WiFi', '空调', '独立卫浴'], roomCount: 30, basePrice: 218, weekdayPrice: 238, weekendPrice: 278, holidayPrice: 318, minPrice: 188, status: 'active' },
    { id: 'rt11', storeId: 's5', name: '豪华大床房', bedType: '大床1.8m', area: '32', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴', '迷你吧'], roomCount: 50, basePrice: 428, weekdayPrice: 458, weekendPrice: 528, holidayPrice: 628, minPrice: 388, status: 'inactive' },
    { id: 'rt12', storeId: 's5', name: '商务套房', bedType: '大床2.0m', area: '48', maxGuests: 2, facilities: ['WiFi', '空调', '电视', '独立卫浴', '迷你吧', '客厅'], roomCount: 20, basePrice: 688, weekdayPrice: 728, weekendPrice: 828, holidayPrice: 998, minPrice: 628, status: 'inactive' },
    { id: 'rt13', storeId: 's6', name: '标准大床房', bedType: '大床1.8m', area: '25', maxGuests: 2, facilities: ['WiFi', '空调', '独立卫浴'], roomCount: 30, basePrice: 188, weekdayPrice: 208, weekendPrice: 238, holidayPrice: 278, minPrice: 158, status: 'pending' },
    { id: 'rt14', storeId: 's6', name: '标准双床房', bedType: '双床1.2m', area: '25', maxGuests: 2, facilities: ['WiFi', '空调', '独立卫浴'], roomCount: 25, basePrice: 208, weekdayPrice: 228, weekendPrice: 258, holidayPrice: 298, minPrice: 178, status: 'pending' },
    { id: 'rt15', storeId: 's3', name: '别墅套房', bedType: '大床2.2m', area: '180', maxGuests: 6, facilities: ['WiFi', '空调', '电视', '独立卫浴', '泳池', '花园', '厨房'], roomCount: 5, basePrice: 3888, weekdayPrice: 3888, weekendPrice: 4588, holidayPrice: 5888, minPrice: 3588, status: 'active' },
  ]).onConflictDoNothing();

  // 4. 房间 (示例 - 国贸店标准大床房的部分房间)
  console.log('  填充 rooms...');
  const roomsData: typeof pmsBuiRooms.$inferInsert[] = [];
  // 国贸店 - 标准大床房 (801-820)
  for (let i = 1; i <= 20; i++) {
    const num = 800 + i;
    const status = i <= 8 ? 'occupied' : i <= 15 ? 'available' : i <= 18 ? 'dirty' : 'maintenance';
    roomsData.push({
      id: `room_s1_rt1_${i}`, storeId: 's1', roomTypeId: 'rt1', roomTypeName: '标准大床房',
      roomNumber: String(num), floor: Math.ceil(i / 5) + 7, status, price: 328,
      guestName: status === 'occupied' ? `客人${i}` : null,
      guestPhone: status === 'occupied' ? `1360000${String(num).padStart(4, '0')}` : null,
      checkInDate: status === 'occupied' ? '2025-05-07' : null,
      checkOutDate: status === 'occupied' ? '2025-05-09' : null,
    });
  }
  // 国贸店 - 豪华双床房 (1201-1210)
  for (let i = 1; i <= 10; i++) {
    const num = 1200 + i;
    const status = i <= 4 ? 'occupied' : i <= 8 ? 'available' : 'dirty';
    roomsData.push({
      id: `room_s1_rt2_${i}`, storeId: 's1', roomTypeId: 'rt2', roomTypeName: '豪华双床房',
      roomNumber: String(num), floor: 12, status, price: 498,
      guestName: status === 'occupied' ? `客人B${i}` : null,
      guestPhone: status === 'occupied' ? `1370000${String(num).padStart(4, '0')}` : null,
      checkInDate: status === 'occupied' ? '2025-05-07' : null,
      checkOutDate: status === 'occupied' ? '2025-05-08' : null,
    });
  }
  await db.insert(pmsBuiRooms).values(roomsData).onConflictDoNothing();

  // 5. 设备
  console.log('  填充 room_devices...');
  const devicesData: typeof pmsBuiRoomDevices.$inferInsert[] = [];
  for (let i = 1; i <= 5; i++) {
    devicesData.push(
      { id: `dev_ac_${i}`, storeId: 's1', roomNumber: String(800 + i), deviceName: '中央空调', deviceType: 'ac', status: 'normal', lastCheckDate: '2025-05-01' },
      { id: `dev_tv_${i}`, storeId: 's1', roomNumber: String(800 + i), deviceName: '智能电视', deviceType: 'tv', status: 'normal', lastCheckDate: '2025-05-01' },
      { id: `dev_lock_${i}`, storeId: 's1', roomNumber: String(800 + i), deviceName: '智能门锁', deviceType: 'lock', status: 'normal', lastCheckDate: '2025-05-01' },
    );
  }
  devicesData.push(
    { id: 'dev_ac_6', storeId: 's1', roomNumber: '806', deviceName: '中央空调', deviceType: 'ac', status: 'fault', lastCheckDate: '2025-04-28', remark: '制冷效果差' },
    { id: 'dev_lock_7', storeId: 's1', roomNumber: '807', deviceName: '智能门锁', deviceType: 'lock', status: 'offline', lastCheckDate: '2025-05-05', remark: '电池低电量' },
  );
  await db.insert(pmsBuiRoomDevices).values(devicesData).onConflictDoNothing();

  // 6. 角色
  console.log('  填充 roles...');
  await db.insert(pmsBuiRoles).values([
    { id: 'role1', name: '超级管理员', description: '拥有系统所有权限', isPreset: true, scope: 'tenant', permissions: ['dashboard', 'stores', 'rooms', 'orders', 'pricing', 'channels', 'finance', 'data-center', 'customers', 'staff', 'settings', 'assets:manage'], staffCount: 1 },
    { id: 'role2', name: '酒店经理', description: '管理门店运营', isPreset: true, scope: 'store', permissions: ['dashboard', 'rooms', 'orders', 'pricing', 'customers', 'assets:manage'], staffCount: 3 },
    { id: 'role3', name: '前台接待', description: '办理入住退房', isPreset: true, scope: 'store', permissions: ['rooms', 'orders', 'customers'], staffCount: 4 },
    { id: 'role4', name: '财务专员', description: '处理财务对账', isPreset: true, scope: 'brand', permissions: ['finance', 'orders'], staffCount: 1 },
    { id: 'role5', name: '渠道运营', description: '管理OTA渠道', isPreset: false, scope: 'brand', permissions: ['channels', 'orders'], staffCount: 1 },
  ]).onConflictDoNothing();

  // 7. 员工
  console.log('  填充 staff...');
  await db.insert(pmsBuiStaff).values([
    { id: 'staff1', name: '张明远', phone: '13800000001', email: 'zhangmy@feicui.com', department: '管理层', position: '总经理', roleId: 'role1', roleName: '超级管理员', stores: ['s1', 's2', 's3', 's4', 's5', 's6'], scope: 'tenant', status: 'active', lastLoginAt: new Date('2025-05-07T09:15:00') },
    { id: 'staff2', name: '李婉清', phone: '13800000002', email: 'liwq@feicui.com', department: '运营部', position: '店长', roleId: 'role2', roleName: '酒店经理', stores: ['s1'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-07T08:30:00') },
    { id: 'staff3', name: '王海涛', phone: '13800000003', email: 'wanght@feicui.com', department: '运营部', position: '店长', roleId: 'role2', roleName: '酒店经理', stores: ['s3'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-06T18:20:00') },
    { id: 'staff4', name: '赵晓敏', phone: '13800000004', email: 'zhaoxm@feicui.com', department: '运营部', position: '店长', roleId: 'role2', roleName: '酒店经理', stores: ['s4'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-07T07:45:00') },
    { id: 'staff5', name: '陈思雨', phone: '13800000005', email: 'chensy@feicui.com', department: '前台', position: '前台主管', roleId: 'role3', roleName: '前台接待', stores: ['s1'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-07T07:00:00') },
    { id: 'staff6', name: '刘洋', phone: '13800000006', email: 'liuy@feicui.com', department: '前台', position: '前台接待', roleId: 'role3', roleName: '前台接待', stores: ['s1'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-07T07:00:00') },
    { id: 'staff7', name: '林小燕', phone: '13800000007', email: 'linxy@feicui.com', department: '前台', position: '前台接待', roleId: 'role3', roleName: '前台接待', stores: ['s3'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-07T08:00:00') },
    { id: 'staff8', name: '孙雨萱', phone: '13800000008', email: 'sunyx@feicui.com', department: '前台', position: '前台接待', roleId: 'role3', roleName: '前台接待', stores: ['s4'], scope: 'store', status: 'active', lastLoginAt: new Date('2025-05-06T22:30:00') },
    { id: 'staff9', name: '周建国', phone: '13800000009', email: 'zhoujg@feicui.com', department: '财务部', position: '财务主管', roleId: 'role4', roleName: '财务专员', stores: ['s1', 's2', 's3', 's4'], scope: 'brand', status: 'active', lastLoginAt: new Date('2025-05-07T09:00:00') },
    { id: 'staff10', name: '吴佳琪', phone: '13800000010', email: 'wujq@feicui.com', department: '市场部', position: '渠道经理', roleId: 'role5', roleName: '渠道运营', stores: ['s1', 's2', 's3', 's4'], scope: 'brand', status: 'disabled', lastLoginAt: new Date('2025-04-20T10:00:00') },
  ] as any).onConflictDoNothing();

  // 8. 渠道
  console.log('  填充 channels...');
  await db.insert(pmsBuiChannels).values([
    { id: 'ch1', name: '携程', icon: '✈️', color: '#0086f6', type: 'ota', account: 'feicui_ctrip', balance: 125680, status: 'connected', commissionRate: '15.00', todayOrders: 8, todayRevenue: 4560, monthOrders: 245, monthRevenue: 138900, description: '携程旅行网', features: ['自动接单', '库存同步', '价格同步'], connectedAt: new Date('2024-01-15') },
    { id: 'ch2', name: '美团', icon: '🍔', color: '#ffcd00', type: 'ota', account: 'feicui_meituan', balance: 89200, status: 'connected', commissionRate: '12.00', todayOrders: 6, todayRevenue: 3280, monthOrders: 198, monthRevenue: 108600, description: '美团酒店', features: ['自动接单', '库存同步'], connectedAt: new Date('2024-01-15') },
    { id: 'ch3', name: '飞猪', icon: '🐷', color: '#ff6600', type: 'ota', account: 'feicui_fliggy', balance: 56300, status: 'connected', commissionRate: '10.00', todayOrders: 3, todayRevenue: 1890, monthOrders: 86, monthRevenue: 42800, description: '飞猪旅行', features: ['自动接单'], connectedAt: new Date('2024-03-20') },
    { id: 'ch4', name: 'Booking', icon: '🌍', color: '#003580', type: 'ota', account: 'feicui_booking', balance: 32100, status: 'disconnected', commissionRate: '18.00', todayOrders: 0, todayRevenue: 0, monthOrders: 12, monthRevenue: 8960, description: 'Booking.com', features: ['价格同步'] },
    { id: 'ch5', name: '直客', icon: '🏠', color: '#059669', type: 'direct', account: 'direct', balance: 0, status: 'connected', commissionRate: '0.00', todayOrders: 5, todayRevenue: 3780, monthOrders: 156, monthRevenue: 96800, description: '酒店直销', features: [], connectedAt: new Date('2024-01-15') },
  ]).onConflictDoNothing();

  // 9. 标签
  console.log('  填充 tags...');
  await db.insert(pmsBuiTags).values([
    { id: 'tag1', name: 'VIP客户', color: '#f59e0b', description: '高价值客户', isAuto: true, count: 2 },
    { id: 'tag2', name: '商务出行', color: '#3b82f6', description: '商务差旅客户', isAuto: true, count: 5 },
    { id: 'tag3', name: '家庭亲子', color: '#10b981', description: '带小孩的家庭客户', isAuto: false, count: 2 },
    { id: 'tag4', name: '长住客户', color: '#8b5cf6', description: '连续入住7天以上', isAuto: true, count: 1 },
    { id: 'tag5', name: '投诉风险', color: '#ef4444', description: '曾有投诉记录', isAuto: false, count: 1 },
    { id: 'tag6', name: '回头客', color: '#06b6d4', description: '入住3次以上', isAuto: true, count: 4 },
  ]).onConflictDoNothing();

  // 10. 客户
  console.log('  填充 customers...');
  await db.insert(pmsBuiCustomers).values([
    { id: 'c1', name: '张伟', phone: '13900001111', memberLevel: 'gold', memberLevelName: '金卡会员', memberLevelIcon: '🥇', memberLevelDiscount: 85, valueScore: 82, stayCount: 12, totalSpent: 28600, avgSpent: 2383, lastStayDate: '2025-04-28', source: 'direct', tags: ['tag1', 'tag2', 'tag6'], preferences: ['高楼层', '远离电梯'] },
    { id: 'c2', name: '李娜', phone: '13900002222', memberLevel: 'platinum', memberLevelName: '白金会员', memberLevelIcon: '💎', memberLevelDiscount: 78, valueScore: 95, stayCount: 28, totalSpent: 86500, avgSpent: 3089, lastStayDate: '2025-05-05', source: 'ctrip', tags: ['tag1', 'tag4', 'tag6'], preferences: ['行政楼层', '枕头菜单'] },
    { id: 'c3', name: '王磊', phone: '13900003333', memberLevel: 'silver', memberLevelName: '银卡会员', memberLevelIcon: '🥈', memberLevelDiscount: 92, valueScore: 55, stayCount: 4, totalSpent: 8200, avgSpent: 2050, lastStayDate: '2025-03-15', source: 'meituan', tags: ['tag2'], preferences: ['安静房间'] },
    { id: 'c4', name: '陈静', phone: '13900004444', memberLevel: 'gold', memberLevelName: '金卡会员', memberLevelIcon: '🥇', memberLevelDiscount: 85, valueScore: 78, stayCount: 9, totalSpent: 22300, avgSpent: 2478, lastStayDate: '2025-05-01', source: 'direct', tags: ['tag3', 'tag6'], preferences: ['亲子房', '加床'] },
    { id: 'c5', name: '刘洋', phone: '13900005555', memberLevel: 'regular', memberLevelName: '普通会员', memberLevelIcon: '🎫', memberLevelDiscount: 98, valueScore: 35, stayCount: 1, totalSpent: 1580, avgSpent: 1580, lastStayDate: '2025-04-20', source: 'fliggy', tags: [], preferences: [] },
    { id: 'c6', name: '赵敏', phone: '13900006666', memberLevel: 'silver', memberLevelName: '银卡会员', memberLevelIcon: '🥈', memberLevelDiscount: 92, valueScore: 62, stayCount: 6, totalSpent: 15600, avgSpent: 2600, lastStayDate: '2025-04-10', source: 'ctrip', tags: ['tag2', 'tag5'], preferences: ['无烟房'] },
    { id: 'c7', name: '孙丽', phone: '13900007777', memberLevel: 'regular', memberLevelName: '普通会员', memberLevelIcon: '🎫', memberLevelDiscount: 98, valueScore: 28, stayCount: 2, totalSpent: 3200, avgSpent: 1600, lastStayDate: '2025-05-03', source: 'meituan', tags: ['tag3'], preferences: ['低楼层'] },
    { id: 'c8', name: '周涛', phone: '13900008888', memberLevel: 'regular', memberLevelName: '普通会员', memberLevelIcon: '🎫', memberLevelDiscount: 98, valueScore: 40, stayCount: 3, totalSpent: 5400, avgSpent: 1800, lastStayDate: '2025-04-25', source: 'direct', tags: ['tag2'], preferences: ['靠窗'] },
    { id: 'c9', name: '吴芳', phone: '13900009999', memberLevel: 'gold', memberLevelName: '金卡会员', memberLevelIcon: '🥇', memberLevelDiscount: 85, valueScore: 76, stayCount: 10, totalSpent: 24800, avgSpent: 2480, lastStayDate: '2025-05-06', source: 'ctrip', tags: ['tag1', 'tag2', 'tag6'], preferences: ['行政楼层'] },
    { id: 'c10', name: '郑强', phone: '13900010000', memberLevel: 'regular', memberLevelName: '普通会员', memberLevelIcon: '🎫', memberLevelDiscount: 98, valueScore: 45, stayCount: 2, totalSpent: 4200, avgSpent: 2100, lastStayDate: '2025-04-15', source: 'fliggy', tags: ['tag3'], preferences: ['大床'] },
  ]).onConflictDoNothing();

  // 11. 设置 (key-value 结构)
  console.log('  填充 settings...');
  await db.insert(pmsBuiSettings).values([
    { id: 'set1', category: 'basic', key: 'company_info', value: { name: '翡翠酒店集团', shortName: '翡翠酒店', phone: '400-888-9999', email: 'info@feicui-hotel.com', address: '北京市朝阳区建国门外大街1号国贸大厦A座', website: 'https://www.feicui-hotel.com', description: '翡翠酒店集团，始创于2010年，专注于高端商务与精品度假酒店运营', logo: '🏨', businessLicense: '91110000MA01234567', legalPerson: '张明远' } },
    { id: 'set2', category: 'business', key: 'booking_policy', value: { advanceDays: 30, sameDayCutoff: '18:00', maxRoomsPerBooking: 5, requireDeposit: true, depositRate: 100, allowCancel: true, freeCancelHours: 24, specialRequestEnabled: true } },
    { id: 'set3', category: 'business', key: 'check_in_policy', value: { standardTime: '14:00', latestTime: '次日06:00', idRequired: true, depositAmount: 500, earlyCheckInFee: 100, earlyCheckInStart: '10:00' } },
    { id: 'set4', category: 'subscription', key: 'current_plan', value: { plan: 'professional', status: 'active', startDate: '2025-01-01', endDate: '2025-12-31', stores: 6, staff: 10, features: ['dashboard', 'stores', 'rooms', 'orders', 'pricing', 'channels', 'finance', 'customers', 'staff', 'settings'], price: 999, unit: '月' } },
    { id: 'set5', category: 'security', key: 'password_policy', value: { minLength: 8, requireUpper: true, requireLower: true, requireNumber: true, requireSpecial: false, expireDays: 90 } },
    { id: 'set6', category: 'security', key: 'login_policy', value: { maxAttempts: 5, lockDuration: 30, sessionTimeout: 480, twoFactorEnabled: false } },
    { id: 'set7', category: 'security', key: 'audit_policy', value: { operationLog: true, retentionDays: 180, sensitiveOperations: ['staff_delete', 'role_change', 'password_reset', 'finance_export'] } },
  ]).onConflictDoNothing();

  // 12. 订单
  console.log('  填充 orders...');
  await db.insert(pmsBuiOrders).values([
    { id: 'ord1', orderNo: 'ORD20250507001', channel: '携程', channelColor: '#0086f6', icon: '✈️', channelOrderId: 'CT20250507001', guestName: '王建国', guestPhone: '13600001111', checkIn: '2025-05-07', checkOut: '2025-05-09', nights: 2, roomType: '标准大床房', roomTypeId: 'rt1', roomNumber: '801', totalPrice: 656, status: 'confirmed', paymentStatus: 'paid', source: 'ota', remark: '', storeId: 's1', createdAt: new Date('2025-05-06T14:30:00') },
    { id: 'ord2', orderNo: 'ORD20250507002', channel: '美团', channelColor: '#ffcd00', icon: '🍔', channelOrderId: 'MT20250507002', guestName: '刘晓燕', guestPhone: '13600002222', checkIn: '2025-05-07', checkOut: '2025-05-08', nights: 1, roomType: '豪华双床房', roomTypeId: 'rt2', roomNumber: '1205', totalPrice: 498, status: 'pending_confirm', paymentStatus: 'paid', source: 'ota', remark: '需要无烟房', storeId: 's1', createdAt: new Date('2025-05-06T16:20:00') },
    { id: 'ord3', orderNo: 'ORD20250507003', channel: '直客', channelColor: '#059669', icon: '🏠', channelOrderId: '', guestName: '张伟', guestPhone: '13900001111', checkIn: '2025-05-07', checkOut: '2025-05-10', nights: 3, roomType: '行政套房', roomTypeId: 'rt3', roomNumber: '1501', totalPrice: 2664, status: 'checked_in', paymentStatus: 'paid', source: 'direct', remark: 'VIP客户', storeId: 's1', createdAt: new Date('2025-05-05T10:00:00') },
    { id: 'ord4', orderNo: 'ORD20250507004', channel: '飞猪', channelColor: '#ff6600', icon: '🐷', channelOrderId: 'FL20250507003', guestName: '陈丽华', guestPhone: '13600003333', checkIn: '2025-05-07', checkOut: '2025-05-08', nights: 1, roomType: '标准大床房', roomTypeId: 'rt1', roomNumber: '603', totalPrice: 398, status: 'checked_in', paymentStatus: 'paid', source: 'ota', remark: '', storeId: 's1', createdAt: new Date('2025-05-06T20:15:00') },
    { id: 'ord5', orderNo: 'ORD20250507005', channel: '携程', channelColor: '#0086f6', icon: '✈️', channelOrderId: 'CT20250507005', guestName: '李明', guestPhone: '13600004444', checkIn: '2025-05-08', checkOut: '2025-05-10', nights: 2, roomType: '豪华双床房', roomTypeId: 'rt2', roomNumber: '', totalPrice: 856, status: 'pending_confirm', paymentStatus: 'unpaid', source: 'ota', remark: '', storeId: 's1', createdAt: new Date('2025-05-07T08:00:00') },
  ]).onConflictDoNothing();

  // 13. 渠道待处理订单
  console.log('  填充 channel_orders...');
  await db.insert(pmsBuiChannelOrders).values([
    { id: 'cp1', orderNo: 'CT20250507-C01', channel: '携程', channelColor: '#0086f6', icon: '✈️', channelOrderId: 'CT5050701', guestName: '赵明', guestPhone: '13700001111', roomType: '标准大床房', roomTypeId: 'rt1', roomNumber: '502', checkIn: '2025-05-07', checkOut: '2025-05-09', nights: 2, totalPrice: 656, status: 'pending_confirm', paymentStatus: 'paid', remark: '靠近电梯' },
    { id: 'cp2', orderNo: 'MT20250507-C02', channel: '美团', channelColor: '#ffcd00', icon: '🍔', channelOrderId: 'MT5050702', guestName: '孙红', guestPhone: '13700002222', roomType: '豪华双床房', roomTypeId: 'rt2', roomNumber: '1008', checkIn: '2025-05-08', checkOut: '2025-05-09', nights: 1, totalPrice: 498, status: 'pending_confirm', paymentStatus: 'paid', remark: '' },
    { id: 'cp3', orderNo: 'FL20250507-C03', channel: '飞猪', channelColor: '#ff6600', icon: '🐷', channelOrderId: 'FL5050703', guestName: '周杰', guestPhone: '13700003333', roomType: '标准大床房', roomTypeId: 'rt1', roomNumber: '305', checkIn: '2025-05-07', checkOut: '2025-05-08', nights: 1, totalPrice: 398, status: 'pending_confirm', paymentStatus: 'paid', remark: '' },
  ]).onConflictDoNothing();

  // 14. 财务流水
  console.log('  填充 transactions...');
  await db.insert(pmsBuiTransactions).values([
    { id: 'tx1', type: 'income', category: '房费收入', amount: 656, channel: '携程', orderNo: 'ORD20250507001', guestName: '王建国', storeName: '翡翠酒店(国贸店)', paymentMethod: '在线支付', status: 'completed', remark: '2晚标准大床房', createdAt: new Date('2025-05-07T10:00:00') },
    { id: 'tx2', type: 'expense', category: 'OTA佣金', amount: 98, channel: '携程', orderNo: 'ORD20250507001', guestName: '王建国', storeName: '翡翠酒店(国贸店)', paymentMethod: '自动扣款', status: 'completed', remark: '15%佣金', createdAt: new Date('2025-05-07T10:00:00') },
    { id: 'tx3', type: 'income', category: '房费收入', amount: 2664, channel: '直客', orderNo: 'ORD20250507003', guestName: '张伟', storeName: '翡翠酒店(国贸店)', paymentMethod: '刷卡', status: 'completed', remark: '3晚行政套房', createdAt: new Date('2025-05-07T11:30:00') },
    { id: 'tx4', type: 'income', category: '押金收入', amount: 500, channel: '直客', orderNo: 'ORD20250507003', guestName: '张伟', storeName: '翡翠酒店(国贸店)', paymentMethod: '刷卡', status: 'pending', remark: '入住押金', createdAt: new Date('2025-05-07T11:30:00') },
    { id: 'tx5', type: 'income', category: '房费收入', amount: 498, channel: '美团', orderNo: 'ORD20250507002', guestName: '刘晓燕', storeName: '翡翠酒店(国贸店)', paymentMethod: '在线支付', status: 'completed', remark: '1晚豪华双床房', createdAt: new Date('2025-05-07T14:00:00') },
    { id: 'tx6', type: 'expense', category: 'OTA佣金', amount: 60, channel: '美团', orderNo: 'ORD20250507002', guestName: '刘晓燕', storeName: '翡翠酒店(国贸店)', paymentMethod: '自动扣款', status: 'completed', remark: '12%佣金', createdAt: new Date('2025-05-07T14:00:00') },
  ]).onConflictDoNothing();

  // 15. 对账预警
  console.log('  填充 reconciliation_alerts...');
  await db.insert(pmsBuiReconciliationAlerts).values([
    { id: 'ra1', type: 'amount_mismatch', channel: '携程', title: '携程金额不一致', description: '3笔订单系统金额与渠道金额不一致', count: 3, amount: 456, status: 'pending' },
    { id: 'ra2', type: 'missing_order', channel: '美团', title: '美团漏单', description: '2笔渠道订单未在系统中找到对应记录', count: 2, amount: 898, status: 'pending' },
    { id: 'ra3', type: 'amount_mismatch', channel: '飞猪', title: '飞猪金额差异', description: '1笔订单金额差异超过50元', count: 1, amount: 120, status: 'resolved' },
  ]).onConflictDoNothing();

  // 16. 对账明细
  console.log('  填充 reconciliation_details...');
  await db.insert(pmsBuiReconciliationDetails).values([
    { id: 'rd1', channelName: '携程', orderNo: 'ORD20250506001', guestName: '李华', systemAmount: 328, channelAmount: 298, difference: 30, status: 'mismatch', orderDate: '2025-05-06' },
    { id: 'rd2', channelName: '美团', orderNo: 'ORD20250506002', guestName: '王芳', systemAmount: 498, channelAmount: 498, difference: 0, status: 'matched', orderDate: '2025-05-06' },
    { id: 'rd3', channelName: '携程', orderNo: 'ORD20250506003', guestName: '陈明', systemAmount: 398, channelAmount: 368, difference: 30, status: 'mismatch', orderDate: '2025-05-06' },
    { id: 'rd4', channelName: '飞猪', orderNo: 'ORD20250506004', guestName: '张丽', systemAmount: 598, channelAmount: 598, difference: 0, status: 'matched', orderDate: '2025-05-05' },
  ]).onConflictDoNothing();

  // 17. 操作日志
  console.log('  填充 op_logs...');
  await db.insert(pmsBuiOpLogs).values([
    { id: 'log1', staffId: 'staff1', staffName: '张明远', module: 'orders', moduleLabel: '订单管理', action: '确认订单', target: 'ORD20250507001', detail: '确认订单 ORD20250507001', ip: '192.168.1.100', level: 'info', timestamp: new Date('2025-05-07T09:15:00') },
    { id: 'log2', staffId: 'staff5', staffName: '陈思雨', module: 'rooms', moduleLabel: '房态管理', action: '办理入住', target: '1501', detail: '为客人张伟办理入住 1501房间', ip: '192.168.1.101', level: 'info', timestamp: new Date('2025-05-07T11:30:00') },
    { id: 'log3', staffId: 'staff9', staffName: '周建国', module: 'finance', moduleLabel: '收支明细', action: '导出报表', target: '5月收支报表', detail: '导出5月收支报表', ip: '192.168.1.105', level: 'warning', timestamp: new Date('2025-05-07T14:00:00') },
    { id: 'log4', staffId: 'staff1', staffName: '张明远', module: 'staff', moduleLabel: '团队管理', action: '重置密码', target: '吴佳琪', detail: '重置员工吴佳琪登录密码', ip: '192.168.1.100', level: 'warning', timestamp: new Date('2025-05-06T16:00:00') },
    { id: 'log5', staffId: 'staff2', staffName: '李婉清', module: 'pricing', moduleLabel: '价格管理', action: '调整房价', target: '标准大床房', detail: '调整标准大床房周末价格为398', ip: '192.168.1.102', level: 'info', timestamp: new Date('2025-05-06T10:20:00') },
  ]).onConflictDoNothing();

  // 18. 关怀提醒
  console.log('  填充 care_reminders...');
  await db.insert(pmsBuiCareReminders).values([
    { id: 'care1', customerId: 'c1', customerName: '张伟', type: 'birthday', content: '客户生日即将到来，请准备生日关怀', priority: 'high', status: 'pending', dueDate: '2025-06-15' },
    { id: 'care2', customerId: 'c2', customerName: '李娜', type: 'rebuy', content: '已超过30天未入住，建议发送优惠', priority: 'medium', status: 'pending', dueDate: '2025-05-15' },
    { id: 'care3', customerId: 'c4', customerName: '陈静', type: 'birthday', content: '客户生日即将到来，请准备生日关怀', priority: 'low', status: 'pending', dueDate: '2025-07-22' },
    { id: 'care4', customerId: 'c6', customerName: '赵敏', type: 'rebuy', content: '已超过25天未入住，建议发送优惠', priority: 'high', status: 'pending', dueDate: '2025-05-10' },
  ]).onConflictDoNothing();

  // 19. 自动标签规则
  console.log('  填充 auto_tag_rules...');
  await db.insert(pmsBuiAutoTagRules).values([
    { id: 'atr1', name: 'VIP自动标记', rule: 'totalSpent>20000', field: 'totalSpent', tag: 'tag1', enabled: true },
    { id: 'atr2', name: '回头客标记', rule: 'stayCount>=3', field: 'stayCount', tag: 'tag6', enabled: true },
    { id: 'atr3', name: '长住客户标记', rule: 'nights>=7', field: 'nights', tag: 'tag4', enabled: false },
  ]).onConflictDoNothing();

  // 20. 评价
  console.log('  填充 reviews...');
  await db.insert(pmsBuiReviews).values([
    { id: 'rev1', channelId: 'ch1', channelName: '携程', channelIcon: '✈️', guestName: '王先生', rating: 5, content: '位置好，服务态度棒，房间干净整洁', replyStatus: 'replied', replyContent: '感谢您的好评！期待您的再次光临！', reviewTime: '2025-05-05', storeId: 's1' },
    { id: 'rev2', channelId: 'ch2', channelName: '美团', channelIcon: '🍔', guestName: '李女士', rating: 3, content: '隔音效果一般，其他还行', replyStatus: 'pending', replyContent: '', reviewTime: '2025-05-04', storeId: 's1' },
    { id: 'rev3', channelId: 'ch3', channelName: '飞猪', channelIcon: '🐷', guestName: '张先生', rating: 4, content: '整体不错，早餐品种可以再丰富些', replyStatus: 'replied', replyContent: '感谢您的建议，我们会改进早餐品种！', reviewTime: '2025-05-03', storeId: 's1' },
    { id: 'rev4', channelId: 'ch5', channelName: '直客', channelIcon: '🏠', guestName: '陈女士', rating: 5, content: '第二次入住了，一如既往的好', replyStatus: 'replied', replyContent: '感谢您的信赖！欢迎常来！', reviewTime: '2025-05-06', storeId: 's3' },
    { id: 'rev5', channelId: 'ch1', channelName: '携程', channelIcon: '✈️', guestName: '赵先生', rating: 2, content: '空调噪音大，影响睡眠', replyStatus: 'pending', replyContent: '', reviewTime: '2025-05-07', storeId: 's1' },
  ]).onConflictDoNothing();

  // 21. 定价规则
  console.log('  填充 pricing_rules...');
  await db.insert(pmsBuiPricingRules).values([
    { id: 'pr1', storeId: 's1', roomTypeId: 'rt1', roomType: '标准大床房', basePrice: 298, weekdayPrice: 328, weekendPrice: 398, holidayPrice: 498, minPrice: 268, priceHistory: [{ date: '2025-04-01', price: 298 }, { date: '2025-05-01', price: 328 }], status: 'active' },
    { id: 'pr2', storeId: 's1', roomTypeId: 'rt2', roomType: '豪华双床房', basePrice: 398, weekdayPrice: 428, weekendPrice: 498, holidayPrice: 598, minPrice: 358, priceHistory: [{ date: '2025-04-01', price: 398 }, { date: '2025-05-01', price: 428 }], status: 'active' },
    { id: 'pr3', storeId: 's1', roomTypeId: 'rt3', roomType: '行政套房', basePrice: 828, weekdayPrice: 888, weekendPrice: 998, holidayPrice: 1288, minPrice: 758, priceHistory: [], status: 'active' },
    { id: 'pr4', storeId: 's3', roomTypeId: 'rt5', roomType: '海景大床房', basePrice: 598, weekdayPrice: 628, weekendPrice: 798, holidayPrice: 998, minPrice: 498, priceHistory: [], status: 'active' },
  ]).onConflictDoNothing();

  // 22. 价格日历 (5月前7天)
  console.log('  填充 pricing_calendar...');
  await db.insert(pmsBuiPricingCalendar).values([
    { id: 'pc1', storeId: 's1', date: '2025-05-01', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 498, available: 38 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 598, available: 28 }, { roomTypeId: 'rt3', name: '行政套房', price: 1288, available: 9 }], isWeekend: false, isHoliday: true },
    { id: 'pc2', storeId: 's1', date: '2025-05-02', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 498, available: 36 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 598, available: 26 }, { roomTypeId: 'rt3', name: '行政套房', price: 1288, available: 8 }], isWeekend: false, isHoliday: true },
    { id: 'pc3', storeId: 's1', date: '2025-05-03', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 398, available: 35 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 498, available: 25 }, { roomTypeId: 'rt3', name: '行政套房', price: 998, available: 8 }], isWeekend: true, isHoliday: false },
    { id: 'pc4', storeId: 's1', date: '2025-05-04', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 398, available: 34 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 498, available: 24 }, { roomTypeId: 'rt3', name: '行政套房', price: 998, available: 8 }], isWeekend: true, isHoliday: false },
    { id: 'pc5', storeId: 's1', date: '2025-05-05', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 328, available: 33 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 428, available: 23 }, { roomTypeId: 'rt3', name: '行政套房', price: 888, available: 9 }], isWeekend: false, isHoliday: false },
    { id: 'pc6', storeId: 's1', date: '2025-05-06', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 328, available: 32 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 428, available: 22 }, { roomTypeId: 'rt3', name: '行政套房', price: 888, available: 9 }], isWeekend: false, isHoliday: false },
    { id: 'pc7', storeId: 's1', date: '2025-05-07', roomTypes: [{ roomTypeId: 'rt1', name: '标准大床房', price: 328, available: 30 }, { roomTypeId: 'rt2', name: '豪华双床房', price: 428, available: 20 }, { roomTypeId: 'rt3', name: '行政套房', price: 888, available: 8 }], isWeekend: false, isHoliday: false },
  ]).onConflictDoNothing();

  // 23. 限时特价
  console.log('  填充 promotions...');
  await db.insert(pmsBuiPromotions).values([
    { id: 'promo1', storeId: 's1', name: '五一特惠', type: 'percentage', discount: 85, startDate: '2025-05-01', endDate: '2025-05-03', roomTypes: ['rt1', 'rt2'], channels: ['ch1', 'ch2'], status: 'active' },
    { id: 'promo2', storeId: 's3', name: '暑期早鸟', type: 'fixed', discount: 100, startDate: '2025-06-15', endDate: '2025-07-15', roomTypes: ['rt5', 'rt6'], channels: ['ch1', 'ch3'], status: 'scheduled' },
    { id: 'promo3', storeId: 's1', name: '商务特惠', type: 'percentage', discount: 90, startDate: '2025-04-01', endDate: '2025-04-30', roomTypes: ['rt3'], channels: ['ch5'], status: 'expired' },
  ]).onConflictDoNothing();

  // 24. AI建议
  console.log('  填充 ai_suggestions...');
  await db.insert(pmsBuiAiSuggestions).values([
    { id: 'ais1', roomType: '标准大床房', currentPrice: 328, suggestedPrice: 358, reason: '本周商务需求上升，竞品均价已调至350+，建议提价30元', confidence: '0.85', competitorAvg: 356, status: 'pending', type: 'pricing' },
    { id: 'ais2', roomType: '豪华双床房', currentPrice: 428, suggestedPrice: 398, reason: '近期空房率偏高，建议降价促销提升入住率', confidence: '0.72', competitorAvg: 412, status: 'pending', type: 'pricing' },
    { id: 'ais3', roomType: '行政套房', currentPrice: 888, suggestedPrice: 928, reason: '周末需求旺盛，可提价提升收益', confidence: '0.68', competitorAvg: 920, status: 'applied', type: 'pricing' },
  ]).onConflictDoNothing();

  // 25. AI对话历史
  console.log('  填充 ai_chat_history...');
  await db.insert(pmsBuiAiChatHistory).values([
    { id: 'aich1', merchantId: 'default', sessionId: 'seed_revenue', role: 'user', content: '帮我分析一下本月的收益情况' },
    { id: 'aich2', merchantId: 'default', sessionId: 'seed_revenue', role: 'assistant', content: '根据数据分析，本月总收益为5,428,000元，环比上月增长12.5%。其中：\n1. 国贸店贡献最大，占比42%\n2. 三亚湾店度假需求旺盛，入住率达90%\n3. 建议关注望京店的入住率偏低问题' },
    { id: 'aich3', merchantId: 'default', sessionId: 'seed_revenue', role: 'user', content: '国贸店的标准大床房定价合理吗？' },
    { id: 'aich4', merchantId: 'default', sessionId: 'seed_revenue', role: 'assistant', content: '国贸店标准大床房当前定价328元/晚（工作日），相比周边同档次酒店偏低5-10%。建议：\n1. 工作日价格可上调至358元\n2. 周末价格维持398元不变\n3. 预计月增收约8,000元' },
  ]).onConflictDoNothing();

  console.log('✅ 数据填充完成！');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
