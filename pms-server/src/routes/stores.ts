import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { db } from '../db/index';
import { pmsBuiStores, pmsBuiRoomTypes, pmsBuiRooms, pmsBuiRoomDevices } from '../db/schema';
import { eq, and, type SQL } from 'drizzle-orm';
import { JWT_SECRET } from '../constants.js';
import { getTenantScope } from '../utils/tenant.js';

function getMerchantId(c: any): string {
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    try { const p = jwt.verify(auth.slice(7), JWT_SECRET) as any; return p.merchantId || 'default'; } catch {}
  }
  return 'default';
}
import { validateBody } from '../utils/validate';

const route = new Hono();

// GET /api/stores/current — 返回当前门店基本信息
route.get('/current', async (c) => {
  const scope = getTenantScope(c);
  const [store] = await db.select().from(pmsBuiStores)
    .where(eq(pmsBuiStores.id, scope.storeId)).limit(1);
  if (!store) return c.json({ success: false, error: '门店不存在' }, 404);
  return c.json({ success: true, data: store });
});

// Mapping for store settings display
const cancelPolicyLabels: Record<string, string> = {
  flexible: '灵活取消',
  moderate: '适度取消',
  strict: '严格取消',
};
const depositRuleLabels: Record<string, string> = {
  none: '无押金',
  first_night: '首晚房费',
  fixed: '固定金额',
  percentage: '按比例',
};

function formatStoreSettings() {
  return {
    checkInTime: '14:00',
    checkOutTime: '12:00',
    cancelPolicy: cancelPolicyLabels['flexible'],
    depositRule: depositRuleLabels['first_night'],
    depositAmount: 0,
    identityRequired: true,
    petAllowed: false,
    smokingAllowed: false,
    lateCheckOut: { enabled: true, fee: 100, maxHours: 2 },
    earlyCheckIn: { enabled: true, fee: 100, earliestTime: '12:00' },
  };
}

route.get('/', async (c) => {
  const type = c.req.query('type');
  const storeId = c.req.query('storeId') || c.req.header('X-Store-Id') || '';

  if (type === 'rooms') {
    const mid2 = getMerchantId(c);
    const rooms = storeId
      ? await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId))
      : (mid2 && mid2 !== 'default'
        ? await db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.merchantId, mid2))
        : await db.select().from(pmsBuiRooms));
    const enriched = rooms.map(r => ({
      ...r,
      attributes: r.status === 'occupied' ? ['有住客'] : r.status === 'dirty' ? ['需打扫'] : [],
    }));
    return c.json(enriched);
  }

  if (type === 'roomTypes') {
    const mid3 = getMerchantId(c);
    // 用条件数组一次构造 where，避免 let 重新赋值 .where() 导致 select 类型不匹配
    const roomTypeConditions: SQL[] = [];
    if (storeId) {
      roomTypeConditions.push(eq(pmsBuiRoomTypes.storeId, storeId));
    } else if (mid3 && mid3 !== 'default') {
      // 真实商户：按商户过滤（兼容多门店商户，返回该商户所有门店房型）
      roomTypeConditions.push(eq(pmsBuiRoomTypes.merchantId, mid3));
    } else {
      // 平台调用（merchant=default）且未指定门店：按租户门店上下文兜底，
      // 无门店上下文则返回空列表，防止「全部门店房型」跨门店泄漏
      const scope = getTenantScope(c);
      if (scope.storeId && scope.storeId !== '*') {
        roomTypeConditions.push(eq(pmsBuiRoomTypes.storeId, scope.storeId));
      } else {
        return c.json([]);
      }
    }
    const roomTypes = await db.select().from(pmsBuiRoomTypes)
      .where(roomTypeConditions.length ? and(...roomTypeConditions) : undefined);
    return c.json(roomTypes);
  }

  if (type === 'devices') {
    const mid4 = getMerchantId(c);
    const devices = storeId
      ? await db.select().from(pmsBuiRoomDevices).where(eq(pmsBuiRoomDevices.storeId, storeId))
      : (mid4 && mid4 !== 'default'
        ? await db.select().from(pmsBuiRoomDevices).where(eq(pmsBuiRoomDevices.merchantId, mid4))
        : await db.select().from(pmsBuiRoomDevices));
    return c.json(devices);
  }

  if (type === 'storeProfile') {
    const store = await db.select().from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId || '')).limit(1);
    if (store.length === 0) return c.json({ error: '门店不存在' }, 404);
    const s = store[0];
    return c.json({
      id: s.id,
      name: s.name || '',
      shortName: s.shortName || '',
      phone: s.phone || '',
      email: s.email || '',
      address: s.address || '',
      latitude: s.latitude || '',
      longitude: s.longitude || '',
      logo: s.logo || '',
      description: s.description || '',
    });
  }

  if (type === 'storeDetail') {
    const store = await db.select().from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId || '')).limit(1);
    if (store.length === 0) return c.json({ error: '门店不存在' }, 404);

    const [rooms, roomTypes, devices] = await Promise.all([
      db.select().from(pmsBuiRooms).where(eq(pmsBuiRooms.storeId, storeId!)),
      db.select().from(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.storeId, storeId!)),
      db.select().from(pmsBuiRoomDevices).where(eq(pmsBuiRoomDevices.storeId, storeId!)),
    ]);

    return c.json({
      ...store[0],
      settings: formatStoreSettings(),
      images: 5,
      rating: 4.5,
      reviewCount: 128,
      rooms,
      roomTypes,
      devices,
    });
  }

  // Default: stores list（按商户过滤）
  const mid = getMerchantId(c);
  const stores = mid && mid !== 'default'
    ? await db.select().from(pmsBuiStores).where(eq(pmsBuiStores.merchantId, mid))
    : await db.select().from(pmsBuiStores);
  const enriched = stores.map(s => ({
    ...s,
    settings: formatStoreSettings(),
    images: 5,
    rating: 4.5,
    reviewCount: 128,
  }));
  return c.json(enriched);
});

