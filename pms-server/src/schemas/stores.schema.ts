import { z } from 'zod';

// ============ 子模型 ============

export const StoreSchema = z.object({
  id: z.string().describe('门店ID'),
  brandId: z.string().describe('品牌ID'),
  brandName: z.string().describe('品牌名称'),
  name: z.string().describe('门店名称'),
  address: z.string().describe('门店地址'),
  phone: z.string().describe('联系电话'),
  roomCount: z.number().describe('房间总数'),
  manager: z.string().describe('店长'),
  status: z.enum(['active', 'inactive']).describe('状态'),
  facilities: z.array(z.string()).describe('设施列表'),
  todayOccupancy: z.number().describe('今日入住率(%)'),
  todayRevenue: z.number().describe('今日营收'),
  monthRevenue: z.number().describe('本月营收'),
}).describe('门店');

export const RoomTypeSchema = z.object({
  id: z.string().describe('房型ID'),
  storeId: z.string().describe('门店ID'),
  name: z.string().describe('房型名称'),
  bedType: z.string().describe('床型'),
  area: z.number().describe('面积(㎡)'),
  maxGuests: z.number().describe('最大入住人数'),
  facilities: z.array(z.string()).describe('设施列表'),
  roomCount: z.number().describe('房间数'),
  basePrice: z.number().describe('基础价格'),
  images: z.array(z.string()).optional().describe('房型图片'),
}).describe('房型');

export const RoomSchema = z.object({
  id: z.string().describe('房间ID'),
  roomTypeId: z.string().describe('房型ID'),
  roomTypeName: z.string().describe('房型名称'),
  roomNumber: z.string().describe('房号'),
  floor: z.number().describe('楼层'),
  status: z.enum(['available', 'occupied', 'dirty', 'maintenance', 'locked', 'booked']).describe('房间状态'),
  price: z.number().describe('价格'),
}).describe('房间');

export const DeviceSchema = z.object({
  id: z.string().describe('设备ID'),
  name: z.string().describe('设备名称'),
  type: z.string().describe('设备类型'),
  roomId: z.string().optional().describe('关联房间ID'),
  status: z.enum(['online', 'offline', 'error']).describe('设备状态'),
  lastSync: z.string().describe('最后同步时间'),
}).describe('设备');

// ============ 查询参数 ============

export const StoreQuerySchema = z.object({
  type: z.enum(['roomTypes', 'rooms', 'devices', 'storeDetail']).optional().describe('查询类型'),
  storeId: z.string().optional().describe('门店ID'),
}).describe('门店查询参数');

// ============ 路由定义 ============

export const getStores = {
  method: 'get' as const,
  path: '/',
  summary: '获取门店列表',
  description: '返回所有门店列表',
  tags: ['门店管理'],
  request: {
    query: StoreQuerySchema,
  },
  responses: {
    200: {
      description: '门店列表',
      content: { 'application/json': { schema: z.array(StoreSchema) } },
    },
  },
};