// Zod 请求体验证 schema
const storesActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('addStore'),
    name: z.string().min(1, '门店名称不能为空'),
    address: z.string().optional(),
    phone: z.string().optional(),
    brandId: z.string().optional(),
    brandName: z.string().optional(),
    roomCount: z.number().optional(),
    facilities: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal('editStore'),
    storeId: z.string().min(1, '门店ID不能为空'),
  }).passthrough(),
  z.object({
    action: z.literal('addRoomType'),
    storeId: z.string().min(1, '门店ID不能为空'),
    name: z.string().min(1, '房型名称不能为空'),
    bedType: z.string().optional(),
    area: z.union([z.string(), z.number()]).optional(),
    maxGuests: z.number().optional(),
    facilities: z.array(z.string()).optional(),
    roomCount: z.number().optional(),
    basePrice: z.number().optional(),
    images: z.array(z.string()).optional(),
    description: z.string().optional(),
    status: z.string().optional(),
  }),
  z.object({
    action: z.literal('addRoom'),
    storeId: z.string().min(1, '门店ID不能为空'),
    roomTypeId: z.string().min(1, '房型ID不能为空'),
    roomTypeName: z.string().optional(),
    roomNumber: z.string().min(1, '房间号不能为空'),
    floor: z.number().optional(),
    status: z.string().optional(),
    price: z.number().optional(),
  }),
  z.object({
    action: z.literal('editRoomType'),
    id: z.string().min(1, '房型ID不能为空'),
    storeId: z.string().optional(),
    name: z.string().optional(),
    bedType: z.string().optional(),
    area: z.union([z.string(), z.number()]).optional(),
    maxGuests: z.number().optional(),
    facilities: z.array(z.string()).optional(),
    roomCount: z.number().optional(),
    basePrice: z.number().optional(),
    images: z.array(z.string()).optional(),
    description: z.string().optional(),
    status: z.string().optional(),
  }),
  z.object({
    action: z.literal('editRoom'),
    id: z.string().min(1, '房间ID不能为空'),
    roomNumber: z.string().optional(),
    floor: z.number().optional(),
    status: z.string().optional(),
    price: z.number().optional(),
    attributes: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal('deleteRoom'),
    id: z.string().min(1, '房间ID不能为空'),
  }),
  z.object({
    action: z.literal('deleteRoomType'),
    id: z.string().min(1, '房型ID不能为空'),
  }),
]);

route.post('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, storesActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;

  if (data.action === 'addStore') {
    const { name, address, phone, brandId, brandName, roomCount, facilities } = data;
    const id = `store-${Date.now()}`;
    const result = await db.insert(pmsBuiStores).values({
      id, name, address: address || '', phone: phone || '',
      brandId: brandId || '', brandName: brandName || '',
      roomCount: roomCount || 0, status: 'active',
      facilities: facilities || [],
      todayOccupancy: 0, todayRevenue: 0, monthRevenue: 0,
    } as any).returning();

    // 自动初始化私域小程序配置（避免门店无配置记录导致二维码生成失败）
    const { pmsBuiMiniStoreConfig } = await import('../db/schema/mini-store.js');
    await db.insert(pmsBuiMiniStoreConfig).values({
      id: `msc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: getMerchantId(c),
      storeId: id,
      online: false,
      headerImages: [],
      intro: '',
      gallery: [],
    }).onConflictDoNothing();

    return c.json(result[0], 201);
  }

  if (data.action === 'editStore') {
    const { storeId, ...updates } = data;
    const setData: any = { updatedAt: new Date() };
    if (updates.name !== undefined) setData.name = updates.name;
    if (updates.shortName !== undefined) setData.shortName = updates.shortName;
    if (updates.phone !== undefined) setData.phone = updates.phone;
    if (updates.email !== undefined) setData.email = updates.email;
    if (updates.address !== undefined) setData.address = updates.address;
    if (updates.latitude !== undefined) setData.latitude = updates.latitude;
    if (updates.longitude !== undefined) setData.longitude = updates.longitude;
    if (updates.logo !== undefined) setData.logo = updates.logo;
    if (updates.description !== undefined) setData.description = updates.description;
    if (updates.manager !== undefined) setData.manager = updates.manager;
    if (updates.brandId !== undefined) setData.brandId = updates.brandId;
    if (updates.brandName !== undefined) setData.brandName = updates.brandName;
    if (updates.status !== undefined) setData.status = updates.status;
    if (updates.facilities !== undefined) setData.facilities = updates.facilities;
    if (updates.city !== undefined) setData.city = updates.city;
    if (updates.preferenceTags !== undefined) setData.preferenceTags = updates.preferenceTags;
    await db.update(pmsBuiStores).set(setData).where(eq(pmsBuiStores.id, storeId));
    return c.json({ success: true });
  }

  if (data.action === 'addRoomType') {
    const mid = getMerchantId(c);
    const { storeId, name, bedType, area, maxGuests, facilities, roomCount, basePrice, images, description, status } = data;
    const id = `rt-${Date.now()}`;
    const result = await db.insert(pmsBuiRoomTypes).values({
      id, merchantId: mid, storeId, name, bedType: bedType || '', area: area || 0,
      maxGuests: maxGuests || 2, facilities: facilities || [],
      roomCount: roomCount || 0, basePrice: basePrice || 0,
      images: images || [], description: description || '',
      status: status || 'active',
    } as any).returning();
    return c.json(result[0], 201);
  }

  if (data.action === 'addRoom') {
    const { storeId, roomTypeId, roomTypeName, roomNumber, floor, status, price } = data;
    const id = `room-${Date.now()}`;
    const mid2 = getMerchantId(c);
    const result = await db.insert(pmsBuiRooms).values({
      id, merchantId: mid2, storeId, roomTypeId, roomTypeName: roomTypeName || '',
      roomNumber, floor: floor || 3,
      status: status || 'available', price: price || 0,
    } as any).returning();
    return c.json(result[0], 201);
  }

  if (data.action === 'editRoomType') {
    const { id, ...updates } = data;
    if (!id) return c.json({ error: 'Missing room type id' }, 400);
    const setData: any = { updatedAt: new Date() };
    if (updates.storeId !== undefined) setData.storeId = updates.storeId;
    if (updates.name !== undefined) setData.name = updates.name;
    if (updates.bedType !== undefined) setData.bedType = updates.bedType;
    if (updates.area !== undefined) setData.area = String(updates.area);
    if (updates.maxGuests !== undefined) setData.maxGuests = updates.maxGuests;
    if (updates.facilities !== undefined) setData.facilities = updates.facilities;
    if (updates.roomCount !== undefined) setData.roomCount = updates.roomCount;
    if (updates.basePrice !== undefined) setData.basePrice = updates.basePrice;
    if (updates.images !== undefined) setData.images = updates.images;
    if (updates.description !== undefined) setData.description = updates.description;
    if (updates.status !== undefined) setData.status = updates.status;
    const result = await db.update(pmsBuiRoomTypes).set(setData)
      .where(eq(pmsBuiRoomTypes.id, id)).returning();
    return c.json(result[0] || { success: true });
  }

  if (data.action === 'editRoom') {
    const { id, roomNumber, floor, status, price, attributes } = data;
    if (!id) return c.json({ error: 'Missing room id' }, 400);
    const result = await db.update(pmsBuiRooms).set({
      roomNumber, floor: floor || 3, status: status || 'available', price: price || 0,
    } as any).where(eq(pmsBuiRooms.id, id)).returning();
    return c.json(result[0] || { success: true });
  }

  if (data.action === 'deleteRoom') {
    const { id } = data;
    if (!id) return c.json({ error: 'Missing room id' }, 400);
    await db.delete(pmsBuiRooms).where(eq(pmsBuiRooms.id, id));
    return c.json({ success: true });
  }

  if (data.action === 'deleteRoomType') {
    const { id } = data;
    // 检查是否有房间关联此房型
    const linkedRooms = await db.select().from(pmsBuiRooms)
      .where(eq(pmsBuiRooms.roomTypeId, id)).limit(1);
    if (linkedRooms.length > 0) {
      return c.json({ success: false, error: '该房型下存在房间，请先删除相关房间' }, 400);
    }
    await db.delete(pmsBuiRoomTypes).where(eq(pmsBuiRoomTypes.id, id));
    return c.json({ success: true, message: '房型已删除' });
  }

  return c.json({ success: true });
});

export default route;
